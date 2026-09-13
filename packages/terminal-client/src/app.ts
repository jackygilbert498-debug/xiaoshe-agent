import { createInterface } from 'node:readline/promises'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { DshApiClient, DshRpcError, MuxConnection } from './api.js'
import { isRecord } from './protocol.js'
import type { TerminalOptions } from './options.js'
import type { MuxEnvelope, QuestionAnswer, QuestionItem, SessionEvent, SessionHistory, SessionSummary } from './protocol.js'
import {
  eventText, eventUsage, formatNumber, modelLabel, oneLine, palette, parseQuestionAnswer,
  projectionStatus, sessionTitle, turnReason,
} from './presentation.js'

interface TerminalStreams {
  readonly input: Readable
  readonly output: Writable
  readonly error: Writable
  readonly color: boolean
}

interface ActiveSession {
  readonly sessionId: string
  readonly cwd?: string
}

function write(stream: Writable, text: string): void {
  stream.write(text)
}

function notification(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(wake => { resolve = wake })
  return { promise, resolve }
}

function recentSessions(items: readonly SessionSummary[]): readonly SessionSummary[] {
  return items.filter(item => item.origin !== 'subagent').sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 5)
}

function resolveResume(items: readonly SessionSummary[], requested: string): SessionSummary {
  const exact = items.find(item => item.sessionId === requested)
  if (exact !== undefined) return exact
  const prefixed = items.filter(item => item.sessionId.startsWith(requested))
  if (prefixed.length === 1 && prefixed[0] !== undefined) return prefixed[0]
  if (prefixed.length > 1) throw new Error(`会话前缀不唯一：${requested}`)
  throw new Error(`没有找到会话：${requested}`)
}

/** Interactive terminal surface over the shared Xiaoshe DSH Host. */
export class TerminalApp {
  private readonly api: DshApiClient
  private readonly mux: MuxConnection
  private readonly rl
  private readonly colors
  private active: ActiveSession | undefined
  private interruptCount = 0
  private pendingFrame: Promise<MuxEnvelope> | undefined
  private interactionWaiting = 0
  private readonly lifetime = new AbortController()
  private readonly lines: string[] = []
  private inputClosed = false
  private explicitExit = false
  private inputWake: (() => void) | undefined
  private stateChange = notification()
  private sending = 0
  private sendTail = Promise.resolve()
  private readonly queues = new Map<string, readonly unknown[]>()
  private readonly running = new Set<string>()
  private readonly awaitingPrompt = new Map<string, string>()
  private readonly followSeq = new Map<string, number>()
  private readonly queueRetirements = new Map<string, { sessionId: string; cutoff?: number }>()
  private reconciliationFailure: Error | undefined
  private details = false
  private toolCount = 0
  private toolDetails: string[] = []
  private toolNames = new Map<string, string>()
  private usage: Record<string, number> | undefined

  constructor(private readonly options: TerminalOptions, private readonly streams: TerminalStreams) {
    this.api = new DshApiClient(options.baseUrl, fetch, process.env.XIAOSHE_AUTH_COOKIE)
    this.mux = new MuxConnection(this.api)
    this.rl = createInterface({ input: streams.input, output: streams.output, terminal: streams.color })
    this.colors = palette(streams.color && !options.noColor)
    this.rl.on('SIGINT', () => { void this.onInterrupt() })
    // A permanent line listener preserves pasted/non-TTY lines between prompts.
    // Only the input arbiter removes them; an approval can preempt a pending read.
    this.rl.on('line', line => { this.lines.push(line); this.inputWake?.() })
    this.rl.on('close', () => { this.inputClosed = true; this.inputWake?.(); this.notifyState() })
  }

  async run(): Promise<void> {
    try {
      await this.mux.opened
      const sessions = await this.api.listSessions()
      for (const session of sessions) if (session.running) this.running.add(session.sessionId)
      this.active = await this.selectSession(sessions)
      await this.waitForSubscription(this.active.sessionId)
      await this.printBanner()
      await this.loop()
    } finally {
      this.lifetime.abort()
      this.mux.close()
      this.rl.close()
      this.inputWake = undefined
    }
  }

  private async selectSession(all: readonly SessionSummary[]): Promise<ActiveSession> {
    if (this.options.resume !== undefined) {
      const selected = resolveResume(all, this.options.resume)
      return { sessionId: selected.sessionId, ...(selected.cwd === undefined ? {} : { cwd: selected.cwd }) }
    }
    if (this.options.fresh || !this.streams.color) return this.createSession()
    const recent = recentSessions(all)
    if (recent.length === 0) return this.createSession()
    write(this.streams.output, `${this.colors.heading}最近会话${this.colors.reset}\n`)
    recent.forEach((session, index) => {
      const running = session.running ? ` ${this.colors.warning}运行中${this.colors.reset}` : ''
      write(this.streams.output, `  ${index + 1}. ${sessionTitle(session)}${running}${session.cwd === undefined ? '' : `\n     ${this.colors.dim}${oneLine(session.cwd, 68)}${this.colors.reset}`}\n`)
    })
    const line = await this.question('输入编号继续；直接回车新建：')
    if (line === undefined) return this.createSession()
    const answer = line.trim()
    if (answer === '') return this.createSession()
    const index = Number(answer)
    const selected = Number.isInteger(index) ? recent[index - 1] : undefined
    if (selected === undefined) throw new Error(`无效的会话编号：${answer}`)
    return { sessionId: selected.sessionId, ...(selected.cwd === undefined ? {} : { cwd: selected.cwd }) }
  }

  private async createSession(): Promise<ActiveSession> {
    const sessionId = await this.api.createSession(this.options.cwd)
    return { sessionId, ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }) }
  }

  private async waitForSubscription(sessionId: string): Promise<void> {
    this.mux.subscribe(sessionId)
    await this.mux.waitSubscribed(sessionId)
  }

  private async printBanner(): Promise<void> {
    if (this.active === undefined) return
    const [model, history] = await Promise.all([
      this.api.models(this.active.sessionId),
      this.api.history(this.active.sessionId, 20),
    ])
    const c = this.colors
    write(this.streams.output, `\n${c.heading}小蛇 · 终端工作台${c.reset}\n`)
    write(this.streams.output, `${c.dim}与界面版共享会话、模型、审批、记忆和执行沙箱${c.reset}\n`)
    write(this.streams.output, `模型：${modelLabel(model)}\n`)
    write(this.streams.output, `目录：${this.active.cwd ?? '未固定（由会话决定）'}\n`)
    for (const line of projectionStatus(history.projections)) write(this.streams.output, `${line}\n`)
    write(this.streams.output, `${c.dim}:help 帮助 · :queue 队列 · :effort 思考强度 · :stop 停止 · :details 工具明细\n运行中输入默认排队；:steer <文本> 立即调整。:exit 退出，/ 查看会话命令。${c.reset}\n\n`)
  }

  private async loop(): Promise<void> {
    while (true) {
      this.interruptCount = 0
      const line = await this.idleInput()
      if (line === undefined) return
      const input = line.trim()
      if (input === '') continue
      if (input === ':exit' || input === ':quit') return
      try {
      if (input === ':help') { this.printHelp(); continue }
      if (input === ':stop') { await this.stop(); continue }
      if (input === ':queue' || input.startsWith(':queue ')) { await this.queueCommand(input); continue }
      if (input === ':effort' || input.startsWith(':effort ')) { await this.effortCommand(input); continue }
      if (input === ':details') {
        this.details = !this.details
        write(this.streams.output, `工具明细已${this.details ? '展开（最近 100 条）' : '折叠'}。\n`)
        if (this.details) for (const row of this.toolDetails) write(this.streams.output, `  ${row}\n`)
        continue
      }
      if (input === ':status') { await this.printStatus(); continue }
      if (input === ':models') { write(this.streams.output, JSON.stringify(await this.api.modelCatalog(), null, 2) + '\n'); continue }
      if (input.startsWith(':model ')) {
        const [provider, model, ...extra] = input.slice(7).trim().split(/\s+/u)
        if (!provider || !model || extra.length || this.active === undefined) { write(this.streams.error, '用法：:model <provider> <model>\n'); continue }
        const receipt = await this.api.selectModel(this.active.sessionId, provider, model)
        write(this.streams.output, JSON.stringify(receipt) + '\n')
        continue
      }
      if (input.startsWith(':steer ') && this.active !== undefined) {
        this.submit(input.slice(7), 'steer')
        continue
      }
      if (input === ':sessions') { await this.printSessions(); continue }
      if (input === ':new') { await this.switchToNew(); continue }
      if (input.startsWith(':resume ')) { await this.switchTo(input.slice(':resume '.length).trim()); continue }
      if (input.startsWith(':')) {
        write(this.streams.error, `${this.colors.warning}未知本地命令：${input}（输入 :help 查看）${this.colors.reset}\n`)
        continue
      }
      this.submit(input, 'queue')
      } catch (error) { write(this.streams.error, `${this.colors.warning}${String(error)}${this.colors.reset}\n`) }
    }
  }

  private printHelp(): void {
    write(this.streams.output, [
      '本地命令：',
      '  :status             查看模型、词元、缓存与上下文',
      '  :models             查看模型目录',
      '  :model <服务> <模型> 切换模型（仅空闲时）',
      '  :steer <文本>       向运行中的会话插入引导',
      '  :queue              查看 Host 当前队列与消息 ID',
      '  :queue edit <ID> <文本> / :queue remove <ID> / :queue steer <ID>',
      '  :effort [强度]      查看或设置当前模型支持的思考强度',
      '  :stop               停止当前轮（保留队列）',
      '  :details            展开/折叠最近工具明细',
      '  :sessions           列出最近会话',
      '  :new                新建并切换会话',
      '  :resume <编号或ID>  继续会话',
      '  :exit               退出终端版（后台 Runtime 不停止）',
      'DSH 命令：直接输入 / 可查看命令，/permission 可切换权限方案。',
      '执行中按 Ctrl-C 会取消本轮；空闲时按两次 Ctrl-C 退出。',
      '',
    ].join('\n'))
  }

  /** Keep exactly one pending read so an input/stream race cannot steal the next event. */
  private peekFrame(): Promise<MuxEnvelope> { return this.pendingFrame ??= this.mux.next() }
  private notifyState(): void { this.stateChange.resolve(); this.stateChange = notification() }

  /** Reserve, but do not consume a line until the arbiter has selected it. */
  private async waitLine(signal: AbortSignal): Promise<void> {
    while (!this.lines.length && !this.inputClosed && !signal.aborted) {
      await new Promise<void>(resolve => {
        const wake = () => { signal.removeEventListener('abort', wake); this.inputWake = undefined; resolve() }
        this.inputWake = wake
        signal.addEventListener('abort', wake, { once: true })
      })
    }
  }

  /** One input reader and one feed read serve both idle and running sessions. */
  private async idleInput(): Promise<string | undefined> {
    while (true) {
      const input = new AbortController()
      if (!this.inputClosed) {
        this.rl.setPrompt(`${this.colors.user}你${this.running.has(this.active?.sessionId ?? '') ? ' · 排队' : ''} › ${this.colors.reset}`)
        this.rl.prompt(true)
      }
      const line = this.waitLine(input.signal)
      try {
        while (true) {
          if (this.explicitExit) return undefined
          if (this.reconciliationFailure !== undefined) throw this.reconciliationFailure
          const sessionId = this.active?.sessionId ?? ''
          if (this.inputClosed && !this.lines.length && !this.sending && !this.running.has(sessionId) && !(this.queues.get(sessionId)?.length) && ![...this.awaitingPrompt.values()].includes(sessionId)) return undefined
          const next = await Promise.race([
            this.peekFrame().then(value => ({ kind: 'frame' as const, value })),
            ...(!this.inputClosed || this.lines.length ? [line.then(() => ({ kind: 'line' as const }))] : []),
            this.stateChange.promise.then(() => ({ kind: 'state' as const })),
          ])
          if (next.kind === 'state') continue
          if (next.kind === 'line') {
            if (this.lines.length) return this.lines.shift()
            continue
          }
          this.pendingFrame = undefined
          const frame = next.value.payload
          if (frame.type === 'stream/error') throw new Error(frame.error.message)
          if (frame.type === 'session/queue') this.reconcileQueue(frame.sessionId, frame.items)
          if (frame.type === 'session/subscribed') { this.followSeq.set(frame.sessionId, frame.lastSeq); this.retireCaughtUp() }
          if (frame.type === 'session/event') this.trackEvent(frame.sessionId, frame.event)
          if (!('sessionId' in frame) || frame.sessionId !== this.active?.sessionId) continue
          if (frame.type === 'approval/requested' || frame.type === 'question/requested') {
            input.abort(); await line
            if (frame.type === 'approval/requested') await this.answerApproval(next.value)
            else await this.answerQuestions(next.value)
            break
          }
          if (frame.type === 'session/event') this.presentEvent(frame.event)
        }
      } finally { input.abort() }
    }
  }

  private async printStatus(): Promise<void> {
    if (this.active === undefined) return
    const [model, history] = await Promise.all([
      this.api.models(this.active.sessionId),
      this.api.history(this.active.sessionId, 20),
    ])
    write(this.streams.output, `${this.colors.heading}当前状态${this.colors.reset}\n`)
    write(this.streams.output, `模型：${model.provider} / ${modelLabel(model)}\n会话：${this.active.sessionId}\n目录：${this.active.cwd ?? '未固定'}\n`)
    for (const line of projectionStatus(history.projections)) write(this.streams.output, `${line}\n`)
  }

  private async printSessions(): Promise<void> {
    const items = recentSessions(await this.api.listSessions())
    if (items.length === 0) { write(this.streams.output, '暂无历史会话。\n'); return }
    items.forEach((session, index) => write(this.streams.output, `${index + 1}. ${sessionTitle(session)} · ${session.sessionId}${session.running ? ' · 运行中' : ''}\n`))
  }

  private async switchToNew(): Promise<void> {
    this.active = await this.createSession()
    this.resetPresentation()
    await this.waitForSubscription(this.active.sessionId)
    await this.printBanner()
  }

  private async switchTo(requested: string): Promise<void> {
    const items = await this.api.listSessions()
    const recent = recentSessions(items)
    const numeric = Number(requested)
    const selected = Number.isInteger(numeric) && numeric >= 1 ? recent[numeric - 1] : resolveResume(items, requested)
    if (selected === undefined) throw new Error(`无效的会话编号：${requested}`)
    this.active = { sessionId: selected.sessionId, ...(selected.cwd === undefined ? {} : { cwd: selected.cwd }) }
    if (selected.running) this.running.add(selected.sessionId)
    else this.running.delete(selected.sessionId)
    this.resetPresentation()
    await this.waitForSubscription(this.active.sessionId)
    await this.printBanner()
  }

  /** Serialize admission order only; event consumption and stop stay independent. */
  private submit(input: string, mode: 'queue' | 'steer'): void {
    if (this.active === undefined || !input.trim()) return
    const owner = this.active
    const requestId = randomUUID()
    this.awaitingPrompt.set(requestId, owner.sessionId)
    this.sending++
    write(this.streams.output, `${this.colors.dim}正在发送 · ${mode === 'queue' ? '排队' : '立即调整'} · ${oneLine(input)}${this.colors.reset}\n`)
    this.sendTail = this.sendTail.then(async () => {
      if (this.lifetime.signal.aborted) {
        this.awaitingPrompt.delete(requestId)
        write(this.streams.error, `尚未发送；保留草稿 [${owner.sessionId}]：${input}\n`)
        return
      }
      try {
        const result = await this.api.prompt(owner.sessionId, input, Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', this.lifetime.signal, mode, requestId)
        if (this.lifetime.signal.aborted) return
        const scope = owner === this.active ? '' : ` [${owner.sessionId}]`
        if (result.commandText !== undefined) { this.awaitingPrompt.delete(requestId); write(this.streams.output, `小蛇${scope} › ${result.commandText}\n`) }
        else write(this.streams.output, `${this.colors.assistant}已接收${scope} · ${mode === 'queue' ? '按队列顺序处理' : '立即调整请求'}${this.colors.reset}\n`)
      } catch (error) {
        this.awaitingPrompt.delete(requestId)
        const status = error instanceof DshRpcError ? '发送失败' : '发送结果不明，请先查看会话或队列，避免重复发送'
        write(this.streams.error, `${status} [${owner.sessionId}]：${String(error)}\n保留草稿：${input}\n`)
      }
    }).finally(() => { this.sending--; this.notifyState() })
  }

  private async stop(): Promise<void> {
    if (this.active === undefined) return
    write(this.streams.output, '正在请求停止本轮…\n')
    await this.api.cancel(this.active.sessionId)
    write(this.streams.output, 'Host 已接收停止请求。\n')
  }

  private async queueCommand(input: string): Promise<void> {
    if (this.active === undefined) return
    if (input === ':queue') {
      const items = this.queues.get(this.active.sessionId) ?? []
      write(this.streams.output, items.length ? 'Host 当前队列：\n' : '暂无排队消息。\n')
      for (const item of items) {
        if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.message)) continue
        const text = eventText({ type: 'user/message', seq: 0, time: 0, data: { message: item.message } })
        write(this.streams.output, `  ${item.id} · ${item.placement === 'steering' ? '立即调整' : '排队'} · ${oneLine(text, 160)}\n`)
      }
      return
    }
    const match = /^:queue (edit|remove|steer) (\S+)(?: (.+))?$/u.exec(input)
    if (!match || (match[1] === 'edit' ? !match[3]?.trim() : match[3] !== undefined)) throw new Error('用法：:queue edit <ID> <文本> / :queue remove <ID> / :queue steer <ID>')
    const action = match[1] === 'edit' ? { kind: 'edit', content: [{ type: 'text', text: match[3]!.trim() }] } : { kind: match[1] }
    const item = this.queues.get(this.active.sessionId)?.find(row => isRecord(row) && row.id === match[2])
    const result = await this.api.call<unknown>('session.updateQueue', { sessionId: this.active.sessionId, itemId: match[2], action }, this.lifetime.signal)
    if (!isRecord(result) || result.accepted !== true) throw new Error('队列更新回执无效；请查看队列确认结果')
    if (match[1] === 'remove') {
      if (isRecord(item) && typeof item.rpcId === 'string') this.awaitingPrompt.delete(item.rpcId)
    }
    // Queue contents change only when Host control publishes its snapshot.
    write(this.streams.output, 'Host 已接收队列更新。\n')
  }

  private async effortCommand(input: string): Promise<void> {
    if (this.active === undefined) return
    const owner = this.active
    const current = await this.api.models(owner.sessionId, this.lifetime.signal)
    const catalog = await this.api.modelCatalog(this.lifetime.signal)
    const provider = Array.isArray(catalog.groups) ? catalog.groups.find(row => isRecord(row) && row.id === current.provider) : undefined
    const model = isRecord(provider) && Array.isArray(provider.models) ? provider.models.find(row => isRecord(row) && row.id === current.model) : undefined
    const reasoning = isRecord(model) && isRecord(model.reasoning) ? model.reasoning : undefined
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts.flatMap(row => isRecord(row) && typeof row.id === 'string' ? [row.id] : []) : []
    const effort = input.slice(':effort'.length).trim()
    if (!effort) { write(this.streams.output, `思考强度 · ${current.provider}/${current.model} · 当前 ${current.reasoningEffort ?? '模型默认'}\n可选：${efforts.join('、') || '当前模型未提供可调强度'}\n`); return }
    if (!efforts.includes(effort)) throw new Error(`当前模型不支持强度 ${effort}；可选：${efforts.join('、') || '无'}`)
    if (owner !== this.active) throw new Error('会话已切换，强度未修改')
    const result = await this.api.selectModel(owner.sessionId, current.provider, current.model, effort)
    if (!isRecord(result) || !isRecord(result.selected) || result.selected.provider !== current.provider || result.selected.model !== current.model || result.selected.reasoningEffort !== effort) throw new Error('强度回执无效；请查看状态确认结果')
    const boundary = result.effective === 'next-request' ? '下一次模型请求生效，当前请求保持原强度' : result.effective === 'immediate' ? 'Host 已确认生效' : 'Host 已接收，未报告生效边界'
    write(this.streams.output, `思考强度 ${effort} · ${boundary}\n`)
    if (isRecord(result.persistence) && result.persistence.status === 'session-only') write(this.streams.output, `仅当前会话${typeof result.persistence.warning === 'string' ? '：' + result.persistence.warning : ''}\n`)
  }

  private resetPresentation(): void {
    this.toolCount = 0; this.toolNames.clear(); this.toolDetails = []; this.usage = undefined
  }

  /** Queue disappearance may precede turn/start on the separate follow stream.
   * Retire its local receipt only after that stream reaches a freshly read
   * durable watermark. Host opens a turn before claiming input, so a claim keeps
   * EOF waiting on running state; a true external removal can finish draining.
   */
  private reconcileQueue(sessionId: string, items: readonly unknown[]): void {
    const previous = this.queues.get(sessionId) ?? []
    this.queues.set(sessionId, items)
    const present = new Set(items.flatMap(row => isRecord(row) && typeof row.rpcId === 'string' ? [row.rpcId] : []))
    for (const id of present) this.queueRetirements.delete(id)
    const retired: [string, { sessionId: string; cutoff?: number }][] = []
    for (const row of previous) {
      if (!isRecord(row) || typeof row.rpcId !== 'string' || present.has(row.rpcId) || this.awaitingPrompt.get(row.rpcId) !== sessionId) continue
      const retirement = { sessionId }
      this.queueRetirements.set(row.rpcId, retirement)
      retired.push([row.rpcId, retirement])
    }
    this.retireCaughtUp()
    if (retired.length === 0) return
    // The mux does not expose control-generation identity. A projection cached
    // before disconnect cannot prove the next queue's cutoff, so every removal
    // of a still-awaited local prompt gets one fresh read (batched per snapshot).
    void this.api.history(sessionId, 1, this.lifetime.signal).then(history => {
      if (!Number.isSafeInteger(history.throughSeq)) throw new Error('队列确认缺少有效历史边界')
      for (const [id, retirement] of retired) {
        if (this.queueRetirements.get(id) === retirement) retirement.cutoff = history.throughSeq!
      }
      this.retireCaughtUp(); this.notifyState()
    }).catch(error => {
      if (this.lifetime.signal.aborted) return
      this.reconciliationFailure = new Error(`无法确认队列移除后的历史，已停止等待：${String(error)}`)
      this.notifyState()
    })
  }

  private retireCaughtUp(): void {
    for (const [id, retirement] of this.queueRetirements) {
      if (retirement.cutoff === undefined || (this.followSeq.get(retirement.sessionId) ?? -1) < retirement.cutoff) continue
      this.awaitingPrompt.delete(id)
      this.queueRetirements.delete(id)
    }
  }

  /** Keep completion fences for every subscribed session, including after switching away. */
  private trackEvent(sessionId: string, event: SessionEvent): void {
    this.followSeq.set(sessionId, event.seq)
    if (event.type === 'turn/start') this.running.add(sessionId)
    if (event.type === 'turn/end') this.running.delete(sessionId)
    if (event.type === 'user/message' && isRecord(event.data)) {
      const message = isRecord(event.data.message) ? event.data.message : event.data
      const source = isRecord(message.source) ? message.source : undefined
      if (typeof source?.rpcId === 'string' && this.awaitingPrompt.get(source.rpcId) === sessionId) this.awaitingPrompt.delete(source.rpcId)
    }
    this.retireCaughtUp()
  }

  /** Progress is derived only from durable public events; raw reasoning is ignored. */
  private presentEvent(event: SessionEvent): void {
    const data = isRecord(event.data) ? event.data : {}
    if (event.type === 'turn/start') {
      this.toolCount = 0; this.toolNames.clear(); this.usage = undefined
      write(this.streams.output, `${this.colors.dim}  已开始本轮 · 可继续输入排队${this.colors.reset}\n`)
    } else if (event.type === 'tool/call' || event.type === 'tool/result') {
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const name = typeof data.name === 'string' ? data.name : this.toolNames.get(callId) ?? '工具'
      if (event.type === 'tool/call') {
        this.toolNames.set(callId, name)
        this.toolCount++
        if (!this.details && this.toolCount === 1) write(this.streams.output, `  正在使用工具 · ${oneLine(name, 40)}（:details 查看明细）\n`)
      }
      const failed = event.type === 'tool/result' && (data.error !== undefined || this.toolResultIsError(data))
      const message = isRecord(data.message) ? data.message : undefined
      const errorText = typeof data.error === 'string' ? data.error : isRecord(data.error) && typeof data.error.message === 'string' ? data.error.message : Array.isArray(message?.content) ? message.content.flatMap(block => isRecord(block) && block.isError === true && typeof block.text === 'string' ? [block.text] : []).join(' ') : ''
      const row = `${oneLine(name, 40)} · ${failed ? '失败' : event.type === 'tool/call' ? '执行中' : '完成'}${errorText ? '：' + oneLine(errorText, 240) : ''}`
      if (event.type === 'tool/result') this.toolNames.delete(callId)
      this.toolDetails.push(row)
      if (this.toolDetails.length > 100) this.toolDetails.shift()
      if (this.details || failed) write(this.streams.output, `${failed ? this.colors.warning : this.colors.dim}  ${row}${this.colors.reset}\n`)
    } else if (event.type === 'assistant/message') {
      const text = eventText(event)
      if (text) write(this.streams.output, `\n小蛇 › ${text}\n`)
      this.usage = eventUsage(event) ?? this.usage
    } else if (event.type === 'llm/retry') write(this.streams.output, `${this.colors.warning}  模型请求重试中${this.colors.reset}\n`)
    else if (event.type === 'compaction/start') write(this.streams.output, '  正在整理上下文\n')
    else if (event.type === 'turn/end') {
      const completed = isRecord(data.reason) && data.reason.kind === 'completed'
      const tokenLine = this.usage === undefined ? '' : ` · 输入 ${formatNumber(this.usage.inputTokens ?? 0)} / 输出 ${formatNumber(this.usage.outputTokens ?? 0)}`
      const tools = this.toolCount ? ` · 工具调用 ${this.toolCount} 次` : ''
      write(this.streams.output, `${completed ? this.colors.success : this.colors.warning}${completed ? '✓' : '!'} 本轮${turnReason(event)}${tools}${tokenLine}${this.colors.reset}\n`)
    }
  }

  private toolResultIsError(data: Record<string, unknown>): boolean {
    const message = typeof data.message === 'object' && data.message !== null ? data.message as Record<string, unknown> : undefined
    const content = Array.isArray(message?.content) ? message.content : []
    return content.some(block => typeof block === 'object' && block !== null && (block as Record<string, unknown>).isError === true)
  }

  private async answerApproval(envelope: MuxEnvelope): Promise<void> {
    const frame = envelope.payload
    if (frame.type !== 'approval/requested') return
    write(this.streams.output, `${this.colors.warning}\n需要批准：${frame.toolName}${frame.reason === undefined ? '' : `\n原因：${frame.reason}`}${this.colors.reset}\n`)
    const signal = this.mux.interactionSignal(envelope.rpcId)
    const answer = (await this.question('本次允许？[y/N] ', signal, true) ?? '').trim().toLowerCase()
    if (signal.aborted) return
    const outcome = answer === 'y' || answer === 'yes' || answer === '是' ? 'allowed-once' : 'rejected'
    await this.mux.respond(envelope.rpcId, outcome)
    write(this.streams.output, `${outcome === 'allowed-once' ? this.colors.success : this.colors.warning}${outcome === 'allowed-once' ? '已允许本次操作' : '已拒绝操作'}${this.colors.reset}\n`)
  }

  private async answerQuestions(envelope: MuxEnvelope): Promise<void> {
    const frame = envelope.payload
    if (frame.type !== 'question/requested') return
    const answers: QuestionAnswer[] = []
    const signal = this.mux.interactionSignal(envelope.rpcId)
    for (const question of frame.questions) {
      const answer = await this.askQuestion(question, signal)
      if (signal.aborted) return
      if (answer === undefined) {
        await this.mux.respondCancelled(envelope.rpcId, '终端输入已关闭，问题未作答')
        write(this.streams.output, `${this.colors.warning}问题已取消；未执行默认选择。${this.colors.reset}\n`)
        return
      }
      answers.push(answer)
    }
    await this.mux.respond(envelope.rpcId, { answers })
  }

  private async askQuestion(question: QuestionItem, signal?: AbortSignal): Promise<QuestionAnswer | undefined> {
    write(this.streams.output, `${this.colors.heading}\n${question.header ?? '需要你的选择'}${this.colors.reset}\n${question.question}\n`)
    if (question.detail !== undefined) write(this.streams.output, `${this.colors.dim}${question.detail}${this.colors.reset}\n`)
    question.options?.forEach((option, index) => write(this.streams.output, `  ${index + 1}. ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}\n`))
    while (true) {
      const prompt = question.multiSelect === true ? '输入编号（多个用逗号分隔）：' : '输入编号或自定义回答：'
      const line = await this.question(prompt, signal, true)
      if (line === undefined) return undefined
      const answer = parseQuestionAnswer(question, line)
      if (answer !== undefined) return answer
      write(this.streams.error, `${this.colors.warning}输入无效，请重试。${this.colors.reset}\n`)
    }
  }

  /** Human interactions share the buffered reader and release it on cancellation. */
  private async question(prompt: string, signal?: AbortSignal, interaction = false): Promise<string | undefined> {
    if (interaction) this.interactionWaiting++
    const lifetime = signal ?? this.lifetime.signal
    try {
      this.rl.setPrompt(prompt)
      if (!this.inputClosed) this.rl.prompt(true)
      await this.waitLine(lifetime)
      if (lifetime.aborted) return undefined
      return this.lines.shift()
    } finally {
      if (interaction) this.interactionWaiting--
    }
  }

  private async onInterrupt(): Promise<void> {
    this.interruptCount += 1
    if ((this.running.has(this.active?.sessionId ?? '') || this.sending > 0 || this.interactionWaiting > 0) && this.active !== undefined) {
      write(this.streams.output, `\n${this.colors.warning}正在取消本轮…${this.colors.reset}\n`)
      await this.api.cancel(this.active.sessionId).catch(error => write(this.streams.error, `取消失败：${String(error)}\n`))
      return
    }
    if (this.interruptCount >= 2) {
      this.explicitExit = true
      write(this.streams.output, '\n已退出。\n')
      this.rl.close()
      this.notifyState()
    } else {
      write(this.streams.output, '\n再次按 Ctrl-C 退出；或输入 :exit。\n')
    }
  }
}

export function nodeStreams(): TerminalStreams {
  return { input: process.stdin, output: process.stdout, error: process.stderr, color: process.stdin.isTTY === true && process.stdout.isTTY === true }
}

export function lastProjection(history: SessionHistory): SessionHistory['projections'] {
  return history.projections
}
