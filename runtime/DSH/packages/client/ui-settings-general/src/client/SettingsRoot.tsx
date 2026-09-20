/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. The shell is
 * a pure composition face — slot-owned text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve from localized content (trigger: shell locale; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  ConnectionIndicator,
  IconAgentPresetOutline16, IconCheckOutline14, IconCloseOutline16, IconCodeOutline16,
  IconCordisPluginOutline14, IconDataOutline16, IconDatabaseOutline16, IconGaugeOutline16,
  IconPersonalizationOutline16, IconRefreshOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

const RECOVERY_CONFIRMATION_MS = 2_000

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  // Use the shared glyph family where available. These three small outlines
  // fill missing navigation concepts without adding a second icon library.
  if (id === 'shortcuts') return (
    <svg className={css.navIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="3.5" width="13" height="9" rx="2" />
      <path d="M4 6h.01M6.7 6h.01M9.3 6h.01M12 6h.01M4 8.5h.01M6.7 8.5h.01M9.3 8.5h.01M12 8.5h.01M5.5 10.5h5" />
    </svg>
  )
  if (id === 'security') return (
    <svg className={css.navIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5 13.5 4v3.5c0 3.2-2.3 5.6-5.5 7-3.2-1.4-5.5-3.8-5.5-7V4Z" />
      <path d="m5.5 7.7 1.6 1.6 3.4-3.4" />
    </svg>
  )
  if (id === 'about') return (
    <svg className={css.navIcon} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
      <circle cx="8" cy="8" r="6" /><path d="M8 7.2v4M8 4.8h.01" />
    </svg>
  )
  if (id === 'appearance') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconCordisPluginOutline14 className={css.navIcon} size={16} />
  if (id === 'memory') return <IconDatabaseOutline16 className={css.navIcon} size={16} />
  if (id === 'coding-workbench') return <IconCodeOutline16 className={css.navIcon} size={16} />
  if (['migration', 'recovery', 'migration-recovery'].includes(id)) return <IconRefreshOutline16 className={css.navIcon} size={16} />
  if (id === 'runtime') return <IconGaugeOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
  t: SettingsRootComponentProps['t']
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose, t }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()
  const panel = useRef<HTMLDivElement | null>(null)
  const groups = [
    { id: 'preferences', label: t('group.preferences'), ids: ['general', 'appearance', 'shortcuts'] },
    { id: 'capabilities', label: t('group.capabilities'), ids: ['models', 'agent-presets', 'memory', 'plugins', 'coding-workbench'] },
    { id: 'system', label: t('group.system'), ids: ['security', 'migration', 'recovery', 'migration-recovery', 'runtime', 'about'] },
    { id: 'extensions', label: t('group.extensions'), ids: [] as string[] },
  ]
  // Unknown feature-owned sections remain reachable instead of disappearing
  // when a plugin is installed after the shell's navigation was designed.
  const groupFor = (id: string) => groups.find(group => group.ids.includes(id))?.id ?? 'extensions'

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !panel.current) return
      const owner = e.target instanceof Element ? e.target.closest('[role="dialog"]') : null
      if (owner && owner !== panel.current) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab') return
      const controls = [...panel.current.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex]')]
        .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[hidden],[inert]') && node.checkVisibility?.({ visibilityProperty: true }) !== false)
      const first = controls[0], last = controls.at(-1)
      if (!first) { e.preventDefault(); panel.current.focus(); return }
      if (!panel.current.contains(document.activeElement) || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        e.preventDefault(); (e.shiftKey ? last : first)?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Entering the dialog focuses the close button; the root restores its trigger on close.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} data-xs-settings-overlay="" role="presentation">
      <div className={css.mask} data-xs-settings-mask="" aria-hidden="true" onClick={onClose} />
      <div ref={panel} tabIndex={-1} className={css.panel} data-xs-settings-panel="" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className={css.nav} data-xs-settings-nav="">
          <div className={css.navTitle} data-xs-settings-nav-title="" id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList} data-xs-settings-nav-list="">
            {groups.filter(group => rows.some(row => groupFor(row.id) === group.id)).map(group => (
              <div key={group.id} className={css.navGroup} data-xs-settings-group={group.id} role="group" aria-labelledby={`${titleId}-${group.id}`}>
                <h3 id={`${titleId}-${group.id}`} className={css.navGroupTitle} data-xs-settings-group-title="">{group.label}</h3>
                {rows.filter(row => groupFor(row.id) === group.id).map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                data-xs-settings-nav-item={row.id}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                <span className={css.navGlyph} data-xs-settings-nav-glyph="" aria-hidden="true">{navIcon(row.id)}</span>
                <span className={css.navLabel} data-xs-settings-nav-label="">{row.label}</span>
                {row.id === active && <span className={css.navCheck} data-xs-settings-nav-check="" aria-hidden="true"><IconCheckOutline14 size={14} /></span>}
              </button>
                ))}
              </div>
            ))}
          </div>
        </nav>
        <div className={css.content} data-xs-settings-content="">
          <div className={css.header} data-xs-settings-header="">
            <div className={css.actions} data-xs-settings-actions="">{renderSlot('settings.action', {})}</div>
            <button ref={closeButton} type="button" className={css.close} data-xs-settings-close="" onClick={onClose}>
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options} data-xs-settings-options="">
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useSessions, renderSlot, t,
  } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const triggerButton = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(open)
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  // Restore after the close commit, when the dialog can no longer own focus.
  useEffect(() => {
    if (wasOpen.current && !open) triggerButton.current?.focus()
    wasOpen.current = open
  }, [open])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const connectionState = useConnectionState(state => state)
  const previousConnectionState = useRef(connectionState)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [connectionState])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (connectionState === 'connecting') {
    connectionIndicator = 'connecting'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  return (
    <>
      <div className={clsx(css.triggerRow, !wide && css.railRow)}>
        <button
          ref={triggerButton}
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label={t('trigger')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(true) }}
        >
          {renderSlot('settings.trigger', { wide })}
        </button>
        <ConnectionIndicator
          state={wide ? connectionIndicator : undefined}
          disconnectedLabel={t('connection.error')}
          reconnectLabel={t('connection.retry')}
          connectingLabel={t('connection.connecting')}
          recoveredLabel={t('connection.connected')}
          reconnectActionLabel={t('connection.reconnect')}
          restartActionLabel={t('connection.restart')}
          onReconnect={reconnect}
        />
      </div>
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
          t={t}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
