/** Read-only event access across DSH's public snapshot API and legacy ports. */
export interface SessionEventSource<Event> {
  snapshotEvents?(): readonly Event[]
  readonly events?: readonly Event[]
}

export function readSessionEvents<Event>(session: SessionEventSource<Event> | undefined): readonly Event[] {
  // Never fall back after a snapshot error: stale legacy data must not certify
  // a newer session. Callers decide whether missing optional history is fatal.
  if (session?.snapshotEvents) return session.snapshotEvents()
  return session?.events ?? []
}
