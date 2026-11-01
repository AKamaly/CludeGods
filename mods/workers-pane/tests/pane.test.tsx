import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'workers-pane',
  component: 'Pane',
  requestId: 'workers',
  props: {
    title: 'Workers',
    isFocused: false,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = 1_000_000_000
const HOME = '/home/tester'
const REGISTRY = {
  workers: [
    { key: 'quick', name: 'Quick', role: 'Lookups, opening things, short tasks', model: 'claude-haiku-5-5', effort: 'low',
      session: 'local_quick-1', transcript: 'quick.jsonl', avatar: 'blue' },
    { key: 'work', name: 'Work', role: 'Drafts and summaries', model: 'claude-sonnet-5-5', effort: 'medium',
      session: 'local_work-2', transcript: 'work.jsonl', avatar: 'violet' },
    { key: 'deep', name: 'Deep', role: 'Strategy, research, code', model: 'claude-opus-5-5', effort: 'high',
      session: 'local_deep-3', transcript: 'deep.jsonl', avatar: 'orange' },
    { key: 'scout', name: 'Scout', role: 'Fresh one', model: 'claude-haiku-5-5', session: 'local_scout-4', avatar: 'rose' },
  ],
}

// Registry from fs.read; quick is mid-turn, the others idle for three minutes.
function world(on: On) {
  mock.env(on, { HOME })
  on('clock.now', () => ({ value: NOW }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined })) // fires at once; the clock stays at NOW, so an armed Delete stays armed
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/workers.json')) return { value: JSON.stringify(REGISTRY) }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', (_, e) => {
    if (e.path === `${HOME}/.claude/projects/quick.jsonl`) return { value: { kind: 'file', size: 1, mtimeMs: NOW - 2_000, isLink: false } }
    if (e.path.endsWith('.jsonl')) return { value: { kind: 'file', size: 1, mtimeMs: NOW - 180_000, isLink: false } }
    return { deny: `ENOENT ${e.path}` }
  })
}

test('the pane draws one full-width card per registry worker, with avatars and statuses', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(4)
  expect(await ui.findAll({ type: 'Input' })).toHaveLength(4)
  expect((await ui.find({ key: 'card-work' }))?.props.width).toBe('100%')
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
  // The name opens the chat; there is no separate Open button.
  expect(await ui.find({ key: 'name-deep' })).toBeDefined()
  expect(await ui.find({ key: 'open-deep' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Lookups, opening things/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '4 standing chats' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Working/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Idle · 3m ago/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /New/ })).toBeDefined()
  // No model anywhere: the user picks it inside the chat.
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
  expect(await ui.find({ key: 'model-work' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Haiku|Sonnet|Opus|5\.5/ })).toBeUndefined()
  expect((await ui.find({ key: 'task-deep' }))?.props.placeholder).toBe('Ask Deep…')
  // "Last: …" only once there is a last task; no "No tasks yet" filler.
  expect(await ui.find({ type: 'Text', text: /No tasks yet|^Last:/ })).toBeUndefined()
  await ui.unmount()
})

test('each Input is the only submit control: no separate Send or Create Buttons', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })

  const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label ?? b.text))
  expect(labels.filter(l => /^(send|create)$/i.test(l))).toEqual([])
  // One field in the form, so one "create" chip; no model Select in the form either.
  expect((await ui.findAll({ type: 'Input' })).map(i => i.props.submitLabel)).toEqual([
    'create', 'send', 'send', 'send', 'send',
  ])
  expect((await ui.find({ key: 'nw-entry' }))?.props.placeholder).toBe('Name, then what it does (optional)')
  expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
  // The hint stays hidden until an invalid attempt.
  expect(await ui.find({ type: 'Text', text: /1 to 24 letters/ })).toBeUndefined()
  await ui.unmount()
})

test('the name opens the worker chat in the centre', async ($, on) => {
  world(on)
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'name-work' })
  await ui.press({ key: 'name-deep' })

  expect(runs).toEqual([
    ['open', 'claude://claude.ai/epitaxy/local_work-2'],
    ['open', 'claude://claude.ai/epitaxy/local_deep-3'],
  ])
  await ui.unmount()
})

test('pressing the name marks that card selected with its persona border', async ($, on) => {
  world(on)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'card-work' }))?.props.borderColor).toBeUndefined()

  await ui.press({ key: 'name-work' })
  const work = await ui.find({ key: 'card-work' })
  expect(work?.props.borderColor).toBe('#a78bfa') // violet persona colour
  expect(work?.props.borderDimColor).toBe(false)
  expect(work?.props.backgroundColor).toBeDefined()
  expect((await ui.find({ key: 'card-quick' }))?.props.borderColor).toBeUndefined()
  expect((await ui.find({ key: 'card-quick' }))?.props.borderDimColor).toBe(true)

  // Pressing another name moves the glow.
  await ui.press({ key: 'name-deep' })
  expect((await ui.find({ key: 'card-deep' }))?.props.borderColor).toBe('#fb923c')
  expect((await ui.find({ key: 'card-work' }))?.props.borderColor).toBeUndefined()
  await ui.unmount()
})

test('Delete needs two presses, then writes the request, drops the registry entry and removes the card at once', async ($, on) => {
  world(on)
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'delete-deep' })
  expect(writes).toHaveLength(0)
  expect((await ui.find({ key: 'delete-deep' }))?.props.label).toBe('Confirm delete')
  expect((await ui.find({ key: 'delete-work' }))?.props.label).toBe('Delete')

  await ui.press({ key: 'delete-deep' })
  expect(writes).toHaveLength(2)
  expect(writes[0]?.path).toMatch(/^\/home\/tester\/\.voicemode\/call\/requests\/[^/]+\.json$/)
  expect(JSON.parse(writes[0]?.text ?? '{}')).toEqual({
    type: 'delete',
    key: 'deep',
    session: 'local_deep-3',
    at: NOW,
  })
  expect(writes[1]?.path).toBe(`${HOME}/.voicemode/call/workers.json`)
  const kept = JSON.parse(writes[1]?.text ?? '{}') as { workers: { key: string }[] }
  expect(kept.workers.map(w => w.key)).not.toContain('deep')
  expect(await ui.find({ key: 'delete-deep' })).toBeUndefined()
  expect(await ui.find({ key: 'task-deep' })).toBeUndefined()
  await ui.unmount()
})

test('the avatar row shows one colour swatch per preset; pressing one selects it', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })

  const swatches = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('avatar-'))
  expect(swatches.map(b => b.key)).toEqual([
    'avatar-blue', 'avatar-violet', 'avatar-orange', 'avatar-rose', 'avatar-lime', 'avatar-gold',
  ])
  // Desktop buttons ignore a text colour, so each swatch is a coloured emoji.
  expect((await ui.find({ key: 'avatar-blue' }))?.props.label).toBe('🔵')
  expect((await ui.find({ key: 'avatar-gold' }))?.props.label).toBe('🟡')
  expect((await ui.find({ key: 'avatar-blue' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'avatar-gold' }))?.props.variant).toBeUndefined()

  await ui.press({ key: 'avatar-gold' })
  expect((await ui.find({ key: 'avatar-gold' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'avatar-blue' }))?.props.variant).toBeUndefined()
  expect((await ui.find({ key: 'new-form' }))?.props.borderColor).toBe('#facc15')
  await ui.unmount()
})

test('Enter splits the one field at the first comma and puts the create request in the prompt box', async ($, on) => {
  world(on)
  const prompts: string[] = []
  on('prompt.fill', (_, e) => {
    prompts.push(e.text)
    return { isFilled: true }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  await ui.press({ key: 'avatar-gold' })
  await ui.input({ key: 'nw-entry', text: 'Sales, outreach', kind: 'change' })
  await ui.input({ key: 'nw-entry', text: 'Sales, outreach' })
  await ui.press({ key: 'new-worker' })
  await ui.input({ key: 'nw-entry', text: 'Scribe 2, drafts, posts; comments' })
  await ui.press({ key: 'new-worker' })
  await ui.input({ key: 'nw-entry', text: '  Solo  ' })

  expect(prompts).toEqual([
    'Create worker: name=Sales; role=outreach; avatar=gold',
    'Create worker: name=Scribe 2; role=drafts, posts, comments; avatar=gold',
    'Create worker: name=Solo; role=; avatar=gold',
  ])
  expect(await ui.find({ key: 'nw-entry' })).toBeUndefined()
  await ui.unmount()
})

test('an invalid name does not submit', async ($, on) => {
  world(on)
  let count = 0
  on('prompt.fill', () => {
    count += 1
    return { isFilled: true }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'new-worker' })
  await ui.input({ key: 'nw-entry', text: 'bad;name!', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /1 to 24 letters/ })).toBeUndefined()
  await ui.input({ key: 'nw-entry', text: 'bad;name!' })
  expect(await ui.find({ type: 'Text', text: /1 to 24 letters/ })).toBeDefined()
  await ui.input({ key: 'nw-entry', text: '   ' })
  await ui.input({ key: 'nw-entry', text: ', only a role' })
  // Over 24 characters before the comma (26, then 25 with no comma).
  await ui.input({ key: 'nw-entry', text: 'A name far too long for it, sales' })
  await ui.input({ key: 'nw-entry', text: 'Abcdefghijklmnopqrstuvwxy' })

  expect(count).toBe(0)
  // A valid name clears the hint; Cancel closes the form.
  await ui.input({ key: 'nw-entry', text: 'Fine, a role', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /1 to 24 letters/ })).toBeUndefined()
  await ui.press({ key: 'nw-cancel' })
  expect(await ui.find({ key: 'nw-entry' })).toBeUndefined()
  await ui.unmount()
})

test('Enter in a task box sends the task to that worker chat', async ($, on) => {
  world(on)
  const sends: { to: unknown; text: string }[] = []
  on('session.send', (_, e) => {
    sends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'task-quick', text: 'Open the team dashboard' })

  expect(sends).toHaveLength(1)
  expect(sends[0]?.text).toBe('Open the team dashboard')
  expect(JSON.stringify(sends[0]?.to)).toContain('local_quick-1')
  await ui.unmount()
})

test('a blank task is not sent', async ($, on) => {
  world(on)
  let count = 0
  on('session.send', () => {
    count += 1
    return { isDelivered: true }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'task-deep', text: '   ' })

  expect(count).toBe(0)
  await ui.unmount()
})

test('a missing registry draws an empty pane with the New worker button', async ($, on) => {
  mock.env(on, { HOME })
  on('clock.now', () => ({ value: NOW }))
  on('fs.read', (_, e) => ({ deny: `ENOENT ${e.path}` }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ key: 'new-worker' })).toBeDefined()
  await ui.unmount()
})

const FOOTER = {
  plugin: 'workers-pane',
  component: 'SessionMode',
  props: { modes: ['Bypass permissions'] },
} as const

// Stands for the engine's own mode labels beneath the plugin.
function engineModes(on: On) {
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Bypass permissions</Text>
  })
}

test('the footer launcher sits left of Claude\'s own mode labels and opens the Workers pane', async ($, on) => {
  world(on)
  engineModes(on)
  const opens: unknown[] = []
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    opens.push({ ...e })
    return { value: { isPlaced: true } }
  })

  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await ui.find({ key: 'open-workers-band' }))?.props.label).toBe('Workers · 4')
  expect(await ui.find({ type: 'Text', text: /Bypass permissions/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)

  await ui.press({ key: 'open-workers-band' })
  expect(opens).toEqual([expect.objectContaining({ id: 'workers', title: 'Workers', columns: 46, focus: true })])
  await ui.unmount()
})

test('the footer launcher reads "Workers" with no workers and keeps the mode labels', async ($, on) => {
  mock.env(on, { HOME })
  on('clock.now', () => ({ value: NOW }))
  on('fs.read', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('ui.panes', () => ({ value: [] }))
  engineModes(on)

  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await ui.find({ key: 'open-workers-band' }))?.props.label).toBe('Workers')
  expect(await ui.find({ type: 'Text', text: /Bypass permissions/ })).toBeDefined()
  await ui.unmount()
})

// A proactive worker: a charter, a weekday schedule, and three outbox lines (two drafts,
// one note), the second draft newer than what the user last looked at.
const SALES = {
  workers: [
    { key: 'sales', name: 'Sales', role: 'Follow-ups', session: 'local_sales-9', transcript: 'sales.jsonl', avatar: 'blue',
      charter: 'You are Sales, a standing follow-up worker. Drafts only.\nMore rules here.',
      schedule: { days: 'mon-fri', time: '09:00', tz: 'Asia/Tokyo' } },
  ],
}
const ISO = (ms: number) => new Date(ms).toISOString()
const OUTBOX = [
  { at: ISO(NOW - 3_600_000), kind: 'draft', title: 'Reply to Jordan (Acme)', body: 'Hi Jordan,\nQuick one on the demo call.\nThird line', to: 'jordan@example.com', needs_approval: true },
  { at: ISO(NOW - 1_800_000), kind: 'note', title: 'Globex went quiet', body: 'No reply in two weeks.', needs_approval: false },
  { at: ISO(NOW - 60_000), kind: 'draft', title: 'Nudge to Sam Lee', body: 'Hi Sam,\nSeat count?', to: 'sam@example.com', needs_approval: true },
].map(o => JSON.stringify(o)).join('\n') + '\nnot json\n'

function salesWorld(on: On, seenMs = NOW - 2_000_000) {
  mock.env(on, { HOME })
  on('clock.now', () => ({ value: NOW }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/workers.json')) return { value: JSON.stringify(SALES) }
    if (e.path.endsWith('/outbox/sales.jsonl')) return { value: OUTBOX }
    if (e.path.endsWith('/outbox/.seen.json')) return { value: JSON.stringify({ sales: seenMs }) }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: NOW - 180_000, isLink: false } }))
}

test('a proactive card reads as tidy rows: role and schedule on one dim line, no charter, one draft indicator', async ($, on) => {
  salesWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Row 2: the role, then the short schedule, both dim; no timezone, no box, no tint.
  expect(await ui.find({ type: 'Text', text: 'Follow-ups' })).toBeDefined()
  const schedule = await ui.find({ type: 'Text', text: '· Mon–Fri · 9:00' })
  expect(schedule?.props.dimColor).toBe(true)
  expect(schedule?.props.backgroundColor).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Tokyo|⏰/ })).toBeUndefined()
  // The charter is the worker's instructions: never on the card.
  expect(await ui.find({ type: 'Text', text: /You are Sales|More rules here/ })).toBeUndefined()
  // One draft indicator, on the Outbox button; no badge beside the name.
  expect(await ui.find({ type: 'Text', text: /draft/ })).toBeUndefined()
  expect((await ui.find({ key: 'feed-sales' }))?.props.label).toBe('Outbox · 1 draft')
  expect(await ui.find({ key: 'outbox-sales' })).toBeUndefined()
  await ui.unmount()
})

test('the footer has Run now and Outbox, then a quiet clickable Delete, and no Open', async ($, on) => {
  salesWorld(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ key: 'run-sales' }))?.props.label).toBe('Run now')
  expect(await ui.find({ key: 'open-sales' })).toBeUndefined()
  const del = await ui.find({ key: 'delete-sales' })
  expect(del?.props.label).toBe('Delete')
  expect(del?.props.plain).toBe(true)
  expect(del?.props.dimColor).toBeUndefined()
  // The visible footer actions, in order.
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => /^(run|feed|open|delete)-sales$/.test(k ?? ''))
  expect(keys).toEqual(['run-sales', 'feed-sales', 'delete-sales'])
  await ui.unmount()
})

test('with nothing fresh the Outbox button carries no count', async ($, on) => {
  salesWorld(on, NOW)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'feed-sales' }))?.props.label).toBe('Outbox')
  await ui.unmount()
})

test('the badge counts every fresh draft, and notes only when no draft is fresh', async ($, on) => {
  salesWorld(on, 0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'feed-sales' }))?.props.label).toBe('Outbox · 2 drafts')
  await ui.unmount()
})

test('Run now sends the charter wake to that worker chat', async ($, on) => {
  salesWorld(on)
  const sends: { to: unknown; text: string }[] = []
  on('session.send', (_, e) => {
    sends.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'run-sales' })

  expect(sends).toHaveLength(1)
  expect(JSON.stringify(sends[0]?.to)).toContain('local_sales-9')
  expect(sends[0]?.text).toMatch(/^Run now, from the Workers pane: run your charter now/)
  expect(sends[0]?.text).toContain('~/.voicemode/call/outbox/sales.jsonl')
  expect(sends[0]?.text).toContain('More rules here.')
  expect(await ui.find({ type: 'Text', text: /^Last: Run its charter now/ })).toBeDefined()
  await ui.unmount()
})

test('the outbox feed lists items newest first, marks them seen, and never sends', async ($, on) => {
  salesWorld(on)
  let sendCount = 0
  on('session.send', () => {
    sendCount += 1
    return { isDelivered: true }
  })
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'feed-sales' })

  const cards = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('item-sales-'))
  expect(cards.map(b => b.key)).toEqual(['item-sales-2', 'item-sales-1', 'item-sales-0'])
  expect(await ui.find({ type: 'Text', text: 'Nudge to Sam Lee' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /to jordan@example\.com/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Quick one on the demo call.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Third line' })).toBeUndefined()
  expect((await ui.find({ key: 'feed-sales' }))?.props.label).toBe('Hide outbox')
  expect(writes).toEqual([{ path: `${HOME}/.voicemode/call/outbox/.seen.json`, text: JSON.stringify({ sales: NOW - 60_000 }) }])

  await ui.press({ key: 'feed-open-sales' })
  expect(runs).toEqual([['open', 'claude://claude.ai/epitaxy/local_sales-9']])
  expect(sendCount).toBe(0)

  await ui.press({ key: 'feed-sales' })
  expect(await ui.find({ key: 'outbox-sales' })).toBeUndefined()
  await ui.unmount()
})
