import { expect, test } from 'claude-code/testing'

import {
  createText,
  keyFor,
  liveState,
  markerKey,
  parseRuns,
  parseState,
  runLine,
  standbyPrompt,
  whoAmI,
} from '../hooks/register'
import { CALL, PANE, PROJ, REG, makeWorld, registryOf, settle, start } from './world'

// A worker's own chat reports on itself: it fills in its transcript (which the status,
// Activity and the guard key on), writes status/<key>.json as each turn starts and ends,
// and appends runs/<key>.jsonl. The pane draws that status.

const NOW = Date.parse('2026-11-02T10:00:00Z')
const HOST = 'local_aaaa-host'
const WORKERS = {
  note: 'kept',
  workers: [
    { key: 'scribe', name: 'Scribe', role: 'Drafts', session: HOST, transcript: null, god: 'scribe', model: 'm' },
    { key: 'other', name: 'Other', session: 'local_other', transcript: 'other-cli.jsonl' },
  ],
}

test('whoAmI: by the desktop id first (fixing the transcript), else by the transcript name', () => {
  const ws = [
    { key: 'a', session: 'local_a', transcript: 'old.jsonl' },
    { key: 'b', session: 'local_b', transcript: '-proj/b-cli.jsonl' },
    { key: 'c', session: 'local_c' },
  ]
  expect(whoAmI(ws, 'local_a', 'new')).toEqual({ key: 'a', patch: { transcript: 'new.jsonl' } })
  expect(whoAmI(ws, 'local_a', 'old')).toEqual({ key: 'a' })
  expect(whoAmI(ws, 'local_c', 'c-cli')).toEqual({ key: 'c', patch: { transcript: 'c-cli.jsonl' } })
  // No desktop id: the transcript name alone, never corrected from here.
  expect(whoAmI(ws, '', 'b-cli')).toEqual({ key: 'b' })
  expect(whoAmI(ws, '', 'zzz')).toBeUndefined()
  expect(whoAmI(ws, 'local_nobody', 'zzz')).toBeUndefined()
  expect(whoAmI(ws, 'local_c', '')).toEqual({ key: 'c' })
})

test('the standby prompt names the key; the create request quoting it never counts', () => {
  const prompt = standbyPrompt({ name: 'Herald', key: 'herald', role: 'announcements' })
  expect(prompt).toBe('You are Herald, a standing CludeGods worker (key herald): announcements. Stand by for tasks from the Workers pane.')
  expect(markerKey(prompt)).toBe('herald')
  expect(markerKey(`Some preface.\n${prompt}`)).toBe('herald')
  const request = createText({ name: 'Herald', role: 'announcements', god: 'herald', tools: 'full', key: 'herald' })
  expect(request).toContain(prompt)
  expect(request).toContain('start_session')
  expect(markerKey(request)).toBeUndefined()
  expect(markerKey('a standing worker (key herald)')).toBeUndefined()
  expect(markerKey('')).toBeUndefined()
})

test('keyFor: a lowercase slug, unique, short enough for every reader', () => {
  expect(keyFor('Scribe 2', [])).toBe('scribe-2')
  expect(keyFor('Scribe', ['scribe'])).toBe('scribe-2')
  expect(keyFor('Scribe', ['scribe', 'scribe-2'])).toBe('scribe-3')
  expect(keyFor('Café Ops', [])).toBe('cafe-ops')
  expect(keyFor('مساعد', [])).toBe('worker')
  expect(keyFor('مساعد', ['worker'])).toBe('worker-2')
  expect(keyFor('A very long worker name xx', []).length).toBeLessThanOrEqual(24)
  expect(keyFor('A very long worker name xx', [])).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
})

test('liveState: a working report holds while fresh, a settled one wins over a fresh mtime', () => {
  const report = { state: 'working' as const, at: NOW - 60_000, since: NOW - 180_000 }
  expect(liveState(report, NOW - 120_000, NOW, 10_000)).toEqual({ isWorking: true, lastActiveMs: NOW - 60_000, state: 'working', sinceMs: NOW - 180_000 })
  // Gone quiet for 15 minutes, both report and transcript: no longer working.
  expect(liveState({ ...report, at: NOW - 16 * 60_000 }, NOW - 16 * 60_000, NOW, 10_000).isWorking).toBe(false)
  // A long turn still writing its transcript keeps it working.
  expect(liveState({ ...report, at: NOW - 30 * 60_000 }, NOW - 5 * 60_000, NOW, 10_000).isWorking).toBe(true)
  // The turn's end wrote "idle" with the transcript: idle at once.
  expect(liveState({ state: 'idle', at: NOW - 1_000, since: NOW - 60_000 }, NOW - 1_500, NOW, 10_000)).toMatchObject({ isWorking: false, state: 'idle' })
  // No report: the mtime, as before.
  expect(liveState(undefined, NOW - 2_000, NOW, 10_000)).toEqual({ isWorking: true, lastActiveMs: NOW - 2_000 })
  expect(liveState(undefined, NOW - 60_000, NOW, 10_000)).toEqual({ isWorking: false, lastActiveMs: NOW - 60_000 })
  expect(parseState('{"state":"error","at":5}')).toEqual({ state: 'error', at: 5, since: 5 })
  expect(parseState('{"state":"busy","at":5}')).toBeUndefined()
  expect(parseState('nope')).toBeUndefined()
})

test('runLine and parseRuns round-trip, cut lines skipped, answers kept short', () => {
  const line = runLine({ turnId: 't1', reason: 'answer', durationMs: 1234.4, answer: `Done.\n${'x'.repeat(900)}`, asked: 'Run now', now: NOW })
  expect(line.endsWith('\n')).toBe(true)
  const [r] = parseRuns(`"cut":1}\n${line}not json\n`)
  expect(r).toMatchObject({ at: '2026-11-02T10:00:00.000Z', turn: 't1', reason: 'answer', durationMs: 1234, asked: 'Run now' })
  expect(r!.answer.length).toBeLessThanOrEqual(600)
  expect(r!.answer.startsWith('Done.\nxxx')).toBe(true)
})

test("a worker's own chat fills in its transcript; another chat writes nothing", async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: WORKERS, env: { CLAUDE_CODE_HOST_SESSION_ID: HOST }, self: 'scribe-cli' })
  await start($)
  await settle()
  const reg = registryOf(w)
  expect(reg.note).toBe('kept')
  expect(reg.workers[0]).toEqual({ ...WORKERS.workers[0], transcript: 'scribe-cli.jsonl' })
  expect(reg.workers[1]).toEqual(WORKERS.workers[1])
  // Once: the next poll finds it right.
  await start($)
  await settle()
  expect(w.writes.filter(x => x.path === REG)).toHaveLength(1)
})

test('after a /clear the same desktop chat has a new transcript, and the entry follows it', async ($, on) => {
  const reg = { workers: [{ ...WORKERS.workers[0], transcript: '-proj/scribe-old.jsonl' }] }
  const w = makeWorld(on, { now: NOW, registry: reg, env: { CLAUDE_CODE_HOST_SESSION_ID: HOST }, self: 'scribe-new' })
  await start($)
  await settle()
  expect(registryOf(w).workers[0]?.transcript).toBe('scribe-new.jsonl')
})

test('a chat that is no worker writes nothing, and its turns report nothing', async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: WORKERS, env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_someone-else' }, self: 'x' })
  await start($)
  await settle()
  await $.turn.start({ text: 'hello', turnId: 't1' })
  await $.turn.complete({ answer: 'hi', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.writes).toEqual([])
  expect(w.runs.filter(r => r.argv[0] === '/usr/bin/tee')).toEqual([])
})

test("each of a worker's turns writes its status and, at the end, one run line", async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: WORKERS, env: { CLAUDE_CODE_HOST_SESSION_ID: HOST }, self: 'scribe-cli' })
  await start($)
  await settle()
  await $.turn.start({ text: 'Scheduled run (2026-11-02 09:00 UTC): run your charter now.\nYour charter: ...', turnId: 't7' })
  expect(JSON.parse(w.files.get(`${CALL}/status/scribe.json`)!.text)).toEqual({
    state: 'working', at: NOW, since: NOW, asked: 'Scheduled run (2026-11-02 09:00 UTC): run your charter now.',
  })
  // A subagent's turn is not the worker's.
  await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'agent-1' })
  expect(JSON.parse(w.files.get(`${CALL}/status/scribe.json`)!.text).asked).toMatch(/^Scheduled run/)
  w.now = NOW + 90_000
  await $.turn.complete({ answer: 'Two drafts in the outbox.', durationMs: 90_000, isAborted: false, turnId: 't7', reason: 'answer' })
  expect(JSON.parse(w.files.get(`${CALL}/status/scribe.json`)!.text)).toEqual({
    state: 'idle', at: NOW + 90_000, since: NOW, asked: 'Scheduled run (2026-11-02 09:00 UTC): run your charter now.',
  })
  const appended = w.runs.filter(r => r.argv[0] === '/usr/bin/tee')
  expect(appended.map(r => r.argv)).toEqual([['/usr/bin/tee', '-a', `${CALL}/runs/scribe.jsonl`]])
  expect(parseRuns(w.files.get(`${CALL}/runs/scribe.jsonl`)!.text)).toEqual([{
    at: new Date(NOW + 90_000).toISOString(), turn: 't7', reason: 'answer', durationMs: 90_000,
    asked: 'Scheduled run (2026-11-02 09:00 UTC): run your charter now.', answer: 'Two drafts in the outbox.',
  }])
  // An interrupted turn reads as Stopped.
  await $.turn.start({ text: 'Long task', turnId: 't8' })
  await $.turn.complete({ answer: '', durationMs: 3, isAborted: true, turnId: 't8', reason: 'aborted' })
  expect(JSON.parse(w.files.get(`${CALL}/status/scribe.json`)!.text).state).toBe('stopped')
})

test('a new chat started with a standby prompt claims its entry: session and transcript', async ($, on) => {
  const reg = { workers: [{ key: 'herald', name: 'Herald', god: 'herald', tools: 'full' }, WORKERS.workers[1]] }
  const w = makeWorld(on, { now: NOW, registry: reg, env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_new-1' }, self: 'herald-cli' })
  await start($)
  await settle()
  expect(w.writes).toEqual([]) // nothing matches yet
  // The create request itself (in the creating chat) never claims anything.
  await $.turn.start({ text: createText({ name: 'Herald', role: '', god: 'herald', tools: 'full', key: 'herald' }), turnId: 'c1' })
  expect(w.writes).toEqual([])
  await $.turn.start({ text: standbyPrompt({ name: 'Herald', key: 'herald' }), turnId: 't1' })
  expect(registryOf(w).workers[0]).toEqual({
    key: 'herald', name: 'Herald', god: 'herald', tools: 'full', session: 'local_new-1', transcript: 'herald-cli.jsonl',
  })
  expect(JSON.parse(w.files.get(`${CALL}/status/herald.json`)!.text).state).toBe('working')
})

test("a standby prompt never takes an entry another chat holds", async ($, on) => {
  const reg = { workers: [{ key: 'herald', name: 'Herald', session: 'local_theirs' }] }
  const w = makeWorld(on, { now: NOW, registry: reg, env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_mine' }, self: 'mine' })
  await start($)
  await settle()
  await $.turn.start({ text: standbyPrompt({ name: 'Herald', key: 'herald' }), turnId: 't1' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.writes).toEqual([])
})

test('the card reads the worker\'s own report: Working for how long, an error, a stale report', async ($, on) => {
  const reg = {
    workers: [
      { key: 'a', name: 'Alpha', session: 'local_a', transcript: 'a.jsonl', god: 'scout' },
      { key: 'b', name: 'Beta', session: 'local_b', transcript: 'b.jsonl', god: 'scribe' },
      { key: 'c', name: 'Gamma', session: 'local_c', transcript: 'c.jsonl', god: 'herald' },
      { key: 'd', name: 'Delta', god: 'sales' },
    ],
  }
  const w = makeWorld(on, {
    now: NOW,
    registry: reg,
    files: {
      [`${CALL}/status/a.json`]: JSON.stringify({ state: 'working', at: NOW - 30_000, since: NOW - 4 * 60_000 }),
      [`${CALL}/status/b.json`]: JSON.stringify({ state: 'error', at: NOW - 5 * 60_000, since: NOW - 6 * 60_000 }),
      [`${CALL}/status/c.json`]: JSON.stringify({ state: 'working', at: NOW - 40 * 60_000, since: NOW - 41 * 60_000 }),
    },
  })
  for (const k of ['a', 'b', 'c']) w.files.set(`${PROJ}/${k}.jsonl`, { text: '', mtimeMs: NOW - 40 * 60_000 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const shown = async (text: string) => ui.find({ type: 'Text', text })
  expect((await shown('● Working · 4m'))?.props.color).toBe('#2f8f5b')
  expect((await shown('▲ Stopped on an error · 5m ago'))?.props.color).toBe('#c2412d')
  // Working, but nothing written by the chat or its transcript for 40 minutes: idle.
  expect(await shown('○ Idle · 40m ago')).toBeDefined()
  // An entry with no chat yet says so, and offers Start chat once selected.
  expect(await shown('◌ No chat yet')).toBeDefined()
  await ui.press({ key: 'feed-d' })
  await ui.press({ key: 'overview-d' })
  expect(await ui.find({ type: 'Text', text: /Its chat has not started yet/ })).toBeDefined()
  await ui.press({ key: 'start-d' })
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toMatch(/^Create worker: name=Delta; role=; avatar=orange; god=sales; voice=am_michael; tools=full; key=d\n/)
  expect(w.prompts[0]).toContain('standing CludeGods worker (key d)')
  expect(w.toasts).toContain("Press Enter to start Delta's chat")
  await ui.unmount()
})
