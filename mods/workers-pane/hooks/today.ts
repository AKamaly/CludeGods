// The Today view's digest across every worker, as pure functions: what each worker did
// since local midnight (its finished turns, from `runs/<key>.jsonl`, and what it put in
// its outbox), newest first. What still waits for a yes is listed apart, with its buttons.

import type { Decision, OutboxItem, RunRecord } from '../types'

export type TodayEntry = {
  /** Unique within the digest, for a drawing key. */
  id: string
  key: string
  atMs: number
  kind: 'run' | 'stopped' | 'error' | 'note' | 'draft' | 'page'
  /** One line: what happened. */
  title: string
  /** One line under it: the start of the answer, or the item's state. */
  detail: string
}

/** Local midnight before `ms`, on this Mac's clock. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function firstLine(s: string, max = 120): string {
  const t = (s.split('\n').find(l => l.trim()) ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** What a turn was, from what it was asked: a scheduled run, Run now, an approval, a task. */
export function runLabel(asked: string): string {
  const a = asked.trim()
  if (!a) return 'Carried on'
  if (/^Scheduled (run|check-in)\b/.test(a)) return 'Scheduled run'
  if (/^Run now\b/.test(a)) return 'Run now'
  if (/^Approved in the Workers pane\b/.test(a)) return 'Acted on your approval'
  if (/^Declined:/.test(a)) return 'Dropped a declined draft'
  if (/^Changes requested\b/.test(a)) return 'Revised a draft'
  if (/^(Slack|[A-Z][a-z]+) message from\b/.test(a)) return firstLine(a, 80)
  return `Asked: ${firstLine(a, 80)}`
}

function atMs(at: string): number {
  const t = Date.parse(at)
  return Number.isNaN(t) ? 0 : t
}

/** The decision's words in the digest. */
function decisionWord(d: Decision | undefined): string {
  if (!d) return ''
  return d.decision === 'approved' ? 'approved' : d.decision === 'declined' ? 'declined' : 'asked for changes'
}

/**
 * Everything each worker did at or after `since`, newest first: its finished turns and
 * the outbox items that do not wait for a yes (notes, and drafts already decided).
 */
export function todayEntries(input: {
  keys: readonly string[]
  runs: Readonly<Record<string, readonly RunRecord[]>>
  outbox: Readonly<Record<string, readonly OutboxItem[]>>
  decided: Readonly<Record<string, Readonly<Record<string, Decision>>>>
  since: number
}): TodayEntry[] {
  const out: TodayEntry[] = []
  for (const key of input.keys) {
    ;(input.runs[key] ?? []).forEach((r, n) => {
      const t = atMs(r.at)
      if (t < input.since) return
      const kind = r.reason === 'answer' ? 'run' : r.reason === 'aborted' ? 'stopped' : 'error'
      const label = runLabel(r.asked)
      out.push({
        id: `run-${key}-${r.turn || n}`,
        key,
        atMs: t,
        kind,
        title: kind === 'run' ? label : kind === 'stopped' ? `Stopped: ${label}` : `Hit an error: ${label}`,
        detail: firstLine(r.answer),
      })
    })
    const decided = input.decided[key] ?? {}
    for (const item of input.outbox[key] ?? []) {
      const t = atMs(item.at)
      if (t < input.since) continue
      const d = decided[item.id]
      if (item.needs_approval && d === undefined) continue // listed under Needs your yes
      out.push({
        id: `item-${key}-${item.id}`,
        key,
        atMs: t,
        kind: item.kind,
        title: item.kind === 'note' ? `Noted: ${item.title}` : `Drafted ${item.title}`,
        detail: d ? `You ${decisionWord(d)}` : firstLine(item.body),
      })
    }
  }
  return out.sort((a, b) => b.atMs - a.atMs)
}
