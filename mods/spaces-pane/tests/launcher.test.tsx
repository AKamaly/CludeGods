import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CALL, FOOTER, NOW, SPACES, settle, standardFiles, start, world } from './world'

// Stands for the engine's own mode labels beneath the plugin.
function engineModes(on: On) {
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Bypass permissions</Text>
  })
}

test("the footer launcher keeps Claude's own mode labels and opens the Spaces pane", async ($, on) => {
  const w = world(on)
  engineModes(on)
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })

  expect((await ui.find({ key: 'open-spaces-band' }))?.props.label).toBe('Spaces')
  expect(await ui.find({ type: 'Text', text: 'Bypass permissions' })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)

  await ui.press({ key: 'open-spaces-band' })
  expect(w.opens).toEqual([expect.objectContaining({ id: 'spaces', title: 'Spaces', columns: 46, focus: true })])
  await ui.unmount()
})

test('the launcher draws on the terminal too, without the icon', async ($, on) => {
  world(on)
  engineModes(on)
  const ui = await $.ui.mount({ ...FOOTER, surface: 'terminal' })
  expect((await ui.find({ key: 'open-spaces-band' }))?.props.label).toBe('Spaces')
  expect(await ui.find({ type: 'Text', text: 'Bypass permissions' })).toBeDefined()
  await ui.unmount()
})

test('after the poll the launcher counts drafts awaiting review', async ($, on) => {
  const files = standardFiles()
  files[`${SPACES}/.drafts/ob_aaaaaaaaaaaa.md`] = { text: '---\ntitle: A\nby: scribe\nspace: notes\n---\n\nx\n', mtimeMs: 1 }
  files[`${SPACES}/.drafts/ob_bbbbbbbbbbbb.md`] = { text: '---\ntitle: B\nby: scribe\nspace: notes\n---\n\nx\n', mtimeMs: 2 }
  world(on, files)
  engineModes(on)
  await start($)
  await settle()

  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await ui.find({ key: 'open-spaces-band' }))?.props.label).toBe('Spaces · 2 drafts')
  expect(await ui.find({ type: 'Text', text: 'Bypass permissions' })).toBeDefined()
  await ui.unmount()
})

test('the session start registers /spaces, seeds Memory and Notes on a first run, and opens nothing', async ($, on) => {
  const w = world(on, { [`${CALL}/workers.json`]: { text: '{"workers":[]}', mtimeMs: 0 } })
  await start($)
  await settle()

  expect(w.commands).toEqual(['spaces-pane'])
  expect(w.opens).toEqual([])
  const written = w.writes.map(x => x.path)
  expect(written).toEqual([
    `${SPACES}/memory/space.json`,
    `${SPACES}/memory/welcome.md`,
    `${SPACES}/notes/space.json`,
    `${SPACES}/notes/welcome.md`,
  ])
  const memory = w.files[`${SPACES}/memory/welcome.md`]?.text ?? ''
  expect(memory).toMatch(/^---\ntitle: About Memory\ncreated: 2026-11-01T12:00:00\.000Z\nupdated: 2026-11-01T12:00:00\.000Z\nby: you\n---\n\n# About Memory\n/)
  expect(memory).toContain('every worker may read')
  expect(JSON.parse(w.files[`${SPACES}/memory/space.json`]?.text ?? '{}')).toEqual({ name: 'Memory', created: new Date(NOW).toISOString() })
  // Plain copy: no em dashes, no exclamation marks.
  for (const x of w.writes) expect(x.text).not.toMatch(/\u2014|!/)
})

test('Memory comes back when it is missing, but Notes is seeded only on a first run', async ($, on) => {
  const files = standardFiles()
  for (const path of Object.keys(files)) if (path.includes('/spaces/memory/') || path.includes('/spaces/notes/')) delete files[path]
  const w = world(on, files)
  await start($)
  await settle()
  expect(w.writes.map(x => x.path)).toEqual([`${SPACES}/memory/space.json`, `${SPACES}/memory/welcome.md`])
})

test('an existing Memory space is left alone', async ($, on) => {
  const w = world(on)
  await start($)
  await settle()
  expect(w.writes).toEqual([])
})

test('/spaces opens the pane', async ($, on) => {
  const w = world(on)
  await start($)
  await settle()
  const result = await $.command.run({ command: 'spaces-pane', args: '' } as any)
  expect(JSON.stringify(result)).toContain('Spaces pane opened.')
  expect(w.opens).toEqual([expect.objectContaining({ id: 'spaces', title: 'Spaces', columns: 46 })])
})

test('touching open-spaces opens the pane with focus on the next poll', async ($, on) => {
  const w = world(on)
  w.files[`${CALL}/open-spaces`] = { text: '', mtimeMs: NOW + 1_000 }
  await start($)
  await settle()
  expect(w.opens).toEqual([expect.objectContaining({ id: 'spaces', focus: true })])
})
