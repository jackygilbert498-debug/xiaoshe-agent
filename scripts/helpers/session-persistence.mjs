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
