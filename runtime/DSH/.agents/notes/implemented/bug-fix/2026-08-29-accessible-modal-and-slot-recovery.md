# Agent Note: Modal focus and slot failures must remain recoverable

Status: implemented

English | [中文](2026-08-29-accessible-modal-and-slot-recovery.zh.md)

## Problem

The shared modal atom exposed `role="dialog"` but did not contain keyboard focus, isolate the page behind it, or restore the invoking control after close. Separately, a crashed UI slot rendered an empty `data-slot-error` element. A root-slot failure therefore looked like an unexplained blank application even though the renderer had already supervised and recorded the fault.

## Decision

`Modal` now owns the complete browser-modal interaction contract. While open it records the previously focused element, marks every sibling of its portal root `inert` and `aria-hidden`, chooses a useful initial control, traps `Tab` and `Shift+Tab`, closes on `Escape`, and restores the exact prior accessibility state and focus on cleanup.

The slot renderer still reports and abdicates failed entries through the ledger. Its transient boundary and permanent dry-cell paths now render a small accessible recovery face instead of an empty node. A root failure occupies the viewport and explains the condition; all failure faces expose a reload action, while a still-mounted boundary also exposes a local retry action. Boot-order assembly errors remain fail-loud and are not converted into runtime recovery UI.

## Alternatives considered

**Let each product shell implement modal keyboard handling.** Rejected because focus containment, background isolation, and restoration are primitive behavior and would drift across shells.

**Automatically reload after a slot crash.** Rejected because it can create a reload loop and discard unsaved user state without consent.

**Swallow a missing root registration.** Rejected because absent composition is an assembly error, not a recoverable registrant crash.

## Consequences

- Keyboard and assistive-technology users cannot interact with background controls while a shared modal is open.
- Slot supervision remains authoritative; recovery UI does not misrepresent a crashed entry as healthy.
- A dry root no longer presents an unexplained blank screen, but retry still cannot revive an entry already abdicated by the ledger; reload is the explicit recovery path.

## Testing

`packages/client/ui-primitives/tests/atoms.client.spec.tsx` covers initial focus, forward and reverse focus wrapping, background isolation, and focus restoration. `packages/client/ui-renderer/tests/scoped-slots.client.spec.tsx` covers actionable root and child-slot crash faces while retaining sibling isolation and fail-loud boot-order behavior.
