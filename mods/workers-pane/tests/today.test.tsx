import { expect, test } from 'claude-code/testing'

import {
  changesText,
  foldDuplicates,
  parseConfig,
  parseDecisions,
  runLabel,
  runLine,
  startOfDay,
  todayEntries,
  withDefaultTools,
} from '../hooks/register'
import { CALL, PANE, REG, makeWorld, registryOf, settle, start } from './world'

// v0.4: the Today view (what waits, Ask all, what each worker did today), Change on an
// outbox item, the default tools from config.json, creating a worker in one step, and
// scheduled wakes that hold up with any number of open chats.

const DAY = startOfDay(Date.parse('2026-11-02T12:00:00Z'))
const NOW = DAY + 13 * 3_600_000 // 13:00 on this Mac's clock, whatever its zone
const ISO = (ms: number) => new Date(ms).toISOString()

const TWO = {
  workers: [
    { key: 'alpha', name: 'Alpha', role: 'Inbox', session: 'local_alpha', transcript: 'alpha.jsonl', god: 'sales' },
    { key: 'beta', name: 'Beta', role: 'Research', session: 'local_beta', transcript: 'beta.jsonl', god: 'research' },
    { key: 'gamma', name: 'Gamma', role: 'Not started', god: 'scout' },
  ],
}
const DRAFT = { id: 'ob_000000000001', at: ISO(NOW - 20 * 60_000), kind: 'draft', title: 'a reply to the venue', body: 'Hi,\nFriday works.', to: 'events@example.com', subject: 'Friday', needs_approval: true }
const NOTE = { id: 'ob_000000000002', at: ISO(NOW - 40 * 60_000), kind: 'note', title: 'Repo went quiet', body: 'No reply since Monday.', needs_approval: false }
const OLD = { id: 'ob_000000000003', at: ISO(DAY - 3_600_000), kind: 'note', title: 'Yesterday note', body: 'x', needs_approval: false }
const RUNS = [
  runLine({ turnId: 'y1', reason: 'answer', durationMs: 5, answer: 'Old answer', asked: 'Run now, from the Workers pane: run your charter now.', now: DAY - 7_200_000 }),
  runLine({ turnId: 't1', reason: 'answer', durationMs: 5, answer: 'Two drafts in the outbox.\nMore.', asked: 'Scheduled run (2026-11-02 09:00 UTC): run your charter now.', now: NOW - 25 * 60_000 }),
].join('')

function todayWorld(on: Parameters<typeof makeWorld>[0], extra: Record<string, string> = {}) {
  return makeWorld(on, {
    now: NOW,
    registry: TWO,
    files: {
      [`${CALL}/outbox/alpha.jsonl`]: [DRAFT, NOTE, OLD].map(o => JSON.stringify(o)).join('\n') + '\n',
      [`${CALL}/runs/alpha.jsonl`]: RUNS,
      [`${CALL}/runs/beta.jsonl`]: runLine({ turnId: 'b1', reason: 'error', durationMs: 5, answer: 'API error', asked: 'Summarise the thread', now: NOW - 5 * 60_000 }),
      ...extra,
    },
  })
}

test('the digest: finished turns and notes since midnight, newest first; what waits is left out', () => {
  const entries = todayEntries({
    keys: ['alpha', 'beta'],
    runs: {
      alpha: [{ at: ISO(NOW - 60_000), turn: 't', reason: 'answer', durationMs: 1, asked: 'Scheduled run (x): run your charter now.', answer: 'Done.\nMore' }],
      beta: [{ at: ISO(DAY - 1), turn: 'old', reason: 'answer', durationMs: 1, asked: 'x', answer: 'y' }],
    },
    outbox: {
      alpha: [
        { ...DRAFT, kind: 'draft' as const },
        { ...NOTE, kind: 'note' as const },
        { ...DRAFT, id: 'ob_d2', title: 'a nudge', kind: 'draft' as const },
      ],
    },
    decided: { alpha: { ob_d2: { id: 'ob_d2', decision: 'changes', at: ISO(NOW) } } },
    since: DAY,
  })
  expect(entries.map(e => [e.key, e.kind, e.title, e.detail])).toEqual([
    ['alpha', 'run', 'Scheduled run', 'Done.'],
    ['alpha', 'draft', 'Drafted a nudge', 'You asked for changes'],
    ['alpha', 'note', 'Noted: Repo went quiet', 'No reply since Monday.'],
  ])
  expect(runLabel('Approved in the Workers pane: x (ob_1). Go ahead')).toBe('Acted on your approval')
  expect(runLabel('Changes requested in the Workers pane for x')).toBe('Revised a draft')
  expect(runLabel('Scheduled check-in (2026-11-02 09:00 UTC): check in now.')).toBe('Scheduled run')
  expect(runLabel('Draft the release note')).toBe('Asked: Draft the release note')
  expect(runLabel('')).toBe('Carried on')
})

test('Today: what waits across workers with its buttons, Ask all, and what each did today', async ($, on) => {
  const w = todayWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'today' }))?.props.label).toBe('Today · 1')
  await ui.press({ key: 'today' })
  expect(await ui.find({ key: 'today-panel' })).toBeDefined()
  expect((await ui.find({ key: 'today' }))?.props.label).toBe('All workers')
  expect(await ui.find({ key: 'card-alpha' })).toBeUndefined()
  // Ask all reaches the two workers with a chat.
  expect((await ui.find({ key: 'ask-all' }))?.props.placeholder).toBe('Ask all 2 workers…')
  expect(await ui.find({ type: 'Text', text: 'None wakes on its own: give one hours in its Settings.' })).toBeDefined()
  // Needs your yes: the draft, with who drafted it, its subject, and its buttons.
  expect(await ui.find({ type: 'Text', text: 'Needs your yes · 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Alpha · draft · to events@example\.com · "Friday"/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Svg' })).some(s => s.props.alt === 'Alpha' && s.props.width === 16)).toBe(true)
  for (const k of ['decline', 'change', 'approve']) expect(await ui.find({ key: `${k}-alpha-ob_000000000001` })).toBeDefined()
  // Done today: the scheduled run and the note; yesterday's run and note are not there.
  const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(lines).toContain('Scheduled run')
  expect(lines).toContain('Two drafts in the outbox.')
  expect(lines).toContain('Noted: Repo went quiet')
  expect(lines).toContain('Hit an error: Asked: Summarise the thread')
  expect(lines.some(l => /Old answer|Yesterday note/.test(l))).toBe(false)
  // The newest first: Beta's error (5m), Alpha's run (25m), the note (40m).
  const done = (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => k.startsWith('today-') && k !== 'today-panel')
  expect(done).toEqual(['today-run-beta-b1', 'today-run-alpha-t1', 'today-item-alpha-ob_000000000002'])
  // A name opens that worker's chat.
  await ui.press({ key: 'today-open-run-alpha-t1' })
  expect(w.runs.filter(r => r.argv[0] === 'open').map(r => r.argv[1])).toEqual(['claude://claude.ai/epitaxy/local_alpha'])

  // Approve works from here as on the card.
  await ui.press({ key: 'approve-alpha-ob_000000000001' })
  expect(w.sends.at(-1)).toEqual({
    to: 'local_alpha',
    text: 'Approved in the Workers pane: a reply to the venue (ob_000000000001). Go ahead with exactly what the draft says, then report back.',
  })
  expect(await ui.find({ type: 'Text', text: 'Nothing waits for you.' })).toBeDefined()
  expect((await ui.find({ key: 'today' }))?.props.label).toBe('All workers')
  await ui.press({ key: 'today' })
  expect(await ui.find({ key: 'card-alpha' })).toBeDefined()
  expect((await ui.find({ key: 'today' }))?.props.label).toBe('Today')
  await ui.unmount()
})

test('Ask all sends one message to every worker with a chat, and names who did not get it', async ($, on) => {
  const w = todayWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'today' })
  await ui.input({ key: 'ask-all', text: '   ' })
  expect(w.sends).toEqual([])
  await ui.input({ key: 'ask-all', text: 'What is blocking you today?' })
  expect(w.sends).toEqual([
    { to: 'local_alpha', text: 'What is blocking you today?' },
    { to: 'local_beta', text: 'What is blocking you today?' },
  ])
  expect(w.toasts.at(-1)).toBe('Sent to all 2 workers. 1 without a chat yet')
  w.deliver = to => to !== 'local_beta'
  await ui.input({ key: 'ask-all', text: 'Second ask' })
  expect(w.toasts.at(-1)).toBe("Sent to 1 of 2; didn't reach Beta. 1 without a chat yet")
  // Each worker's card shows it as its last message.
  await ui.press({ key: 'today' })
  expect(await ui.find({ type: 'Text', text: /^Last: Second ask · just now/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Not delivered: Second ask/ })).toBeDefined()
  await ui.unmount()
})

test('Change sends the worker a note on what to revise and takes the item off the waiting list', async ($, on) => {
  const w = todayWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'feed-alpha' })
  expect(await ui.find({ key: 'changenote-alpha-ob_000000000001' })).toBeUndefined()
  await ui.press({ key: 'change-alpha-ob_000000000001' })
  expect((await ui.find({ key: 'changenote-alpha-ob_000000000001' }))?.props.placeholder).toBe('What should change?')
  expect((await ui.find({ key: 'change-alpha-ob_000000000001' }))?.props.label).toBe('Cancel change')

  // Not delivered: nothing recorded, it still waits.
  w.deliver = false
  await ui.input({ key: 'changenote-alpha-ob_000000000001', text: 'Shorter, and mention the parking' })
  expect(w.files.has(`${CALL}/outbox/alpha.decisions.jsonl`)).toBe(false)
  expect(w.toasts.at(-1)).toBe("Alpha didn't get it, so it still waits: not running")

  w.deliver = true
  await ui.input({ key: 'changenote-alpha-ob_000000000001', text: 'Shorter, and mention the parking' })
  expect(w.sends.at(-1)).toEqual({
    to: 'local_alpha',
    text: changesText({ id: 'ob_000000000001', title: 'a reply to the venue', kind: 'draft' }, 'Shorter, and mention the parking'),
  })
  expect(w.sends.at(-1)?.text).toBe(
    'Changes requested in the Workers pane for a reply to the venue (ob_000000000001): Shorter, and mention the parking\n' +
      'Revise it and append the revised version to your outbox as a new item. Do nothing outward with the old one.',
  )
  const decided = parseDecisions(w.files.get(`${CALL}/outbox/alpha.decisions.jsonl`)!.text)
  expect(decided).toEqual({ ob_000000000001: { id: 'ob_000000000001', decision: 'changes', at: ISO(NOW), note: 'Shorter, and mention the parking' } })
  expect(await ui.find({ type: 'Text', text: '↺ Changes asked' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'You asked: Shorter, and mention the parking' })).toBeDefined()
  expect(await ui.find({ key: 'approve-alpha-ob_000000000001' })).toBeUndefined()
  expect(await ui.find({ key: 'changenote-alpha-ob_000000000001' })).toBeUndefined()
  expect((await ui.find({ key: 'feed-alpha' }))?.props.label).toBe('Hide outbox')
  expect(w.toasts.at(-1)).toBe('Asked Alpha to revise a reply to the venue')
  // A page goes back through `pages draft`.
  expect(changesText({ id: 'ob_p', title: 'Notes', kind: 'page' }, 'x')).toContain('run `pages draft` again')
  await ui.unmount()
})

test('config.json: parsed safely, written with every other key kept', () => {
  expect(parseConfig(undefined)).toEqual({ defaultTools: 'full' })
  expect(parseConfig('not json')).toEqual({ defaultTools: 'full' })
  expect(parseConfig('[]')).toEqual({ defaultTools: 'full' })
  expect(parseConfig('{"workers": {"default_tools": "everything"}}')).toEqual({ defaultTools: 'full' })
  expect(parseConfig('{"workers": {"default_tools": "drafts"}}')).toEqual({ defaultTools: 'drafts' })
  const raw = JSON.stringify({ user_label: 'Boss', approvals: { mode: 'click' }, workers: { default_tools: 'full', later: 1 } })
  expect(JSON.parse(withDefaultTools(raw, 'read').text!)).toEqual({ user_label: 'Boss', approvals: { mode: 'click' }, workers: { default_tools: 'read', later: 1 } })
  expect(JSON.parse(withDefaultTools(undefined, 'drafts').text!)).toEqual({ workers: { default_tools: 'drafts' } })
  expect(withDefaultTools('{oops', 'read')).toEqual({ error: 'config.json is not valid JSON' })
  expect(withDefaultTools('[1]', 'read')).toEqual({ error: 'config.json is not a JSON object' })
})

test('New worker starts with the default tools from config.json; another pick can become the default', async ($, on) => {
  const config = { user_label: 'Boss', approvals: { mode: 'click' }, workers: { default_tools: 'drafts' } }
  const w = makeWorld(on, { now: NOW, registry: TWO, files: { [`${CALL}/config.json`]: JSON.stringify(config) } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  const ringed = async () =>
    (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('nw-tools-tile-') && b.props.borderColor !== undefined).map(b => b.key)
  expect(await ringed()).toEqual(['nw-tools-tile-drafts'])
  expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('nw-tools-')).map(b => b.props.label)).toEqual([
    'Full access', 'Drafts only', 'Read only',
  ])
  expect(await ui.find({ type: 'Text', text: /· drafts only\. Change both later/ })).toBeDefined()
  expect(await ui.find({ key: 'nw-default' })).toBeUndefined()

  await ui.press({ key: 'nw-tools-read' })
  expect(await ringed()).toEqual(['nw-tools-tile-read'])
  await ui.press({ key: 'nw-default' })
  expect(JSON.parse(w.files.get(`${CALL}/config.json`)!.text)).toEqual({ ...config, workers: { default_tools: 'read' } })
  expect(w.toasts.at(-1)).toBe('New workers now start with read only')
  expect(await ui.find({ key: 'nw-default' })).toBeUndefined()

  await ui.input({ key: 'nw-entry', text: 'Reader, reads things' })
  expect(registryOf(w).workers.at(-1)).toMatchObject({ key: 'reader', name: 'Reader', tools: 'read' })
  expect(w.prompts[0]).toMatch(/; tools=read; key=reader\n/)
  await ui.unmount()
})

test('a config.json that is not JSON means the defaults, and is never overwritten', async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: TWO, files: { [`${CALL}/config.json`]: '{ "user_label": "Bo' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  expect(await ui.find({ type: 'Text', text: /· full access\. Change both later/ })).toBeDefined()
  await ui.press({ key: 'nw-tools-drafts' })
  await ui.press({ key: 'nw-default' })
  expect(w.files.get(`${CALL}/config.json`)!.text).toBe('{ "user_label": "Bo')
  expect(w.toasts.at(-1)).toBe("Couldn't save the default: config.json is not valid JSON")
  await ui.unmount()
})

test('create: the card shows at once, selected; a name in use is refused; the first worker starts the registry', async ($, on) => {
  const w = makeWorld(on, { now: NOW })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^No workers yet/ })).toBeDefined()
  await ui.press({ key: 'new-worker' })
  await ui.input({ key: 'nw-entry', text: 'Scribe, drafts the notes' })
  expect(w.runs.some(r => r.argv.join(' ') === `/bin/mkdir -p ${CALL}`)).toBe(true)
  expect(JSON.parse(w.files.get(REG)!.text)).toEqual({
    workers: [{ key: 'scribe', name: 'Scribe', role: 'drafts the notes', god: 'scribe', avatar: 'blue', voice: 'bf_emma', tools: 'full', created: ISO(NOW) }],
  })
  expect(await ui.find({ key: 'card-scribe' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◌ No chat yet' })).toBeDefined()
  expect(await ui.find({ key: 'start-scribe' })).toBeDefined()
  expect(w.toasts.at(-1)).toBe("Press Enter to start Scribe's chat")

  await ui.press({ key: 'new-worker' })
  await ui.input({ key: 'nw-entry', text: 'scribe, again' })
  expect(registryOf(w).workers).toHaveLength(1)
  expect(w.prompts).toHaveLength(1)
  expect(w.toasts.at(-1)).toBe('There is already a worker named Scribe. Pick another name.')
  await ui.unmount()
})

test('a registry that is not JSON is never overwritten by a create', async ($, on) => {
  const w = makeWorld(on, { now: NOW, files: { [REG]: '{"workers": [' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  await ui.input({ key: 'nw-entry', text: 'Scribe' })
  expect(w.files.get(REG)!.text).toBe('{"workers": [')
  expect(w.prompts).toEqual([])
  expect(w.toasts.at(-1)).toBe("Couldn't add Scribe: workers.json is not valid JSON")
  await ui.unmount()
})

test('foldDuplicates folds a second entry for the new worker into the first, by key or exact name', () => {
  const ws: unknown[] = [
    { key: 'old', name: 'Old' },
    { key: 'herald', name: 'Herald', god: 'herald', tools: 'full', session: null },
    { key: 'herald-2', name: 'Herald', session: 'local_h', transcript: 'h.jsonl', tools: 'drafts', model: 'm' },
    { key: 'heraldo', name: 'Heraldo', session: 'local_x' },
  ]
  expect(foldDuplicates(ws, 'herald', 'Herald', ['old'])).toBe(true)
  expect(ws).toEqual([
    { key: 'old', name: 'Old' },
    { key: 'herald', name: 'Herald', god: 'herald', tools: 'full', session: 'local_h', transcript: 'h.jsonl', model: 'm' },
    { key: 'heraldo', name: 'Heraldo', session: 'local_x' },
  ])
  const same: unknown[] = [{ key: 'h', name: 'H', tools: 'read' }, { key: 'h', name: 'H', session: 'local_h', tools: 'drafts' }]
  expect(foldDuplicates(same, 'h', 'H', [])).toBe(true)
  expect(same).toEqual([{ key: 'h', name: 'H', tools: 'read', session: 'local_h' }])
  expect(foldDuplicates(same, 'h', 'H', [])).toBe(false)
  expect(foldDuplicates([{ key: 'a', name: 'A' }], 'h', 'H', [])).toBe(false)
})

test('a create an older call session registers a second time is folded into the pane\'s entry', async ($, on) => {
  const w = makeWorld(on, { now: NOW, registry: { workers: [TWO.workers[0]] } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'nw-god-herald' })
  await ui.input({ key: 'nw-entry', text: 'Herald, announcements' })
  await ui.unmount()
  const reg = registryOf(w)
  reg.workers.push({ key: 'herald-x', name: 'Herald', role: 'announcements', session: 'local_h', avatar: 'gold', tools: 'drafts', model: 'm' })
  w.files.set(REG, { text: JSON.stringify(reg), mtimeMs: NOW })
  await start($)
  await settle()
  expect(registryOf(w).workers).toEqual([
    TWO.workers[0],
    { key: 'herald', name: 'Herald', role: 'announcements', god: 'herald', avatar: 'gold', voice: 'bm_george', tools: 'full', created: ISO(NOW), session: 'local_h', model: 'm' },
  ])
})

// Scheduled wakes with several chats open (every chat runs the pane).
const DUE = Date.parse('2026-11-02T06:05:00Z') // Mon 09:05 Riyadh
const SALES = { key: 'sales', name: 'Sales', session: 'local_sales', transcript: 'sales-cli.jsonl', charter: 'Drafts only.', schedule: { days: 'mon-fri', time: '09:00', tz: 'Asia/Riyadh' } }
const CLAIM = `${CALL}/wakes/sales-2026-11-02`

test('a wake another pane delivered (its claim holds result.json) is never sent again', async ($, on) => {
  const w = makeWorld(on, { now: DUE, registry: { workers: [SALES] }, files: { [`${CLAIM}/result.json`]: '{"isDelivered":true}' } })
  w.dirs.set(CLAIM, DUE - 60_000)
  await start($)
  await settle()
  w.now = DUE + 5 * 60_000
  await start($)
  await settle()
  expect(w.sends).toEqual([])
  // Known done after the first look: no more claim attempts.
  expect(w.runs.filter(r => r.argv[0] === '/bin/mkdir' && r.argv[1] === CLAIM)).toHaveLength(1)
})

test('a claim left with no result by a pane that went away is taken over once, after 10 minutes', async ($, on) => {
  const w = makeWorld(on, { now: DUE + 2 * 60_000, registry: { workers: [SALES] } })
  w.dirs.set(CLAIM, DUE) // claimed at 09:05, never delivered
  await start($)
  await settle()
  expect(w.sends).toEqual([]) // still fresh: someone may be sending it now
  w.now = DUE + 11 * 60_000
  await start($)
  await settle()
  expect(w.sends).toHaveLength(1)
  expect(w.dirs.has(`${CLAIM}/takeover`)).toBe(true)
  expect(JSON.parse(w.files.get(`${CLAIM}/result.json`)!.text).isDelivered).toBe(true)
  w.now = DUE + 30 * 60_000
  await start($)
  await settle()
  expect(w.sends).toHaveLength(1)
})

test('an undelivered wake tells every pane when to try again, through wakes/<id>.retry', async ($, on) => {
  const w = makeWorld(on, { now: DUE, registry: { workers: [SALES] } })
  w.deliver = false
  await start($)
  await settle()
  expect(w.sends).toHaveLength(1)
  expect(w.dirs.has(CLAIM)).toBe(false) // given back
  expect(w.files.get(`${CLAIM}.retry`)?.text).toBe(String(DUE + 10 * 60_000))
})

test('a retry time another pane wrote is honoured here too', async ($, on) => {
  const w = makeWorld(on, { now: DUE, registry: { workers: [SALES] }, files: { [`${CLAIM}.retry`]: String(DUE + 8 * 60_000) } })
  await start($)
  await settle()
  expect(w.sends).toEqual([])
  w.now = DUE + 9 * 60_000
  await start($)
  await settle()
  expect(w.sends).toHaveLength(1)
})

test('a worker with hours and no charter is woken to check in on its role', async ($, on) => {
  const worker = { key: 'scout', name: 'Scout', role: 'Watches the repo for new issues', session: 'local_scout', schedule: SALES.schedule }
  const w = makeWorld(on, { now: DUE, registry: { workers: [worker] } })
  await start($)
  await settle()
  expect(w.sends).toHaveLength(1)
  expect(w.sends[0]?.text).toMatch(/^Scheduled check-in \(2026-11-02 09:00 Asia\/Riyadh\): check in now\. Your role: Watches the repo for new issues\./)
  expect(w.sends[0]?.text).toContain('~/.voicemode/call/outbox/scout.jsonl')
  expect(w.sends[0]?.text).toContain('Drafts only: send, post or change nothing outward.')
  // Its card offers Check in, not Run now.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'run-scout' }))?.props.label).toBe('Check in')
  await ui.press({ key: 'run-scout' })
  expect(w.sends[1]?.text).toMatch(/^Run now, from the Workers pane: check in now\./)
  expect(w.toasts.at(-1)).toBe('Scout is checking in')
  await ui.unmount()
})

test("a worker's own chat never wakes it, known by its desktop id", async ($, on) => {
  const w = makeWorld(on, { now: DUE, registry: { workers: [{ ...SALES, transcript: 'elsewhere.jsonl' }] }, env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_sales' }, self: 'sales-cli' })
  await start($)
  await settle()
  expect(w.sends).toEqual([])
  // ...and it set its transcript right while it was at it.
  expect(registryOf(w).workers[0]?.transcript).toBe('sales-cli.jsonl')
})
