import { expect, test } from 'claude-code/testing'

import {
  approveText,
  awaiting,
  badge,
  chipLabel,
  createText,
  daysLabel,
  declineText,
  dueDate,
  dueSlot,
  editSchedule,
  godOf,
  headsUp,
  intervalSlots,
  legacyId,
  outboxLabel,
  pageSavedText,
  parseDecisions,
  parseOutbox,
  parseSteps,
  scheduleDays,
  scheduleLabel,
  scheduleSentence,
  sha1Hex,
  shortArg,
  toolsOf,
  voiceOf,
  wakeText,
} from '../hooks/register'

const WEEKDAYS = { days: 'mon-fri', time: '09:00', tz: 'Asia/Riyadh' }
// Riyadh is UTC+3 all year.
const at = (iso: string) => Date.parse(iso)

test('a weekday schedule is due from its time in its own zone, on its days only', async () => {
  // Mon 2 Nov 2026, 08:59 and 09:00 Riyadh.
  expect(dueDate(WEEKDAYS, at('2026-11-02T05:59:00Z'))).toBeUndefined()
  expect(dueDate(WEEKDAYS, at('2026-11-02T06:00:00Z'))).toBe('2026-11-02')
  // Late the same day still counts (the app was closed at 09:00).
  expect(dueDate(WEEKDAYS, at('2026-11-02T19:00:00Z'))).toBe('2026-11-02')
  // 23:30 UTC Monday is already Tuesday 02:30 in Riyadh: before its time.
  expect(dueDate(WEEKDAYS, at('2026-11-02T23:30:00Z'))).toBeUndefined()
  // Sun 1 Nov and Sat 7 Nov are off.
  expect(dueDate(WEEKDAYS, at('2026-11-01T12:00:00Z'))).toBeUndefined()
  expect(dueDate(WEEKDAYS, at('2026-11-07T12:00:00Z'))).toBeUndefined()
  expect(dueDate({ ...WEEKDAYS, tz: 'Not/AZone' }, at('2026-11-02T12:00:00Z'))).toBeUndefined()
  expect(dueDate({ ...WEEKDAYS, time: '9am' }, at('2026-11-02T12:00:00Z'))).toBeUndefined()
})

test('days parse ranges, lists, wraps and daily', async () => {
  expect([...scheduleDays('mon-fri')].sort()).toEqual([1, 2, 3, 4, 5])
  expect([...scheduleDays('sun-thu')].sort()).toEqual([0, 1, 2, 3, 4])
  expect([...scheduleDays('fri-mon')].sort()).toEqual([0, 1, 5, 6])
  expect([...scheduleDays('mon,wed,fri')].sort()).toEqual([1, 3, 5])
  expect([...scheduleDays('sat,sun')].sort()).toEqual([0, 6])
  expect(scheduleDays('daily').size).toBe(7)
  expect(scheduleDays('nonsense').size).toBe(0)
})

test('labels read as the film writes them', async () => {
  expect(scheduleLabel(WEEKDAYS)).toBe('Mon to Fri · 9:00')
  expect(scheduleLabel({ days: 'daily', time: '07:30', tz: 'America/New_York' })).toBe('Daily · 7:30')
  expect(scheduleLabel({ days: 'mon,wed,fri', time: '14:00', tz: 'UTC' })).toBe('Mon, Wed, Fri · 14:00')
  expect(daysLabel('sun-thu')).toBe('Sun to Thu')
  expect(chipLabel({ schedule: WEEKDAYS })).toBe('Mon to Fri · 9:00')
  expect(chipLabel({ schedule: WEEKDAYS, paused: true })).toBe('Paused')
  expect(chipLabel({})).toBe('Manual')
  expect(outboxLabel(2, false)).toBe('Outbox · 2')
  expect(outboxLabel(0, false)).toBe('Outbox · 0')
  expect(outboxLabel(2, true)).toBe('Hide outbox')
})

test('sha1 matches the standard vectors, multi-byte text and several blocks included', async () => {
  expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
  expect(sha1Hex('a'.repeat(1000))).toBe('291e9a6c66994949b57ba5e650361e98fc36b1ba')
  expect(sha1Hex('2026-11-01T06:00:00.000ZRéponse à Jordan ✉ 🚀')).toBe('520b312868b411cd270574dd154fc8f5339b35ec')
  expect(legacyId('1970-01-12T12:46:40.000Z', 'Reply to Jordan')).toBe('ob_36294061541d')
})

test('outbox v2: ids kept, old lines get the sha1 id, kinds, pages and broken lines', async () => {
  const items = parseOutbox([
    JSON.stringify({ at: '1970-01-12T12:46:40.000Z', kind: 'draft', title: 'Reply to Jordan', body: 'b', needs_approval: true }),
    JSON.stringify({ id: 'ob_000000000001', at: '2026-11-01T06:00:00Z', kind: 'page', title: 'Notes', body: '', needs_approval: true, space: 'notes', draft_path: '~/x.md' }),
    JSON.stringify({ at: '2026-11-01T06:01:00Z', kind: 'weird', title: 'Odd kind', body: 1 }),
    '{"at": "2026-11-01T06:02:00Z"}',
    'not json',
  ].join('\n'))
  expect(items.map(i => [i.id, i.kind, i.needs_approval])).toEqual([
    ['ob_36294061541d', 'draft', true],
    ['ob_000000000001', 'page', true],
    [legacyId('2026-11-01T06:01:00Z', 'Odd kind'), 'note', false],
  ])
  expect(items[1]?.space).toBe('notes')
  expect(items[1]?.draft_path).toBe('~/x.md')
  expect(items[2]?.body).toBe('')

  const decided = parseDecisions([
    JSON.stringify({ id: 'ob_000000000001', decision: 'declined', at: 'x' }),
    JSON.stringify({ id: 'ob_000000000001', decision: 'approved', at: 'y' }),
    JSON.stringify({ id: 'ob_x', decision: 'maybe' }),
    'nope',
  ].join('\n'))
  expect(decided).toEqual({ ob_000000000001: { id: 'ob_000000000001', decision: 'approved', at: 'y' } })
  expect(awaiting(items, decided).map(i => i.id)).toEqual(['ob_36294061541d'])
  expect(badge(items, decided)).toBe('1 draft')
  expect(badge(items, {})).toBe('2 drafts')
  expect(badge([], {})).toBe('')
})

test('the lines a worker is told on Approve and Decline, and the spoken heads-up', async () => {
  const d = { id: 'ob_abc', kind: 'draft' as const, title: 'A reply to Jordan', space: 'notes' }
  expect(approveText(d)).toBe('Approved in the Workers pane: A reply to Jordan (ob_abc). Go ahead with exactly what the draft says, then report back.')
  expect(pageSavedText(d)).toBe('Approved in the Workers pane: A reply to Jordan (ob_abc). It is saved as a page in notes.')
  expect(declineText(d)).toBe("Declined: A reply to Jordan (ob_abc). Don't do it.")
  expect(headsUp('Inbox', d)).toBe('Inbox drafted a reply to Jordan')
  expect(headsUp('Inbox', { kind: 'page', title: 'Release notes' })).toBe('Inbox drafted release notes')
  expect(headsUp('Inbox', { kind: 'note', title: 'Repo went quiet' })).toBe('Inbox has a note: Repo went quiet')
  const text = wakeText({ key: 'inbox', name: 'Inbox', charter: 'CHARTER BODY' }, 'Scheduled run (2026-11-02 09:00 Asia/Riyadh)')
  expect(text).toMatch(/^Scheduled run \(2026-11-02 09:00 Asia\/Riyadh\): run your charter now\./)
  expect(text).toContain('Drafts only')
  expect(text.endsWith('CHARTER BODY')).toBe(true)
})

test('registry v2 defaults: god from the avatar, voice from the god, full tools for an old worker', async () => {
  expect(godOf({ avatar: 'violet' })).toBe('research')
  expect(godOf({ avatar: 'purple' })).toBe('research')
  expect(godOf({ avatar: 'blue' })).toBe('scribe')
  expect(godOf({ avatar: 'lime' })).toBe('scout')
  expect(godOf({ avatar: 'green' })).toBe('scout')
  expect(godOf({ avatar: 'orange' })).toBe('sales')
  expect(godOf({ avatar: 'red' })).toBe('sales')
  expect(godOf({ avatar: 'gold' })).toBe('herald')
  expect(godOf({ avatar: 'yellow' })).toBe('herald')
  expect(godOf({})).toBe('colleague')
  expect(godOf({ god: 'herald', avatar: 'blue' })).toBe('herald')
  expect(godOf({ god: 'zeus', avatar: 'blue' })).toBe('scribe')
  expect(voiceOf({})).toBe('af_heart')
  expect(voiceOf({ avatar: 'violet' })).toBe('af_nicole')
  expect(voiceOf({ god: 'scribe' })).toBe('bf_emma')
  expect(voiceOf({ god: 'scout' })).toBe('am_adam')
  expect(voiceOf({ god: 'sales' })).toBe('am_michael')
  expect(voiceOf({ god: 'herald' })).toBe('bm_george')
  expect(voiceOf({ god: 'herald', voice: 'bf_isabella' })).toBe('bf_isabella')
  expect(toolsOf({})).toBe('full')
  expect(toolsOf({ tools: 'read' })).toBe('read')
  expect(toolsOf({ tools: ['Read', 'Grep'] })).toEqual(['Read', 'Grep'])
  expect(createText({ name: 'Scout', role: 'watch; repos\nand issues', god: 'scout' })).toBe(
    'Create worker: name=Scout; role=watch, repos and issues; avatar=lime; god=scout; voice=am_adam; tools=full',
  )
  expect(createText({ name: 'Scout', role: 'r', god: 'scout', tools: 'read' })).toMatch(/; tools=read$/)
})

test('a tool call reads as its tool and one short argument', async () => {
  const home = '/home/tester'
  expect(shortArg('Read', { file_path: '/home/tester/repo/a.ts' }, home)).toBe('~/repo/a.ts')
  expect(shortArg('Edit', { file_path: '/home/tester/one/two/three/four/five/six/seven/eight/file.tsx' }, home)).toBe('…/eight/file.tsx')
  expect(shortArg('Grep', { pattern: 'TODO', path: '/home/tester/src' }, home)).toBe('"TODO" in ~/src')
  expect(shortArg('Glob', { pattern: '**/*.md' }, home)).toBe('**/*.md')
  expect(shortArg('Bash', { command: 'npm test\nnpm run lint', description: 'Run the tests' }, home)).toBe('Run the tests')
  expect(shortArg('Bash', { command: 'ls -la\necho hi' }, home)).toBe('ls -la')
  expect(shortArg('WebFetch', { url: 'https://example.com/a' }, home)).toBe('example.com/a')
  expect(shortArg('WebSearch', { query: 'kokoro voices' }, home)).toBe('kokoro voices')
  expect(shortArg('mcp__srv__update_plan', { items: [] }, home)).toBe('')
  expect(shortArg('Bash', { command: 'x'.repeat(200) }, home)).toHaveLength(72)
  const steps = parseSteps([
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T06:00:00Z', message: { content: [
      { type: 'tool_use', id: 'a', name: 'mcp__srv__update_plan', input: {} },
      { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/home/tester/x' } },
    ] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }] } }),
  ].join('\n'), home, 10)
  expect(steps).toEqual([
    { id: 'b', tool: 'Read', arg: '~/x', atMs: Date.parse('2026-11-01T06:00:00Z') },
    { id: 'a', tool: 'update_plan', arg: '', atMs: Date.parse('2026-11-01T06:00:00Z') },
  ])
  const many = Array.from({ length: 15 }, (_, i) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `s${i}`, name: 'Bash', input: { description: `step ${i}` } }] } }),
  ).join('\n')
  expect(parseSteps(many, home, 10).map(s => s.arg)).toEqual(Array.from({ length: 10 }, (_, i) => `step ${14 - i}`))
})

// Every N hours: { days, every, from, to, tz }. Riyadh is UTC+3 all year; New York is
// UTC-5 from Sun 1 Nov 2026 (its clocks went back that morning).
const EVERY3 = { days: 'mon-fri', every: '3h', from: '09:00', to: '18:00', tz: 'Asia/Riyadh' }
const riyadh = (day: number, hhmm: string) => at(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00+03:00`)

test("Sales' once-a-day schedule is unchanged: the same due window, the same claim id, the same time", async () => {
  // Mon 2 Nov 09:05 Riyadh: the claim is wakes/sales-2026-11-02, as it always was.
  expect(dueSlot(WEEKDAYS, riyadh(2, '09:05'))).toEqual({ id: '2026-11-02', date: '2026-11-02', time: '09:00' })
  expect(dueSlot(WEEKDAYS, riyadh(2, '08:59'))).toBeUndefined()
  expect(dueSlot(WEEKDAYS, riyadh(2, '23:59'))?.id).toBe('2026-11-02')
  expect(dueSlot(WEEKDAYS, riyadh(7, '09:05'))).toBeUndefined() // Saturday
  for (const iso of ['2026-11-02T05:59:00Z', '2026-11-02T06:00:00Z', '2026-11-02T19:00:00Z', '2026-11-02T23:30:00Z', '2026-11-01T12:00:00Z']) {
    expect(dueSlot(WEEKDAYS, at(iso))?.id).toBe(dueDate(WEEKDAYS, at(iso)))
  }
})

test('every 3h within 9:00-18:00: one slot due at a time, each until the next', async () => {
  expect(intervalSlots(EVERY3)).toEqual([540, 720, 900, 1080]) // 9:00, 12:00, 15:00, 18:00 (inclusive)
  expect(dueSlot(EVERY3, riyadh(2, '08:59'))).toBeUndefined()
  expect(dueSlot(EVERY3, riyadh(2, '09:00'))).toEqual({ id: '2026-11-02-0900', date: '2026-11-02', time: '09:00' })
  expect(dueSlot(EVERY3, riyadh(2, '11:59'))?.id).toBe('2026-11-02-0900')
  expect(dueSlot(EVERY3, riyadh(2, '12:00'))?.id).toBe('2026-11-02-1200')
  expect(dueSlot(EVERY3, riyadh(2, '18:00'))?.id).toBe('2026-11-02-1800')
  // The last slot keeps one interval's grace for a late poll, never longer.
  expect(dueSlot(EVERY3, riyadh(2, '20:59'))?.id).toBe('2026-11-02-1800')
  expect(dueSlot(EVERY3, riyadh(2, '21:00'))).toBeUndefined()
  expect(dueSlot(EVERY3, riyadh(1, '12:00'))).toBeUndefined() // Sunday: off
  expect(dueSlot(EVERY3, riyadh(6, '12:00'))?.id).toBe('2026-11-06-1200') // Friday
})

test('the active window: no window is all day, a window ends at midnight, a malformed one never wakes', async () => {
  const allDay = { days: 'daily', every: '6h', tz: 'Asia/Riyadh' }
  expect(intervalSlots(allDay)).toEqual([0, 360, 720, 1080])
  expect(dueSlot(allDay, riyadh(1, '00:00'))?.id).toBe('2026-11-01-0000')
  expect(dueSlot(allDay, riyadh(1, '23:59'))?.id).toBe('2026-11-01-1800')
  expect(intervalSlots({ ...allDay, every: '12h' })).toEqual([0, 720])
  expect(intervalSlots({ ...allDay, every: '1h', from: '09:00', to: '18:00' })).toHaveLength(10)
  expect(intervalSlots({ ...allDay, every: '4h', from: '10:30' })).toEqual([630, 870, 1110, 1350]) // to the end of the day
  expect(intervalSlots({ ...allDay, every: '2h', from: '20:00', to: '06:00' })).toEqual([1200, 1320]) // never past midnight
  expect(intervalSlots({ ...allDay, every: '2h', from: '08:00', to: '24:00' })).toEqual([480, 600, 720, 840, 960, 1080, 1200, 1320])
  for (const bad of [{ every: '5x' }, { every: '0h' }, { every: '13h' }, { every: '3h', from: '9am' }, { every: '3h', from: '09:00', to: '25:00' }]) {
    expect(dueSlot({ ...allDay, ...bad }, riyadh(2, '12:00'))).toBeUndefined()
  }
  expect(dueSlot({ ...EVERY3, tz: 'Not/AZone' }, riyadh(2, '12:00'))).toBeUndefined()
})

test("slots follow the worker's own zone across day edges", async () => {
  const ny = { days: 'mon-fri', every: '2h', tz: 'America/New_York' }
  // Mon 2 Nov 00:30 New York is 05:30 UTC.
  expect(dueSlot(ny, at('2026-11-02T05:30:00Z'))).toEqual({ id: '2026-11-02-0000', date: '2026-11-02', time: '00:00' })
  // Mon 23:30 New York is already Tuesday in UTC: still Monday's 22:00 slot.
  expect(dueSlot(ny, at('2026-11-03T04:30:00Z'))?.id).toBe('2026-11-02-2200')
  // Fri 22:00 New York (Saturday in UTC) is a weekday there; Sun 22:00 (Monday in UTC) is not.
  expect(dueSlot(ny, at('2026-11-07T03:00:00Z'))?.id).toBe('2026-11-06-2200')
  expect(dueSlot(ny, at('2026-11-02T03:00:00Z'))).toBeUndefined()
  // Riyadh's Monday starts at 21:00 UTC on Sunday.
  const r = { days: 'mon-fri', every: '1h', tz: 'Asia/Riyadh' }
  expect(dueSlot(r, at('2026-11-01T20:59:00Z'))).toBeUndefined()
  expect(dueSlot(r, at('2026-11-01T21:30:00Z'))?.id).toBe('2026-11-02-0000')
})

test('no backlog burst: a pane away for hours wakes the latest slot once, the missed ones never', async () => {
  const fired = (from: string, to: string, gaps: [string, string][] = []) => {
    const ids: string[] = []
    for (let ms = riyadh(2, from); ms <= riyadh(2, to); ms += 60_000) {
      if (gaps.some(([a, b]) => ms >= riyadh(2, a) && ms < riyadh(2, b))) continue
      const id = dueSlot(EVERY3, ms)?.id
      if (id && !ids.includes(id)) ids.push(id)
    }
    return ids
  }
  // Polled every minute all day: each slot once.
  expect(fired('07:00', '23:00')).toEqual(['2026-11-02-0900', '2026-11-02-1200', '2026-11-02-1500', '2026-11-02-1800'])
  // Asleep 09:30 to 16:10: 12:00 never fires; 15:00 fires once, late.
  expect(fired('07:00', '23:00', [['09:30', '16:10']])).toEqual(['2026-11-02-0900', '2026-11-02-1500', '2026-11-02-1800'])
  // Away all morning, back at 16:10: one wake, not three.
  expect(fired('16:10', '16:20')).toEqual(['2026-11-02-1500'])
})

test('interval labels: the chip, the sentence and the Hours control edits', async () => {
  expect(scheduleLabel(EVERY3)).toBe('Every 3h · 9:00-18:00')
  expect(scheduleLabel({ days: 'daily', every: '2h', tz: 'UTC' })).toBe('Every 2h')
  expect(scheduleLabel({ days: 'daily', every: '6h', from: '07:00', tz: 'UTC' })).toBe('Every 6h · from 7:00')
  expect(chipLabel({ schedule: EVERY3 })).toBe('Every 3h · 9:00-18:00')
  expect(chipLabel({ schedule: EVERY3, paused: true })).toBe('Paused')
  expect(scheduleSentence(EVERY3)).toBe('Every 3h, 9:00-18:00, Mon to Fri')
  expect(scheduleSentence({ days: 'daily', every: '1h', tz: 'UTC' })).toBe('Every 1h, every day')
  expect(scheduleSentence(WEEKDAYS)).toBe('Mon to Fri at 9:00')
  expect(scheduleSentence({ days: 'daily', time: '07:30', tz: 'UTC' })).toBe('Every day at 7:30')

  // Once a day to every 3h: the documented shape, the default window, the days kept.
  const withExtra = { ...WEEKDAYS, note: 'kept' }
  expect(editSchedule(withExtra, { mode: '3h' }, 'UTC')).toEqual({ days: 'mon-fri', every: '3h', from: '09:00', to: '18:00', tz: 'Asia/Riyadh', note: 'kept' })
  // And back: once a day, the interval's keys gone.
  expect(editSchedule(EVERY3, { mode: 'daily' }, 'UTC')).toEqual({ days: 'mon-fri', time: '09:00', tz: 'Asia/Riyadh' })
  expect(editSchedule(EVERY3, { mode: '6h' }, 'UTC')).toEqual({ ...EVERY3, every: '6h' })
  expect(editSchedule(EVERY3, { from: '' }, 'UTC')).toEqual({ days: 'mon-fri', every: '3h', tz: 'Asia/Riyadh' })
  expect(editSchedule(EVERY3, { from: '19:00' }, 'UTC')).toEqual({ days: 'mon-fri', every: '3h', from: '19:00', tz: 'Asia/Riyadh' })
  expect(editSchedule(EVERY3, { to: '' }, 'UTC')).toEqual({ days: 'mon-fri', every: '3h', from: '09:00', tz: 'Asia/Riyadh' })
  expect(editSchedule(EVERY3, { days: 'sun-thu' }, 'UTC')).toEqual({ ...EVERY3, days: 'sun-thu' })
  expect(editSchedule(WEEKDAYS, { time: '07:30' }, 'UTC')).toEqual({ ...WEEKDAYS, time: '07:30' })
  expect(editSchedule(EVERY3, { mode: 'off' }, 'UTC')).toBeUndefined()
  expect(editSchedule(WEEKDAYS, { days: 'none' }, 'UTC')).toBeUndefined()
  expect(editSchedule(undefined, { mode: 'daily' }, 'Europe/Berlin')).toEqual({ days: 'mon-fri', time: '09:00', tz: 'Europe/Berlin' })
  expect(editSchedule(undefined, { mode: '2h' }, 'Europe/Berlin')).toEqual({ days: 'mon-fri', every: '2h', from: '09:00', to: '18:00', tz: 'Europe/Berlin' })
})
