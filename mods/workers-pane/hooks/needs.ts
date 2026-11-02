// "Needs you": everything waiting on the owner, from four places, and the health strip,
// as pure functions.
//
// - Outbox items that need a yes (every worker's `outbox/<key>.jsonl` without a decision).
// - Permission requests the call card shows: `permit/<id>.json` with no `<id>.answer` yet.
//   Only a click on the call card answers them, so the pane offers Open, never Allow.
// - Scheduled wakes that did not go through: `wakes/<id>.retry` whose claim holds no
//   `result.json`. The pane retries those every 10 minutes by itself while the slot is
//   due; a slot that passed is not replayed, so its row offers Retry.
// - Health problems from `~/.claude/skills/gods/bin/cludegods doctor --json`:
//   `{"version", "voice_installed", "checks": [{"id", "label", "ok", "severity", "detail", "fix", "fix_label"}]}`.

import type { DoctorCheck, DoctorReport, NeedsItem } from '../types'

/** A permission request older than this is a leftover: the permit hook gives up after 50 s. */
export const PERMIT_FRESH_MS = 120_000
/** A wake that failed longer ago than this has left the list. */
export const WAKE_FRESH_MS = 24 * 60 * 60_000

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function check(v: unknown): DoctorCheck | undefined {
  if (!isObject(v)) return undefined
  const { id, label, ok, severity, detail, fix } = v
  if (typeof id !== 'string' || !id.trim() || typeof ok !== 'boolean') return undefined
  if (severity !== 'error' && severity !== 'warn' && severity !== 'info') return undefined
  const fixLabel = v.fix_label
  return {
    id: id.trim(),
    label: typeof label === 'string' && label.trim() ? label.trim() : id.trim(),
    ok,
    severity,
    detail: typeof detail === 'string' ? detail.trim() : '',
    fix: typeof fix === 'string' && fix.trim() ? fix.trim() : null,
    fix_label: typeof fixLabel === 'string' && fixLabel.trim() ? fixLabel.trim() : null,
  }
}

/**
 * `cludegods doctor --json`'s output as a report, or undefined when it is not one (no
 * CLI, an older one, a crash): the strip then hides. A check that is not well formed is
 * skipped; the rest stand.
 */
export function parseDoctor(stdout: string): DoctorReport | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    // a CLI that printed something before its JSON: take the last line that parses
    const last = text.split('\n').reverse().find(l => l.trim().startsWith('{'))
    if (!last) return undefined
    try {
      doc = JSON.parse(last)
    } catch {
      return undefined
    }
  }
  if (!isObject(doc) || !Array.isArray(doc.checks) || typeof doc.voice_installed !== 'boolean') return undefined
  return {
    version: typeof doc.version === 'string' ? doc.version : '',
    voice_installed: doc.voice_installed,
    checks: doc.checks.map(check).filter((c): c is DoctorCheck => c !== undefined),
  }
}

/** A failed check the owner should see: every error, and a warning only when it has a fix.
 * A warning with nothing to press is noise, so the pane neither lists it nor turns a dot amber. */
function needsOwner(c: DoctorCheck): boolean {
  return !c.ok && (c.severity === 'error' || (c.severity === 'warn' && !!c.fix))
}

/** The checks that need the owner, errors first. */
export function problems(report: DoctorReport | undefined): DoctorCheck[] {
  if (!report) return []
  const bad = report.checks.filter(needsOwner)
  return [...bad.filter(c => c.severity === 'error'), ...bad.filter(c => c.severity === 'warn')]
}

export type HealthGroup = 'voice' | 'listening' | 'workers' | 'setup'
export const HEALTH_GROUPS: readonly { id: HealthGroup; label: string }[] = [
  { id: 'voice', label: 'Voice' },
  { id: 'listening', label: 'Listening' },
  { id: 'workers', label: 'Workers' },
  { id: 'setup', label: 'Setup' },
]

/** Which dot of the strip a check belongs to, by the words in its id and label. */
export function groupOf(c: Pick<DoctorCheck, 'id' | 'label'>): HealthGroup {
  const s = `${c.id} ${c.label}`.toLowerCase()
  if (/whisper|stt|ears|listen|\bmic|microphone|vad|silero|hear|transcri/.test(s)) return 'listening'
  if (/voice|tts|kokoro|mlx|mouth|speak|speech|audio|pill|\bcall/.test(s)) return 'voice'
  if (/worker|registry|pane|guard|hook|pages|space|plugin|\bmods?\b|outbox|skill|config|settings/.test(s)) return 'workers'
  return 'setup'
}

/** One dot: green, amber, red, off (voice not installed) or none (no check of that kind). */
export type GroupState = 'ok' | 'warn' | 'error' | 'off' | 'none'

export function groupState(report: DoctorReport, group: HealthGroup): GroupState {
  if (!report.voice_installed && (group === 'voice' || group === 'listening')) return 'off'
  const mine = report.checks.filter(c => groupOf(c) === group)
  if (mine.length === 0) return 'none'
  if (mine.some(c => !c.ok && c.severity === 'error')) return 'error'
  if (mine.some(c => needsOwner(c) && c.severity === 'warn')) return 'warn'
  return 'ok'
}

/** A permission request the call card shows, as the pane lists it. */
export type PermitRecord = { id: string; title: string; tool: string; short: string; sessionId: string; atMs: number }

/** One `permit/<id>.json` (the permit hook's record), or undefined when it is not one. */
export function parsePermit(raw: string, fileId: string): PermitRecord | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isObject(doc)) return undefined
  const str = (k: string) => (typeof doc[k] === 'string' ? (doc[k] as string).trim() : '')
  const created = typeof doc.created === 'number' && Number.isFinite(doc.created) ? doc.created : 0
  return {
    id: str('id') || fileId,
    title: str('title'),
    tool: str('tool_name') || 'a tool',
    short: str('short'),
    sessionId: str('session_id'),
    // The hook writes seconds (time.time()); a value already in ms is taken as is.
    atMs: created > 1e12 ? created : created * 1000,
  }
}

const SLOT_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\d{4}))?$/

/**
 * A wake claim's id (`<key>-<YYYY-MM-DD>` once a day, `<key>-<YYYY-MM-DD>-<HHMM>` per
 * interval slot) as the worker it is for and its slot: the longest registry key that
 * leaves a slot behind it, so "repo" and "repo-2" never mix.
 */
export function wakeOf(id: string, keys: readonly string[]): { key: string; slot: string } | undefined {
  const fits = keys.filter(k => id.startsWith(`${k}-`) && SLOT_RE.test(id.slice(k.length + 1)))
  const key = fits.sort((a, b) => b.length - a.length)[0]
  return key === undefined ? undefined : { key, slot: id.slice(key.length + 1) }
}

/** A slot's time of day, "9:00", when it carries one (an interval slot); '' for a daily one. */
export function slotTime(slot: string): string {
  const m = SLOT_RE.exec(slot)
  if (!m?.[2]) return ''
  return `${Number(m[2].slice(0, 2))}:${m[2].slice(2)}`
}

/**
 * The Needs you list: permission requests first (they expire within a minute), then
 * the outbox items, newest first, then the wakes that did not go through, then health
 * problems, errors first.
 */
export function needsItems(input: {
  approvals: readonly { key: string; id: string; atMs: number }[]
  permits: readonly PermitRecord[]
  wakes: readonly { id: string; key: string; slot: string; retryAtMs: number; isRetrying: boolean; atMs: number }[]
  health?: DoctorReport
}): NeedsItem[] {
  const permits: NeedsItem[] = [...input.permits]
    .sort((a, b) => b.atMs - a.atMs)
    .map(p => ({ kind: 'permit', ...p }))
  const approvals: NeedsItem[] = [...input.approvals]
    .sort((a, b) => b.atMs - a.atMs)
    .map(a => ({ kind: 'approval', ...a }))
  const wakes: NeedsItem[] = [...input.wakes].sort((a, b) => b.atMs - a.atMs).map(w => ({ kind: 'wake', ...w }))
  const health: NeedsItem[] = problems(input.health).map(c => ({
    kind: 'health',
    id: c.id,
    label: c.label,
    detail: c.detail,
    severity: c.severity === 'error' ? 'error' : 'warn',
    fix: c.fix,
    fixLabel: c.fix_label,
    atMs: 0,
  }))
  return [...permits, ...approvals, ...wakes, ...health]
}

/** What the list holds, compactly: the poll's redraw trigger for the pane and the footer badge. */
export function needsSig(items: readonly NeedsItem[]): string {
  return items.map(i => `${i.kind}:${i.kind === 'approval' ? `${i.key}/${i.id}` : i.id}`).join('|')
}

/** The footer badge: "1 needs you", "3 need you", or '' with nothing waiting. */
export function needsBadge(n: number): string {
  return n <= 0 ? '' : n === 1 ? '1 needs you' : `${n} need you`
}
