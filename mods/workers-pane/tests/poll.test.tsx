import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Mon 2 Nov 2026, 09:05 Riyadh: the Sales schedule is due.
const DUE = Date.parse('2026-11-02T06:05:00Z')
const HOME = '/home/tester'
const CALL = `${HOME}/.voicemode/call`
const SALES = {
  workers: [
    { key: 'sales', name: 'Sales', session: 'local_sales-9', transcript: 'sales-cli.jsonl', avatar: 'blue',
      charter: 'You are Sales. Drafts only.', schedule: { days: 'mon-fri', time: '09:00', tz: 'Asia/Riyadh' } },
  ],
}
const item = (min: number, title: string) =>
  JSON.stringify({ at: new Date(DUE - min * 60_000).toISOString(), kind: 'draft', title, body: 'b', needs_approval: true })

type World = {
  now: number
  outbox: string
  registry: unknown
  claimed: Set<string>
  deliver: boolean
  self: string
  flag?: { mtimeMs: number; text: string }
  writes: { path: string; text: string }[]
  opens: unknown[]
}

function world(on: On, w: World) {
  const runs: string[][] = []
  const sends: string[] = []
  mock.env(on, { HOME })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: w.now }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    w.opens.push({ ...e })
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: w.self }))
  on('fs.write', (_, e) => {
    w.writes.push({ path: e.path, text: e.text })
    if (e.path.endsWith('/workers.json')) w.registry = JSON.parse(e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/workers.json')) return { value: JSON.stringify(w.registry) }
    if (e.path.endsWith('/outbox/sales.jsonl')) return { value: w.outbox }
    if (e.path === `${CALL}/open-workers` && w.flag) return { value: w.flag.text }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', (_, e) => {
    if (e.path === `${HOME}/.claude/projects`) return { value: [{ name: '-home-tester-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', (_, e) => {
    if (e.path.endsWith('.jsonl')) return { value: { kind: 'file', size: 1, mtimeMs: w.now - 600_000, isLink: false } }
    if (e.path === `${CALL}/open-workers` && w.flag) return { value: { kind: 'file', size: 1, mtimeMs: w.flag.mtimeMs, isLink: false } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    let exitCode = 0
    if (argv[0] === '/bin/mkdir' && argv[1] !== '-p') {
      exitCode = w.claimed.has(argv[1]!) ? 1 : 0
      w.claimed.add(argv[1]!)
    }
    if (argv[0] === '/bin/rmdir') w.claimed.delete(argv[1]!)
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', (_, e) => {
    sends.push(e.text)
    return w.deliver ? { isDelivered: true } : { isDelivered: false, reason: 'not running' }
  })
  return { runs, sends }
}

const fresh = (patch: Partial<World> = {}): World => ({
  now: DUE, outbox: '', registry: SALES, claimed: new Set(), deliver: true, self: 'me', writes: [], opens: [], ...patch,
})
const start = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 50))

test('a due schedule wakes the worker once per day across polls and sessions', async ($, on) => {
  const w = fresh()
  const { sends } = world(on, w)
  await start($)
  await settle()
  expect(sends).toHaveLength(1)
  expect(sends[0]).toMatch(/^Scheduled run \(2026-11-02 09:00 Asia\/Riyadh\): run your charter now/)
  expect([...w.claimed]).toEqual([`${CALL}/wakes/sales-2026-11-02`])
  await start($) // a second poll, and the claim another session would see
  await settle()
  expect(sends).toHaveLength(1)
})

test('a paused worker is not woken, and wakes again once resumed', async ($, on) => {
  const paused = { workers: [{ ...SALES.workers[0], paused: true }] }
  const w = fresh({ registry: paused })
  const { sends } = world(on, w)
  await start($)
  await settle()
  expect(sends).toHaveLength(0)
  expect(w.claimed.size).toBe(0)
  w.registry = { workers: [{ ...SALES.workers[0], paused: false }] }
  await start($)
  await settle()
  expect(sends).toHaveLength(1)
})

test('an undelivered wake gives its claim back and retries after 10 minutes', async ($, on) => {
  const w = fresh({ deliver: false })
  const { sends } = world(on, w)
  await start($)
  await settle()
  expect(sends).toHaveLength(1)
  expect(w.claimed.size).toBe(0)
  w.deliver = true
  w.now = DUE + 5 * 60_000
  await start($)
  await settle()
  expect(sends).toHaveLength(1)
  w.now = DUE + 11 * 60_000
  await start($)
  await settle()
  expect(sends).toHaveLength(2)
  expect(w.claimed.size).toBe(1)
})

test("the worker's own chat never wakes itself", async ($, on) => {
  const w = fresh({ self: 'sales-cli' })
  const { sends } = world(on, w)
  await start($)
  await settle()
  expect(sends).toHaveLength(0)
})

test('new outbox items are announced once by id; old ones and failed reads are not', async ($, on) => {
  const w = fresh({ now: DUE - 3_600_000, outbox: item(90, 'An old reply') })
  const { runs } = world(on, w)
  const said = () => runs.filter(r => r[0]?.endsWith('/outbox-say')).map(r => [r[2], r[3]])
  await start($)
  await settle()
  expect(said()).toEqual([])
  w.outbox = `${item(90, 'An old reply')}\n${item(1, 'A reply to Jordan')}\n`
  await start($)
  await settle()
  const id = said()[0]?.[0] ?? ''
  expect(id).toMatch(/^ob_[0-9a-f]{12}$/)
  expect(said()).toEqual([[id, 'Sales drafted a reply to Jordan']])
  w.outbox = '' // a read that comes back empty
  await start($)
  await settle()
  w.outbox = `${item(90, 'An old reply')}\n${item(1, 'A reply to Jordan')}\n`
  await start($)
  await settle()
  expect(said()).toHaveLength(1)
})

test('the open-workers flag opens the pane; with {"outbox": key} it opens that outbox too', async ($, on) => {
  const w = fresh({ now: DUE - 3_600_000 })
  world(on, w)
  await start($)
  await settle()
  const focused = () => w.opens.filter(o => (o as { focus?: boolean }).focus === true)
  expect(focused()).toHaveLength(0)

  // A plain touch.
  w.flag = { mtimeMs: DUE - 3_000_000, text: '' }
  await start($)
  await settle()
  expect(focused()).toHaveLength(1)

  // The Spaces pane's Review.
  w.flag = { mtimeMs: DUE - 2_000_000, text: JSON.stringify({ at: DUE - 2_000_000, outbox: 'sales' }) }
  await start($)
  await settle()
  expect(focused()).toHaveLength(2)
  const ui = await $.ui.mount({
    plugin: 'workers-pane', component: 'Pane', requestId: 'workers', surface: 'desktop',
    props: { title: 'Workers', isFocused: true, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(await ui.find({ key: 'outbox-sales' })).toBeDefined()
  expect((await ui.find({ key: 'card-sales' }))?.props.borderColor).toBe('#3b82f6') // its god's colour (blue: Scribe)
  expect((await ui.find({ key: 'outboxtab-sales' }))?.props.dimColor).toBe(false)
  await ui.unmount()
})

test('a worker created here gets the god, voice and tools it was made with, once registered', async ($, on) => {
  const w = fresh({ now: DUE - 3_600_000 })
  world(on, w)
  on('prompt.fill', () => ({ isFilled: true }))
  const ui = await $.ui.mount({
    plugin: 'workers-pane', component: 'Pane', requestId: 'workers', surface: 'desktop',
    props: { title: 'Workers', isFocused: true, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'nw-god-herald' })
  await ui.input({ key: 'nw-entry', text: 'Herald, announcements' })
  // A same-named worker that was already there is never touched.
  await ui.press({ key: 'new-worker' })
  await ui.input({ key: 'nw-entry', text: 'Sales, again' })
  await ui.unmount()

  // The call session registers Herald with the v1 fields only.
  w.registry = {
    note: 'kept',
    workers: [...SALES.workers, { key: 'herald', name: 'Herald', role: 'announcements', session: 'local_h', avatar: 'gold', model: 'm' }],
  }
  await start($)
  await settle()
  const reg = w.registry as { note: string; workers: Record<string, unknown>[] }
  expect(reg.note).toBe('kept')
  expect(reg.workers[0]).toEqual(SALES.workers[0])
  expect(reg.workers[1]).toEqual({
    key: 'herald', name: 'Herald', role: 'announcements', session: 'local_h', avatar: 'gold', model: 'm',
    god: 'herald', voice: 'bm_george', tools: 'drafts',
  })
  // Once only.
  const count = w.writes.filter(x => x.path.endsWith('/workers.json')).length
  expect(count).toBe(1)
  await start($)
  await settle()
  expect(w.writes.filter(x => x.path.endsWith('/workers.json')).length).toBe(1)
})

// Every 3h, 9:00 to 18:00 Riyadh (UTC+3), Monday to Friday.
const EVERY = {
  workers: [
    { key: 'scout', name: 'Scout', session: 'local_scout-7', transcript: 'scout-cli.jsonl', god: 'scout',
      charter: 'Watch the repo. Drafts only.', schedule: { days: 'mon-fri', every: '3h', from: '09:00', to: '18:00', tz: 'Asia/Riyadh' } },
  ],
}
const riyadh = (hhmm: string) => Date.parse(`2026-11-02T${hhmm}:00+03:00`)

test('an every-3h schedule claims each slot once, as wakes/<key>-<date>-<HHMM>', async ($, on) => {
  const w = fresh({ registry: EVERY, now: riyadh('09:05') })
  const { sends } = world(on, w)
  await start($)
  await settle()
  expect(sends).toHaveLength(1)
  expect(sends[0]).toMatch(/^Scheduled run \(2026-11-02 09:00 Asia\/Riyadh\): run your charter now/)
  expect(sends[0]).toContain('Watch the repo. Drafts only.')
  expect([...w.claimed]).toEqual([`${CALL}/wakes/scout-2026-11-02-0900`])
  // Later in the same slot: nothing more.
  w.now = riyadh('11:59')
  await start($)
  await settle()
  expect(sends).toHaveLength(1)
  // The next slot.
  w.now = riyadh('12:01')
  await start($)
  await settle()
  expect(sends).toHaveLength(2)
  expect(sends[1]).toMatch(/^Scheduled run \(2026-11-02 12:00 Asia\/Riyadh\)/)
  expect([...w.claimed]).toEqual([`${CALL}/wakes/scout-2026-11-02-0900`, `${CALL}/wakes/scout-2026-11-02-1200`])
  // Past the window's last slot and its grace: nothing.
  w.now = riyadh('21:30')
  await start($)
  await settle()
  expect(sends).toHaveLength(2)
})

test('a slot another session already claimed is not woken again', async ($, on) => {
  const w = fresh({ registry: EVERY, now: riyadh('12:02'), claimed: new Set([`${CALL}/wakes/scout-2026-11-02-1200`]) })
  const { sends, runs } = world(on, w)
  await start($)
  await settle()
  expect(sends).toHaveLength(0)
  expect(runs.filter(r => r[0] === '/bin/mkdir' && r[1] !== '-p')).toEqual([['/bin/mkdir', `${CALL}/wakes/scout-2026-11-02-1200`]])
})

test('back after hours away: one wake for the latest slot, none for the slots it missed', async ($, on) => {
  const w = fresh({ registry: EVERY, now: riyadh('16:10') })
  const { sends } = world(on, w)
  await start($)
  await settle()
  await start($)
  await settle()
  expect(sends).toHaveLength(1)
  expect(sends[0]).toMatch(/^Scheduled run \(2026-11-02 15:00 Asia\/Riyadh\)/)
  expect([...w.claimed]).toEqual([`${CALL}/wakes/scout-2026-11-02-1500`])
})

test('a paused interval worker is not woken; an undelivered slot retries while it is still due', async ($, on) => {
  const w = fresh({ registry: { workers: [{ ...EVERY.workers[0], paused: true }] }, now: riyadh('09:05') })
  const { sends } = world(on, w)
  await start($)
  await settle()
  expect(sends).toHaveLength(0)
  w.registry = EVERY
  w.deliver = false
  await start($)
  await settle()
  expect(sends).toHaveLength(1)
  expect(w.claimed.size).toBe(0) // given back
  w.deliver = true
  w.now = riyadh('09:16')
  await start($)
  await settle()
  expect(sends).toHaveLength(2)
  expect([...w.claimed]).toEqual([`${CALL}/wakes/scout-2026-11-02-0900`])
})
