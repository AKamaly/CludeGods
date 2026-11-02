// First run: the three steps of the Welcome view and `~/.voicemode/call/onboarding.json`,
// as pure functions.
//
//   { "done": ["worker", "memory", "voice"], "dismissed": false }
//
// The file may carry keys another part of CludeGods adds: a write keeps every one. A
// missing file means nothing done and not dismissed; a file that is not a JSON object is
// read the same way and never overwritten, so a hand edit in progress is never lost.

import type { Onboarding, OnboardingStep } from '../types'

export const STEPS: readonly OnboardingStep[] = ['worker', 'memory', 'voice']

/** Each step as the checklist names it. */
export const STEP_LABEL: Record<OnboardingStep, string> = {
  worker: 'First worker',
  memory: 'Memory rule',
  voice: 'Voice call',
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isStep(v: unknown): v is OnboardingStep {
  return v === 'worker' || v === 'memory' || v === 'voice'
}

/** onboarding.json's text (undefined: no file) as the steps done and the dismissal. Never throws. */
export function parseOnboarding(raw: string | undefined): Onboarding {
  if (raw === undefined) return { done: [], dismissed: false, exists: false }
  try {
    const doc = JSON.parse(raw) as unknown
    if (!isObject(doc)) return { done: [], dismissed: false, exists: true, error: 'onboarding.json is not a JSON object' }
    const done = Array.isArray(doc.done) ? [...new Set(doc.done.filter(isStep))] : []
    return { done, dismissed: doc.dismissed === true, exists: true }
  } catch {
    return { done: [], dismissed: false, exists: true, error: 'onboarding.json is not valid JSON' }
  }
}

/**
 * onboarding.json's new text with a step added to `done` and/or `dismissed` set, every
 * other key kept; or an error when the file is there and is not a JSON object.
 */
export function withOnboarding(
  raw: string | undefined,
  change: { done?: OnboardingStep; dismissed?: boolean },
): { text?: string; error?: string } {
  let doc: Record<string, unknown> = {}
  if (raw !== undefined && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isObject(parsed)) return { error: 'onboarding.json is not a JSON object' }
      doc = parsed
    } catch {
      return { error: 'onboarding.json is not valid JSON' }
    }
  }
  const done = Array.isArray(doc.done) ? doc.done.filter(isStep) : []
  if (change.done && !done.includes(change.done)) done.push(change.done)
  doc.done = done
  if (change.dismissed !== undefined) doc.dismissed = change.dismissed
  else if (typeof doc.dismissed !== 'boolean') doc.dismissed = false
  return { text: `${JSON.stringify(doc, null, 2)}\n` }
}

/**
 * The checklist: the steps done (recorded, or seen on this Mac: a worker in the
 * registry, a page in Memory), how many, and whether it is finished.
 */
export function progress(
  o: Pick<Onboarding, 'done'>,
  seen: Partial<Record<OnboardingStep, boolean>>,
): { done: OnboardingStep[]; count: number; total: number; isFinished: boolean } {
  const done = STEPS.filter(s => o.done.includes(s) || seen[s] === true)
  return { done, count: done.length, total: STEPS.length, isFinished: done.length === STEPS.length }
}

/** "1 of 3 done". */
export function progressLabel(count: number, total: number): string {
  return `${count} of ${total} done`
}

/**
 * Whether the checklist shows: until every step is done or it is dismissed. A file that
 * cannot be parsed hides it (nothing it says can be trusted, and it is never rewritten).
 */
export function showsChecklist(o: Onboarding, isFinished: boolean): boolean {
  return !o.error && !o.dismissed && !isFinished
}
