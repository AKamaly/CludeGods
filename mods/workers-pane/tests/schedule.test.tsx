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
  godOf,
  headsUp,
  legacyId,
  outboxLabel,
  pageSavedText,
  parseDecisions,
  parseOutbox,
  parseSteps,
  scheduleDays,
  scheduleLabel,
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
    'Create worker: name=Scout; role=watch, repos and issues; avatar=lime; god=scout; voice=am_adam; tools=drafts',
  )
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
