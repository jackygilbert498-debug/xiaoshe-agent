export const name = 'xiaoshe-tool-composition-inspector'
export const inject = ['tools']

export async function apply(ctx) {
  const actionToolsEnabled = process.env.XIAOSHE_EXPECT_ACTIONS !== undefined
    ? process.env.XIAOSHE_EXPECT_ACTIONS !== 'off'
    : process.env.XIAOSHE_DESKTOP_ACTIONS !== 'off'
  const expected = [
    ...(actionToolsEnabled ? ['screen_click', 'screen_press', 'screen_type'] : []),
    'screen_observe',
    'screen_verify',
    'screen_zoom',
  ].sort()

  // Sibling bundles mount concurrently. Poll the shared registry instead of
  // inspecting it synchronously during this diagnostic plugin's own mount.
  const deadline = Date.now() + 5_000
  let names = []
  while (Date.now() < deadline) {
    names = ctx.tools.schemas().map(schema => schema.name).sort()
    const actual = names.filter(name => name.startsWith('screen_'))
    if (
      JSON.stringify(actual) === JSON.stringify(expected)
      && names.includes('modlens_read_image')
    ) {
      console.log(
        `[xiaoshe-composition] actions=${actionToolsEnabled} tools=${JSON.stringify(actual)} modlens=true total=${names.length}`,
      )
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  const actual = names.filter(name => name.startsWith('screen_'))
  throw new Error(
    `DSH tool composition timed out: actions=${actionToolsEnabled} `
      + `screen=${JSON.stringify(actual)} modlens=${names.includes('modlens_read_image')}`,
  )
}
