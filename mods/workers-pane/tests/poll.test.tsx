import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Mon 2 Nov 2026, 09:05 Tokyo: the Sales schedule is due.
const DUE = Date.parse('2026-11-02T00:05:00Z')
const HOME = '/home/tester'
const SALES = {
  workers: [
    { key: 'sales', name: 'Sales', session: 'local_sales-9', transcript: 'sales-cli.jsonl', avatar: 'blue',
      charter: 'You are Sales. Drafts only.', schedule: { days: 'mon-fri', time: '09:00', tz: 'Asia/Tokyo' } },
  ],
}
const item = (min: number, title: string) =>
  JSON.stringify({ at: new Date(DUE - min * 60_000).toISOString(), kind: 'draft', title, body: 'b', needs_approval: true })

type World = { now: number; outbox: string; claimed: Set<string>; deliver: boolean; self: string }

function world(on: On, w: World) {
  const runs: string[][] = []
  const sends: string[] = []
  mock.env(on, { HOME })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: w.now }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: w.self }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/workers.json')) return { value: JSON.stringify(SALES) }
    if (e.path.endsWith('/outbox/sales.jsonl')) return { value: w.outbox }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', (_, e) => {
    if (e.path.endsWith('.jsonl')) return { value: { kind: 'file', size: 1, mtimeMs: w.now - 600_000, isLink: false } }
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

const start = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 50))

test('a due schedule wakes the worker once per day across polls and sessions', async ($, on) => {
  const w: World = { now: DUE, outbox: '', claimed: new Set(), deliver: true, self: 'me' }
  const { sends } = world(on, w)
  await start($)
  await settle()
  expect(sends).toHaveLength(1)
  expect(sends[0]).toMatch(/^Scheduled run \(2026-11-02 09:00 Asia\/Tokyo\): run your charter now/)
  expect([...w.claimed]).toEqual([`${HOME}/.voicemode/call/wakes/sales-2026-11-02`])
  await start($) // a second poll, and the claim another session would see
  await settle()
  expect(sends).toHaveLength(1)
})

test('an undelivered wake gives its claim back and retries after 10 minutes', async ($, on) => {
  const w: World = { now: DUE, outbox: '', claimed: new Set(), deliver: false, self: 'me' }
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
  const w: World = { now: DUE, outbox: '', claimed: new Set(), deliver: true, self: 'sales-cli' }
  const { sends } = world(on, w)
  await start($)
  await settle()
  expect(sends).toHaveLength(0)
})

test('new outbox items are announced once; old ones and failed reads are not', async ($, on) => {
  const w: World = { now: DUE - 3_600_000, outbox: item(90, 'An old reply'), claimed: new Set(), deliver: true, self: 'me' }
  const { runs } = world(on, w)
  const said = () => runs.filter(r => r[0]?.endsWith('/outbox-say')).map(r => r[3])
  await start($)
  await settle()
  expect(said()).toEqual([])
  w.outbox = `${item(90, 'An old reply')}\n${item(1, 'A reply to Jordan (Acme)')}\n`
  await start($)
  await settle()
  expect(said()).toEqual(['Sales drafted a reply to Jordan (Acme)'])
  w.outbox = '' // a read that comes back empty
  await start($)
  await settle()
  w.outbox = `${item(90, 'An old reply')}\n${item(1, 'A reply to Jordan (Acme)')}\n`
  await start($)
  await settle()
  expect(said()).toEqual(['Sales drafted a reply to Jordan (Acme)'])
})
