import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseOpenRequest } from '../hooks/register'
import { CALL, FOOTER, NOW, PANE, SPACES, page, settle, standardFiles, start, world } from './world'

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
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Spaces')

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
  expect(memory).toContain('Rules every worker reads before it starts')
  expect(w.files[`${SPACES}/notes/welcome.md`]?.text ?? '').toContain('Ask a worker about a page from the Spaces pane.')
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

test('/spaces-pane opens the pane', async ($, on) => {
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
  expect(w.toasts).toEqual([])
})

// ---------------------------------------------------------------- open requests from other panes

const request = (body: unknown): { text: string; mtimeMs: number } => ({
  text: typeof body === 'string' ? body : `${JSON.stringify(body)}\n`,
  mtimeMs: NOW + 1_000,
})

test('the open request is read as JSON, and anything else is a plain open', () => {
  expect(parseOpenRequest('{"at": 1, "space": "memory", "action": "new-page"}')).toEqual({ space: 'memory', action: 'new-page' })
  expect(parseOpenRequest('{"space": "notes", "action": "open"}')).toEqual({ space: 'notes', action: 'open' })
  expect(parseOpenRequest('{"space": " notes "}')).toEqual({ space: 'notes', action: 'open' })
  expect(parseOpenRequest('{"space": "notes", "action": "delete"}')).toEqual({ space: 'notes', action: 'open' })
  for (const plain of ['', '\n', 'open', '{not json', '[]', 'null', '{"action": "new-page"}', '{"space": "../x"}', '{"space": 3}']) {
    expect(parseOpenRequest(plain)).toBeUndefined()
  }
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: a new-page request opens Memory with the new-rule form focused`, async ($, on) => {
    const w = world(on)
    w.files[`${CALL}/open-spaces`] = request({ at: NOW + 1_000, space: 'memory', action: 'new-page' })
    const ui = await $.ui.mount({ ...PANE, surface })
    await start($)
    await settle()
    expect(w.opens).toEqual([expect.objectContaining({ id: 'spaces', focus: true })])
    expect(w.toasts).toEqual([])

    expect(await ui.find({ type: 'Text', text: 'Memory' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'New rule' })).toBeDefined()
    const field = await ui.find({ key: 'form-title' })
    expect(field?.props.autoFocus).toBe(true)
    expect(field?.props.placeholder).toBe('Rule, like Keep replies short')
    expect((await ui.find({ key: 'form-body' }))?.props.rows).toBe(4)
    await ui.unmount()
  })
}

test('an open request opens that space without a form', async ($, on) => {
  const w = world(on)
  w.files[`${CALL}/open-spaces`] = request({ at: NOW + 1_000, space: 'notes', action: 'open' })
  await start($)
  await settle()
  expect(w.opens).toEqual([expect.objectContaining({ id: 'spaces', focus: true })])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'row-launch-brief' })).toBeDefined()
  expect(await ui.find({ key: 'form-title' })).toBeUndefined()
  await ui.unmount()
})

test('a request replaces where the pane was, and an unknown space opens the list and says so', async ($, on) => {
  const w = world(on)
  w.files[`${SPACES}/notes/blank.md`] = page('Blank', '')
  w.files[`${CALL}/open-spaces`] = request({ at: NOW + 1_000, space: 'ghost', action: 'new-page' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })
  await ui.press({ key: 'page-welcome' })
  await start($)
  await settle()
  expect(w.toasts).toEqual(["There's no space \"ghost\", so here are all your spaces"])
  expect(w.opens).toEqual([expect.objectContaining({ id: 'spaces', focus: true })])
  expect(await ui.find({ key: 'space-notes' })).toBeDefined()
  expect(await ui.find({ key: 'form-title' })).toBeUndefined()
  await ui.unmount()
})

test('a flag that is not a request keeps the plain open', async ($, on) => {
  const w = world(on)
  w.files[`${CALL}/open-spaces`] = request('{not json')
  await start($)
  await settle()
  expect(w.opens).toEqual([expect.objectContaining({ id: 'spaces', focus: true })])
  expect(w.toasts).toEqual([])
})
