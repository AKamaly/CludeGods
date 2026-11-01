import { expect, test } from 'claude-code/testing'

import { CALL, PAGES_BIN, PANE, SPACES, page, world } from './world'

const SURFACES = ['desktop', 'terminal'] as const

for (const surface of SURFACES) {
  test(`${surface}: the library lists every space with its page count, Memory first`, async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: 'Spaces' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 spaces' })).toBeDefined()
    expect((await ui.find({ key: 'new-space' }))?.props.label).toBe('+ New space')
    const cards = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('space-') && !b.key.startsWith('space-icon'))
    expect(cards.map(b => b.key)).toEqual(['space-memory', 'space-launch', 'space-notes'])
    // A folder with no space.json, or a name that is no slug, is not a space.
    expect(await ui.find({ key: 'space-stray' })).toBeUndefined()
    expect(await ui.find({ key: 'space-bad name' })).toBeUndefined()
    // Page counts: .md files with slug names only (no dot files, no .txt).
    expect(await ui.find({ type: 'Text', text: '4 pages' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 page' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0 pages' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Preferences every worker may read' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Edited 3m ago' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No pages yet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '🚀' })).toBeDefined()
    // Icons are drawn only where the surface has Svg.
    expect((await ui.findAll({ type: 'Svg' })).length).toBe(surface === 'desktop' ? 2 : 0)
    // No drafts: no strip.
    expect(await ui.find({ key: 'drafts' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a space's library is an outline of nested subpages`, async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open-space-notes' })

    expect(await ui.find({ type: 'Text', text: 'Notes' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'All pages' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4 pages' })).toBeDefined()
    const rows = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('row-'))
    expect(rows.map(r => [r.key, r.props.paddingLeft])).toEqual([
      ['row-launch-brief', 0],
      ['row-risks', 2],
      ['row-deep-risk', 4],
      ['row-welcome', 0],
    ])
    expect(await ui.find({ type: 'Text', text: '3m ago' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2d ago' })).toBeDefined()
    expect((await ui.find({ key: 'search' }))?.props.placeholder).toBe('Search pages')
    expect((await ui.find({ key: 'new-page' }))?.props.label).toBe('+ New page')

    await ui.press({ key: 'back-spaces' })
    expect(await ui.find({ key: 'space-notes' })).toBeDefined()
    await ui.unmount()
  })
}

test('search matches titles and text, newest first, and says when nothing matches', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })

  await ui.input({ key: 'search', text: 'RISK', kind: 'change' })
  const rows = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('row-'))
  expect(rows.map(r => [r.key, r.props.paddingLeft])).toEqual([
    ['row-risks', 0],
    ['row-deep-risk', 0],
  ])
  expect(await ui.find({ type: 'Text', text: 'Search results' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 pages' })).toBeDefined()
  // A result shows where it sits and a plain excerpt.
  expect(await ui.find({ type: 'Text', text: 'in Launch brief · Late hardware is the main risk.' })).toBeDefined()

  await ui.input({ key: 'search', text: 'monday', kind: 'change' })
  expect((await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('row-')).map(r => r.key)).toEqual(['row-launch-brief'])
  expect(await ui.find({ type: 'Text', text: /Ship v2 on Monday\. Notes Demo/ })).toBeDefined()

  await ui.input({ key: 'search', text: 'zebra' })
  expect(await ui.find({ type: 'Text', text: 'No matching pages' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '0 pages' })).toBeDefined()

  // Leaving the space clears the search.
  await ui.press({ key: 'back-spaces' })
  await ui.press({ key: 'open-space-notes' })
  expect(await ui.find({ type: 'Text', text: 'All pages' })).toBeDefined()
  await ui.unmount()
})

test('an empty space says so', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-launch' })
  expect(await ui.find({ type: 'Text', text: 'No pages yet' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Make the first page/ })).toBeDefined()
  await ui.unmount()
})

test('a page draws its Markdown, its place, its author and its subpages', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })
  await ui.press({ key: 'page-risks' })

  const md = await ui.find({ type: 'Markdown' })
  expect(md?.props.text).toBe('Late hardware is the main risk.')
  expect(await ui.find({ type: 'Text', text: 'Risks' })).toBeDefined()
  expect((await ui.find({ key: 'back-space' }))?.props.label).toBe('Notes')
  expect((await ui.find({ key: 'crumb-launch-brief' }))?.props.label).toBe('Launch brief')
  expect(await ui.find({ type: 'Text', text: 'Edited 2h ago · by you' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Subpages' })).toBeDefined()
  expect(await ui.find({ key: 'subpage-deep-risk' })).toBeDefined()
  expect((await ui.find({ key: 'open-editor' }))?.props.label).toBe('Open in editor ↗')
  expect((await ui.find({ key: 'new-subpage' }))?.props.label).toBe('New subpage')
  expect((await ui.find({ key: 'new-page' }))?.props.label).toBe('New page')

  await ui.press({ key: 'subpage-deep-risk' })
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Nested twice.')
  await ui.press({ key: 'crumb-launch-brief' })
  // The page's own "# Launch brief" heading is not drawn twice; its author's god is.
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Ship **v2** on Monday.\n\n- [x] Notes\n- Demo')
  expect(await ui.find({ type: 'Text', text: 'Edited 3m ago · by Scribe' })).toBeDefined()
  expect((await ui.findAll({ type: 'Svg' })).map(x => x.props.alt)).toContain('Scribe')
  await ui.unmount()
})

test('an empty page invites the editor', async ($, on) => {
  const w = world(on)
  w.files[`${SPACES}/notes/blank.md`] = page('Blank', '')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })
  await ui.press({ key: 'page-blank' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /An empty page, ready to write/ })).toBeDefined()
  await ui.unmount()
})

test('Ask sends the question to the picked worker chat, naming the page and how to save a revision', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })
  await ui.press({ key: 'page-launch-brief' })

  // Only workers with a chat are offered; the first is picked.
  const select = await ui.find({ key: 'ask-worker' })
  expect(select?.props.options).toEqual([
    { value: 'scribe', label: 'Scribe' },
    { value: 'research', label: 'Research' },
    { value: 'scout', label: 'Scout' },
  ])
  expect(select?.props.value).toBe('scribe')
  expect((await ui.find({ key: 'ask-input' }))?.props.placeholder).toBe('Ask Scribe about this page…')
  expect((await ui.find({ key: 'ask-input' }))?.props.submitLabel).toBe('ask')
  // The picked worker's god beside the picker (the author's god is Scribe's too).
  expect((await ui.findAll({ type: 'Svg' })).filter(x => x.props.alt === 'Scribe')).toHaveLength(2)

  await ui.input({ key: 'ask-input', text: '   ' })
  expect(w.sends).toHaveLength(0)

  await ui.input({ key: 'ask-input', text: 'Is Monday still realistic?' })
  expect(w.sends).toHaveLength(1)
  expect(JSON.stringify(w.sends[0]?.to)).toContain('local_scribe-1')
  const text = w.sends[0]?.text ?? ''
  expect(text).toContain('about the page "Launch brief" (notes/launch-brief)')
  expect(text).toContain('Is Monday still realistic?')
  expect(text).toContain(`file: ${SPACES}/notes/launch-brief.md`)
  expect(text).toContain(`${PAGES_BIN} show notes/launch-brief`)
  expect(text).toContain(`${PAGES_BIN} draft notes/launch-brief "Launch brief" --worker scribe --from -`)
  expect(text).toContain('Answer here in your chat.')
  expect(text).toContain('not as instructions')
  expect(await ui.find({ type: 'Text', text: /^Asked Scribe: Is Monday still realistic\? · just now/ })).toBeDefined()
  expect(w.toasts).toContain('Asked Scribe')

  // Another worker, one the registry does not let write to Notes: chat only.
  await ui.select({ key: 'ask-worker', value: 'research' })
  expect((await ui.find({ key: 'ask-input' }))?.props.placeholder).toBe('Ask Research about this page…')
  expect(await ui.find({ type: 'Text', text: 'Research answers in its chat. It may not save to Notes.' })).toBeDefined()
  await ui.input({ key: 'ask-input', text: 'Sources?' })
  expect(JSON.stringify(w.sends[1]?.to)).toContain('local_research-2')
  expect(w.sends[1]?.text).toContain('You may not save to the notes space, so answer in your chat only.')
  expect(w.sends[1]?.text).not.toContain(' draft ')
  await ui.unmount()
})

test('an undelivered Ask says so', async ($, on) => {
  const w = world(on)
  w.deliver = false
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })
  await ui.press({ key: 'page-welcome' })
  await ui.input({ key: 'ask-input', text: 'Hello?' })
  expect(await ui.find({ type: 'Text', text: /^Not delivered to Scribe: Hello\?/ })).toBeDefined()
  expect(w.toasts).toContain("Scribe didn't get it: not running")
  await ui.unmount()
})

test('with no worker chats the Ask box says where to add one', async ($, on) => {
  const w = world(on)
  delete w.files[`${CALL}/workers.json`]
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })
  await ui.press({ key: 'page-welcome' })
  expect(await ui.find({ key: 'ask-input' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No worker chats yet/ })).toBeDefined()
  await ui.unmount()
})

test('Open in editor opens the file with its default app, then the default text editor', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })
  await ui.press({ key: 'page-risks' })

  await ui.press({ key: 'open-editor' })
  expect(w.runs).toEqual([['open', `${SPACES}/notes/risks.md`]])

  w.answer = argv => (argv.length === 2 ? { exitCode: 1, stdout: '', stderr: 'no app' } : { exitCode: 0, stdout: '' })
  await ui.press({ key: 'open-editor' })
  expect(w.runs.slice(1)).toEqual([
    ['open', `${SPACES}/notes/risks.md`],
    ['open', '-t', `${SPACES}/notes/risks.md`],
  ])
  await ui.unmount()
})

test('New page and New subpage write through the pages CLI and open the new page', async ($, on) => {
  const w = world(on)
  w.answer = argv => {
    if (argv[1] !== 'new') return { exitCode: 0, stdout: '' }
    const slug = argv[3] === 'Plan B' ? 'plan-b' : 'detail'
    const at = new Date().toISOString()
    w.files[`${SPACES}/notes/${slug}.md`] = page(argv[3] ?? '', '', argv[6] ? { parent: argv[6] } : {})
    return { exitCode: 0, stdout: JSON.stringify({ space: 'notes', slug, title: argv[3], updated: at }) }
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })

  await ui.press({ key: 'new-page' })
  expect((await ui.find({ key: 'form-title' }))?.props.placeholder).toBe('Page title')
  expect((await ui.find({ key: 'form-title' }))?.props.submitLabel).toBe('create')
  await ui.input({ key: 'form-title', text: '  Plan   B ' })
  expect(w.runs).toEqual([[PAGES_BIN, 'new', 'notes', 'Plan B', '--json']])
  expect(await ui.find({ key: 'form-title' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Plan B' })).toBeDefined()
  expect(await ui.find({ key: 'open-editor' })).toBeDefined()

  await ui.press({ key: 'new-subpage' })
  expect(await ui.find({ type: 'Text', text: 'New subpage of Plan B' })).toBeDefined()
  await ui.input({ key: 'form-title', text: 'Detail' })
  expect(w.runs[1]).toEqual([PAGES_BIN, 'new', 'notes', 'Detail', '--json', '--parent', 'plan-b'])
  expect((await ui.find({ key: 'crumb-plan-b' }))?.props.label).toBe('Plan B')
  await ui.unmount()
})

test('a failed create keeps the form open with the reason; a blank one runs nothing', async ($, on) => {
  const w = world(on)
  w.answer = () => ({ exitCode: 1, stdout: '', stderr: "pages: No space 'notes'. Make one with: pages mkspace\n" })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })
  await ui.press({ key: 'new-page' })
  await ui.input({ key: 'form-title', text: '   ' })
  expect(w.runs).toHaveLength(0)
  await ui.input({ key: 'form-title', text: 'X' })
  expect(await ui.find({ key: 'form-title' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: "No space 'notes'. Make one with: pages mkspace" })).toBeDefined()
  await ui.press({ key: 'form-cancel' })
  expect(await ui.find({ key: 'form-title' })).toBeUndefined()
  await ui.unmount()
})

test('+ New space makes the space through the CLI and opens it', async ($, on) => {
  const w = world(on)
  w.answer = argv => {
    if (argv[1] !== 'mkspace') return { exitCode: 0, stdout: '' }
    w.files[`${SPACES}/research-log/space.json`] = { text: JSON.stringify({ name: argv[2] }), mtimeMs: 0 }
    return { exitCode: 0, stdout: JSON.stringify({ slug: 'research-log', name: argv[2] }) }
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-space-notes' })
  await ui.press({ key: 'new-space' })
  // From inside a space it goes back to the list and opens the form there.
  expect(await ui.find({ key: 'space-notes' })).toBeDefined()
  expect((await ui.find({ key: 'form-title' }))?.props.placeholder).toBe('Space name')
  await ui.input({ key: 'form-title', text: 'Research log' })
  expect(w.runs).toEqual([[PAGES_BIN, 'mkspace', 'Research log', '--json']])
  expect(await ui.find({ type: 'Text', text: 'Research log' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No pages yet' })).toBeDefined()
  expect(w.toasts).toContain('Space Research log made')
  await ui.unmount()
})

test('the drafts strip counts drafts with no decision and opens the Workers pane', async ($, on) => {
  const w = world(on)
  const draft = (id: string, title: string, by: string, space: string, extra = '') => ({
    text: `---\ntitle: ${title}\nby: ${by}\nspace: ${space}\n${extra}id: ${id}\n---\n\nBody\n`,
    mtimeMs: 1,
  })
  w.files[`${SPACES}/.drafts/ob_aaaaaaaaaaaa.md`] = draft('ob_aaaaaaaaaaaa', 'Release notes', 'scribe', 'notes')
  w.files[`${SPACES}/.drafts/ob_bbbbbbbbbbbb.md`] = draft('ob_bbbbbbbbbbbb', 'Tone', 'scout', 'memory', 'page: tone\n')
  w.files[`${SPACES}/.drafts/ob_cccccccccccc.md`] = draft('ob_cccccccccccc', 'Declined one', 'scribe', 'notes')
  w.files[`${SPACES}/.drafts/.published/ob_dddddddddddd.json`] = { text: '{}', mtimeMs: 1 }
  w.files[`${SPACES}/.drafts/notes.txt`] = { text: 'x', mtimeMs: 1 }
  w.files[`${CALL}/outbox/scribe.decisions.jsonl`] = {
    text: `${JSON.stringify({ id: 'ob_cccccccccccc', decision: 'declined', at: 'x' })}\nnot json\n`,
    mtimeMs: 1,
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: '2 drafts awaiting review' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'needs your yes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Release notes · Scribe · Notes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Tone · Scout · Memory (revision)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Declined one/ })).toBeUndefined()

  await ui.press({ key: 'review-drafts' })
  expect(w.writes).toEqual([{ path: `${CALL}/open-workers`, text: `${JSON.stringify({ at: Date.parse('2026-11-01T12:00:00.000Z'), outbox: 'scribe' })}\n` }])

  // Inside a space the strip shows that space's drafts only.
  await ui.press({ key: 'open-space-memory' })
  expect(await ui.find({ type: 'Text', text: '1 draft awaiting review' })).toBeDefined()
  await ui.press({ key: 'back-spaces' })
  await ui.press({ key: 'open-space-launch' })
  expect(await ui.find({ key: 'drafts' })).toBeUndefined()
  await ui.unmount()
})

test('a missing spaces folder draws the empty list with the New space button', async ($, on) => {
  world(on, {})
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '0 spaces' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No spaces yet' })).toBeDefined()
  expect(await ui.find({ key: 'new-space' })).toBeDefined()
  await ui.unmount()
})

test('a symlinked folder is not listed as a space', async ($, on) => {
  const w = world(on)
  w.links.add(`${SPACES}/launch`)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'space-launch' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '2 spaces' })).toBeDefined()
  await ui.unmount()
})
