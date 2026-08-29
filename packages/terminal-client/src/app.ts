import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import { DshApiClient, MuxConnection } from './api.js'
import type { TerminalOptions } from './options.js'
import type { MuxEnvelope, QuestionAnswer, QuestionItem, SessionEvent, SessionHistory, SessionSummary } from './protocol.js'
import {
  eventText, eventTurn, eventUsage, formatNumber, modelLabel, oneLine, palette, parseQuestionAnswer,
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
  private executing = false
  private interruptCount = 0

  constructor(private readonly options: TerminalOptions, private readonly streams: TerminalStreams) {
    this.api = new DshApiClient(options.baseUrl)
    this.mux = new MuxConnection(this.api.muxUrl())
    this.rl = createInterface({ input: streams.input, output: streams.output, terminal: streams.color })
    this.colors = palette(streams.color && !options.noColor)
    this.rl.on('SIGINT', () => { void this.onInterrupt() })
  }

  async run(): Promise<void> {
    try {
      await this.mux.opened
      const sessions = await this.api.listSessions()
      this.active = await this.selectSession(sessions)
      await this.waitForSubscription(this.active.sessionId)
      await this.printBanner()
      await this.loop()
    } finally {
      this.mux.close()
      this.rl.close()
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
    if (this.mux.hasSubscription(sessionId)) return
    while (true) {
      const envelope = await this.mux.next()
      if (envelope.payload.type === 'stream/error') throw new Error(envelope.payload.error.message)
      if (envelope.payload.type === 'session/subscribed' && envelope.payload.sessionId === sessionId) return
    }
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
    write(this.streams.output, `${c.dim}:help 帮助 · :status 状态 · :new 新会话 · :sessions 最近会话 · :exit 退出\n斜杠命令直接输入，例如 /permission、/compact。执行写入或高风险动作时会先请求批准。${c.reset}\n\n`)
  }

  private async loop(): Promise<void> {
    while (true) {
      this.interruptCount = 0
      const line = await this.question(`${this.colors.user}你 › ${this.colors.reset}`)
      if (line === undefined) return
      const input = line.trim()
      if (input === '') continue
      if (input === ':exit' || input === ':quit') return
      if (input === ':help') { this.printHelp(); continue }
      if (input === ':status') { await this.printStatus(); continue }
      if (input === ':sessions') { await this.printSessions(); continue }
      if (input === ':new') { await this.switchToNew(); continue }
      if (input.startsWith(':resume ')) { await this.switchTo(input.slice(':resume '.length).trim()); continue }
      if (input.startsWith(':')) {
        write(this.streams.error, `${this.colors.warning}未知本地命令：${input}（输入 :help 查看）${this.colors.reset}\n`)
        continue
      }
      await this.runTurn(input)
    }
  }

  private printHelp(): void {
    write(this.streams.output, [
      '本地命令：',
      '  :status             查看模型、词元、缓存与上下文',
      '  :sessions           列出最近会话',
      '  :new                新建并切换会话',
      '  :resume <编号或ID>  继续会话',
      '  :exit               退出终端版（后台 Runtime 不停止）',
      'DSH 命令：直接输入 / 可查看命令，/permission 可切换权限方案。',
      '执行中按 Ctrl-C 会取消本轮；空闲时按两次 Ctrl-C 退出。',
      '',
    ].join('\n'))
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
    await this.waitForSubscription(this.active.sessionId)
    await this.printBanner()
  }

  private async runTurn(input: string): Promise<void> {
    if (this.active === undefined) return
    const sessionId = this.active.sessionId
    const before = await this.api.history(sessionId, 1)
    let floorSeq = before.events.at(-1)?.event.seq ?? -1
    this.executing = true
    write(this.streams.output, `${this.colors.assistant}小蛇 › 已接收，正在处理…${this.colors.reset}\n`)
    try {
      const result = await this.api.prompt(sessionId, input, Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai')
      if (result.commandText !== undefined) {
        write(this.streams.output, `${this.colors.assistant}小蛇 › ${result.commandText}${this.colors.reset}\n`)
        return
      }
      let finalText = ''
      let usage: Record<string, number> | undefined
      let activeTurn: number | undefined
      let sawTurnStart = false
      while (true) {
        const envelope = await this.mux.next()
        const frame = envelope.payload
        if (frame.type === 'stream/error') throw new Error(frame.error.message)
        if (!('sessionId' in frame) || frame.sessionId !== sessionId) continue
        if (frame.type === 'approval/requested') { await this.answerApproval(envelope); continue }
        if (frame.type === 'question/requested') { await this.answerQuestions(envelope); continue }
        if (frame.type !== 'session/event' || frame.event.seq <= floorSeq) continue
        floorSeq = frame.event.seq
        const event = frame.event
        if (event.type === 'turn/start') {
          sawTurnStart = true
          activeTurn = eventTurn(event)
          finalText = ''
          usage = undefined
          write(this.streams.output, `${this.colors.dim}  ◌ 已开始本轮${this.colors.reset}\n`)
        }
        else if (event.type === 'tool/call') this.printToolCall(event)
        else if (event.type === 'tool/result') this.printToolResult(event)
        else if (event.type === 'assistant/message') {
          const text = eventText(event)
          if (text !== '') finalText = text
          usage = eventUsage(event) ?? usage
        } else if (event.type === 'llm/retry') write(this.streams.output, `${this.colors.warning}  ↻ 模型请求重试中${this.colors.reset}\n`)
        else if (event.type === 'compaction/start') write(this.streams.output, `${this.colors.dim}  ◌ 正在整理上下文${this.colors.reset}\n`)
        if (event.type === 'turn/end') {
          // `mode: queue` may be called while another turn is ending. Only the
          // turn that starts after this prompt belongs to the terminal request.
          if (!sawTurnStart) continue
          const endingTurn = eventTurn(event)
          if (activeTurn !== undefined && endingTurn !== activeTurn) continue
          if (finalText !== '') write(this.streams.output, `${this.colors.assistant}小蛇 › ${finalText}${this.colors.reset}\n`)
          const tokenLine = usage === undefined ? '' : ` · 输入 ${formatNumber(usage.inputTokens ?? 0)} / 输出 ${formatNumber(usage.outputTokens ?? 0)}${usage.cacheReadTokens === undefined ? '' : ` / cache ${formatNumber(usage.cacheReadTokens)}`}`
          write(this.streams.output, `${this.colors.success}✓ 本轮${turnReason(event)}${tokenLine}${this.colors.reset}\n`)
          return
        }
      }
    } finally {
      this.executing = false
    }
  }

  private printToolCall(event: SessionEvent): void {
    const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}
    const name = typeof data.name === 'string' ? data.name : '工具'
    write(this.streams.output, `${this.colors.tool}  ◆ 工具 · ${oneLine(name, 40)} · 执行中${this.colors.reset}\n`)
  }

  private printToolResult(event: SessionEvent): void {
    const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}
    const failed = data.error !== undefined || this.toolResultIsError(data)
    write(this.streams.output, `${failed ? this.colors.warning : this.colors.tool}  ${failed ? '!' : '◇'} 工具 · ${failed ? '失败' : '完成'}${this.colors.reset}\n`)
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
    const answer = (await this.question('本次允许？[y/N] ') ?? '').trim().toLowerCase()
    const outcome = answer === 'y' || answer === 'yes' || answer === '是' ? 'allowed-once' : 'rejected'
    await this.api.respond(envelope.rpcId, { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome })
    write(this.streams.output, `${outcome === 'allowed-once' ? this.colors.success : this.colors.warning}${outcome === 'allowed-once' ? '已允许本次操作' : '已拒绝操作'}${this.colors.reset}\n`)
  }

  private async answerQuestions(envelope: MuxEnvelope): Promise<void> {
    const frame = envelope.payload
    if (frame.type !== 'question/requested') return
    const answers: QuestionAnswer[] = []
    for (const question of frame.questions) {
      const answer = await this.askQuestion(question)
      if (answer === undefined) {
        await this.api.respondCancelled(envelope.rpcId, '终端输入已关闭，问题未作答')
        write(this.streams.output, `${this.colors.warning}问题已取消；未执行默认选择。${this.colors.reset}\n`)
        return
      }
      answers.push(answer)
    }
    await this.api.respond(envelope.rpcId, { sessionId: frame.sessionId, answer: { answers } })
  }

  private async askQuestion(question: QuestionItem): Promise<QuestionAnswer | undefined> {
    write(this.streams.output, `${this.colors.heading}\n${question.header ?? '需要你的选择'}${this.colors.reset}\n${question.question}\n`)
    if (question.detail !== undefined) write(this.streams.output, `${this.colors.dim}${question.detail}${this.colors.reset}\n`)
    question.options?.forEach((option, index) => write(this.streams.output, `  ${index + 1}. ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}\n`))
    while (true) {
      const prompt = question.multiSelect === true ? '输入编号（多个用逗号分隔）：' : '输入编号或自定义回答：'
      const line = await this.question(prompt)
      if (line === undefined) return undefined
      const answer = parseQuestionAnswer(question, line)
      if (answer !== undefined) return answer
      write(this.streams.error, `${this.colors.warning}输入无效，请重试。${this.colors.reset}\n`)
    }
  }

  /** readline rejects after EOF/Ctrl-D; treat that as a normal terminal exit. */
  private async question(prompt: string): Promise<string | undefined> {
    try {
      return await this.rl.question(prompt)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_USE_AFTER_CLOSE') return undefined
      if (error instanceof Error && error.message === 'readline was closed') return undefined
      throw error
    }
  }

  private async onInterrupt(): Promise<void> {
    this.interruptCount += 1
    if (this.executing && this.active !== undefined) {
      write(this.streams.output, `\n${this.colors.warning}正在取消本轮…${this.colors.reset}\n`)
      await this.api.cancel(this.active.sessionId).catch(error => write(this.streams.error, `取消失败：${String(error)}\n`))
      return
    }
    if (this.interruptCount >= 2) {
      write(this.streams.output, '\n已退出。\n')
      this.rl.close()
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
