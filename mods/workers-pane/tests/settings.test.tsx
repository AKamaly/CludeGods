import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { GOD_ACCENT, WIDE_AT, paneColumns, themeOf, tint } from '../hooks/register'

// Settings picks as radio groups (drawn at once, written in turn, last click wins), each
// worker's colour, and the two layouts: cards when narrow, list and detail when wide.

const NOW = 1_000_000_000
const HOME = '/home/tester'
const CALL = `${HOME}/.voicemode/call`
const REG = `${CALL}/workers.json`
const PROPS = { title: 'Workers', isFocused: false, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const NARROW = { plugin: 'workers-pane', component: 'Pane', requestId: 'workers', props: PROPS } as const
const WIDE = { ...NARROW, props: { ...PROPS, bodyColumns: 120 } } as const
const AMBER = '#b7791f'
const GREEN = '#2f8f5b'

const ONE = {
  version: 2,
  workers: [
    { key: 'ops', name: 'Ops', role: 'Watches the queue', session: 'local_ops', avatar: 'blue', model: 'm', effort: 'low',
      schedule: { days: 'mon-fri', time: '09:00', tz: 'Asia/Riyadh' } },
  ],
}
const FOUR = {
  workers: [
    { key: 'quick', name: 'Quick', role: 'Lookups', session: 'local_q', transcript: 'quick.jsonl', avatar: 'blue' },
    { key: 'work', name: 'Work', role: 'Drafts', session: 'local_w', transcript: 'work.jsonl', avatar: 'violet', charter: 'C' },
    { key: 'deep', name: 'Deep', role: 'Research', session: 'local_d', transcript: 'deep.jsonl', god: 'herald' },
    { key: 'scout', name: 'Scout', role: 'Fresh one', session: 'local_s', god: 'scout' },
  ],
}

type World = {
  files: Map<string, string>
  writes: { path: string; text: string }[]
  runs: string[][]
  toasts: string[]
  /** While held, writes of workers.json wait for `release`: a slow disk. */
  held: boolean
  waiting: (() => void)[]
  failRegistry: boolean
}

function world(on: On, registry: unknown, extra: Record<string, string> = {}): World {
  const w: World = {
    files: new Map([[REG, JSON.stringify(registry)], ...Object.entries(extra)]),
    writes: [], runs: [], toasts: [], held: false, waiting: [], failRegistry: false,
  }
  mock.env(on, { HOME })
  on('clock.now', () => ({ value: NOW }))
  on('clock.after', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', async (_, e) => {
    if (e.path === REG && w.held) await new Promise<void>(r => w.waiting.push(r))
    if (e.path === REG && w.failRegistry) return { deny: 'EACCES workers.json' }
    w.writes.push({ path: e.path, text: e.text })
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    if (e.path.endsWith('quick.jsonl')) return { value: { kind: 'file', size: 1, mtimeMs: NOW - 2_000, isLink: false } }
    if (e.path.endsWith('.jsonl') && e.path.includes('/projects/')) return { value: { kind: 'file', size: 1, mtimeMs: NOW - 180_000, isLink: false } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', (_, e) => {
    if (e.path === `${HOME}/.claude/projects`) return { value: [{ name: '-home-tester-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    if (e.path === `${CALL}/spaces`) return { value: [{ name: 'notes', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }, { name: 'launch', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    return { deny: `ENOENT ${e.path}` }
  })
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', () => ({ isDelivered: true }))
  return w
}

const release = (w: World) => {
  w.held = false
  for (const r of w.waiting.splice(0)) r()
}
const tick = () => new Promise(r => (globalThis as any).setTimeout(r, 30))
/**
 * Waits for the write queue to drain: a press resolves once its own calls settle, and a
 * pick queued behind a slow write runs after that, so wait until the writes stop.
 */
async function drain(w: World) {
  let seen = -1
  for (let i = 0; i < 50 && seen !== w.writes.length; i++) {
    seen = w.writes.length
    await tick()
  }
}
const entry = (w: World, n = 0) => (JSON.parse(w.files.get(REG) ?? '{}') as { workers: Record<string, unknown>[] }).workers[n] ?? {}
const regWrites = (w: World) => w.writes.filter(x => x.path === REG)

/** The keys of a radio group's ringed tiles: exactly one, when it behaves. */
async function ringed(ui: { findAll: (q: { type: string }) => Promise<{ key?: string; props: Record<string, unknown> }[]> }, prefix: string) {
  return (await ui.findAll({ type: 'Box' }))
    .filter(b => b.key?.startsWith(`${prefix}-tile-`) && b.props.borderColor !== undefined)
    .map(b => b.key?.slice(`${prefix}-tile-`.length))
}

test('the god picker is a radio: the highlight moves on the click, before the write lands', async ($, on) => {
  const w = world(on, ONE)
  const ui = await $.ui.mount({ ...NARROW, surface: 'desktop' })
  await ui.press({ key: 'settings-ops' })
  expect(await ringed(ui, 'god-ops')).toEqual(['scribe']) // a blue v1 avatar: Scribe

  w.held = true
  const first = ui.press({ key: 'god-ops-herald' })
  await tick()
  // Drawn at once: one tile ringed, in the new god's colour, the card with it.
  expect(await ringed(ui, 'god-ops')).toEqual(['herald'])
  expect((await ui.find({ key: 'god-ops-herald' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'god-ops-scribe' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ key: 'card-ops' }))?.props.borderColor).toBe(GOD_ACCENT.herald)
  expect(entry(w).god).toBeUndefined() // the write has not landed

  // A second click while the first write waits: it moves again, still one.
  const second = ui.press({ key: 'god-ops-research' })
  await tick()
  expect(await ringed(ui, 'god-ops')).toEqual(['research'])

  release(w)
  await Promise.all([first, second])
  await drain(w)
  // The last click wins, and the registry agrees with what was drawn.
  expect(entry(w).god).toBe('research')
  expect(entry(w).avatar).toBe('violet')
  expect(await ringed(ui, 'god-ops')).toEqual(['research'])
  expect((await ui.find({ key: 'card-ops' }))?.props.borderColor).toBe(GOD_ACCENT.research)
  // Every other key kept.
  expect(entry(w).model).toBe('m')
  expect(entry(w).schedule).toEqual(ONE.workers[0]?.schedule)
  await ui.unmount()
})

test('a pick overtaken before its write starts is not written at all', async ($, on) => {
  const w = world(on, ONE)
  const ui = await $.ui.mount({ ...NARROW, surface: 'desktop' })
  await ui.press({ key: 'settings-ops' })
  // A slow write of something else holds the queue, so both god picks wait behind it.
  w.held = true
  const pause = ui.press({ key: 'pause-ops' })
  await tick()
  const a = ui.press({ key: 'god-ops-herald' })
  const b = ui.press({ key: 'god-ops-sales' })
  await tick()
  expect(await ringed(ui, 'god-ops')).toEqual(['sales'])
  release(w)
  await Promise.all([pause, a, b])
  await drain(w)
  const texts = regWrites(w).map(x => JSON.parse(x.text).workers[0])
  expect(texts.map(t => [t.paused, t.god])).toEqual([[true, undefined], [true, 'sales']]) // herald never written
  await ui.unmount()
})

test('pressing the picked tile writes nothing', async ($, on) => {
  const w = world(on, { workers: [{ ...ONE.workers[0], god: 'scout', tools: 'drafts' }] })
  const ui = await $.ui.mount({ ...NARROW, surface: 'desktop' })
  await ui.press({ key: 'settings-ops' })
  await ui.press({ key: 'god-ops-scout' })
  await ui.press({ key: 'tools-ops-drafts' })
  expect(regWrites(w)).toHaveLength(0)
  expect(await ringed(ui, 'god-ops')).toEqual(['scout'])
  expect(await ringed(ui, 'tools-ops')).toEqual(['drafts'])
  await ui.unmount()
})

test('overlapping writes of different settings never interleave: both land', async ($, on) => {
  const w = world(on, ONE)
  const ui = await $.ui.mount({ ...NARROW, surface: 'desktop' })
  await ui.press({ key: 'settings-ops' })
  w.held = true
  const pause = ui.press({ key: 'pause-ops' })
  const tools = ui.press({ key: 'tools-ops-read' })
  const voice = ui.select({ key: 'voice-ops', value: 'bm_lewis' })
  await tick()
  // All three show at once.
  expect((await ui.find({ key: 'pause-ops' }))?.props.label).toBe('Resume')
  expect(await ringed(ui, 'tools-ops')).toEqual(['read'])
  expect((await ui.find({ key: 'voice-ops' }))?.props.value).toBe('bm_lewis')
  expect((await ui.find({ key: 'hours-ops' }))?.props.label).toBe('Paused')
  release(w)
  await Promise.all([pause, tools, voice])
  await drain(w)
  // Each write read the file the one before it wrote: nothing lost.
  expect(entry(w)).toEqual({ ...ONE.workers[0], paused: true, tools: 'read', voice: 'bm_lewis' })
  const steps = regWrites(w).map(x => JSON.parse(x.text).workers[0])
  expect(steps.map(t => [t.paused, t.tools, t.voice])).toEqual([
    [true, undefined, undefined],
    [true, 'read', undefined],
    [true, 'read', 'bm_lewis'],
  ])
  await ui.unmount()
})

test('quick toggles build on each other: pause twice, two spaces, hours then days', async ($, on) => {
  const w = world(on, ONE, {
    [`${CALL}/spaces/notes/space.json`]: JSON.stringify({ name: 'Notes' }),
    [`${CALL}/spaces/launch/space.json`]: JSON.stringify({ name: 'Launch plan' }),
  })
  const ui = await $.ui.mount({ ...NARROW, surface: 'desktop' })
  await ui.press({ key: 'settings-ops' })
  w.held = true
  const presses = [
    ui.press({ key: 'pause-ops' }),
    ui.press({ key: 'pause-ops' }),
    ui.press({ key: 'space-ops-launch' }),
    ui.press({ key: 'space-ops-notes' }),
  ]
  await tick()
  presses.push(ui.select({ key: 'mode-ops', value: '3h' }))
  await tick()
  presses.push(ui.select({ key: 'days-ops', value: 'sun-thu' }))
  await tick()
  // Drawn from the picks: an interval with its from and to, the days just picked.
  expect((await ui.find({ key: 'mode-ops' }))?.props.value).toBe('3h')
  expect((await ui.find({ key: 'days-ops' }))?.props.value).toBe('sun-thu')
  expect((await ui.find({ key: 'from-ops' }))?.props.value).toBe('09:00')
  expect(await ui.find({ key: 'time-ops' })).toBeUndefined()
  release(w)
  await Promise.all(presses)
  await drain(w)
  const e = entry(w)
  expect(e.paused).toBe(false) // on, then off
  expect(e.spaces).toEqual(['launch']) // launch on, then notes off: launch kept
  expect(e.schedule).toEqual({ days: 'sun-thu', every: '3h', from: '09:00', to: '18:00', tz: 'Asia/Riyadh' })
  expect((await ui.find({ key: 'hours-ops' }))?.props.label).toBe('Every 3h · 9:00-18:00')
  await ui.unmount()
})

test('a failed write drops the pick: the registry value shows again, with a toast', async ($, on) => {
  const w = world(on, ONE)
  const ui = await $.ui.mount({ ...NARROW, surface: 'desktop' })
  await ui.press({ key: 'settings-ops' })
  w.failRegistry = true
  await ui.press({ key: 'god-ops-herald' })
  expect(await ringed(ui, 'god-ops')).toEqual(['scribe'])
  expect(w.toasts.some(t => /^Couldn't save Ops: couldn't write workers\.json/.test(t))).toBe(true)
  await ui.unmount()
})

test("each god's accent reads at 3:1 or more on the light and the dark theme alike", async () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
  }
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05)
  }
  const accents = Object.values(GOD_ACCENT)
  expect(new Set(accents).size).toBe(6)
  for (const a of accents) {
    expect(ratio(a, '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(ratio(a, '#262624')).toBeGreaterThanOrEqual(3)
  }
  expect(themeOf('scout')).toEqual({ accent: '#578f0e', soft: '#578f0e24', wash: '#578f0e0d', hover: '#578f0e80' })
  expect(tint('#ea580c', 0.12)).toBe('#ea580c1f')
})

test("the selected worker's god colours its card, badge, chip, tabs and header; amber and green stay", async ($, on) => {
  const gods = ['colleague', 'research', 'scribe', 'scout', 'sales', 'herald'] as const
  const registry = {
    workers: gods.map((g, i) => ({ key: `w${i}`, name: `W${i}`, session: `local_${i}`, god: g, transcript: i === 0 ? 'quick.jsonl' : undefined })),
  }
  const extra = Object.fromEntries(gods.map((_, i) => [
    `${CALL}/outbox/w${i}.jsonl`,
    JSON.stringify({ id: `ob_00000000000${i}`, at: new Date(NOW - 60_000).toISOString(), kind: 'draft', title: `Draft ${i}`, body: 'b', needs_approval: true }),
  ]))
  world(on, registry, extra)
  const ui = await $.ui.mount({ ...NARROW, surface: 'desktop' })
  for (const [i, g] of gods.entries()) {
    await ui.press({ key: `feed-w${i}` })
    const accent = GOD_ACCENT[g]
    expect((await ui.find({ key: `card-w${i}` }))?.props.borderColor).toBe(accent)
    expect((await ui.find({ key: `card-w${i}` }))?.props.backgroundColor).toBe(tint(accent, 0.05))
    expect((await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('card-') && b.props.borderColor).length).toBe(1)
    const badges = (await ui.findAll({ type: 'Text', text: ' 1 draft ' })).map(t => t.props.color)
    expect(badges[i]).toBe(accent)
    expect((await ui.find({ key: `hours-chip-w${i}` }))?.props.backgroundColor).toBe(tint(accent, 0.12))
    expect((await ui.find({ key: `tabbox-outbox-w${i}` }))?.props.borderColor).toBe(accent)
    expect((await ui.find({ type: 'Text', text: /^●$/ }))?.props.color).toBe(accent)
    // "needs your yes" is amber whatever the worker's colour.
    expect((await ui.find({ type: 'Text', text: 'needs your yes' }))?.props.color).toBe(AMBER)
  }
  expect((await ui.find({ type: 'Text', text: '● Working' }))?.props.color).toBe(GREEN)
  await ui.unmount()
})

test('wide: a list of compact rows beside the selected worker\'s tabbed detail', async ($, on) => {
  const w = world(on, FOUR)
  const ui = await $.ui.mount({ ...WIDE, surface: 'desktop' })
  expect(await ui.find({ key: 'split' })).toBeDefined()
  expect((await ui.find({ key: 'list' }))?.props.width).toBe('34%')
  const rows = (await ui.findAll({ type: 'Box' })).filter(b => /^row-[a-z]+$/.test(b.key ?? '')).map(b => b.key)
  expect(rows).toEqual(['row-quick', 'row-work', 'row-deep', 'row-scout'])
  expect(await ui.findAll({ type: 'Box', text: /./ }).then(bs => bs.filter(b => b.key?.startsWith('card-')))).toHaveLength(0)
  // Each row: god, name, status; the first is selected, in Scribe's colour.
  expect((await ui.find({ key: 'row-quick' }))?.props.borderColor).toBe(GOD_ACCENT.scribe)
  expect((await ui.find({ key: 'row-work' }))?.props.borderColor).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: '● Working' }))).toHaveLength(2) // the row, and the detail's header
  expect((await ui.findAll({ type: 'Svg' })).filter(s => String(s.props.alt).includes(', ')).map(s => s.props.width)).toEqual([28, 28, 28, 28, 48])
  // The detail: the god large, the tabs, Overview with the one Ask field, hours, Open.
  expect(await ui.find({ key: 'detail-quick' })).toBeDefined()
  expect((await ui.find({ key: 'detail-quick' }))?.props.borderColor).toBe(GOD_ACCENT.scribe)
  const tabs = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => /^(overview|outboxtab|activity|settings)-/.test(k ?? ''))
  expect(tabs).toEqual(['overview-quick', 'outboxtab-quick', 'activity-quick', 'settings-quick'])
  expect((await ui.findAll({ type: 'Input' })).map(i => i.key)).toEqual(['task-quick'])
  expect((await ui.find({ key: 'hours-quick' }))?.props.label).toBe('When you ask')
  expect((await ui.find({ key: 'open-quick' }))?.props.label).toBe('Open chat')
  expect((await ui.find({ key: 'talk-quick' }))?.props.label).toBe('Talk to Quick')
  expect(await ui.find({ key: 'run-quick' })).toBeUndefined() // no instructions, nothing to run
  expect(await ui.find({ type: 'Text', text: 'Works when you ask. Set times under When it works in Settings.' })).toBeDefined()

  // A row's name selects it, and opens nothing.
  await ui.press({ key: 'pick-work' })
  expect(w.runs).toEqual([])
  expect(await ui.find({ key: 'detail-quick' })).toBeUndefined()
  expect((await ui.find({ key: 'detail-work' }))?.props.borderColor).toBe(GOD_ACCENT.research)
  expect((await ui.find({ key: 'row-work' }))?.props.borderColor).toBe(GOD_ACCENT.research)
  expect((await ui.find({ key: 'row-quick' }))?.props.borderColor).toBeUndefined()
  expect((await ui.find({ key: 'run-work' }))?.props.variant).toBe('primary') // the one primary action
  expect((await ui.find({ key: 'open-work' }))?.props.variant).toBe('secondary')

  // The tabs: one picked at a time.
  await ui.press({ key: 'outboxtab-work' })
  expect(await ui.find({ key: 'outbox-work' })).toBeDefined()
  expect(await ui.find({ key: 'task-work' })).toBeUndefined()
  expect((await ui.find({ key: 'tabbox-outbox-work' }))?.props.borderColor).toBe(GOD_ACCENT.research)
  expect((await ui.find({ key: 'tabbox-overview-work' }))?.props.borderColor).toBeUndefined()
  await ui.press({ key: 'settings-work' })
  expect(await ui.find({ key: 'outbox-work' })).toBeUndefined()
  expect(await ui.find({ key: 'settings-panel-work' })).toBeDefined()
  expect(await ringed(ui, 'god-work')).toEqual(['research'])
  await ui.press({ key: 'overview-work' })
  await ui.press({ key: 'open-work' })
  expect(w.runs).toEqual([['open', 'claude://claude.ai/epitaxy/local_w']])
  await ui.unmount()
})

test('the same pane narrow and wide: the selection carries across a resize', async ($, on) => {
  world(on, FOUR)
  const ui = await $.ui.mount({ ...NARROW, surface: 'desktop' })
  expect(await ui.find({ key: 'split' })).toBeUndefined()
  expect(await ui.find({ key: 'card-deep' })).toBeDefined()
  await ui.press({ key: 'feed-deep' })
  await ui.redraw({ ...PROPS, bodyColumns: WIDE_AT })
  expect(await ui.find({ key: 'card-deep' })).toBeUndefined()
  expect(await ui.find({ key: 'detail-deep' })).toBeDefined()
  expect(await ui.find({ key: 'outbox-deep' })).toBeDefined()
  await ui.redraw({ ...PROPS, bodyColumns: WIDE_AT - 1 })
  expect(await ui.find({ key: 'split' })).toBeUndefined()
  expect((await ui.find({ key: 'card-deep' }))?.props.borderColor).toBe(GOD_ACCENT.herald)
  expect(await ui.find({ key: 'outbox-deep' })).toBeDefined()
  await ui.unmount()
})

test('wide on the terminal: the same rows and detail, no Svg', async ($, on) => {
  world(on, FOUR)
  const ui = await $.ui.mount({ ...WIDE, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ key: 'row-scout' })).toBeDefined()
  expect(await ui.find({ key: 'detail-quick' })).toBeDefined()
  await ui.unmount()
})

test('the width comes from the body, else the surface, else the docked default', async () => {
  expect(paneColumns({ bodyColumns: 120 }, { columns: 40 })).toBe(120)
  expect(paneColumns({ bodyColumns: 0 }, { columns: 130 })).toBe(130)
  expect(paneColumns({})).toBe(46)
  expect(WIDE_AT).toBe(80)
})

test('narrow: the empty states say what to do', async ($, on) => {
  const w = world(on, { workers: [] })
  const ui = await $.ui.mount({ ...NARROW, surface: 'desktop' })
  // A first run opens on Welcome; once it is dismissed, the empty list says what to do.
  expect(await ui.find({ key: 'welcome' })).toBeDefined()
  await ui.press({ key: 'onboarding-dismiss' })
  expect(await ui.find({ key: 'welcome' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^No workers yet\. \+ New worker picks a ready-made one/ })).toBeDefined()
  expect(JSON.parse(w.files.get(`${HOME}/.voicemode/call/onboarding.json`) ?? '{}')).toEqual({ done: [], dismissed: true })
  await ui.press({ key: 'needs' })
  expect(await ui.find({ type: 'Text', text: /^Nothing needs you\. Drafts waiting for your yes, permission requests/ })).toBeDefined()
  await ui.unmount()
})
