// When the Workers pane wakes a worker, as pure functions: the slot due at a moment,
// the labels the card and the settings draw, and the edits the Hours control makes.
//
// A schedule is one of two shapes in workers.json, both in the IANA zone `tz` and on
// the weekdays `days` ("mon-fri", "sun-thu", "mon,wed,fri", "sat,sun", "daily"):
//
//   Once a day, as before:   { "days": "mon-fri", "time": "09:00", "tz": "Asia/Riyadh" }
//   Every N hours:           { "days": "mon-fri", "every": "3h", "from": "09:00", "to": "18:00", "tz": "Asia/Riyadh" }
//
// No `every` means once a day at `time`, unchanged. With `every` ("1h", "2h", "3h",
// "4h", "6h" or "12h") the day's slots start at `from` (00:00 when absent) and repeat
// every N hours through `to`, inclusive (the end of the day when absent; a window never
// crosses midnight, so a `to` not after `from` also means the end of the day).
//
// Each slot is woken once: the pane claims `wakes/<key>-<date>` for the once-a-day
// slot (the claim it has always used) and `wakes/<key>-<date>-<HHMM>` for an interval
// slot. A slot is due from its time until the next slot's time (or midnight), so a slot
// missed while the Mac slept fires once when the pane polls again, late, and the older
// missed slots never fire: no backlog burst. A once-a-day slot is due until midnight.

import type { Schedule } from '../types'

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_MINUTES = 24 * 60

/** The hour steps the Hours control offers. */
export const EVERY_HOURS = [1, 2, 3, 4, 6, 12] as const

/** The weekdays (0 = Sunday) a schedule's `days` names; ranges may wrap (fri-mon). */
export function scheduleDays(days: string): Set<number> {
  const s = days.trim().toLowerCase()
  if (s === 'daily' || s === 'every day' || s === '*') return new Set([0, 1, 2, 3, 4, 5, 6])
  const out = new Set<number>()
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(x => DOW.indexOf(x.trim().slice(0, 3)))
    if (a === undefined || a < 0) continue
    if (b === undefined) {
      out.add(a)
      continue
    }
    if (b < 0) continue
    for (let d = a; ; d = (d + 1) % 7) {
      out.add(d)
      if (d === b) break
    }
  }
  return out
}

const formats = new Map<string, Intl.DateTimeFormat>()

/** The wall clock in `tz` at `ms`: its date, weekday and minute of the day. */
export function zoned(ms: number, tz: string): { date: string; dow: number; minutes: number } | undefined {
  try {
    let f = formats.get(tz)
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      })
      formats.set(tz, f)
    }
    const parts = f.formatToParts(new Date(ms))
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      dow: DOW.indexOf(get('weekday').toLowerCase().slice(0, 3)),
      minutes: Number(get('hour')) * 60 + Number(get('minute')),
    }
  } catch {
    return undefined
  }
}

/** "HH:MM" as minutes of the day; "24:00" only where `isEnd`. Undefined when malformed. */
export function clockMinutes(t: unknown, isEnd = false): number | undefined {
  if (typeof t !== 'string') return undefined
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
  if (!m) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  if (min > 59 || h > 24 || (h === 24 && (!isEnd || min > 0))) return undefined
  return h * 60 + min
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Minutes of the day as "HH:MM". */
export function clockText(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/** An interval's hours: "3h" is 3. Whole hours 1 to 12; anything else is no interval. */
export function everyHours(every: unknown): number | undefined {
  if (typeof every !== 'string') return undefined
  const m = /^\s*(\d{1,2})\s*h\s*$/i.exec(every)
  if (!m) return undefined
  const n = Number(m[1])
  return n >= 1 && n <= 12 ? n : undefined
}

/** Whether a schedule wakes every N hours rather than once a day. */
export function isInterval(s: Pick<Schedule, 'every'>): boolean {
  return s.every !== undefined
}

/**
 * The minutes of the day an interval schedule's slots fall on, or undefined for a
 * malformed one (which then never wakes): `from`, then every N hours through `to`.
 */
export function intervalSlots(s: Schedule): number[] | undefined {
  const n = everyHours(s.every)
  if (!n) return undefined
  const start = s.from === undefined || s.from === '' ? 0 : clockMinutes(s.from)
  if (start === undefined || start >= DAY_MINUTES) return undefined
  let end = DAY_MINUTES - 1
  if (s.to !== undefined && s.to !== '') {
    const t = clockMinutes(s.to, true)
    if (t === undefined) return undefined
    if (t > start) end = Math.min(t, DAY_MINUTES - 1)
  }
  const out: number[] = []
  for (let m = start; m <= end; m += n * 60) out.push(m)
  return out
}

/**
 * The local date of today's once-a-day wake if it is due at `ms` (a scheduled day, at
 * or past its time), else undefined. A wake missed while the app was closed or the Mac
 * asleep still fires later that day; a day missed entirely is skipped, not replayed.
 */
export function dueDate(schedule: Schedule, ms: number): string | undefined {
  if (typeof schedule.time !== 'string') return undefined
  const m = /^(\d{1,2}):(\d{2})$/.exec(schedule.time.trim())
  if (!m) return undefined
  const z = zoned(ms, schedule.tz)
  if (!z || !scheduleDays(schedule.days).has(z.dow)) return undefined
  return z.minutes >= Number(m[1]) * 60 + Number(m[2]) ? z.date : undefined
}

/** One wake slot: `id` names its claim after the worker key, `time` goes in the wake text. */
export type Slot = { id: string; date: string; time: string }

/**
 * The slot due at `ms`, or undefined. Once a day: today's date while it is due (the
 * claim id the pane has always used). Every N hours: the latest slot at or before now,
 * while now is before the next slot (or midnight), as `<date>-<HHMM>`. At most one slot
 * is ever due, so however long the pane was away, one poll wakes a worker once.
 */
export function dueSlot(schedule: Schedule, ms: number): Slot | undefined {
  if (!isInterval(schedule)) {
    const date = dueDate(schedule, ms)
    return date ? { id: date, date, time: schedule.time ?? '' } : undefined
  }
  const n = everyHours(schedule.every)
  const slots = intervalSlots(schedule)
  if (!n || !slots) return undefined
  const z = zoned(ms, schedule.tz)
  if (!z || !scheduleDays(schedule.days).has(z.dow)) return undefined
  let hit: number | undefined
  for (const m of slots) if (m <= z.minutes) hit = m
  if (hit === undefined || z.minutes >= hit + n * 60) return undefined
  const time = clockText(hit)
  return { id: `${z.date}-${time.replace(':', '')}`, date: z.date, time }
}

/** A schedule's days, as the film writes them: "Mon to Fri", "Daily", "Mon, Wed, Fri". */
export function daysLabel(days: string): string {
  const s = days.trim().toLowerCase()
  if (s === 'daily' || s === 'every day' || s === '*') return 'Daily'
  const cap = (d: string) => d.trim().charAt(0).toUpperCase() + d.trim().slice(1, 3).toLowerCase()
  return s
    .split(',')
    .map(part => {
      const [a, b] = part.split('-')
      return b === undefined ? cap(a ?? '') : `${cap(a ?? '')} to ${cap(b)}`
    })
    .join(', ')
}

/** "9:00" from "09:00". */
export function shortTime(time: string): string {
  return time.trim().replace(/^0(\d)/, '$1')
}

/** An interval's active hours: "9:00-18:00", "from 9:00", "until 18:00", or '' all day. */
export function windowLabel(s: Pick<Schedule, 'from' | 'to'>): string {
  const from = typeof s.from === 'string' && s.from.trim() ? shortTime(s.from) : ''
  const to = typeof s.to === 'string' && s.to.trim() ? shortTime(s.to) : ''
  if (from && to) return `${from}-${to}`
  if (from) return `from ${from}`
  if (to) return `until ${to}`
  return ''
}

/** The schedule chip: "Mon to Fri · 9:00", or "Every 3h · 9:00-18:00", or "Every 3h". */
export function scheduleLabel(schedule: Schedule): string {
  if (isInterval(schedule)) {
    const n = everyHours(schedule.every)
    const head = n ? `Every ${n}h` : `Every ${String(schedule.every)}`
    const win = windowLabel(schedule)
    return win ? `${head} · ${win}` : head
  }
  return `${daysLabel(schedule.days)} · ${shortTime(schedule.time ?? '')}`
}

/** The whole schedule in words, days included: "Every 3h, 9:00-18:00, Mon to Fri". */
export function scheduleSentence(schedule: Schedule): string {
  const days = daysLabel(schedule.days)
  const on = days === 'Daily' ? 'every day' : days
  if (isInterval(schedule)) {
    const n = everyHours(schedule.every)
    const win = windowLabel(schedule)
    return [n ? `Every ${n}h` : `Every ${String(schedule.every)}`, win, on].filter(Boolean).join(', ')
  }
  return `${days === 'Daily' ? 'Every day' : days} at ${shortTime(schedule.time ?? '')}`
}

/** The chip's text: the schedule, "Paused" while paused, "Manual" with none. */
export function chipLabel(w: { schedule?: Schedule; paused?: boolean }): string {
  if (w.paused === true) return 'Paused'
  return w.schedule ? scheduleLabel(w.schedule) : 'Manual'
}

/** The Hours control's mode: 'off', 'daily', or the interval ("3h"). */
export function scheduleMode(s: Schedule | undefined): string {
  if (!s) return 'off'
  if (!isInterval(s)) return 'daily'
  const n = everyHours(s.every)
  return n ? `${n}h` : String(s.every)
}

/** What one pick in the Hours control changes. '' for `from` is all day; for `to`, the end of the day. */
export type ScheduleChange = { mode?: string; days?: string; time?: string; from?: string; to?: string }

/**
 * The schedule after one pick in the Hours control, from the one in effect: `off` (or
 * days `none`) removes it; `daily` is once a day at `time`; "Nh" every N hours within
 * `from`-`to`. Switching shape drops the other shape's keys, so the entry holds exactly
 * one of the two documented shapes; every key the pane does not know is kept.
 */
export function editSchedule(cur: Schedule | undefined, change: ScheduleChange, tz: string): Schedule | undefined {
  const mode = change.mode ?? scheduleMode(cur)
  if (mode === 'off' || change.days === 'none') return undefined
  const base: Record<string, unknown> = cur ? { ...cur } : {}
  const days = change.days ?? cur?.days ?? 'mon-fri'
  const zone = cur?.tz ?? tz
  if (mode === 'daily') {
    delete base.every
    delete base.from
    delete base.to
    const time = change.time ?? cur?.time ?? (cur?.from || '09:00')
    return { ...base, days, time, tz: zone } as Schedule
  }
  const n = everyHours(mode)
  if (!n) return cur
  const wasInterval = cur !== undefined && isInterval(cur)
  delete base.time
  const from = change.from !== undefined ? change.from : wasInterval ? (cur?.from ?? '') : '09:00'
  const to = change.to !== undefined ? change.to : wasInterval ? (cur?.to ?? '') : '18:00'
  const out: Record<string, unknown> = { ...base, days, every: `${n}h`, from, to, tz: zone }
  if (!from) {
    // All day: no window at all.
    delete out.from
    delete out.to
  } else if (!to || (clockMinutes(to, true) ?? 0) <= (clockMinutes(from) ?? 0)) {
    delete out.to
  }
  return out as Schedule
}

/** Half-hour slots for the once-a-day time, plus the current time when it is off the grid. */
export function timeOptions(current: string | undefined): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  for (let m = 0; m < DAY_MINUTES; m += 30) out.push({ value: clockText(m), label: shortTime(clockText(m)) })
  if (current && !out.some(o => o.value === current)) out.unshift({ value: current, label: shortTime(current) })
  return out
}

/** The Select value standing for "no start" (all day) and "no end" (the end of the day). */
export const ALL_DAY = 'all-day'
export const END_OF_DAY = 'end-of-day'

/** The active-hours start: all day, or a whole hour (the current one kept when off the grid). */
export function fromOptions(current: string | undefined): { value: string; label: string }[] {
  const out = [{ value: ALL_DAY, label: 'All day' }]
  for (let h = 0; h < 24; h++) out.push({ value: clockText(h * 60), label: shortTime(clockText(h * 60)) })
  if (current && !out.some(o => o.value === current)) out.splice(1, 0, { value: current, label: shortTime(current) })
  return out
}

/** The active-hours end: the end of the day, or a whole hour after the start. */
export function toOptions(from: string, current: string | undefined): { value: string; label: string }[] {
  const start = clockMinutes(from) ?? 0
  const out = [{ value: END_OF_DAY, label: 'End of day' }]
  for (let h = 1; h < 24; h++) if (h * 60 > start) out.push({ value: clockText(h * 60), label: shortTime(clockText(h * 60)) })
  if (current && !out.some(o => o.value === current)) out.splice(1, 0, { value: current, label: shortTime(current) })
  return out
}
