// A worker's own chat, reporting on itself, as pure functions.
//
// The Workers pane is installed for every chat, so it also runs inside each worker's
// own chat. A chat finds itself in the registry by the desktop's id for it
// (CLAUDE_CODE_HOST_SESSION_ID, what the registry's `session` holds), or by its
// transcript's file name (`$.session.id()` + ".jsonl"). Once it knows it is a worker:
//
// - it fills in (or corrects, after a /clear) its own `transcript`, which the live
//   status, the Activity tab and the `guard` hook all key on. Before, nothing filled it
//   in, and a worker without one ran unguarded and showed "New" forever;
// - it writes `status/<key>.json` as each turn starts and ends (Working, Idle, Stopped,
//   an error), so the card no longer guesses from a file's mtime;
// - it appends one line per finished turn to `runs/<key>.jsonl`: what it was asked and
//   the start of its answer. The Today view reads those.
//
// A chat started by + New worker, before the registry knows its id, recognises itself by
// the standby prompt it was started with ("... a standing CludeGods worker (key x) ...").

import type { RegistryWorker, RunRecord, WorkerState } from '../types'

export const KEY_MAX = 24
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MARKER_RE = /standing CludeGods worker \(key ([a-z0-9][a-z0-9_-]{0,63})\)/

/** How long a "working" report holds with no sign of life in the transcript either. */
export const STALE_WORKING_MS = 15 * 60_000
const SETTLE_MS = 2_000
const ASKED_MAX = 140
const ANSWER_MAX = 600

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The text cut to `max` characters (lines kept, so its first line can lead). */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** A registry `transcript`'s file name ("" for none). */
export function transcriptName(t: unknown): string {
  return typeof t === 'string' ? (t.trim().split('/').pop() ?? '') : ''
}

/**
 * Which worker this chat is, and the registry change it owes: its `transcript` when the
 * entry lacks it or names another file (a /clear starts a new one). Only a match on the
 * desktop's chat id corrects a transcript; a match on the transcript alone is already right.
 */
export function whoAmI(
  workers: readonly Pick<RegistryWorker, 'key' | 'session' | 'transcript'>[],
  hostId: string,
  selfId: string,
): { key: string; patch?: { transcript: string } } | undefined {
  const mine = selfId ? `${selfId}.jsonl` : ''
  if (hostId) {
    const w = workers.find(x => typeof x.session === 'string' && x.session === hostId)
    if (w) return mine && transcriptName(w.transcript) !== mine ? { key: w.key, patch: { transcript: mine } } : { key: w.key }
  }
  if (mine) {
    const w = workers.find(x => transcriptName(x.transcript) === mine)
    if (w) return { key: w.key }
  }
  return undefined
}

/** The sentence a worker's standby prompt carries, by which its new chat knows itself. */
export function marker(key: string): string {
  return `standing CludeGods worker (key ${key})`
}

/** The prompt a new worker's chat starts with. */
export function standbyPrompt(w: { name: string; key: string; role?: string }): string {
  const role = (w.role ?? '').replace(/\s+/g, ' ').trim()
  return `You are ${w.name}, a ${marker(w.key)}${role ? `: ${role}` : ''}. Stand by for tasks from the Workers pane.`
}

/**
 * The worker key a turn's prompt names in its standby sentence, if any. The create
 * request itself quotes that sentence, so a prompt that is a create request is not one.
 */
export function markerKey(text: string): string | undefined {
  if (!text || text.includes('Create worker:')) return undefined
  const m = MARKER_RE.exec(text)
  return m?.[1]
}

/** A registry key from a worker's name: lowercase, a-z 0-9 and dashes, unique among `taken`. */
export function keyFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, KEY_MAX)
      .replace(/-+$/, '') || 'worker'
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const k = `${base.slice(0, KEY_MAX - String(n).length - 1)}-${n}`
    if (!used.has(k)) return k
  }
}

export function isKey(k: unknown): k is string {
  return typeof k === 'string' && KEY_RE.test(k)
}

/** The status a turn's start writes. */
export function startedState(text: string, now: number): WorkerState {
  const asked = oneLine(text.split('\n').find(l => l.trim()) ?? '', ASKED_MAX)
  return { state: 'working', at: now, since: now, ...(asked ? { asked } : {}) }
}

/** The status a turn's end writes, from why it ended. */
export function endedState(
  reason: RunRecord['reason'],
  started: WorkerState | undefined,
  now: number,
): WorkerState {
  const state: WorkerState['state'] = reason === 'answer' ? 'idle' : reason === 'aborted' ? 'stopped' : 'error'
  return { state, at: now, since: started?.since ?? now, ...(started?.asked ? { asked: started.asked } : {}) }
}

/** The run line a turn's end appends (one JSON line, newline included). */
export function runLine(e: {
  turnId: string
  reason: RunRecord['reason']
  durationMs: number
  answer: string
  asked: string
  now: number
}): string {
  const rec: RunRecord = {
    at: new Date(e.now).toISOString(),
    turn: e.turnId,
    reason: e.reason,
    durationMs: Math.max(0, Math.round(e.durationMs)),
    asked: oneLine(e.asked, ASKED_MAX),
    answer: clip(e.answer.trim(), ANSWER_MAX),
  }
  return `${JSON.stringify(rec)}\n`
}

/** A status file's text as a state, or undefined when it is not one. */
export function parseState(raw: string | undefined): WorkerState | undefined {
  if (!raw) return undefined
  try {
    const o = JSON.parse(raw) as Partial<WorkerState>
    if (o.state !== 'working' && o.state !== 'idle' && o.state !== 'stopped' && o.state !== 'error') return undefined
    if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return undefined
    return {
      state: o.state,
      at: o.at,
      since: typeof o.since === 'number' && Number.isFinite(o.since) ? o.since : o.at,
      ...(typeof o.asked === 'string' && o.asked ? { asked: o.asked } : {}),
    }
  } catch {
    return undefined
  }
}

/** A runs file's text (or its tail: a cut first line is skipped), oldest first. */
export function parseRuns(raw: string): RunRecord[] {
  const out: RunRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Partial<RunRecord>
      if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) continue
      const reason = o.reason === 'aborted' || o.reason === 'refusal' || o.reason === 'error' ? o.reason : 'answer'
      out.push({
        at: o.at,
        turn: typeof o.turn === 'string' ? o.turn : '',
        reason,
        durationMs: typeof o.durationMs === 'number' ? o.durationMs : 0,
        asked: typeof o.asked === 'string' ? o.asked : '',
        answer: typeof o.answer === 'string' ? o.answer : '',
      })
    } catch {
      // a cut first line, or a half-written one
    }
  }
  return out
}

/**
 * Working or not, and since when, from the worker's own report and its transcript's
 * mtime. A "working" report holds while either was written in the last
 * STALE_WORKING_MS (a long turn keeps writing its transcript); after that the chat is
 * taken to have gone away mid-turn. A transcript written in the last `windowMs` is
 * working whatever the report says (an older pane in that chat writes no reports).
 */
export function liveState(
  report: WorkerState | undefined,
  mtimeMs: number,
  now: number,
  windowMs: number,
): { isWorking: boolean; lastActiveMs: number; state?: WorkerState['state']; sinceMs?: number } {
  const lastActiveMs = Math.max(mtimeMs, report?.at ?? 0)
  const isFresh = now - mtimeMs < windowMs
  if (report?.state === 'working' && now - lastActiveMs < STALE_WORKING_MS) {
    return { isWorking: true, lastActiveMs, state: 'working', sinceMs: report.since }
  }
  // A turn's end writes the transcript and the report together: a report at least as
  // new as the transcript is the last word.
  const isSettled = report !== undefined && report.state !== 'working' && report.at >= mtimeMs - SETTLE_MS
  if (isFresh && !isSettled) return { isWorking: true, lastActiveMs }
  if (!report || report.state === 'working') return { isWorking: false, lastActiveMs }
  return { isWorking: false, lastActiveMs, state: report.state, sinceMs: report.since }
}
