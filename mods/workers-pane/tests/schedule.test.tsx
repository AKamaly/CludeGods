import { expect, test } from 'claude-code/testing'

import { badge, dueDate, headsUp, outboxLabel, scheduleDays, scheduleLabel, wakeText } from '../hooks/register'

const WEEKDAYS = { days: 'mon-fri', time: '09:00', tz: 'Asia/Tokyo' }
// Tokyo is UTC+9 all year.
const at = (iso: string) => Date.parse(iso)

test('a weekday schedule is due from its time in its own zone, on its days only', async () => {
  // Mon 2 Nov 2026, 08:59 and 09:00 Tokyo.
  expect(dueDate(WEEKDAYS, at('2026-11-01T23:59:00Z'))).toBeUndefined()
  expect(dueDate(WEEKDAYS, at('2026-11-02T00:00:00Z'))).toBe('2026-11-02')
  // Late the same day still counts (the app was closed at 09:00).
  expect(dueDate(WEEKDAYS, at('2026-11-02T13:00:00Z'))).toBe('2026-11-02')
  // 16:30 UTC Monday is already Tuesday 01:30 in Tokyo: before its time.
  expect(dueDate(WEEKDAYS, at('2026-11-02T16:30:00Z'))).toBeUndefined()
  // Sun 1 Nov and Sat 7 Nov are off.
  expect(dueDate(WEEKDAYS, at('2026-11-01T03:00:00Z'))).toBeUndefined()
  expect(dueDate(WEEKDAYS, at('2026-11-07T03:00:00Z'))).toBeUndefined()
  expect(dueDate({ ...WEEKDAYS, tz: 'Not/AZone' }, at('2026-11-02T12:00:00Z'))).toBeUndefined()
  expect(dueDate({ ...WEEKDAYS, time: '9am' }, at('2026-11-02T12:00:00Z'))).toBeUndefined()
})

test('days parse ranges, lists, wraps and daily', async () => {
  expect([...scheduleDays('mon-fri')].sort()).toEqual([1, 2, 3, 4, 5])
  expect([...scheduleDays('sun-thu')].sort()).toEqual([0, 1, 2, 3, 4])
  expect([...scheduleDays('fri-mon')].sort()).toEqual([0, 1, 5, 6])
  expect([...scheduleDays('mon,wed,fri')].sort()).toEqual([1, 3, 5])
  expect(scheduleDays('daily').size).toBe(7)
  expect(scheduleDays('nonsense').size).toBe(0)
})

test('labels, badges, heads-up lines and the wake text', async () => {
  expect(scheduleLabel(WEEKDAYS)).toBe('Mon–Fri · 9:00')
  expect(scheduleLabel({ days: 'daily', time: '07:30', tz: 'America/New_York' })).toBe('Daily · 7:30')
  expect(scheduleLabel({ days: 'mon,wed,fri', time: '14:00', tz: 'UTC' })).toBe('Mon, Wed, Fri · 14:00')
  const d = { at: '2026-11-02T06:10:00Z', kind: 'draft' as const, title: 'A reply to Jordan', body: '', needs_approval: true }
  const n = { ...d, kind: 'note' as const, title: 'Globex went quiet', needs_approval: false }
  expect(badge([d, n], 0)).toBe('1 draft')
  expect(outboxLabel([d], 0, false)).toBe('Outbox · 1 draft')
  expect(outboxLabel([], 0, false)).toBe('Outbox')
  expect(outboxLabel([d], 0, true)).toBe('Hide outbox')
  expect(badge([n, n], 0)).toBe('2 notes')
  expect(badge([d], at('2026-11-02T07:00:00Z'))).toBe('')
  expect(headsUp('Sales', d)).toBe('Sales drafted a reply to Jordan')
  expect(headsUp('Sales', n)).toBe('Sales has a note: Globex went quiet')
  const text = wakeText({ key: 'sales', name: 'Sales', charter: 'CHARTER BODY' }, 'Scheduled run (2026-11-02 09:00 Asia/Tokyo)')
  expect(text).toMatch(/^Scheduled run \(2026-11-02 09:00 Asia\/Tokyo\): run your charter now\./)
  expect(text).toContain('Drafts only')
  expect(text.endsWith('CHARTER BODY')).toBe(true)
})
