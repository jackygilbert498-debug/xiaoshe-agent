import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronDownOutline14,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

/** Registration-side Remote face used by the section. */
export interface PluginInventorySettingsTabInjected {
  /** Read a current Host inventory snapshot. */
  list: () => Promise<PluginInventorySnapshot>
}

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']
type PluginCategory = 'product' | 'conversation' | 'tools' | 'security' | 'interface' | 'runtime'

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

interface PresentedModule {
  readonly moduleName: string
  readonly entries: readonly PluginInventoryEntry[]
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
  readonly category: PluginCategory
  readonly titleKey: PluginInventoryLocaleKey | null
  readonly descriptionKey: PluginInventoryLocaleKey
}

interface PresentedCapability {
  readonly id: string
  readonly modules: readonly PresentedModule[]
  readonly entries: readonly PluginInventoryEntry[]
  readonly enabled: boolean
  readonly partiallyEnabled: boolean
  readonly fiberPhase: PluginFiberPhase
  readonly category: PluginCategory
  readonly titleKey: PluginInventoryLocaleKey | null
  readonly descriptionKey: PluginInventoryLocaleKey
}

interface PresentationRule {
  readonly pattern: RegExp
  readonly titleKey: PluginInventoryLocaleKey
  readonly descriptionKey: PluginInventoryLocaleKey
}

const CATEGORY_ORDER: readonly PluginCategory[] = [
  'product',
  'conversation',
  'tools',
  'security',
  'interface',
  'runtime',
]

const CATEGORY_KEYS = {
  product: ['productGroup', 'productGroupDescription'],
  conversation: ['conversationGroup', 'conversationGroupDescription'],
  tools: ['toolsGroup', 'toolsGroupDescription'],
  security: ['securityGroup', 'securityGroupDescription'],
  interface: ['interfaceGroup', 'interfaceGroupDescription'],
  runtime: ['runtimeGroup', 'runtimeGroupDescription'],
} as const satisfies Record<PluginCategory, readonly [PluginInventoryLocaleKey, PluginInventoryLocaleKey]>

const INTERNAL_FALLBACK_KEYS = {
  product: ['otherProductTitle', 'otherProductDescription'],
  conversation: ['otherConversationTitle', 'otherConversationDescription'],
  tools: ['otherToolsTitle', 'otherToolsDescription'],
  security: ['otherSecurityTitle', 'otherSecurityDescription'],
  interface: ['otherInterfaceTitle', 'otherInterfaceDescription'],
  runtime: ['runtimeComponentTitle', 'runtimeComponentDescription'],
} as const satisfies Record<PluginCategory, readonly [PluginInventoryLocaleKey, PluginInventoryLocaleKey]>

/** Product-facing names for common capabilities; exact technical ids remain in details. */
const PRESENTATION_RULES: readonly PresentationRule[] = [
  { pattern: /@xiaoshe\/memory(?:$|\/)/, titleKey: 'memoryTitle', descriptionKey: 'memoryDescription' },
  { pattern: /modlens|vision|screen-observ/i, titleKey: 'visionTitle', descriptionKey: 'visionDescription' },
  { pattern: /product-identity/i, titleKey: 'identityTitle', descriptionKey: 'identityDescription' },
  { pattern: /runtime-routes/i, titleKey: 'routesTitle', descriptionKey: 'routesDescription' },
  { pattern: /desktop-(?:capability|control)|computer-use/i, titleKey: 'desktopTitle', descriptionKey: 'desktopDescription' },
  { pattern: /verification-policy/i, titleKey: 'verificationTitle', descriptionKey: 'verificationDescription' },
  { pattern: /heartbeat/i, titleKey: 'heartbeatTitle', descriptionKey: 'heartbeatDescription' },
  { pattern: /plugin-governance/i, titleKey: 'governanceTitle', descriptionKey: 'governanceDescription' },
  { pattern: /completion-receipt/i, titleKey: 'receiptTitle', descriptionKey: 'receiptDescription' },
  { pattern: /task-timeline/i, titleKey: 'timelineTitle', descriptionKey: 'timelineDescription' },
  { pattern: /runtime-dsh-provider/i, titleKey: 'runtimeConnectionTitle', descriptionKey: 'runtimeConnectionDescription' },
  { pattern: /native-shell/i, titleKey: 'shellTitle', descriptionKey: 'shellDescription' },
  { pattern: /model-(?:service|catalog|router)|llm/i, titleKey: 'modelTitle', descriptionKey: 'modelDescription' },
  { pattern: /session/i, titleKey: 'sessionTitle', descriptionKey: 'sessionDescription' },
  { pattern: /agent-instruction|prompt/i, titleKey: 'instructionsTitle', descriptionKey: 'instructionsDescription' },
  { pattern: /agent-loop|tool-dispatch/i, titleKey: 'agentLoopTitle', descriptionKey: 'agentLoopDescription' },
  { pattern: /approval|question/i, titleKey: 'approvalTitle', descriptionKey: 'approvalDescription' },
  { pattern: /permission|sandbox|policy/i, titleKey: 'permissionTitle', descriptionKey: 'permissionDescription' },
  { pattern: /credential|secret|auth/i, titleKey: 'credentialTitle', descriptionKey: 'credentialDescription' },
  { pattern: /attachment|upload/i, titleKey: 'attachmentTitle', descriptionKey: 'attachmentDescription' },
  { pattern: /background-job|tool-jobs?|\bjobs?\b/i, titleKey: 'jobsTitle', descriptionKey: 'jobsDescription' },
  { pattern: /tool-(?:bash|pwsh)|shell-command|command-exec/i, titleKey: 'commandTitle', descriptionKey: 'commandDescription' },
  { pattern: /tool-fs|file-system|filesystem/i, titleKey: 'filesTitle', descriptionKey: 'filesDescription' },
  { pattern: /tool-(?:web|search)|web-search/i, titleKey: 'searchTitle', descriptionKey: 'searchDescription' },
  { pattern: /tool-browser|browser-control/i, titleKey: 'browserTitle', descriptionKey: 'browserDescription' },
  { pattern: /tool-subagent|subagent/i, titleKey: 'subagentTitle', descriptionKey: 'subagentDescription' },
  { pattern: /tool-skill|skills?(?:-runtime)?/i, titleKey: 'skillsTitle', descriptionKey: 'skillsDescription' },
  { pattern: /todo|goal/i, titleKey: 'planningTitle', descriptionKey: 'planningDescription' },
  { pattern: /directory-picker/i, titleKey: 'directoryTitle', descriptionKey: 'directoryDescription' },
  { pattern: /workspace/i, titleKey: 'workspaceTitle', descriptionKey: 'workspaceDescription' },
  { pattern: /settings/i, titleKey: 'settingsTitle', descriptionKey: 'settingsDescription' },
  { pattern: /locale|i18n/i, titleKey: 'languageTitle', descriptionKey: 'languageDescription' },
  { pattern: /theme|appearance/i, titleKey: 'themeTitle', descriptionKey: 'themeDescription' },
  { pattern: /terminal/i, titleKey: 'terminalTitle', descriptionKey: 'terminalDescription' },
  { pattern: /hmr|hot-reload/i, titleKey: 'hotReloadTitle', descriptionKey: 'hotReloadDescription' },
]

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

const PHASE_PRIORITY: Readonly<Record<Exclude<PluginFiberPhase, null>, number>> = {
  failed: 5,
  loading: 4,
  unloading: 3,
  pending: 2,
  active: 1,
}

/** Localized accessible label for one aggregated root Fiber phase. */
function phaseLabel(
  phase: PluginFiberPhase,
  t: PluginInventorySettingsTabProps['t'],
): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a module specifier without pretending that the internal id is a product name. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  const normalized = unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
    .replace(/^ui-/, '')
    .replace(/[\/_-]+/g, ' ')
    .trim()
  return normalized.length > 0
    ? normalized.replace(/\b\w/g, letter => letter.toLocaleUpperCase())
    : moduleName
}

/** Assign a user-facing capability group without changing Loader ownership. */
function categoryFor(moduleName: string): PluginCategory {
  if (/@xiaoshe\/|modlens|desktop-|screen-observ|computer-use/i.test(moduleName)) return 'product'
  if (/settings|locale|i18n|theme|appearance|workspace|attachment|directory-picker|client-ui-(?:brand|commands|cordis|deliverables|input|layout|message|plan|reference|renderer|sidebar|tool|trajectory)/i.test(moduleName)) return 'interface'
  if (/session|conversation|model|llm|agent|prompt|context|compaction/i.test(moduleName)) return 'conversation'
  if (/approval|question|permission|sandbox|policy|credential|secret|auth/i.test(moduleName)) return 'security'
  if (/tool-|skill|jobs?|workflow|subagent|bash|pwsh|file-system|filesystem|todo|goal|terminal|search/i.test(moduleName)) return 'tools'
  if (/ui-/i.test(moduleName)) return 'interface'
  return 'runtime'
}

/** Pick the most actionable phase when several Loader instances own one module. */
function aggregatePhase(entries: readonly PluginInventoryEntry[]): PluginFiberPhase {
  const phases = entries.filter(entry => entry.enabled).map(entry => entry.fiberPhase)
  return phases.reduce<PluginFiberPhase>((selected, phase) => {
    if (phase === null) return selected
    if (selected === null || PHASE_PRIORITY[phase] > PHASE_PRIORITY[selected]) return phase
    return selected
  }, null)
}

/** Collapse Loader instances into one truthful product module. */
function aggregateModules(entries: readonly PluginInventoryEntry[]): PresentedModule[] {
  const groups = new Map<string, PluginInventoryEntry[]>()
  for (const entry of entries) {
    const group = groups.get(entry.moduleName)
    if (group === undefined) groups.set(entry.moduleName, [entry])
    else group.push(entry)
  }
  return [...groups].map(([moduleName, moduleEntries]) => {
    const rule = PRESENTATION_RULES.find(candidate => candidate.pattern.test(moduleName))
    const category = categoryFor(moduleName)
    const fallback = /^@deepseek-ai\/|^cordis:/u.test(moduleName) ? INTERNAL_FALLBACK_KEYS[category] : undefined
    return {
      moduleName,
      entries: moduleEntries,
      enabled: moduleEntries.some(entry => entry.enabled),
      fiberPhase: aggregatePhase(moduleEntries),
      category,
      titleKey: rule?.titleKey ?? fallback?.[0] ?? null,
      descriptionKey: rule?.descriptionKey ?? fallback?.[1] ?? CATEGORY_KEYS[category][1],
    }
  }).sort((a, b) => a.moduleName.localeCompare(b.moduleName))
}

/** Fold internal modules that serve the same user-facing capability into one card. */
function aggregateCapabilities(modules: readonly PresentedModule[]): PresentedCapability[] {
  const groups = new Map<string, PresentedModule[]>()
  for (const module of modules) {
    const id = module.titleKey === null ? `${module.category}:${module.moduleName}` : `${module.category}:${module.titleKey}`
    const group = groups.get(id)
    if (group === undefined) groups.set(id, [module])
    else group.push(module)
  }
  return [...groups].map(([id, capabilityModules]) => {
    const entries = capabilityModules.flatMap(module => module.entries)
    const enabledCount = capabilityModules.filter(module => module.enabled).length
    const first = capabilityModules[0]!
    return {
      id,
      modules: capabilityModules,
      entries,
      enabled: enabledCount > 0,
      partiallyEnabled: enabledCount > 0 && enabledCount < capabilityModules.length,
      fiberPhase: aggregatePhase(entries),
      category: first.category,
      titleKey: first.titleKey,
      descriptionKey: first.descriptionKey,
    }
  })
}

/** Whether an aggregated module matches the local catalog query. */
function matches(
  module: PresentedModule,
  normalizedQuery: string,
  t: PluginInventorySettingsTabProps['t'],
): boolean {
  if (normalizedQuery.length === 0) return true
  const title = module.titleKey === null ? moduleShortName(module.moduleName) : t(module.titleKey)
  return [
    module.moduleName,
    title,
    t(module.descriptionKey),
    t(CATEGORY_KEYS[module.category][0]),
    ...module.entries.map(entry => entry.entryId),
  ].some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** Render the read-only current Loader inventory as deduplicated product capabilities. */
export function PluginInventorySettingsTab({ list, t }: PluginInventorySettingsTabProps): ReactNode {
  const catalogId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<PluginCategory>>(() => new Set(['runtime']))
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const modules = useMemo(
    () => state.status === 'ready' ? aggregateModules(state.snapshot.entries) : [],
    [state],
  )
  const filteredModules = useMemo(
    () => modules.filter(module => matches(module, normalizedQuery, t)),
    [modules, normalizedQuery, t],
  )
  const capabilities = useMemo(() => aggregateCapabilities(filteredModules), [filteredModules])
  const filteredInstanceCount = filteredModules.reduce((count, module) => count + module.entries.length, 0)

  useEffect(() => {
    if (expanded !== null && !capabilities.some(capability => capability.id === expanded)) {
      setExpanded(null)
    }
  }, [capabilities, expanded])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const toggleGroup = (category: PluginCategory): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          <div className={css.catalogHeading}>
            <h3>{t('catalog')}</h3>
            <span className={css.catalogSummary}>
              <span aria-hidden="true">
                {filteredModules.length}{t('componentUnit')}{t('summarySeparator')}{filteredInstanceCount}{t('instanceUnit')}
              </span>
              <span className={css.visuallyHidden} data-plugin-count={filteredModules.length}>{filteredModules.length}</span>
              <span className={css.visuallyHidden} data-plugin-instance-count={filteredInstanceCount}>{filteredInstanceCount}</span>
            </span>
          </div>
          {state.snapshot.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {state.snapshot.entries.length > 0 && filteredModules.length === 0
            ? <p className={css.status}>{t('emptySearch')}</p>
            : null}
          {filteredModules.length > 0 ? (
            <div className={css.groups}>
              {CATEGORY_ORDER.map((category) => {
                const categoryCapabilities = capabilities.filter(capability => capability.category === category)
                if (categoryCapabilities.length === 0) return null
                const [groupTitleKey, groupDescriptionKey] = CATEGORY_KEYS[category]
                const isCollapsed = normalizedQuery.length === 0 && collapsed.has(category)
                const panelId = `${catalogId}-group-${category}`
                return (
                  <section className={css.group} data-plugin-group={category} key={category}>
                    <button
                      className={css.groupToggle}
                      type="button"
                      aria-expanded={!isCollapsed}
                      aria-controls={panelId}
                      onClick={() => { toggleGroup(category) }}
                    >
                      <span className={css.groupIdentity}>
                        <strong>{t(groupTitleKey)}</strong>
                        <span>{t(groupDescriptionKey)}</span>
                      </span>
                      <span className={css.groupTrailing}>
                        <span className={css.groupCount}>{categoryCapabilities.length}</span>
                        <IconChevronDownOutline14 className={css.groupChevron} size={12} aria-hidden="true" />
                      </span>
                    </button>
                    <ul className={css.cards} id={panelId} hidden={isCollapsed}>
                      {categoryCapabilities.map((capability) => {
                        const status = phaseLabel(capability.fiberPhase, t)
                        const title = capability.titleKey === null ? moduleShortName(capability.modules[0]!.moduleName) : t(capability.titleKey)
                        const description = t(capability.descriptionKey)
                        const configuration = t(capability.partiallyEnabled ? 'partiallyEnabledTag' : capability.enabled ? 'enabledTag' : 'disabledTag')
                        const open = expanded === capability.id
                        const detailId = `${catalogId}-details-${encodeURIComponent(capability.id)}`
                        const singleModule = capability.modules.length === 1 ? capability.modules[0] : undefined
                        return (
                          <li
                            className={css.card}
                            key={capability.id}
                            data-plugin-capability={capability.id}
                            data-plugin-module={singleModule?.moduleName}
                            data-plugin-modules={capability.modules.map(module => module.moduleName).join(' ')}
                            data-open={open ? 'true' : undefined}
                          >
                            <button
                              className={css.cardContent}
                              type="button"
                              aria-expanded={open}
                              aria-controls={detailId}
                              aria-label={capability.enabled ? `${title}, ${status}, ${configuration}` : `${title}, ${configuration}`}
                              onClick={() => {
                                setExpanded(current => current === capability.id ? null : capability.id)
                              }}
                            >
                              <span className={css.cardIdentity}>
                                <strong className={css.cardTitle} title={capability.modules.map(module => module.moduleName).join('\n')}>{title}</strong>
                                <span className={css.cardDescription}>{description}</span>
                              </span>
                              <span className={css.cardTrailing}>
                                {capability.enabled ? (
                                  <span
                                    className={css.statusDot}
                                    data-phase={capability.fiberPhase ?? 'unobserved'}
                                    role="img"
                                    aria-label={status}
                                    title={status}
                                  />
                                ) : null}
                                {capability.modules.length > 1 ? (
                                  <span className={css.instanceTag} title={`${capability.modules.length} ${t('modules')}`}>{capability.modules.length}</span>
                                ) : capability.entries.length > 1 ? (
                                  <span className={css.instanceTag} title={`${capability.entries.length} ${t('instances')}`}>{capability.entries.length}</span>
                                ) : null}
                                <span className={css.configTag} data-enabled={capability.enabled ? capability.partiallyEnabled ? 'partial' : 'true' : 'false'}>
                                  {configuration}
                                </span>
                                <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                              </span>
                            </button>
                            {open ? (
                              <div className={css.cardDetails} id={detailId}>
                                <dl className={css.details}>
                                  <div>
                                    <dt>{t('configuration')}</dt>
                                    <dd>{configuration}</dd>
                                  </div>
                                  {capability.enabled ? (
                                    <div>
                                      <dt>{t('cordis')}</dt>
                                      <dd>{status}</dd>
                                    </div>
                                  ) : null}
                                </dl>
                                <p className={css.instancesHeading}>{capability.modules.length} {t('modules')} · {capability.entries.length} {t('instances')}</p>
                                <ul className={css.moduleList}>
                                  {capability.modules.map(module => (
                                    <li className={css.moduleRow} key={module.moduleName}>
                                      <code className={css.moduleValue} data-technical-module>{module.moduleName}</code>
                                      <ul className={css.instances}>
                                        {module.entries.map(entry => (
                                          <li className={css.instanceRow} key={entry.entryId}>
                                            <code data-loader-entry>{entry.entryId}</code>
                                            <span>{t(entry.enabled ? 'enabledTag' : 'disabledTag')}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
