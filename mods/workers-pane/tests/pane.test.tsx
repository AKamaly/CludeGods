import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'workers-pane',
  component: 'Pane',
  requestId: 'workers',
  props: {
    title: 'Workers',
    isFocused: false,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = 1_000_000_000
const HOME = '/home/tester'
const CALL = `${HOME}/.voicemode/call`
const PROJECTS = `${HOME}/.claude/projects`
const PROJ = `${PROJECTS}/-home-tester-work`
const PAGES = `${HOME}/.claude/skills/gods/bin/pages`
const AMBER = '#b7791f'
// Each god's accent (register.tsx GOD_ACCENT): a worker's colour in the pane.
const SCRIBE = '#3b82f6'
const RESEARCH = '#9061f9'
const SALES_GOD = '#ea580c'
const HERALD = '#b47a06'
const ISO = (ms: number) => new Date(ms).toISOString()

// `version` and each worker's model and effort are keys the pane does not use: every
// rewrite must keep them.
const REGISTRY = {
  version: 2,
  workers: [
    { key: 'quick', name: 'Quick', role: 'Lookups, opening things, short tasks', model: 'claude-haiku-5-5', effort: 'low',
      session: 'local_quick-1', transcript: 'quick.jsonl', avatar: 'blue' },
    { key: 'work', name: 'Work', role: 'Drafts and summaries', model: 'claude-sonnet-5-5', effort: 'medium',
      session: 'local_work-2', transcript: 'work.jsonl', avatar: 'violet' },
    { key: 'deep', name: 'Deep', role: 'Strategy, research, code', model: 'claude-opus-5-5', effort: 'high',
      session: 'local_deep-3', transcript: 'deep.jsonl', avatar: 'orange' },
    { key: 'scout', name: 'Scout', role: 'Fresh one', model: 'claude-haiku-5-5', session: 'local_scout-4', avatar: 'rose' },
  ],
}

type RunResult = { exitCode: number; stdout?: string; stderr?: string }
type World = {
  files: Map<string, string>
  mtimes: Map<string, number>
  dirs: Map<string, { name: string; kind: 'file' | 'dir' }[]>
  writes: { path: string; text: string }[]
  runs: string[][]
  sends: { to: string; text: string }[]
  toasts: string[]
  prompts: string[]
  deliver: boolean
  run?: (argv: string[]) => RunResult | undefined
}

// A home folder in memory: reads see earlier writes, stats answer the files and
// transcripts there, and every run, send, toast and prompt is recorded.
function world(on: On, registry: unknown = REGISTRY, extra: Record<string, string> = {}): World {
  const w: World = {
    files: new Map([[`${CALL}/workers.json`, JSON.stringify(registry)], ...Object.entries(extra)]),
    mtimes: new Map([
      [`${PROJ}/quick.jsonl`, NOW - 2_000],
      [`${PROJ}/work.jsonl`, NOW - 180_000],
      [`${PROJ}/deep.jsonl`, NOW - 180_000],
      [`${PROJ}/sales.jsonl`, NOW - 180_000],
    ]),
    dirs: new Map([[PROJECTS, [{ name: '-home-tester-other', kind: 'dir' }, { name: '-home-tester-work', kind: 'dir' }]]]),
    writes: [],
    runs: [],
    sends: [],
    toasts: [],
    prompts: [],
    deliver: true,
  }
  mock.env(on, { HOME })
  on('clock.now', () => ({ value: NOW }))
  on('clock.after', () => ({ value: undefined })) // the clock stays at NOW, so an armed Delete stays armed
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    w.writes.push({ path: e.path, text: e.text })
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const m = w.mtimes.get(e.path)
    if (m !== undefined) return { value: { kind: 'file', size: 1, mtimeMs: m, isLink: false } }
    if (w.files.has(e.path)) return { value: { kind: 'file', size: 1, mtimeMs: NOW - 600_000, isLink: false } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', (_, e) => {
    const entries = w.dirs.get(e.path)
    if (!entries) return { deny: `ENOENT ${e.path}` }
    return { value: entries.map(x => ({ ...x, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    const r = w.run?.(argv) ?? { exitCode: 0 }
    return { value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', (_, e) => {
    w.sends.push({ to: String(e.to), text: e.text })
    return w.deliver ? { isDelivered: true } : { isDelivered: false, reason: 'not running' }
  })
  on('prompt.fill', (_, e) => {
    w.prompts.push(e.text)
    return { isFilled: true }
  })
  return w
}

const registryOf = (w: World) => JSON.parse(w.files.get(`${CALL}/workers.json`) ?? '{}') as {
  version?: number
  workers: Record<string, unknown>[]
}

test('cards follow the film: header, god, name, status, role, the Ask field and the footer chips', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: '· 4 standing chats' })).toBeDefined()
  expect((await ui.find({ key: 'new-worker' }))?.props.label).toBe('+ New worker')
  expect((await ui.find({ key: 'card-work' }))?.props.width).toBe('100%')
  // The god comes from v1 avatar colours: blue scribe, violet research, orange and rose sales.
  const avatars = (await ui.findAll({ type: 'Svg' })).filter(s => String(s.props.alt).includes(', '))
  expect(avatars.map(s => s.props.alt)).toEqual(['Quick, Scribe', 'Work, Research', 'Deep, Sales', 'Scout, Sales'])
  // Animated while working (a SMIL god needs the interactive frame), still otherwise.
  expect(avatars.map(s => s.props.isInteractive)).toEqual([true, undefined, undefined, undefined])
  expect(avatars[0]?.props.width).toBe(40)
  expect(String(avatars[0]?.props.source)).toMatch(/^<svg/)
  // Status: green Working, dim Idle with its age, blue New for a chat not yet started.
  const working = await ui.findAll({ type: 'Text', text: '● Working' })
  expect(working).toHaveLength(1)
  expect(working[0]?.props.color).toBe('#2f8f5b')
  const idle = await ui.findAll({ type: 'Text', text: '○ Idle · 3m ago' })
  expect(idle).toHaveLength(2)
  expect(idle[0]?.props.dimColor).toBe(true)
  expect(await ui.findAll({ type: 'Text', text: '✦ New' })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /Lookups, opening things/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Input' })).toHaveLength(4)
  expect((await ui.find({ key: 'task-deep' }))?.props.placeholder).toBe('Ask Deep…')
  // The footer: hours chip, then (no charter, so no Run now) Outbox and Open. The
  // first worker is the selected one: under its footer, the tabs, Overview picked.
  const keysOf = async (k: string) =>
    (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(x => x?.endsWith(`-${k}`) && !/^(name|role|status)-/.test(x ?? ''))
  expect(await keysOf('quick')).toEqual([
    'hours-quick', 'feed-quick', 'open-quick', 'overview-quick', 'outboxtab-quick', 'activity-quick', 'settings-quick',
    'talk-quick',
  ])
  expect((await ui.find({ key: 'talk-quick' }))?.props.label).toBe('Talk to Quick')
  expect((await ui.find({ key: 'overview-quick' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'activity-quick' }))?.props.dimColor).toBe(true)
  // Every other card is the film's card alone: no tabs, no Delete on its face.
  expect(await keysOf('deep')).toEqual(['hours-deep', 'feed-deep', 'open-deep'])
  expect(await ui.find({ key: 'delete-deep' })).toBeUndefined()
  expect((await ui.find({ key: 'hours-quick' }))?.props.label).toBe('When you ask')
  expect((await ui.find({ key: 'feed-quick' }))?.props.label).toBe('Outbox')
  // Line icons, not emoji: a clock, an inbox and an external-link glyph on every card.
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.filter(s => s.props.alt === 'clock')).toHaveLength(4)
  expect(svgs.filter(s => s.props.alt === 'inbox')).toHaveLength(4)
  expect(svgs.filter(s => s.props.alt === 'external')).toHaveLength(4)
  expect(String(svgs.find(s => s.props.alt === 'clock')?.props.source)).toContain('stroke-width')
  // No model anywhere: it is picked inside the chat. No badge with nothing waiting.
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /Haiku|Sonnet|Opus|5\.5/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /drafts? $/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No tasks yet|^Last:/ })).toBeUndefined()
  await ui.unmount()
})

test('the terminal draws the same cards with no Svg', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ key: 'name-quick' })).toBeDefined()
  expect((await ui.find({ key: 'feed-deep' }))?.props.label).toBe('Outbox')
  await ui.unmount()
})

test('each Input is the only submit control: no separate Send or Create Buttons', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'nw-blank' })

  const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label ?? b.text))
  expect(labels.filter(l => /^(send|create)$/i.test(l))).toEqual([])
  expect((await ui.findAll({ type: 'Input' })).map(i => i.props.submitLabel)).toEqual([
    'create', 'send', 'send', 'send', 'send',
  ])
  expect((await ui.find({ key: 'nw-entry' }))?.props.placeholder).toBe('Name, then what it does (optional)')
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /1 to 24 letters/ })).toBeUndefined()
  await ui.unmount()
})

test("the name selects the card and Open opens the worker chat, both in its god's colour", async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // With none picked yet, the first card is the selected one.
  expect((await ui.find({ key: 'card-quick' }))?.props.borderColor).toBe(SCRIBE)
  expect((await ui.find({ key: 'card-work' }))?.props.borderColor).toBeUndefined()

  await ui.press({ key: 'name-work' })
  const work = await ui.find({ key: 'card-work' })
  expect(work?.props.borderColor).toBe(RESEARCH)
  expect(work?.props.borderDimColor).toBe(false)
  expect(work?.props.backgroundColor).toBe(`${RESEARCH}0d`)
  expect((await ui.find({ key: 'card-quick' }))?.props.borderDimColor).toBe(true)
  // The header's dot follows the selected worker.
  const dot = async () => (await ui.find({ type: 'Text', text: /^●$/ }))?.props.color
  expect(await dot()).toBe(RESEARCH)

  await ui.press({ key: 'open-deep' })
  expect((await ui.find({ key: 'card-deep' }))?.props.borderColor).toBe(SALES_GOD)
  expect((await ui.find({ key: 'card-work' }))?.props.borderColor).toBeUndefined()
  expect(await dot()).toBe(SALES_GOD)
  // Pressing a name selects without opening its chat; only Open opens it.
  expect(w.runs).toEqual([['open', 'claude://claude.ai/epitaxy/local_deep-3']])

  // Its role line and its status select a card too, and exactly one card is highlighted.
  await ui.press({ key: 'role-quick' })
  expect((await ui.find({ key: 'card-quick' }))?.props.borderColor).toBe(SCRIBE)
  expect((await ui.find({ key: 'card-deep' }))?.props.borderColor).toBeUndefined()
  await ui.press({ key: 'status-work' })
  expect((await ui.find({ key: 'card-work' }))?.props.borderColor).toBe(RESEARCH)
  expect((await ui.find({ key: 'card-quick' }))?.props.borderColor).toBeUndefined()
  // Hovering an unselected card never borrows a worker's colour, so it can't look selected.
  expect((await ui.find({ key: 'card-quick' }))?.props.hover?.borderColor).toBeUndefined()
  await ui.unmount()
})

test('Delete, in Settings, needs two presses, then writes the request and drops only that entry, keeping every other key', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The hours chip selects the worker and opens its Settings, where Delete lives.
  await ui.press({ key: 'hours-deep' })
  expect((await ui.find({ key: 'delete-deep' }))?.props.label).toBe('Delete')
  await ui.press({ key: 'delete-deep' })
  expect(w.writes).toHaveLength(0)
  expect((await ui.find({ key: 'delete-deep' }))?.props.label).toBe('Confirm delete')
  expect(await ui.find({ type: 'Text', text: 'Press again to delete it.' })).toBeDefined()
  expect(await ui.find({ key: 'delete-work' })).toBeUndefined()

  await ui.press({ key: 'delete-deep' })
  expect(w.writes).toHaveLength(2)
  expect(w.writes[0]?.path).toMatch(new RegExp(`^${CALL}/requests/[^/]+\\.json$`))
  expect(JSON.parse(w.writes[0]?.text ?? '{}')).toEqual({ type: 'delete', key: 'deep', session: 'local_deep-3', at: NOW })
  expect(w.writes[1]?.path).toBe(`${CALL}/workers.json`)
  const kept = registryOf(w)
  expect(kept.version).toBe(2)
  expect(kept.workers.map(x => x.key)).toEqual(['quick', 'work', 'scout'])
  expect(kept.workers[0]).toEqual(REGISTRY.workers[0])
  expect(await ui.find({ key: 'delete-deep' })).toBeUndefined()
  expect(await ui.find({ key: 'task-deep' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '· 3 standing chats' })).toBeDefined()
  await ui.unmount()
})

test('the New worker form picks one of six gods as a radio, Scribe first, the form in the pick\'s colour', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'nw-blank' })

  const tiles = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('nw-god-'))
  expect(tiles.map(b => b.key)).toEqual([
    'nw-god-colleague', 'nw-god-research', 'nw-god-scribe', 'nw-god-scout', 'nw-god-sales', 'nw-god-herald',
  ])
  expect(tiles.map(b => b.props.label)).toEqual(['Colleague', 'Research', 'Scribe', 'Scout', 'Sales', 'Herald'])
  // Each tile is the god's own drawing, not an emoji swatch.
  expect((await ui.findAll({ type: 'Svg' })).filter(s => s.props.alt === 'Herald')).toHaveLength(1)
  // Exactly one tile picked: its ring in the god's colour, its label at full strength.
  const ringed = async () =>
    (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('nw-god-tile-') && b.props.borderColor !== undefined).map(b => b.key)
  expect(await ringed()).toEqual(['nw-god-tile-scribe'])
  expect((await ui.find({ key: 'nw-god-tile-scribe' }))?.props.borderColor).toBe(SCRIBE)
  expect((await ui.find({ key: 'nw-god-scribe' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'nw-god-herald' }))?.props.dimColor).toBe(true)

  await ui.press({ key: 'nw-god-herald' })
  expect(await ringed()).toEqual(['nw-god-tile-herald'])
  expect((await ui.find({ key: 'nw-god-herald' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'nw-god-scribe' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ key: 'nw-god-tile-herald' }))?.props.borderColor).toBe(HERALD)
  expect((await ui.find({ key: 'new-form' }))?.props.borderColor).toBe(HERALD)
  // New workers start with full access unless config.json says otherwise.
  expect(await ui.find({ type: 'Text', text: /Voice bm_george · can do anything/ })).toBeDefined()
  await ui.unmount()
})

test('Enter splits the one field at the first comma and puts the create request in the prompt box', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'nw-blank' })
  await ui.press({ key: 'nw-god-herald' })
  await ui.input({ key: 'nw-entry', text: 'Herald, announcements', kind: 'change' })
  await ui.input({ key: 'nw-entry', text: 'Herald, announcements' })
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'nw-blank' })
  await ui.input({ key: 'nw-entry', text: 'Scribe 2, drafts, posts; comments' })
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'nw-blank' })
  await ui.input({ key: 'nw-entry', text: '  Solo  ' })

  // The v1 fields lead, so an older call session still reads the first line; the key
  // names the entry the pane has already written.
  expect(w.prompts.map(t => t.split('\n')[0])).toEqual([
    'Create worker: name=Herald; role=announcements; avatar=gold; god=herald; voice=bm_george; tools=full; key=herald',
    'Create worker: name=Scribe 2; role=drafts, posts, comments; avatar=gold; god=herald; voice=bm_george; tools=full; key=scribe-2',
    'Create worker: name=Solo; role=; avatar=gold; god=herald; voice=bm_george; tools=full; key=solo',
  ])
  expect(await ui.find({ key: 'nw-entry' })).toBeUndefined()
  // Each one is in the registry at once, every other entry and key kept.
  const reg = registryOf(w)
  expect(reg.version).toBe(2)
  expect(reg.workers.slice(0, 4)).toEqual(REGISTRY.workers)
  expect(reg.workers.slice(4)).toEqual([
    { key: 'herald', name: 'Herald', role: 'announcements', god: 'herald', avatar: 'gold', voice: 'bm_george', tools: 'full', created: ISO(NOW) },
    { key: 'scribe-2', name: 'Scribe 2', role: 'drafts, posts; comments', god: 'herald', avatar: 'gold', voice: 'bm_george', tools: 'full', created: ISO(NOW) },
    { key: 'solo', name: 'Solo', god: 'herald', avatar: 'gold', voice: 'bm_george', tools: 'full', created: ISO(NOW) },
  ])
  await ui.unmount()
})

test('an invalid name does not submit', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'nw-blank' })
  await ui.input({ key: 'nw-entry', text: 'bad;name!', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /1 to 24 letters/ })).toBeUndefined()
  await ui.input({ key: 'nw-entry', text: 'bad;name!' })
  expect(await ui.find({ type: 'Text', text: /1 to 24 letters/ })).toBeDefined()
  await ui.input({ key: 'nw-entry', text: '   ' })
  await ui.input({ key: 'nw-entry', text: ', only a role' })
  await ui.input({ key: 'nw-entry', text: 'A name far too long for it, sales' })
  await ui.input({ key: 'nw-entry', text: 'Abcdefghijklmnopqrstuvwxy' })

  expect(w.prompts).toHaveLength(0)
  await ui.input({ key: 'nw-entry', text: 'Fine, a role', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /1 to 24 letters/ })).toBeUndefined()
  await ui.press({ key: 'nw-cancel' })
  expect(await ui.find({ key: 'nw-entry' })).toBeUndefined()
  await ui.unmount()
})

test('Enter in a task box sends the task to that worker chat; a blank one is not sent', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'task-quick', text: 'Open the dashboard' })
  await ui.input({ key: 'task-deep', text: '   ' })

  expect(w.sends).toEqual([{ to: 'local_quick-1', text: 'Open the dashboard' }])
  expect(await ui.find({ type: 'Text', text: /^Last: Open the dashboard · just now/ })).toBeDefined()
  await ui.unmount()
})

test('a missing registry opens on Welcome, with the New worker button', async ($, on) => {
  mock.env(on, { HOME })
  on('clock.now', () => ({ value: NOW }))
  on('fs.read', (_, e) => ({ deny: `ENOENT ${e.path}` }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Only the colleague god heads it; no worker icons.
  expect((await ui.findAll({ type: 'Svg' })).map(s => s.props.alt)).toEqual(['CludeGods'])
  expect(await ui.find({ key: 'new-worker' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Welcome to CludeGods' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No workers.json yet' })).toBeUndefined()
  await ui.unmount()
})

const FOOTER = {
  plugin: 'workers-pane',
  component: 'SessionMode',
  props: { modes: ['Bypass permissions'] },
} as const

// Stands for the engine's own mode labels beneath the plugin.
function engineModes(on: On) {
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Bypass permissions</Text>
  })
}

test("the footer launcher sits left of Claude's own mode labels and opens the Workers pane", async ($, on) => {
  world(on)
  engineModes(on)
  const opens: unknown[] = []
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    opens.push({ ...e })
    return { value: { isPlaced: true } }
  })

  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await ui.find({ key: 'open-workers-band' }))?.props.label).toBe('Workers · 4')
  expect(await ui.find({ type: 'Text', text: /Bypass permissions/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)

  await ui.press({ key: 'open-workers-band' })
  expect(opens).toEqual([expect.objectContaining({ id: 'workers', title: 'Workers', columns: 46, focus: true })])
  await ui.unmount()
})

test('the footer launcher reads "Workers" with no workers and keeps the mode labels', async ($, on) => {
  mock.env(on, { HOME })
  on('clock.now', () => ({ value: NOW }))
  on('fs.read', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('ui.panes', () => ({ value: [] }))
  engineModes(on)

  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await ui.find({ key: 'open-workers-band' }))?.props.label).toBe('Workers')
  expect(await ui.find({ type: 'Text', text: /Bypass permissions/ })).toBeDefined()
  await ui.unmount()
})

// A proactive worker: a charter, a weekday schedule, a key the pane does not know
// (`outbox`), and an outbox of two lines from before ids (a draft and a note), a v2
// draft and a v2 page, then a broken line.
const CHARTER = 'You are Sales, the standing sales worker. Drafts only.\nMore rules here.'
const SALES = {
  workers: [
    { key: 'sales', name: 'Sales', role: 'Follow-ups', model: 'claude-sonnet-5-5', session: 'local_sales-9',
      transcript: 'sales.jsonl', avatar: 'blue', charter: CHARTER,
      schedule: { days: 'mon-fri', time: '09:00', tz: 'Asia/Riyadh' }, outbox: '~/.voicemode/call/outbox/sales.jsonl' },
  ],
}
const LEGACY_DRAFT = 'ob_36294061541d' // sha1("1970-01-12T12:46:40.000Z" + "Reply to Jordan"), first 12 hex
const LEGACY_NOTE = 'ob_f89dc1496b82'
const OUTBOX = [
  { at: ISO(NOW - 3_600_000), kind: 'draft', title: 'Reply to Jordan', body: 'Hi Jordan,\nQuick one on the bench call.\nThird line', to: 'jordan@example.com', needs_approval: true },
  { at: ISO(NOW - 1_800_000), kind: 'note', title: 'Repo went quiet', body: 'No reply since 10-20.', needs_approval: false },
  { id: 'ob_aaaaaaaaaaaa', at: ISO(NOW - 600_000), kind: 'draft', title: 'Nudge to Sam', body: 'Hi Sam,\nSeat count?', to: 'sam@example.com', needs_approval: true },
  { id: 'ob_bbbbbbbbbbbb', at: ISO(NOW - 60_000), kind: 'page', title: 'Release notes v2.3', body: 'What changed', needs_approval: true,
    space: 'notes', draft_path: '~/.voicemode/call/spaces/.drafts/ob_bbbbbbbbbbbb.md' },
].map(o => JSON.stringify(o)).join('\n') + '\nnot json\n'
const DECISIONS = `${CALL}/outbox/sales.decisions.jsonl`

function salesWorld(on: On, extra: Record<string, string> = {}) {
  return world(on, SALES, {
    [`${CALL}/outbox/sales.jsonl`]: OUTBOX,
    [`${CALL}/outbox/.seen.json`]: JSON.stringify({ sales: NOW - 2_000_000 }),
    ...extra,
  })
}

test('a proactive card: a badge for what waits, the hours chip, Run now, Outbox · N, Open, never the charter', async ($, on) => {
  salesWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Two drafts and a page wait for a yes; the note does not count.
  // The badge in the worker's colour (blue avatar: Scribe), on a tint of it.
  const tag = await ui.find({ type: 'Text', text: ' 3 drafts ' })
  expect(tag).toBeDefined()
  expect(tag?.props.color).toBe(SCRIBE)
  expect(tag?.props.backgroundColor).toBe(`${SCRIBE}24`)
  expect((await ui.find({ key: 'hours-sales' }))?.props.label).toBe('Mon to Fri · 9:00')
  expect((await ui.find({ key: 'feed-sales' }))?.props.label).toBe('Needs you · 3')
  expect(await ui.find({ type: 'Text', text: 'Follow-ups' })).toBeDefined()
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => /-sales$/.test(k ?? '') && !/^(name|role|status)-/.test(k ?? ''))
  expect(keys).toEqual([
    'hours-sales', 'run-sales', 'feed-sales', 'open-sales', 'overview-sales', 'outboxtab-sales', 'activity-sales', 'settings-sales',
    'talk-sales',
  ])
  // The tab reads the count; Overview says when it wakes, in words.
  expect((await ui.find({ key: 'outboxtab-sales' }))?.props.label).toBe('Outbox · 3')
  expect(await ui.find({ type: 'Text', text: 'Mon to Fri at 9:00' })).toBeDefined()
  expect((await ui.find({ key: 'hours-chip-sales' }))?.props.backgroundColor).toBe(`${SCRIBE}1f`)
  await ui.press({ key: 'settings-sales' })
  const del = await ui.find({ key: 'delete-sales' })
  expect(del?.props.plain).toBe(true)
  expect(del?.props.dimColor).toBeUndefined()
  await ui.press({ key: 'overview-sales' })
  // The charter is the worker's instructions: never on the card.
  expect(await ui.find({ type: 'Text', text: /You are Sales|More rules here/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Riyadh/ })).toBeUndefined()
  expect(await ui.find({ key: 'outbox-sales' })).toBeUndefined()
  await ui.unmount()
})

test('an item with a decision on file leaves the count; nothing waiting means no badge', async ($, on) => {
  salesWorld(on, {
    [DECISIONS]: `${JSON.stringify({ id: LEGACY_DRAFT, decision: 'approved', at: ISO(NOW) })}\n`,
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: ' 2 drafts ' })).toBeDefined()
  expect((await ui.find({ key: 'feed-sales' }))?.props.label).toBe('Needs you · 2')
  await ui.unmount()
})

test('Run now sends the charter wake to that worker chat', async ($, on) => {
  const w = salesWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'run-sales' })

  expect(w.sends).toHaveLength(1)
  expect(w.sends[0]?.to).toBe('local_sales-9')
  expect(w.sends[0]?.text).toMatch(/^Run now, from the Workers pane: run your charter now/)
  expect(w.sends[0]?.text).toContain('~/.voicemode/call/outbox/sales.jsonl')
  expect(w.sends[0]?.text).toContain('More rules here.')
  expect(await ui.find({ type: 'Text', text: /^Last: Run its instructions now/ })).toBeDefined()
  await ui.unmount()
})

test('the outbox lists items newest first by id: needs your yes in amber, buttons only on what waits', async ($, on) => {
  const w = salesWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'feed-sales' })

  const rows = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('item-sales-'))
  expect(rows.map(b => b.key)).toEqual([
    'item-sales-ob_bbbbbbbbbbbb', 'item-sales-ob_aaaaaaaaaaaa', `item-sales-${LEGACY_NOTE}`, `item-sales-${LEGACY_DRAFT}`,
  ])
  const asks = await ui.findAll({ type: 'Text', text: 'needs your yes' })
  expect(asks).toHaveLength(3)
  expect(asks.every(t => t.props.color === AMBER)).toBe(true)
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => /^(approve|decline)-/.test(k))
  expect(buttons).toEqual([
    'decline-sales-ob_bbbbbbbbbbbb', 'approve-sales-ob_bbbbbbbbbbbb',
    'decline-sales-ob_aaaaaaaaaaaa', 'approve-sales-ob_aaaaaaaaaaaa',
    `decline-sales-${LEGACY_DRAFT}`, `approve-sales-${LEGACY_DRAFT}`,
  ])
  expect((await ui.find({ key: `approve-sales-${LEGACY_DRAFT}` }))?.props.variant).toBe('primary')
  // The note has no buttons; each row has a line file icon.
  expect(await ui.find({ key: `approve-sales-${LEGACY_NOTE}` })).toBeUndefined()
  const glyphs = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect(glyphs.filter(a => a === 'file' || a === 'fileText' || a === 'note')).toHaveLength(4)
  expect(await ui.find({ type: 'Text', text: /to jordan@example\.com/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Quick one on the bench call.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Third line' })).toBeUndefined()
  expect((await ui.find({ key: 'feed-sales' }))?.props.label).toBe('Hide outbox')
  // Opening it marks what is there seen; nothing is sent by looking.
  expect(w.writes).toEqual([{ path: `${CALL}/outbox/.seen.json`, text: JSON.stringify({ sales: NOW - 60_000 }) }])
  expect(w.sends).toHaveLength(0)

  await ui.press({ key: 'feed-open-sales' })
  expect(w.runs).toEqual([['open', 'claude://claude.ai/epitaxy/local_sales-9']])
  await ui.press({ key: 'feed-sales' })
  expect(await ui.find({ key: 'outbox-sales' })).toBeUndefined()
  await ui.unmount()
})

test('Approve on a draft tells the worker to go ahead, then records the decision', async ($, on) => {
  const w = salesWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'feed-sales' })
  await ui.press({ key: `approve-sales-${LEGACY_DRAFT}` })

  expect(w.sends).toEqual([{
    to: 'local_sales-9',
    text: `Approved in the Workers pane: Reply to Jordan (${LEGACY_DRAFT}). Go ahead with exactly what the draft says, then report back.`,
  }])
  expect(w.files.get(DECISIONS)).toBe(`${JSON.stringify({ id: LEGACY_DRAFT, decision: 'approved', at: ISO(NOW) })}\n`)
  expect(await ui.find({ key: `approve-sales-${LEGACY_DRAFT}` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '✓ Approved' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 2 drafts ' })).toBeDefined()
  expect(w.toasts).toContain('Approved: Reply to Jordan')
  expect(await ui.find({ type: 'Text', text: /^Last: Approved: Reply to Jordan/ })).toBeDefined()

  // A second decision appends a line; the first stays.
  await ui.press({ key: 'decline-sales-ob_aaaaaaaaaaaa' })
  expect(w.files.get(DECISIONS)?.trim().split('\n').map(l => JSON.parse(l).id)).toEqual([LEGACY_DRAFT, 'ob_aaaaaaaaaaaa'])
  await ui.unmount()
})

test('an Approve the chat does not receive records nothing, so it still waits', async ($, on) => {
  const w = salesWorld(on)
  w.deliver = false
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'feed-sales' })
  await ui.press({ key: 'approve-sales-ob_aaaaaaaaaaaa' })

  expect(w.sends).toHaveLength(1)
  expect(w.files.has(DECISIONS)).toBe(false)
  expect(await ui.find({ key: 'approve-sales-ob_aaaaaaaaaaaa' })).toBeDefined()
  expect(w.toasts.some(t => /didn't get the approval, so it still waits: not running/.test(t))).toBe(true)
  await ui.unmount()
})

test('Decline records the decision and tells the worker not to do it', async ($, on) => {
  const w = salesWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'feed-sales' })
  await ui.press({ key: 'decline-sales-ob_aaaaaaaaaaaa' })

  expect(w.sends).toEqual([{ to: 'local_sales-9', text: "Declined: Nudge to Sam (ob_aaaaaaaaaaaa). Don't do it." }])
  expect(JSON.parse(w.files.get(DECISIONS) ?? '{}')).toEqual({ id: 'ob_aaaaaaaaaaaa', decision: 'declined', at: ISO(NOW) })
  expect(await ui.find({ key: 'decline-sales-ob_aaaaaaaaaaaa' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Declined' })).toBeDefined()
  await ui.unmount()
})

test('Approve on a page publishes it with bin/pages, then tells the worker it was saved', async ($, on) => {
  const w = salesWorld(on)
  w.mtimes.set(PAGES, NOW - 1_000_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'feed-sales' })
  expect(await ui.find({ type: 'Text', text: /page in notes/ })).toBeDefined()
  await ui.press({ key: 'approve-sales-ob_bbbbbbbbbbbb' })

  expect(w.runs.filter(r => r[0] === PAGES)).toEqual([
    [PAGES, 'publish', `${CALL}/spaces/.drafts/ob_bbbbbbbbbbbb.md`, '--space', 'notes', '--json'],
  ])
  expect(w.sends).toEqual([{
    to: 'local_sales-9',
    text: 'Approved in the Workers pane: Release notes v2.3 (ob_bbbbbbbbbbbb). It is saved as a page in notes.',
  }])
  expect(JSON.parse(w.files.get(DECISIONS) ?? '{}').decision).toBe('approved')
  expect(w.toasts).toContain('Saved "Release notes v2.3" in notes')
  await ui.unmount()
})

test('Approve on a page shows why when bin/pages is missing, the page moved on, or the space is closed', async ($, on) => {
  const w = salesWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'feed-sales' })
  await ui.press({ key: 'approve-sales-ob_bbbbbbbbbbbb' })
  expect(w.toasts.some(t => /bin\/pages is not installed yet/.test(t))).toBe(true)
  expect(w.runs.filter(r => r[0] === PAGES)).toHaveLength(0)

  w.mtimes.set(PAGES, NOW - 1_000_000)
  let code = 3
  let stderr = 'pages: notes/release-notes changed after this draft was made. Ask for a fresh draft.'
  w.run = argv => (argv[0] === PAGES ? { exitCode: code, stderr } : undefined)
  await ui.press({ key: 'approve-sales-ob_bbbbbbbbbbbb' })
  expect(w.toasts).toContain('Page changed since this draft. Ask for a fresh one.')

  code = 4
  stderr = "pages: Sales may not write to 'notes' (its spaces: memory). The owner adds it under \"spaces\" in workers.json."
  await ui.press({ key: 'approve-sales-ob_bbbbbbbbbbbb' })
  expect(w.toasts).toContain("Sales may not write to 'notes' (its spaces: memory). The owner adds it under \"spaces\" in workers.json.")

  code = 1
  stderr = 'pages: No draft ob_bbbbbbbbbbbb'
  await ui.press({ key: 'approve-sales-ob_bbbbbbbbbbbb' })
  expect(w.toasts).toContain('Couldn\'t save "Release notes v2.3": No draft ob_bbbbbbbbbbbb')

  // None of them is a decision: the page still waits for a yes.
  expect(w.sends).toHaveLength(0)
  expect(w.files.has(DECISIONS)).toBe(false)
  expect(await ui.find({ key: 'approve-sales-ob_bbbbbbbbbbbb' })).toBeDefined()

  // Publishing a draft twice answers "already": that counts as saved.
  code = 0
  w.run = argv => (argv[0] === PAGES ? { exitCode: 0, stdout: JSON.stringify({ space: 'notes', page: 'release-notes', already: true }) } : undefined)
  await ui.press({ key: 'approve-sales-ob_bbbbbbbbbbbb' })
  expect(JSON.parse(w.files.get(DECISIONS) ?? '{}').decision).toBe('approved')
  await ui.unmount()
})

// The space folders the settings list: one with a space.json, the drafts folder, and
// a folder that is no space.
function withSpaces(w: World) {
  w.dirs.set(`${CALL}/spaces`, [
    { name: '.drafts', kind: 'dir' },
    { name: 'notes', kind: 'dir' },
    { name: 'launch', kind: 'dir' },
    { name: 'stray', kind: 'dir' },
  ])
  w.files.set(`${CALL}/spaces/notes/space.json`, JSON.stringify({ name: 'Notes', created: ISO(NOW) }))
  w.files.set(`${CALL}/spaces/launch/space.json`, JSON.stringify({ name: 'Launch plan', created: ISO(NOW) }))
}

test('Settings show the defaults a v1 worker gets: its god from the avatar, that god\'s voice, full tools', async ($, on) => {
  const w = salesWorld(on)
  withSpaces(w)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The hours chip opens the settings too.
  await ui.press({ key: 'hours-sales' })

  expect(await ui.find({ type: 'Text', text: 'Make Sales yours' })).toBeDefined()
  expect((await ui.find({ key: 'rename-sales' }))?.props.value).toBe('Sales')
  // Blue: Scribe, the one tile ringed in Scribe's colour.
  expect((await ui.find({ key: 'god-sales-scribe' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'god-sales-tile-scribe' }))?.props.borderColor).toBe(SCRIBE)
  expect((await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('god-sales-tile-') && b.props.borderColor).length).toBe(1)
  expect((await ui.find({ key: 'voice-sales' }))?.props.value).toBe('bf_emma')
  const voices = ((await ui.find({ key: 'voice-sales' }))?.props.options as { value: string }[]).map(o => o.value)
  expect(voices).toEqual(['af_heart', 'af_nicole', 'af_bella', 'af_sky', 'bf_emma', 'bf_isabella', 'am_adam', 'am_michael', 'bm_george', 'bm_lewis'])
  expect((await ui.find({ key: 'tools-sales-tile-full' }))?.props.borderColor).toBe(SCRIBE)
  expect((await ui.find({ key: 'tools-sales-full' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'tools-sales-drafts' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ key: 'mode-sales' }))?.props.value).toBe('daily')
  expect((await ui.find({ key: 'days-sales' }))?.props.value).toBe('mon-fri')
  expect((await ui.find({ key: 'time-sales' }))?.props.value).toBe('09:00')
  expect(await ui.find({ key: 'from-sales' })).toBeUndefined()
  // The Settings tab is the picked one.
  expect((await ui.find({ key: 'tabbox-settings-sales' }))?.props.borderColor).toBe(SCRIBE)
  expect((await ui.find({ key: 'pause-sales' }))?.props.label).toBe('Pause')
  // Spaces with a space.json, by name; neither the drafts folder nor a stray folder.
  // With no `spaces` key a worker may write to Notes alone, as bin/pages reads it.
  const spaces = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('space-sales-'))
  expect(spaces.map(b => [b.key, b.props.label])).toEqual([
    ['space-sales-launch', 'Launch plan'],
    ['space-sales-notes', '✓ Notes'],
  ])
  expect(await ui.find({ type: 'Text', text: 'Spaces it may write to: Notes, the default' })).toBeDefined()
  expect((await ui.find({ key: 'spaces-all-sales' }))?.props.label).toBe('All spaces')
  // Still nothing of the charter.
  expect(await ui.find({ type: 'Text', text: /You are Sales|More rules here/ })).toBeUndefined()
  await ui.unmount()
})

test('each setting is written into the registry entry, every other key kept', async ($, on) => {
  const w = salesWorld(on)
  withSpaces(w)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings-sales' })

  await ui.press({ key: 'god-sales-sales' })
  await ui.select({ key: 'voice-sales', value: 'am_michael' })
  await ui.press({ key: 'tools-sales-drafts' })
  await ui.press({ key: 'pause-sales' })
  await ui.select({ key: 'time-sales', value: '07:30' })
  await ui.press({ key: 'space-sales-launch' })
  await ui.input({ key: 'rename-sales', text: 'Sales Desk' })

  const entry = registryOf(w).workers[0] ?? {}
  expect(entry).toEqual({
    ...SALES.workers[0],
    name: 'Sales Desk',
    avatar: 'orange',
    god: 'sales',
    voice: 'am_michael',
    tools: 'drafts',
    paused: true,
    schedule: { days: 'mon-fri', time: '07:30', tz: 'Asia/Riyadh' },
    spaces: ['notes', 'launch'],
  })
  expect(entry.charter).toBe(CHARTER)
  expect(entry.outbox).toBe('~/.voicemode/call/outbox/sales.jsonl')
  // The card follows at once.
  expect((await ui.findAll({ type: 'Svg' })).filter(s => s.props.alt === 'Sales Desk, Sales')).toHaveLength(1)
  expect((await ui.find({ key: 'hours-sales' }))?.props.label).toBe('Paused')
  expect((await ui.find({ key: 'god-sales-sales' }))?.props.dimColor).toBe(false)
  // The card takes its new god's colour.
  expect((await ui.find({ key: 'card-sales' }))?.props.borderColor).toBe(SALES_GOD)
  expect((await ui.find({ key: 'tools-sales-tile-drafts' }))?.props.borderColor).toBe(SALES_GOD)
  expect((await ui.find({ key: 'space-sales-launch' }))?.props.label).toBe('✓ Launch plan')

  // All spaces is "*"; one turned off then keeps the others; All off is the default again.
  await ui.press({ key: 'spaces-all-sales' })
  expect(registryOf(w).workers[0]?.spaces).toBe('*')
  expect((await ui.find({ key: 'space-sales-launch' }))?.props.label).toBe('✓ Launch plan')
  await ui.press({ key: 'space-sales-launch' })
  expect(registryOf(w).workers[0]?.spaces).toEqual(['notes'])
  await ui.press({ key: 'spaces-all-sales' })
  await ui.press({ key: 'spaces-all-sales' })
  expect('spaces' in (registryOf(w).workers[0] ?? {})).toBe(false)

  // Notes off, then no schedule at all; a bad name is refused.
  await ui.press({ key: 'space-sales-notes' })
  await ui.press({ key: 'pause-sales' })
  await ui.select({ key: 'mode-sales', value: 'off' })
  await ui.input({ key: 'rename-sales', text: 'bad;name' })
  const after = registryOf(w).workers[0] ?? {}
  expect(after.spaces).toEqual([])
  expect(after.paused).toBe(false)
  expect('schedule' in after).toBe(false)
  expect(after.name).toBe('Sales Desk')
  expect(w.toasts).toContain('A name is 1 to 24 letters, digits or spaces')
  expect((await ui.find({ key: 'hours-sales' }))?.props.label).toBe('When you ask')
  expect(await ui.find({ key: 'time-sales' })).toBeUndefined()
  expect(await ui.find({ key: 'days-sales' })).toBeUndefined()
  expect((await ui.find({ key: 'mode-sales' }))?.props.value).toBe('off')

  // Done goes back to Overview.
  await ui.press({ key: 'settings-done-sales' })
  expect(await ui.find({ key: 'settings-panel-sales' })).toBeUndefined()
  expect((await ui.find({ key: 'overview-sales' }))?.props.dimColor).toBe(false)
  await ui.unmount()
})

test('picking hours for a worker with none gives it a schedule in the zone the other workers use', async ($, on) => {
  const w = world(on, {
    workers: [
      { key: 'a', name: 'Alpha', session: 'local_a', schedule: { days: 'daily', time: '08:00', tz: 'Europe/Berlin' } },
      { key: 'b', name: 'Beta', session: 'local_b', god: 'scout', tools: ['Read', 'Grep'] },
    ],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'hours-b' })
  expect((await ui.find({ key: 'mode-b' }))?.props.value).toBe('off')
  expect(await ui.find({ key: 'days-b' })).toBeUndefined()
  expect((await ui.find({ key: 'voice-b' }))?.props.value).toBe('am_adam') // Scout's voice
  expect((await ui.find({ key: 'tools-b-tile-custom' }))?.props.borderColor).toBe('#578f0e')
  expect(await ui.find({ type: 'Text', text: 'Only: Read, Grep' })).toBeDefined()

  await ui.select({ key: 'mode-b', value: 'daily' })
  expect(registryOf(w).workers[1]?.schedule).toEqual({ days: 'mon-fri', time: '09:00', tz: 'Europe/Berlin' })
  await ui.select({ key: 'days-b', value: 'sun-thu' })
  expect(registryOf(w).workers[1]?.schedule).toEqual({ days: 'sun-thu', time: '09:00', tz: 'Europe/Berlin' })
  // Picking the custom row again changes nothing, and neither does the picked preset.
  const before = w.writes.length
  await ui.press({ key: 'tools-b-custom' })
  expect(registryOf(w).workers[1]?.tools).toEqual(['Read', 'Grep'])
  expect(w.writes.length).toBe(before)
  await ui.unmount()
})

// The tail of a transcript: a cut first line, a user row, an assistant row with two
// calls, the same call again as a request blob, and a later Bash call.
const TRANSCRIPT = [
  '"cut":"the first line of a tail"}',
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: ISO(NOW - 120_000), message: { role: 'assistant', content: [
    { type: 'text', text: 'Reading the log.' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${HOME}/repo/logs/ci-0412.txt` } },
    { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'mockServer', path: `${HOME}/repo/tests` } },
  ] } }),
  JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }] } }),
  JSON.stringify({ type: 'assistant', timestamp: ISO(NOW - 30_000), message: { role: 'assistant', content: [
    { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test -- audio', description: 'Run the audio tests' } },
  ] } }),
].join('\n')

test('Activity shows the last tool steps from the transcript tail, newest first', async ($, on) => {
  const w = salesWorld(on)
  w.run = argv => (argv[0] === '/usr/bin/tail' ? { exitCode: 0, stdout: TRANSCRIPT } : undefined)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(w.runs).toHaveLength(0) // nothing read until it is opened
  await ui.press({ key: 'activity-sales' })

  // The transcript is found under ~/.claude/projects by its file name, and only its tail is read.
  expect(w.runs).toEqual([['/usr/bin/tail', '-c', '262144', `${PROJ}/sales.jsonl`]])
  const rows = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('step-sales-'))
  expect(rows).toHaveLength(3)
  const tools = (await ui.findAll({ type: 'Text' })).filter(t => t.props.mono && t.props.bold).map(t => t.text)
  expect(tools).toEqual(['Bash', 'Grep', 'Read'])
  expect(await ui.find({ type: 'Text', text: 'Run the audio tests' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '"mockServer" in ~/repo/tests' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '~/repo/logs/ci-0412.txt' })).toBeDefined()
  expect((await ui.find({ key: 'activity-sales' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'tabbox-activity-sales' }))?.props.borderColor).toBe(SCRIBE)

  // A tab is a radio: pressing it again keeps it; Overview puts it away.
  await ui.press({ key: 'activity-sales' })
  expect(await ui.find({ key: 'activity-panel-sales' })).toBeDefined()
  await ui.press({ key: 'overview-sales' })
  expect(await ui.find({ key: 'activity-panel-sales' })).toBeUndefined()
  await ui.unmount()
})

test('Activity says so when the chat has not run or its transcript is not found', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Its chip selects it; then its Activity tab.
  await ui.press({ key: 'feed-scout' })
  expect(await ui.find({ type: 'Text', text: /^Nothing here yet\. When Scout drafts something to send or post, it waits here for your yes\. Ask it a task/ })).toBeDefined()
  await ui.press({ key: 'activity-scout' })
  expect(await ui.find({ type: 'Text', text: 'No steps yet. Ask it a task and its steps show here.' })).toBeDefined()
  await ui.unmount()
})
