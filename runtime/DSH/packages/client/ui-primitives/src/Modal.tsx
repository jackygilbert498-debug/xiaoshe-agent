import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './Modal.module.css'

interface ModalBaseProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
}

type ModalProps = ModalBaseProps & (
  | { headless: true; closeLabel?: never }
  | { headless?: false; closeLabel: string }
)

/**
 * Render a centered, body-portaled modal over a blurred page mask.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape or mask click.
 * @param props.title - dialog heading (aria-label in every mode).
 * @param props.closeLabel - localized accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - body (inputs, etc.).
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome); mask, card, Escape, and aria-label remain.
 * @returns null when closed; otherwise the overlay tree.
 */
export function Modal({
  open, onClose, title, closeLabel, description, children, footer, className, contentClassName, headless = false,
}: ModalProps) {
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => { onCloseRef.current = onClose }, [onClose])
  const rootRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const initialFocusRef = useRef<HTMLElement | null>(null)
  // Capture before the portal commits: React's autoFocus runs before effects,
  // so reading the initiator in the effect would instead remember the dialog.
  if (open && rootRef.current === null) {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    initialFocusRef.current = null
  }

  useEffect(() => {
    if (!open) return
    const previousFocus = returnFocusRef.current
    const root = rootRef.current
    const dialog = dialogRef.current
    const background = root === null
      ? []
      : Array.from(document.body.children).flatMap(element => element === root || !(element instanceof HTMLElement)
        ? []
        : [{ element, inert: element.inert === true, ariaHidden: element.getAttribute('aria-hidden') }])
    for (const state of background) {
      state.element.inert = true
      state.element.setAttribute('aria-hidden', 'true')
    }

    const focusable = (): HTMLElement[] => dialog === null ? [] : Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    )).filter(element => element.getAttribute('aria-hidden') !== 'true')
    const preferred = dialog?.querySelector<HTMLElement>(
      '[autofocus],input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled])',
    )
    const active = document.activeElement
    const alreadyFocused = active instanceof HTMLElement && dialog?.contains(active) ? active : null
    // Honor explicit React autoFocus (e.g. Cancel on a destructive dialog),
    // including StrictMode's effect replay, instead of stealing it for Close.
    const initial = alreadyFocused
      ?? (initialFocusRef.current && dialog?.contains(initialFocusRef.current) ? initialFocusRef.current : null)
      ?? preferred ?? focusable()[0] ?? dialog
    initialFocusRef.current = initial ?? null
    initial?.focus({ preventScroll: true })

    const onKeyDown = (e: KeyboardEvent) => {
      // A nested body portal makes this layer inert; only the top dialog owns keys.
      if (root?.inert === true) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const candidates = focusable()
      if (candidates.length === 0) {
        e.preventDefault()
        dialog?.focus({ preventScroll: true })
        return
      }
      const first = candidates[0]!
      const last = candidates.at(-1)!
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === dialog || !dialog?.contains(active))) {
        e.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!e.shiftKey && (active === last || !dialog?.contains(active))) {
        e.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      for (const state of background) {
        state.element.inert = state.inert
        if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden')
        else state.element.setAttribute('aria-hidden', state.ariaHidden)
      }
      if (previousFocus?.isConnected === true) previousFocus.focus({ preventScroll: true })
    }
  }, [open])

  if (!open) return null

  return createPortal((
    <div ref={rootRef} className={css.root} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        className={clsx(css.dialog, className)}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {headless
          ? children
          : (
            <>
              <div className={clsx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>{title}</h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutline16 size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
