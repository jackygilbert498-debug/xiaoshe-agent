/** Real v3 ownership/durability barriers for isolated cold-reload fixtures. */
export async function saveSessionLog(persistence, session) {
  const handle = await persistence.create(session.header)
  try {
    await handle.append(session.snapshotEvents())
    await handle.flush()
  } finally {
    await handle.close()
  }
}

export async function loadSessionLog(persistence, sessionId) {
  const handle = await persistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read()
    return { events, meta: handle.header }
  } finally {
    await handle.close()
  }
}

/** Keep real native-tool fixtures on v3's explicit writer ownership API. */
export async function attachSessionLog(ctx, persistence, session, { existing = false } = {}) {
  const handle = existing ? await persistence.open(session.header.id, 'write') : await persistence.create(session.header)
  if (existing) {
    const stored = await handle.read()
    const tail = session.snapshotEvents().slice(stored.events.length)
    if (tail.length) await handle.append(tail)
  }
  else if (session.snapshotEvents().length) await handle.append(session.snapshotEvents())
  // Creating/opening the writer attaches the backend's own live event route.
  // Do not append those events twice; drain through the SessionStore barrier.
  let disposed = false
  ctx.effect(() => () => { disposed = true })
  const flush = () => disposed ? Promise.resolve() : ctx.sessions.flush(session)
  return { flush, async close() { try { await flush() } finally { await handle.close() } } }
}
