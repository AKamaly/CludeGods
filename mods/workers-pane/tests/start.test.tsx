import { expect, test } from 'claude-code/testing'

import {
  TEMPLATES,
  freeName,
  groupOf,
  groupState,
  needsBadge,
  needsItems,
  needsSig,
  parseDoctor,
  parseOnboarding,
  parsePermit,
  problems,
  progress,
  showsChecklist,
  slotTime,
  startOfDay,
  templateCharter,
  wakeOf,
  withOnboarding,
} from '../hooks/register'
import { CALL, HOME, PANE, REG, makeWorld, registryOf, settle, start } from './world'

// v0.5, the two-minute start: Welcome and the first-run checklist, worker templates, the
// Needs you list across its four sources, the health strip over `cludegods doctor`, and
// the plain words in the labels.

const DAY = startOfDay(Date.parse('2026-11-02T12:00:00Z'))
const NOW = DAY + 13 * 3_600_000
const ISO = (ms: number) => new Date(ms).toISOString()
const BIN = `${HOME}/.claude/skills/gods/bin`
const CLI = `${BIN}/cludegods`
const ONBOARDING = `${CALL}/onboarding.json`
const GREEN = '#2f8f5b'
const AMBER = '#b7791f'
const RED = '#c2412d'

const TWO = {
  workers: [
    { key: 'alpha', name: 'Alpha', role: 'Inbox', session: 'local_alpha', transcript: 'alpha.jsonl', god: 'sales',
      schedule: { days: 'mon-fri', time: '09:00', tz: 'Asia/Riyadh' } },
    { key: 'beta', name: 'Beta', role: 'Research', session: 'local_beta', transcript: 'beta-cli.jsonl', god: 'research' },
  ],
}
const DRAFT = { id: 'ob_00000000000a', at: ISO(NOW - 20 * 60_000), kind: 'draft', title: 'a reply to the venue', body: 'Hi', to: 'events@example.com', needs_approval: true }

const check = (id: string, label: string, ok: boolean, severity: string, fix: string | null = null, fixLabel: string | null = null, detail = '') =>
  ({ id, label, ok, severity, detail, fix, fix_label: fixLabel })
const REPORT = {
  version: '0.5.0',
  voice_installed: true,
  checks: [
    check('voicemode', 'VoiceMode installed', true, 'error'),
    check('kokoro', 'Voice service (mlx-audio)', true, 'error'),
    check('whisper', 'Whisper (speech to text)', false, 'error', 'voicemode service start whisper', 'Start it', 'nothing on port 2022'),
    check('workers-registry', 'Workers registry', false, 'warn', 'write an empty registry', 'Create it'),
    check('hooks', 'Hooks in settings.json', true, 'warn'),
    check('bluetooth', 'Bluetooth patch', false, 'info', null, null, 'not applied'),
  ],
}

/** A fake `cludegods`: doctor prints `report()`, a fix answers `fix(id)`. Every run is recorded in `w.runs`. */
function fakeCli(w: ReturnType<typeof makeWorld>, report: () => unknown, fix: (id: string) => number = () => 0) {
  w.files.set(CLI, { text: '#!/bin/sh\n', mtimeMs: NOW - 600_000 })
  w.run = argv => {
    if (argv[0] !== CLI) return undefined
    if (argv[1] === 'doctor' && argv[2] === '--json') return { exitCode: 0, stdout: `${JSON.stringify(report())}\n` }
    if (argv[1] === 'doctor' && argv[2] === '--fix') {
      const code = fix(argv[3] ?? '')
      return code === 0 ? { exitCode: 0, stdout: 'fixed\n' } : { exitCode: code, stderr: 'voicemode: whisper failed to start\n' }
    }
    return { exitCode: 2, stderr: 'unknown command' }
  }
}
/** The Text drawn right after `label`: the health strip's dot beside its part's name. */
async function dotAfter(ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }, label: string) {
  const texts = await ui.findAll({ type: 'Text' })
  // The last one: the header's own "Workers" comes first.
  const at = texts.map(t => t.text).lastIndexOf(label)
  return at < 0 ? undefined : texts[at + 1]
}
/** The checklist's "N of 3 done". */
async function doneCount(ui: { find: (q: { type: string; text: RegExp }) => Promise<{ text: string } | undefined> }) {
  return (await ui.find({ type: 'Text', text: /^\d of 3 done$/ }))?.text
}
const doctorRuns = (w: ReturnType<typeof makeWorld>) => w.runs.filter(r => r.argv[0] === CLI && r.argv[1] === 'doctor' && r.argv[2] === '--json').length

// ---- pure parts

test('onboarding.json: parsed safely, a step and a dismissal written with every other key kept', () => {
  expect(parseOnboarding(undefined)).toEqual({ done: [], dismissed: false, exists: false })
  expect(parseOnboarding('{"done": ["worker", "bogus", "worker"], "dismissed": true}')).toEqual({ done: ['worker'], dismissed: true, exists: true })
  expect(parseOnboarding('{"done": [').error).toBe('onboarding.json is not valid JSON')
  expect(parseOnboarding('[1]').error).toBe('onboarding.json is not a JSON object')

  const raw = JSON.stringify({ done: ['voice'], theme: 'dark', extra: { a: 1 } })
  expect(JSON.parse(withOnboarding(raw, { done: 'memory' }).text ?? '')).toEqual({ done: ['voice', 'memory'], theme: 'dark', extra: { a: 1 }, dismissed: false })
  expect(JSON.parse(withOnboarding(raw, { done: 'voice' }).text ?? '').done).toEqual(['voice'])
  expect(JSON.parse(withOnboarding(undefined, { dismissed: true }).text ?? '')).toEqual({ done: [], dismissed: true })
  expect(withOnboarding('{"done": [', { done: 'worker' })).toEqual({ error: 'onboarding.json is not valid JSON' })

  // Steps count when recorded or seen; the checklist shows until all three or a dismissal.
  const p = progress({ done: ['voice'] }, { worker: true, memory: false })
  expect(p).toEqual({ done: ['worker', 'voice'], count: 2, total: 3, isFinished: false })
  expect(showsChecklist(parseOnboarding(undefined), false)).toBe(true)
  expect(showsChecklist(parseOnboarding('{"dismissed": true}'), false)).toBe(false)
  expect(showsChecklist(parseOnboarding(undefined), true)).toBe(false)
  expect(showsChecklist(parseOnboarding('nope'), false)).toBe(false)
})

test('templates: six ready-made workers, valid names, instructions that keep anything outward for a yes', () => {
  expect(TEMPLATES.map(t => t.name)).toEqual(['Inbox triage', 'Daily brief', 'Repo watcher', 'Research', 'Release notes', 'Meeting prep'])
  for (const t of TEMPLATES) {
    expect(t.name).toMatch(/^[\p{L}\p{N} ]{1,24}$/u)
    expect(t.role.length).toBeGreaterThan(10)
    const text = templateCharter(t, t.name, 'k-1')
    expect(text).toContain(`You are ${t.name}`)
    expect(text).toContain('~/.voicemode/call/outbox/k-1.jsonl')
    expect(text).toContain('needs_approval true')
    expect(text).toContain('Never do anything outward that was not approved.')
    expect(text).not.toMatch(/—/) // the house style: no em dashes
  }
  // Research works when asked; every other one has hours.
  expect(TEMPLATES.filter(t => !t.hours).map(t => t.id)).toEqual(['research'])
  expect(freeName('Research', ['research', 'Research 2'])).toBe('Research 3')
  expect(freeName('Daily brief', ['Scribe'])).toBe('Daily brief')
})

test('doctor --json: the contract parsed, junk refused, malformed checks skipped, grouped for the strip', () => {
  const report = parseDoctor(JSON.stringify(REPORT))
  expect(report?.checks).toHaveLength(6)
  expect(parseDoctor('')).toBeUndefined()
  expect(parseDoctor('Usage: cludegods doctor')).toBeUndefined()
  expect(parseDoctor(JSON.stringify({ version: '1', checks: [] }))).toBeUndefined() // no voice_installed
  // A line printed before the JSON is tolerated; a check without an id or a known severity is not.
  const noisy = parseDoctor(`warming up\n${JSON.stringify({ ...REPORT, checks: [...REPORT.checks, { id: '', ok: false }, { id: 'x', ok: false, severity: 'fatal' }] })}`)
  expect(noisy?.checks.map(c => c.id)).toEqual(REPORT.checks.map(c => c.id))
  // Errors first, then warnings; info never needs you.
  expect(problems(report).map(c => c.id)).toEqual(['whisper', 'workers-registry'])
  expect(TEMPLATES.length).toBe(6)
  expect(['voicemode', 'kokoro', 'whisper', 'workers-registry', 'hooks', 'bluetooth'].map(id => groupOf(report!.checks.find(c => c.id === id)!))).toEqual([
    'voice', 'voice', 'listening', 'workers', 'workers', 'setup',
  ])
  expect(groupState(report!, 'voice')).toBe('ok')
  expect(groupState(report!, 'listening')).toBe('error')
  expect(groupState(report!, 'workers')).toBe('warn')
  expect(groupState({ ...report!, voice_installed: false }, 'voice')).toBe('off')
  expect(groupState({ ...report!, checks: [] }, 'workers')).toBe('none')
})

test('needs you, pure: permits, wake ids, the order of the four sources, the badge', () => {
  expect(parsePermit(JSON.stringify({ id: 'p1', created: 1_700_000_000.5, title: 'Fix the build', tool_name: 'Bash', short: 'npm test', session_id: 's' }), 'f')).toEqual({
    id: 'p1', title: 'Fix the build', tool: 'Bash', short: 'npm test', sessionId: 's', atMs: 1_700_000_000_500,
  })
  expect(parsePermit('not json', 'f')).toBeUndefined()
  // "repo" and "repo-2" never mix; a date with no slot is not a wake.
  expect(wakeOf('repo-2-2026-11-02-0900', ['repo', 'repo-2'])).toEqual({ key: 'repo-2', slot: '2026-11-02-0900' })
  expect(wakeOf('repo-2026-11-02', ['repo', 'repo-2'])).toEqual({ key: 'repo', slot: '2026-11-02' })
  expect(wakeOf('ghost-2026-11-02', ['repo'])).toBeUndefined()
  expect(slotTime('2026-11-02-0900')).toBe('9:00')
  expect(slotTime('2026-11-02')).toBe('')

  const items = needsItems({
    approvals: [{ key: 'a', id: 'ob_1', atMs: 1 }, { key: 'b', id: 'ob_2', atMs: 2 }],
    permits: [{ id: 'p', title: '', tool: 'Bash', short: '', sessionId: '', atMs: 5 }],
    wakes: [{ id: 'a-2026-11-02', key: 'a', slot: '2026-11-02', retryAtMs: 9, isRetrying: true, atMs: 3 }],
    health: parseDoctor(JSON.stringify(REPORT)),
  })
  expect(needsSig(items)).toBe('permit:p|approval:b/ob_2|approval:a/ob_1|wake:a-2026-11-02|health:whisper|health:workers-registry')
  expect([needsBadge(0), needsBadge(1), needsBadge(4)]).toEqual(['', '1 needs you', '4 need you'])
})

// ---- Welcome and the first-run checklist

test('Welcome: with no workers the pane opens on it; Memory and voice are one click each', async ($, on) => {
  const w = makeWorld(on, { now: NOW, files: { [`${BIN}/call`]: '#!/bin/sh\n' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'welcome' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^CludeGods puts a voice and always-on workers into Claude Code/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Box' })).map(b => b.key).filter(k => k?.startsWith('welcome-card-'))).toEqual([
    'welcome-card-worker', 'welcome-card-memory', 'welcome-card-voice',
  ])
  expect(await doneCount(ui)).toBe('0 of 3 done')
  // No doctor (an older install), but the call script is there: voice counts as installed.
  expect(await ui.find({ key: 'health' })).toBeUndefined()
  expect((await ui.find({ key: 'welcome-voice' }))?.props.label).toBe('Start a call')

  // Write your first Memory rule: the Spaces pane is asked to open Memory on a new page.
  await ui.press({ key: 'welcome-memory' })
  expect(JSON.parse(w.files.get(`${CALL}/open-spaces`)!.text)).toEqual({ at: NOW, space: 'memory', action: 'new-page' })
  expect(JSON.parse(w.files.get(ONBOARDING)!.text)).toEqual({ done: ['memory'], dismissed: false })
  expect(await doneCount(ui)).toBe('1 of 3 done')
  expect((await ui.find({ type: 'Text', text: '✓ Memory rule' }))?.props.color).toBe(GREEN)

  // Try a voice call: /gods in the prompt box, for the person's own Enter.
  await ui.press({ key: 'welcome-voice' })
  expect(w.prompts).toEqual(['/gods'])
  expect(w.toasts.at(-1)).toBe('Press Enter to start the call')
  expect(JSON.parse(w.files.get(ONBOARDING)!.text).done).toEqual(['memory', 'voice'])

  // Create your first worker: the picker; one template makes the card and the request.
  await ui.press({ key: 'welcome-worker' })
  expect(await ui.find({ key: 'new-picker' })).toBeDefined()
  await ui.press({ key: 'tpl-brief' })
  expect(await ui.find({ key: 'welcome' })).toBeUndefined()
  expect(await ui.find({ key: 'card-daily-brief' })).toBeDefined()
  // All three done: the checklist is gone.
  expect(JSON.parse(w.files.get(ONBOARDING)!.text).done).toEqual(['memory', 'voice', 'worker'])
  expect(await ui.find({ key: 'onboarding' })).toBeUndefined()
  await ui.unmount()
})

test('the checklist stays on top with workers until dismissed, keeping every key in onboarding.json', async ($, on) => {
  const w = makeWorld(on, {
    now: NOW,
    registry: TWO,
    files: { [ONBOARDING]: JSON.stringify({ done: [], dismissed: false, seenAt: 12 }), [`${CALL}/spaces/memory/tone.md`]: '# Tone\n' },
  })
  w.dirs.set(`${CALL}/spaces/memory`, NOW)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A worker and a Memory page already there count as done.
  expect(await ui.find({ key: 'card-alpha' })).toBeDefined()
  expect(await doneCount(ui)).toBe('2 of 3 done')
  expect((await ui.find({ type: 'Text', text: '○ Voice call' }))?.props.dimColor).toBe(true)
  // Show opens Welcome; Go to workers comes back.
  await ui.press({ key: 'onboarding-show' })
  expect(await ui.find({ key: 'welcome' })).toBeDefined()
  expect(await ui.find({ key: 'onboarding-show' })).toBeUndefined()
  await ui.press({ key: 'welcome-workers' })
  expect(await ui.find({ key: 'card-alpha' })).toBeDefined()

  await ui.press({ key: 'onboarding-dismiss' })
  expect(await ui.find({ key: 'onboarding' })).toBeUndefined()
  expect(JSON.parse(w.files.get(ONBOARDING)!.text)).toEqual({ done: [], dismissed: true, seenAt: 12 })
  await ui.unmount()
})

test("Memory's seeded welcome page is no rule: the step stays open until a rule is written", async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: TWO, files: { [`${CALL}/spaces/memory/welcome.md`]: '# About Memory\n' } })
  w.dirs.set(`${CALL}/spaces/memory`, NOW)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await doneCount(ui)).toBe('1 of 3 done')
  expect((await ui.find({ type: 'Text', text: '○ Memory rule' }))?.props.dimColor).toBe(true)
  await ui.unmount()
})

test('a first run begun and not finished opens on Welcome; an upgrade with workers and no file does not', async ($, on) => {
  makeWorld(on, { now: NOW, registry: TWO, files: { [ONBOARDING]: JSON.stringify({ done: ['worker'] }) } })
  await start($)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'welcome' })).toBeDefined()
  expect(await ui.find({ key: 'welcome-workers' })).toBeDefined()
  await ui.unmount()
})

test('an upgrade with workers and no onboarding.json stays on the workers', async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: TWO })
  await start($)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'welcome' })).toBeUndefined()
  expect(await ui.find({ key: 'card-alpha' })).toBeDefined()
  expect(await ui.find({ key: 'onboarding' })).toBeDefined()
  // No doctor installed: nothing ran it, and the strip stays hidden.
  expect(doctorRuns(w)).toBe(0)
  expect(await ui.find({ key: 'health' })).toBeUndefined()
  await ui.unmount()
})

test('an onboarding.json that is not JSON is never overwritten, and hides the checklist', async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: TWO, files: { [ONBOARDING]: '{"done": [' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'onboarding' })).toBeUndefined()
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'tpl-research' })
  expect(w.files.get(ONBOARDING)!.text).toBe('{"done": [')
  await ui.unmount()
})

// ---- templates

test('a template is one click: the card with its hours and instructions, and the start request', async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: TWO })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  // Six templates, then Blank worker; no blank form until it is asked for.
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => /^tpl-|^nw-blank$/.test(k ?? ''))).toEqual([
    'tpl-inbox', 'tpl-brief', 'tpl-repo', 'tpl-research', 'tpl-release', 'tpl-meetings', 'nw-blank',
  ])
  expect(await ui.find({ key: 'nw-entry' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Sorts new mail and drafts the replies that need you/ })).toBeDefined()

  await ui.press({ key: 'tpl-inbox' })
  const entry = registryOf(w).workers.at(-1)!
  expect(entry).toMatchObject({
    key: 'inbox-triage', name: 'Inbox triage', role: 'Sorts new mail and drafts replies; sends only after your yes',
    god: 'sales', avatar: 'orange', voice: 'am_michael', tools: 'full', template: 'inbox', created: ISO(NOW),
    // Its hours in the zone the other workers use.
    schedule: { days: 'mon-fri', every: '3h', from: '09:00', to: '18:00', tz: 'Asia/Riyadh' },
  })
  expect(String(entry.charter)).toMatch(/^You are Inbox triage, a standing inbox worker\. Each run:/)
  expect(String(entry.charter)).toContain('~/.voicemode/call/outbox/inbox-triage.jsonl')
  // The registry keeps every other entry; the card shows, selected, with no chat yet.
  expect(registryOf(w).workers.slice(0, 2)).toEqual(TWO.workers)
  expect((await ui.find({ key: 'card-inbox-triage' }))?.props.borderColor).toBe('#ea580c')
  expect((await ui.find({ key: 'hours-inbox-triage' }))?.props.label).toBe('Every 3h · 9:00-18:00')
  expect(await ui.find({ key: 'new-picker' })).toBeUndefined()
  expect(w.prompts[0]?.split('\n')[0]).toBe(
    'Create worker: name=Inbox triage; role=Sorts new mail and drafts replies, sends only after your yes; avatar=orange; god=sales; voice=am_michael; tools=full; key=inbox-triage',
  )
  expect(w.toasts.at(-1)).toBe("Press Enter to start Inbox triage's chat")

  // The same template again: a free name and key, its instructions point at its own outbox.
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'tpl-inbox' })
  const second = registryOf(w).workers.at(-1)!
  expect([second.key, second.name]).toEqual(['inbox-triage-2', 'Inbox triage 2'])
  expect(String(second.charter)).toContain('~/.voicemode/call/outbox/inbox-triage-2.jsonl')
  // Research works when asked: no schedule.
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'tpl-research' })
  expect(registryOf(w).workers.at(-1)).toMatchObject({ key: 'research', god: 'research', voice: 'af_nicole' })
  expect('schedule' in registryOf(w).workers.at(-1)!).toBe(false)
  // Blank worker is still there, and Templates goes back.
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'nw-blank' })
  expect(await ui.find({ key: 'nw-entry' })).toBeDefined()
  await ui.press({ key: 'nw-templates' })
  expect(await ui.find({ key: 'new-picker' })).toBeDefined()
  await ui.unmount()
})

test('a template follows the default tools from config.json', async ($, on) => {
  const w = makeWorld(on, { now: NOW, files: { [`${CALL}/config.json`]: JSON.stringify({ workers: { default_tools: 'drafts' } }) } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'welcome-worker' })
  expect(await ui.find({ type: 'Text', text: /^New workers can draft; anything outward waits for your yes/ })).toBeDefined()
  await ui.press({ key: 'tpl-release' })
  expect(registryOf(w).workers[0]).toMatchObject({ key: 'release-notes', tools: 'drafts', schedule: { days: 'fri', time: '15:00' } })
  expect(w.files.has(REG)).toBe(true)
  await ui.unmount()
})

// ---- Needs you

/** All four sources at once: a draft, a permission request, a failed wake, a health problem. */
function needsWorld(on: Parameters<typeof makeWorld>[0]) {
  const w = makeWorld(on, {
    now: NOW,
    // Alpha is paused, so no poll wakes it again on its own: its missed run waits for Retry.
    registry: { workers: [{ ...TWO.workers[0], paused: true }, TWO.workers[1]] },
    files: {
      [`${CALL}/outbox/alpha.jsonl`]: `${JSON.stringify(DRAFT)}\n`,
      // Waiting on the call card: Beta's chat asks.
      [`${CALL}/permit/aa11.json`]: JSON.stringify({ id: 'aa11', created: (NOW - 5_000) / 1000, title: 'Research', tool_name: 'Bash', short: 'npm run deploy', session_id: 'beta-cli' }),
      // Answered already, and one left over from long ago: neither shows.
      [`${CALL}/permit/bb22.json`]: JSON.stringify({ id: 'bb22', created: (NOW - 5_000) / 1000, tool_name: 'Bash' }),
      [`${CALL}/permit/bb22.answer`]: 'allow',
      [`${CALL}/permit/cc33.json`]: JSON.stringify({ id: 'cc33', created: (NOW - 3_600_000) / 1000, tool_name: 'Bash' }),
      // Alpha's 9:00 wake did not go through; Beta's retried and was delivered later.
      [`${CALL}/wakes/alpha-2026-11-02.retry`]: String(NOW - 3 * 3_600_000),
      [`${CALL}/wakes/beta-2026-11-02.retry`]: String(NOW - 3 * 3_600_000),
      [`${CALL}/wakes/beta-2026-11-02/result.json`]: '{"isDelivered": true}',
      // A slot a week old is never read.
      [`${CALL}/wakes/alpha-2026-10-26.retry`]: String(NOW),
    },
  })
  w.dirs.set(`${CALL}/permit`, NOW)
  w.dirs.set(`${CALL}/wakes`, NOW)
  w.dirs.set(`${CALL}/wakes/beta-2026-11-02`, NOW)
  return w
}

test('Needs you: one list across the four sources, each row with its action, and the footer badge', async ($, on) => {
  const w = needsWorld(on)
  const report = { ...REPORT, checks: REPORT.checks.filter(c => c.id !== 'workers-registry') }
  fakeCli(w, () => report)
  // Stands for the engine's own mode labels beneath the footer launcher.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Bypass permissions</Text>
  })
  await start($)
  await settle()
  // The doctor runs in the background, so a poll never waits on it: the next poll counts it.
  await start($)
  await settle()

  // The footer launcher counts what waits on you, and opens the list.
  const footer = await $.ui.mount({ plugin: 'workers-pane', component: 'SessionMode', props: { modes: [] }, surface: 'desktop' })
  expect((await footer.find({ key: 'needs-band' }))?.props.label).toBe('4 need you')
  await footer.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'needs' }))?.props.label).toBe('Needs you · 4')
  await ui.press({ key: 'needs' })
  expect((await ui.find({ key: 'needs' }))?.props.label).toBe('All workers')
  const rows = (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => /^(permit|item|wake|needs-health)-/.test(k))
  expect(rows).toEqual(['permit-aa11', 'item-alpha-ob_00000000000a', 'wake-alpha-2026-11-02', 'needs-health-whisper'])
  expect(await ui.find({ type: 'Text', text: 'Beta wants to run npm run deploy' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Permission request. Only a click on the call card answers it.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: "Alpha didn't wake for its 9:00 run" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: "Its chat wasn't running, and that run has passed. Retry runs it now." })).toBeDefined()
  expect((await ui.find({ key: 'needs-fix-whisper' }))?.props.label).toBe('Start it')
  for (const k of ['decline', 'change', 'approve']) expect(await ui.find({ key: `${k}-alpha-ob_00000000000a` })).toBeDefined()

  // Open on a permission request goes to the chat that asked; it never answers it.
  await ui.press({ key: 'permit-open-aa11' })
  expect(w.runs.filter(r => r.argv[0] === 'open').map(r => r.argv[1])).toEqual(['claude://claude.ai/epitaxy/local_beta'])
  expect(w.files.has(`${CALL}/permit/aa11.answer`)).toBe(false)

  // Retry sends the wake now; delivered, its claim holds a result and the retry file goes.
  await ui.press({ key: 'wake-retry-alpha-2026-11-02' })
  expect(w.sends.at(-1)?.to).toBe('local_alpha')
  expect(w.sends.at(-1)?.text).toMatch(/^Retry of a missed run, from the Workers pane: check in now\./)
  expect(JSON.parse(w.files.get(`${CALL}/wakes/alpha-2026-11-02/result.json`)!.text)).toMatchObject({ isDelivered: true, via: 'retry' })
  expect(w.runs.some(r => r.argv.join(' ') === `/bin/rm -f ${CALL}/wakes/alpha-2026-11-02.retry`)).toBe(true)

  // Approve works here as on the card.
  await ui.press({ key: 'approve-alpha-ob_00000000000a' })
  expect(w.sends.at(-1)?.text).toMatch(/^Approved in the Workers pane: a reply to the venue/)

  // The fix runs `cludegods doctor --fix <id>`, then checks again.
  const before = doctorRuns(w)
  await ui.press({ key: 'needs-fix-whisper' })
  expect(w.runs.some(r => r.argv.join(' ') === `${CLI} doctor --fix whisper`)).toBe(true)
  expect(doctorRuns(w)).toBe(before + 1)
  expect(w.toasts).toContain('Fixed: Whisper (speech to text)')
  await ui.unmount()
})

test('Needs you, empty: says what lands there; a wake still due says when it tries again', async ($, on) => {
  const w = makeWorld(on, {
    now: Date.parse('2026-11-02T06:05:00Z'), // Mon 09:05 in Riyadh: Alpha's slot is still due
    registry: TWO,
    files: { [`${CALL}/wakes/alpha-2026-11-02.retry`]: String(Date.parse('2026-11-02T06:15:00Z')) },
  })
  w.dirs.set(`${CALL}/wakes`, w.now)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'needs' })
  expect(await ui.find({ type: 'Text', text: /^Its chat wasn't running\. It tries again by itself at \d{1,2}:15\.$/ })).toBeDefined()
  w.files.delete(`${CALL}/wakes/alpha-2026-11-02.retry`)
  await ui.press({ key: 'needs' })
  await ui.press({ key: 'needs' })
  expect(await ui.find({ type: 'Text', text: /^Nothing needs you\./ })).toBeDefined()
  await ui.unmount()
})

// ---- the health strip

test('the health strip: a dot per part from doctor --json, each red or amber check with its fix', async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: TWO })
  let whisperOk = false
  fakeCli(w, () => ({ ...REPORT, checks: REPORT.checks.map(c => (c.id === 'whisper' ? { ...c, ok: whisperOk } : c)) }), id => {
    if (id === 'whisper') whisperOk = true
    return 0
  })
  await start($)
  await settle()
  expect(doctorRuns(w)).toBe(1)
  // A second poll within the minute does not run it again.
  await start($)
  await settle()
  expect(doctorRuns(w)).toBe(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await dotAfter(ui, 'Voice'))?.props.color).toBe(GREEN)
  expect((await dotAfter(ui, 'Listening'))?.props.color).toBe(RED)
  expect((await dotAfter(ui, 'Workers'))?.props.color).toBe(AMBER)
  // The info-level check only adds the Setup dot; it is no problem.
  expect((await dotAfter(ui, 'Setup'))?.props.color).toBe(GREEN)
  expect((await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props.label]).filter(([k]) => String(k).startsWith('health-fix-'))).toEqual([
    ['health-fix-whisper', 'Start it'],
    ['health-fix-workers-registry', 'Create it'],
  ])
  expect(await ui.find({ type: 'Text', text: 'Whisper (speech to text): nothing on port 2022' })).toBeDefined()

  await ui.press({ key: 'health-fix-whisper' })
  expect(w.runs.filter(r => r.argv[0] === CLI).map(r => r.argv.slice(1).join(' '))).toEqual([
    'doctor --json', 'doctor --fix whisper', 'doctor --json',
  ])
  expect((await dotAfter(ui, 'Listening'))?.props.color).toBe(GREEN)
  expect(await ui.find({ key: 'health-fix-whisper' })).toBeUndefined()

  // Check runs it again on demand.
  await ui.press({ key: 'health-check' })
  expect(doctorRuns(w)).toBe(3)
  await ui.unmount()
})

test('a failed fix says why; doctor output that is not its JSON hides the strip quietly', async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: TWO })
  let isBroken = false
  fakeCli(w, () => (isBroken ? 'Traceback (most recent call last)' : REPORT), () => 1)
  await start($)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'health-fix-whisper' })
  expect(w.toasts).toContain("Couldn't fix Whisper (speech to text): voicemode: whisper failed to start")
  isBroken = true
  await ui.press({ key: 'health-check' })
  expect(await ui.find({ key: 'health' })).toBeUndefined()
  await ui.unmount()
})

test('Enable voice runs cludegods setup voice --yes, streams its last line, and sums it up', async ($, on) => {
  const w = makeWorld(on, { now: NOW })
  let isInstalled = false
  fakeCli(w, () => ({ ...REPORT, voice_installed: isInstalled }))
  const spawned: string[][] = []
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: 'Installing Whisper\nDownloading large-v3-turbo 10%\r' }
    yield { stream: 'stdout' as const, text: 'Downloading large-v3-turbo 100%\nVoice is set up.\n' }
    isInstalled = true
    return { value: { code: 0, signal: null } }
  })
  await start($)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Voice is not installed: the card says what Enable voice does, downloads included.
  expect(await ui.find({ key: 'welcome-voice' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Voice is not set up yet\. Enable voice downloads the local speech and voice models/ })).toBeDefined()
  expect((await dotAfter(ui, 'Voice off'))?.text).toBe('○')

  await ui.press({ key: 'welcome-enable-voice' })
  expect(spawned).toEqual([[CLI, 'setup', 'voice', '--yes']])
  expect(w.toasts).toContain('Voice is ready')
  // Checked again after: voice is on, so the card offers the call.
  expect((await ui.find({ key: 'welcome-voice' }))?.props.label).toBe('Start a call')
  expect(await ui.find({ type: 'Text', text: 'Voice is ready. Start a call to try it.' })).toBeDefined()
  await ui.unmount()
})

test('Enable voice that fails says why and offers Try again', async ($, on) => {
  const w = makeWorld(on, { now: NOW })
  fakeCli(w, () => ({ ...REPORT, voice_installed: false }))
  on('process.spawn', async function* () {
    yield { stream: 'stderr' as const, text: 'Homebrew is not installed\n' }
    return { value: { code: 3, signal: null } }
  })
  await start($)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'welcome-enable-voice' })
  expect(await ui.find({ type: 'Text', text: 'Voice setup stopped (exit 3): Homebrew is not installed' })).toBeDefined()
  expect((await ui.find({ key: 'welcome-enable-voice' }))?.props.label).toBe('Try again')
  await ui.unmount()
})

// ---- plain words

test('plain words: what it can do, when it works, instructions, and Talk to <name>', async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: TWO })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'settings-alpha' })
  const headings = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(headings).toContain('What it can do')
  expect(headings).toContain('When it works')
  expect(headings).toContain('With no instructions, each wake asks it to check in on its role.')
  expect(headings.some(h => /charter|Hours$|^Tools$/.test(h ?? ''))).toBe(false)
  expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('tools-alpha-')).map(b => b.props.label)).toEqual([
    'Can read', 'Can draft', 'Can do anything',
  ])
  expect(((await ui.find({ key: 'mode-alpha' }))?.props.options as unknown[])[0]).toEqual({ value: 'off', label: 'Only when you ask' })

  // Talk to Alpha: with no call, /gods goes in the prompt box first.
  await ui.press({ key: 'overview-alpha' })
  await ui.press({ key: 'talk-alpha' })
  expect(w.prompts).toEqual(['/gods'])
  expect(w.toasts.at(-1)).toBe('Press Enter to start a call, then Talk to Alpha again')
  // On a live call it puts Alpha on (`call focus`); with Alpha on, it hands the call back.
  w.files.set(`${CALL}/session`, { text: 'cli-session', mtimeMs: NOW })
  await ui.press({ key: 'talk-alpha' })
  expect(w.runs.at(-1)?.argv).toEqual([`${BIN}/call`, 'focus', 'alpha'])
  expect(w.toasts.at(-1)).toBe('Alpha is on the call. Say "back to you" to return.')
  w.files.set(`${CALL}/focus`, { text: 'alpha', mtimeMs: NOW })
  await ui.press({ key: 'overview-alpha' })
  expect((await ui.find({ key: 'talk-alpha' }))?.props.label).toBe('Back to Claude')
  await ui.press({ key: 'talk-alpha' })
  expect(w.runs.at(-1)?.argv).toEqual([`${BIN}/call`, 'focus', 'clear'])
  await ui.unmount()
})
