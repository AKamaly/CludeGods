import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren, Timer } from 'claude-code'

import { GOD_KINDS, godSvg } from './gods'
import type { GodKind } from './gods'
import {
  ALL_DAY,
  END_OF_DAY,
  EVERY_HOURS,
  chipLabel,
  daysLabel,
  dueSlot,
  editSchedule,
  fromOptions,
  scheduleMode,
  scheduleSentence,
  timeOptions,
  toOptions,
} from './schedule'
import type { ScheduleChange } from './schedule'
import type {
  ActivityStep,
  Decision,
  EditValue,
  FormState,
  OutboxItem,
  Panel,
  PendingCreate,
  PendingEdit,
  PendingEdits,
  RegistryWorker,
  Schedule,
  SentTask,
  ToolsPreset,
  WorkerStatus,
} from '../types'

// The schedule's pure functions live in ./schedule; these names stay importable from here.
export {
  chipLabel,
  daysLabel,
  dueDate,
  dueSlot,
  editSchedule,
  intervalSlots,
  scheduleDays,
  scheduleLabel,
  scheduleSentence,
} from './schedule'

// The pane draws one card per worker (the launch film's card) while it is narrow; once
// it is expanded to WIDE_AT columns or more, a list of compact rows beside the selected
// worker's detail. Either way the selected worker's detail has four tabs: Overview,
// Outbox, Activity and Settings, and the selected worker's god colours its card or row,
// badges, chips, tabs and the header's dot (amber stays "needs your yes", green
// "Working", red the destructive Delete).
//
// The standing worker chats come from the call session's registry, read on every
// poll. `session` is the app's chat id (what SendMessage and the claude:// link
// take); `transcript` is the CLI transcript the live status and the activity view
// read. The call session adds workers; the pane edits an entry's own settings (name,
// god, voice, hours, tools, paused, spaces) key by key, keeping every key it does not
// know. The model is picked inside the chat, so the pane neither shows nor switches one.
//
// Every pick in a worker's settings is drawn at once from the `edits` atom, then written
// through one queue, so two quick clicks never interleave their read-modify-writes and
// the last click is what the registry ends with.
//
// Every path hangs off $HOME, read through `$.env.get`. The call session opens the
// pane from the shell with `touch ~/.voicemode/call/open-workers`, so the owner is
// never told to type a command.
//
// Proactive workers. A worker with a `schedule` is woken by this pane: the only local
// thing that can put a message into an existing desktop chat is a mod's
// `$.session.send` (launchd cannot reach a chat, a scheduled task starts a new one).
// A schedule is once a day or every N hours (both shapes in ./schedule). Each wake
// claims its slot with an atomic mkdir first, `wakes/<key>-<date>` once a day (as it
// always has) or `wakes/<key>-<date>-<HHMM>` per interval slot, so however many sessions
// run this poll, a slot wakes the worker once. A paused worker is not woken. A worker appends what it finds and drafts to `outbox/<key>.jsonl`; an
// Approve or Decline here is recorded in `outbox/<key>.decisions.jsonl` and told to the
// worker's chat. `outboxSay` speaks one heads-up per new item if a call is live.

type Paths = {
  home: string
  registry: string
  requests: string
  openFlag: string
  projects: string
  outbox: string
  seen: string
  wakes: string
  spaces: string
  outboxSay: string
  pages: string
}

// The minimal surface of `$` the helpers below take, typed loosely so a helper can
// take the hook's `$` from any event.
type Host = {
  env: { get: (name: string) => Promise<string | undefined> }
  fs: {
    read: (path: string) => Promise<unknown>
    write: (path: string, text: string) => Promise<unknown>
    stat: (path: string) => Promise<{ kind: string; size: number; mtimeMs: number }>
    list: (path?: string) => Promise<readonly { name: string; kind: string }[]>
  }
  process: {
    run: (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  }
}

async function paths($: Host): Promise<Paths> {
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {
    // no HOME: the reads below fail and the pane shows "No workers.json yet"
  }
  home = home.replace(/\/+$/, '')
  const call = `${home}/.voicemode/call`
  const bin = `${home}/.claude/skills/colleague/bin`
  return {
    home,
    registry: `${call}/workers.json`,
    requests: `${call}/requests`,
    openFlag: `${call}/open-workers`,
    projects: `${home}/.claude/projects`,
    outbox: `${call}/outbox`,
    seen: `${call}/outbox/.seen.json`,
    wakes: `${call}/wakes`,
    spaces: `${call}/spaces`,
    outboxSay: `${bin}/outbox-say`,
    pages: `${bin}/pages`,
  }
}

function expandHome(p: Paths, path: string): string {
  return path.startsWith('~/') ? `${p.home}/${path.slice(2)}` : path
}

const FEED_ITEMS = 8
const WAKE_RETRY_MS = 10 * 60_000
const ACTIVITY_STEPS = 10
const TAIL_BYTES = 262_144 // the activity view reads this much of a transcript's end, never the whole file
const SEARCH_RETRY_MS = 60_000 // how often a transcript not found under ~/.claude/projects is looked for again
const PENDING_TTL_MS = 60 * 60_000

const PANE = 'workers'
const COLUMNS = 46
const WORKING_WINDOW_MS = 10_000 // a transcript written this recently means a turn is running
const POLL_MS = 3_000

const CONFIRM_MS = 5_000 // how long an armed Delete waits for its second press
const EDIT_TTL_MS = 15_000 // a picked setting no write settled is dropped after this (a reload mid-write)
// From this many body columns the pane draws the list beside the selected worker's
// detail; under it, one card per worker. The docked pane opens at COLUMNS.
export const WIDE_AT = 80

// The film's palette (claude-ui.js). Fills are drawn as tints of these, so a card
// reads the same on the app's light and dark themes; text keeps the theme's own colour.
const ACCENT = '#c96442'
const SUB = '#73726c'
const GREEN = '#2f8f5b'
const AMBER = '#b7791f'
const RED = '#c2412d'
const BLUE = '#3b6fd8'

/** A hex colour at a low alpha, for a tint behind a card, a chip or a row. */
export function tint(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0')
  return `${hex}${a}`
}

// Each god's accent: a mid shade between its body colours (SPEC section 2) that reads at
// about 4:1 on the app's light page and on its dark one alike, so a border, a badge's
// text or an icon in it holds up in both themes. Fills are tints of it over the theme.
export const GOD_ACCENT: Record<GodKind, string> = {
  colleague: '#6b78e0', // between #3d4aa0 and #b9c6ff
  research: '#9061f9', // between #6d28d9 and #a78bfa
  scribe: '#3b82f6', // between #2563eb and #60a5fa
  scout: '#578f0e', // between #65a30d and a deeper lime, for the light theme
  sales: '#ea580c',
  herald: '#b47a06', // between #ca8a04 and a deeper gold, for the light theme
}

/** One worker's colours: its god's accent, and the tints drawn from it. */
export function themeOf(kind: GodKind): { accent: string; soft: string; wash: string; hover: string } {
  const accent = GOD_ACCENT[kind]
  return { accent, soft: tint(accent, 0.14), wash: tint(accent, 0.05), hover: tint(accent, 0.5) }
}

// Thin line icons: paths from Lucide (https://lucide.dev, ISC licence), drawn at a
// 1.5 px stroke whatever their size.
const ICONS = {
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  play: '<path d="M6 3l14 9-14 9z"/>',
  inbox:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  fileText:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
} as const
type IconName = keyof typeof ICONS

function iconSvg(name: IconName, color: string, size: number): string {
  const stroke = Math.min(2.5, (1.5 * 24) / size).toFixed(2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
}

// The gods, and what a worker without v2 keys gets (SPEC section 3).
const GOD_LABEL: Record<GodKind, string> = {
  colleague: 'Colleague', research: 'Research', scribe: 'Scribe', scout: 'Scout', sales: 'Sales', herald: 'Herald',
}
// The v1 colour preset written beside `god`, for readers that only know `avatar`.
const GOD_AVATAR: Record<GodKind, string> = {
  colleague: 'blue', research: 'violet', scribe: 'blue', scout: 'lime', sales: 'orange', herald: 'gold',
}
const DEFAULT_VOICE: Record<GodKind, string> = {
  colleague: 'af_heart', research: 'af_nicole', scribe: 'bf_emma', scout: 'am_adam', sales: 'am_michael', herald: 'bm_george',
}
export const VOICES = [
  'af_heart', 'af_nicole', 'af_bella', 'af_sky', 'bf_emma', 'bf_isabella', 'am_adam', 'am_michael', 'bm_george', 'bm_lewis',
] as const
const VOICE_HINT: Record<string, string> = { af: 'US, female', bf: 'UK, female', am: 'US, male', bm: 'UK, male' }

const TOOL_PRESETS: readonly { value: ToolsPreset; label: string; about: string }[] = [
  { value: 'read', label: 'Read only', about: 'Reads files and the web. Writes nothing.' },
  { value: 'drafts', label: 'Drafts only', about: 'Reads, and writes drafts under ~/.voicemode/call only.' },
  { value: 'full', label: 'Full access', about: 'No guard: anything this Mac lets Claude Code do.' },
]

const DAY_PRESETS: readonly { value: string; label: string }[] = [
  { value: 'mon-fri', label: 'Mon to Fri' },
  { value: 'sun-thu', label: 'Sun to Thu' },
  { value: 'daily', label: 'Every day' },
  { value: 'mon,wed,fri', label: 'Mon, Wed, Fri' },
  { value: 'sat,sun', label: 'Weekends' },
]

/** The Hours control's modes: no schedule, once a day, or every N hours. */
const MODES: readonly { value: string; label: string }[] = [
  { value: 'off', label: 'Manual, no schedule' },
  { value: 'daily', label: 'Once a day' },
  ...EVERY_HOURS.map(n => ({ value: `${n}h`, label: `Every ${n}h` })),
]

const TAB_LABEL: Record<Panel, string> = { overview: 'Overview', outbox: 'Outbox', activity: 'Activity', settings: 'Settings' }
const TABS: readonly Panel[] = ['overview', 'outbox', 'activity', 'settings']

const NAME_RE = /^[\p{L}\p{N} ]{1,24}$/u

const roster = atom({ plugin: 'workers-pane', key: 'roster' } as const, '', { shape: 'roster-1' })
const rev = atom({ plugin: 'workers-pane', key: 'rev' } as const, 0, { shape: 'rev-1' })
const sent = atom({ plugin: 'workers-pane', key: 'sent' } as const, {}, { shape: 'sent-1' })
const formState = atom(
  { plugin: 'workers-pane', key: 'form' } as const,
  { isOpen: false, isValid: false, isTried: false, god: 'scribe' } as FormState,
  { shape: 'form-5' },
)
const selected = atom({ plugin: 'workers-pane', key: 'selected' } as const, '', { shape: 'selected-1' })
const confirming = atom({ plugin: 'workers-pane', key: 'confirming' } as const, {}, { shape: 'confirming-1' })
const removing = atom({ plugin: 'workers-pane', key: 'removing' } as const, {}, { shape: 'removing-1' })
const paneShown = atom({ plugin: 'workers-pane', key: 'paneShown' } as const, false, { shape: 'pane-shown-1' })
const panels = atom({ plugin: 'workers-pane', key: 'panels' } as const, {} as Record<string, Panel>, { shape: 'panels-1' })
const deciding = atom({ plugin: 'workers-pane', key: 'deciding' } as const, {}, { shape: 'deciding-1' })
const pending = atom({ plugin: 'workers-pane', key: 'pending' } as const, {} as Record<string, PendingCreate>, {
  shape: 'pending-1',
})
const edits = atom({ plugin: 'workers-pane', key: 'edits' } as const, {} as PendingEdits, {
  shape: 'edits-1',
})

type Snapshot = {
  workers: RegistryWorker[]
  status: Record<string, WorkerStatus>
  /** Worker key to its transcript's path, where it was found. */
  transcripts: Record<string, string>
  /** Worker key to its outbox, oldest first, as the file lists it. */
  outbox: Record<string, OutboxItem[]>
  /** Worker key to item id to its decision. */
  decided: Record<string, Record<string, Decision>>
  seen: Record<string, number>
  error?: string
}

/** Lookups kept per registration: where each transcript lives, and the last steps read. */
type Cache = {
  where: Map<string, string>
  missAt: Map<string, number>
  steps: Map<string, { mtimeMs: number; steps: ActivityStep[] }>
}

type Panes = { ui: { panes: () => Promise<readonly { id: string; isShown: boolean; isPlaced: boolean }[]> } }

/** The band's redraw trigger: kept in step on every open, close and poll. */
async function syncShown($: Panes & Parameters<typeof update>[0]): Promise<void> {
  const isShown = await isPaneShown($)
  await update($, paneShown, old => (old === isShown ? old : isShown))
}

/** Whether the Workers pane is the one a surface shows right now. */
async function isPaneShown($: Panes): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && p.isShown && p.isPlaced)
  } catch {
    return false
  }
}

function withoutKey<T>(old: Record<string, T>, key: string): Record<string, T> {
  if (!(key in old)) return old
  const { [key]: _gone, ...rest } = old
  return rest
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidName(name: string): boolean {
  const n = name.trim()
  return n.length > 0 && NAME_RE.test(n)
}

/** The New worker field's one line, split at its first comma: the name, then what it does. */
function splitEntry(text: string): { name: string; role: string } {
  const at = text.indexOf(',')
  return at < 0
    ? { name: text.trim(), role: '' }
    : { name: text.slice(0, at).trim(), role: text.slice(at + 1).trim() }
}

/**
 * The one-line prompt the call session acts on. `;` and newlines would break its
 * fields. The v1 fields come first, so a call session that only knows them still works.
 */
export function createText(f: { name: string; role: string; god: GodKind }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/;/g, ',').trim()
  return (
    `Create worker: name=${clean(f.name)}; role=${clean(f.role)}; avatar=${GOD_AVATAR[f.god]}; ` +
    `god=${f.god}; voice=${DEFAULT_VOICE[f.god]}; tools=drafts`
  )
}

function isGod(v: unknown): v is GodKind {
  return typeof v === 'string' && (GOD_KINDS as readonly string[]).includes(v)
}

/** A worker's god: its `god`, else derived from its v1 `avatar` colour. */
export function godOf(w: Pick<RegistryWorker, 'god' | 'avatar'>): GodKind {
  if (isGod(w.god)) return w.god
  switch ((w.avatar ?? '').trim().toLowerCase()) {
    case 'purple':
    case 'violet':
      return 'research'
    case 'blue':
      return 'scribe'
    case 'green':
    case 'lime':
      return 'scout'
    case 'orange':
    case 'red':
    case 'rose':
      return 'sales'
    case 'yellow':
    case 'gold':
      return 'herald'
    default:
      return 'colleague'
  }
}

/** A worker's voice: its `voice`, else its god's default. */
export function voiceOf(w: Pick<RegistryWorker, 'god' | 'avatar' | 'voice'>): string {
  return typeof w.voice === 'string' && w.voice.trim() ? w.voice.trim() : DEFAULT_VOICE[godOf(w)]
}

/** A worker's tools: absent means `full`, so a worker made before v2 keeps what it had. */
export function toolsOf(w: Pick<RegistryWorker, 'tools'>): ToolsPreset | string[] {
  if (Array.isArray(w.tools)) return w.tools.filter((t): t is string => typeof t === 'string')
  return w.tools === 'read' || w.tools === 'drafts' || w.tools === 'full' ? w.tools : 'full'
}

/**
 * The spaces a worker may write pages to, as `bin/pages` reads the registry: `"*"` for
 * all, a list of slugs, or, with no key, Notes alone.
 */
export function spacesOf(w: Pick<RegistryWorker, 'spaces'>): { isAll: boolean; isDefault: boolean; list: string[] } {
  if (w.spaces === '*') return { isAll: true, isDefault: false, list: [] }
  if (Array.isArray(w.spaces)) return { isAll: false, isDefault: false, list: w.spaces.filter((s): s is string => typeof s === 'string') }
  if (w.spaces === undefined) return { isAll: false, isDefault: true, list: ['notes'] }
  return { isAll: false, isDefault: false, list: [] }
}

/** The worker whose outbox the open-workers flag asks for (`{"outbox": "<key>"}`), if any. */
async function flagOutbox($: Host, p: Paths): Promise<string | undefined> {
  try {
    const j = JSON.parse(String(await $.fs.read(p.openFlag))) as unknown
    return isObject(j) && typeof j.outbox === 'string' && j.outbox.trim() ? j.outbox.trim() : undefined
  } catch {
    return undefined // an empty `touch`, or not JSON
  }
}

async function readRegistry($: Host, p: Paths): Promise<{ workers: RegistryWorker[]; error?: string }> {
  let raw: unknown
  try {
    raw = await $.fs.read(p.registry)
  } catch {
    return { workers: [], error: 'No workers.json yet' }
  }
  try {
    const parsed = JSON.parse(String(raw)) as { workers?: unknown }
    const list = Array.isArray(parsed.workers) ? parsed.workers : []
    const workers = list.filter(
      (w): w is RegistryWorker =>
        isObject(w) && typeof (w as RegistryWorker).key === 'string' && typeof (w as RegistryWorker).name === 'string',
    )
    return { workers }
  } catch {
    return { workers: [], error: 'workers.json is not valid JSON' }
  }
}

/**
 * Rewrites the registry with `edit` applied to the parsed file, so every key the pane
 * does not know (top level and per worker) is written back as it was. Answers an error
 * to show, or undefined once written.
 */
async function editRegistry(
  $: Host,
  p: Paths,
  edit: (workers: unknown[]) => boolean,
): Promise<string | undefined> {
  let doc: Record<string, unknown>
  try {
    const parsed = JSON.parse(String(await $.fs.read(p.registry))) as unknown
    if (!isObject(parsed)) return 'workers.json is not an object'
    doc = parsed
  } catch (err) {
    return `couldn't read workers.json: ${String(err)}`
  }
  const workers = Array.isArray(doc.workers) ? doc.workers : []
  if (!edit(workers)) return 'that worker is not in workers.json any more'
  doc.workers = workers
  try {
    await $.fs.write(p.registry, JSON.stringify(doc, null, 2))
  } catch (err) {
    return `couldn't write workers.json: ${String(err)}`
  }
  return undefined
}

/** Sets (or, for undefined, removes) these keys on one worker's entry; nothing else changes. */
export async function patchWorker(
  $: Host,
  p: Paths,
  key: string,
  patch: Record<string, unknown>,
): Promise<string | undefined> {
  return editRegistry($, p, workers => {
    const entry = workers.find(w => isObject(w) && w.key === key)
    if (!isObject(entry)) return false
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete entry[k]
      else entry[k] = v
    }
    return true
  })
}

/**
 * A registry `transcript` as a path: absolute, `~/`-relative, relative to
 * ~/.claude/projects, or a bare file name found under one of its project folders
 * (remembered once found; a miss is looked for again after a minute).
 */
async function resolveTranscript(
  $: Host,
  p: Paths,
  cache: Cache,
  t: string,
  now: number,
): Promise<string | undefined> {
  if (t.startsWith('/')) return t
  if (t.startsWith('~/')) return `${p.home}/${t.slice(2)}`
  if (t.includes('/')) return `${p.projects}/${t}`
  const known = cache.where.get(t)
  if (known) return known
  if (now - (cache.missAt.get(t) ?? -Infinity) < SEARCH_RETRY_MS) return undefined
  cache.missAt.set(t, now)
  let entries: readonly { name: string; kind: string }[]
  try {
    entries = await $.fs.list(p.projects)
  } catch {
    return undefined
  }
  // The folders other workers' transcripts were found in first: workers share one.
  const hinted = [...new Set([...cache.where.values()].map(v => v.slice(0, v.lastIndexOf('/'))))]
  const rest = entries.filter(e => e.kind === 'dir').map(e => `${p.projects}/${e.name}`).filter(d => !hinted.includes(d))
  for (const dir of [...hinted, ...rest]) {
    try {
      const st = await $.fs.stat(`${dir}/${t}`)
      if (st.kind !== 'file') continue
    } catch {
      continue
    }
    cache.where.set(t, `${dir}/${t}`)
    cache.missAt.delete(t)
    return `${dir}/${t}`
  }
  return undefined
}

async function snapshot($: Host, p: Paths, cache: Cache, now: number): Promise<Snapshot> {
  const { workers, error } = await readRegistry($, p)
  const status: Record<string, WorkerStatus> = {}
  const transcripts: Record<string, string> = {}
  for (const w of workers) {
    if (!w.transcript) {
      status[w.key] = { isWorking: false, lastActiveMs: 0, isNew: true }
      continue
    }
    const path = await resolveTranscript($, p, cache, w.transcript, now)
    if (!path) {
      status[w.key] = { isWorking: false, lastActiveMs: 0, isNew: false }
      continue
    }
    try {
      const st = await $.fs.stat(path)
      transcripts[w.key] = path
      status[w.key] = { isWorking: now - st.mtimeMs < WORKING_WINDOW_MS, lastActiveMs: st.mtimeMs, isNew: false }
    } catch {
      cache.where.delete(w.transcript) // moved or gone: look for it again
      status[w.key] = { isWorking: false, lastActiveMs: 0, isNew: false }
    }
  }
  const outbox: Record<string, OutboxItem[]> = {}
  const decided: Record<string, Record<string, Decision>> = {}
  for (const w of workers) {
    outbox[w.key] = await readOutbox($, p, w.key)
    decided[w.key] = await readDecisions($, p, w.key)
  }
  return { workers, status, transcripts, outbox, decided, seen: await readSeen($, p), error }
}

/** What a redraw depends on, coarse enough that an idle pane is not redrawn every poll. */
function signature(s: Snapshot, watched: ReadonlySet<string>): string {
  return JSON.stringify([
    s.error ?? '',
    s.workers.map(w => [
      w.key, w.name, w.role, w.session, w.transcript, w.avatar, w.god, w.voice, w.tools, w.paused, w.spaces,
      w.charter ? 1 : 0, w.schedule,
    ]),
    s.workers.map(w => {
      const st = s.status[w.key]
      return [st?.isWorking, st?.isNew, Math.floor((st?.lastActiveMs ?? 0) / 60_000)]
    }),
    s.workers.map(w => {
      const items = s.outbox[w.key] ?? []
      return [items.length, items[items.length - 1]?.id ?? '', Object.keys(s.decided[w.key] ?? {}).length, s.seen[w.key] ?? 0]
    }),
    // An open activity view follows its transcript as it is written.
    s.workers.filter(w => watched.has(w.key)).map(w => s.status[w.key]?.lastActiveMs ?? 0),
  ])
}

// SHA-1 over UTF-8, for the ids of outbox lines written before ids existed. The
// module has no crypto of its own, so it is spelled out here.
function utf8(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

export function sha1Hex(text: string): string {
  const bytes = utf8(text)
  const bits = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bits / 0x100000000)
  const lo = bits >>> 0
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255)
  bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  const b = (i: number) => bytes[i] ?? 0
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w: number[] = new Array<number>(80).fill(0)
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = (b(i + 4 * t) << 24) | (b(i + 4 * t + 1) << 16) | (b(i + 4 * t + 2) << 8) | b(i + 4 * t + 3)
    for (let t = 16; t < 80; t++) {
      const x = (w[t - 3] ?? 0) ^ (w[t - 8] ?? 0) ^ (w[t - 14] ?? 0) ^ (w[t - 16] ?? 0)
      w[t] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let bb = h1
    let c = h2
    let d = h3
    let e = h4
    for (let t = 0; t < 80; t++) {
      let f: number
      let k: number
      if (t < 20) {
        f = (bb & c) | (~bb & d)
        k = 0x5a827999
      } else if (t < 40) {
        f = bb ^ c ^ d
        k = 0x6ed9eba1
      } else if (t < 60) {
        f = (bb & c) | (bb & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = bb ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + (w[t] ?? 0)) | 0
      e = d
      d = c
      c = (bb << 30) | (bb >>> 2)
      bb = a
      a = temp
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + bb) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }
  return [h0, h1, h2, h3, h4].map(h => (h >>> 0).toString(16).padStart(8, '0')).join('')
}

/** The id of an outbox line written before v2: `ob_` + the first 12 hex of sha1(at + title). */
export function legacyId(at: string, title: string): string {
  return `ob_${sha1Hex(at + title).slice(0, 12)}`
}

/** A worker's outbox text as items, oldest first. A line that is not a valid item is skipped. */
export function parseOutbox(raw: string): OutboxItem[] {
  const items: OutboxItem[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Partial<OutboxItem> & Record<string, unknown>
      if (typeof o.title !== 'string' || typeof o.at !== 'string') continue
      items.push({
        id: typeof o.id === 'string' && o.id.trim() ? o.id.trim() : legacyId(o.at, o.title),
        at: o.at,
        kind: o.kind === 'draft' || o.kind === 'page' ? o.kind : 'note',
        title: o.title,
        body: typeof o.body === 'string' ? o.body : '',
        to: typeof o.to === 'string' && o.to ? o.to : undefined,
        needs_approval: o.needs_approval === true,
        space: typeof o.space === 'string' && o.space ? o.space : undefined,
        draft_path: typeof o.draft_path === 'string' && o.draft_path ? o.draft_path : undefined,
        page: typeof o.page === 'string' && o.page ? o.page : undefined,
      })
    } catch {
      // a half-written or hand-edited line
    }
  }
  return items
}

/** A decisions file as item id to its latest decision. */
export function parseDecisions(raw: string): Record<string, Decision> {
  const out: Record<string, Decision> = {}
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Partial<Decision>
      if (typeof o.id !== 'string' || (o.decision !== 'approved' && o.decision !== 'declined')) continue
      out[o.id] = { id: o.id, decision: o.decision, at: typeof o.at === 'string' ? o.at : '' }
    } catch {
      // skipped
    }
  }
  return out
}

async function readOutbox($: Host, p: Paths, key: string): Promise<OutboxItem[]> {
  try {
    return parseOutbox(String(await $.fs.read(`${p.outbox}/${key}.jsonl`)))
  } catch {
    return []
  }
}

async function readDecisions($: Host, p: Paths, key: string): Promise<Record<string, Decision>> {
  try {
    return parseDecisions(String(await $.fs.read(`${p.outbox}/${key}.decisions.jsonl`)))
  } catch {
    return {}
  }
}

async function readSeen($: Host, p: Paths): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(String(await $.fs.read(p.seen))) as unknown
    return isObject(parsed) ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function atMs(item: OutboxItem): number {
  const t = Date.parse(item.at)
  return Number.isNaN(t) ? 0 : t
}

/** The items still waiting for a yes: they need approval and have no decision. */
export function awaiting(items: readonly OutboxItem[], decided: Readonly<Record<string, unknown>>): OutboxItem[] {
  return items.filter(i => i.needs_approval && decided[i.id] === undefined)
}

/** The badge beside the name: "1 draft", "2 drafts", or '' with nothing waiting. */
export function badge(items: readonly OutboxItem[], decided: Readonly<Record<string, unknown>>): string {
  const n = awaiting(items, decided).length
  return n === 0 ? '' : n === 1 ? '1 draft' : `${n} drafts`
}

/** The outbox chip: "Outbox · 2" (what waits for a yes), or "Hide outbox" while open. */
export function outboxLabel(waiting: number, isOpen: boolean): string {
  return isOpen ? 'Hide outbox' : `Outbox · ${waiting}`
}

/** The spoken heads-up for one new outbox item: "Inbox drafted a reply to Jordan". */
export function headsUp(name: string, item: Pick<OutboxItem, 'kind' | 'title'>): string {
  const title = item.title.trim().replace(/\s+/g, ' ')
  const lower = title.charAt(0).toLowerCase() + title.slice(1)
  return item.kind === 'note' ? `${name} has a note: ${title}` : `${name} drafted ${lower}`
}

/** What the worker is told on Approve (a draft or a note) and on Decline (SPEC section 3). */
export function approveText(item: Pick<OutboxItem, 'id' | 'title'>): string {
  return `Approved in the Workers pane: ${item.title} (${item.id}). Go ahead with exactly what the draft says, then report back.`
}
export function pageSavedText(item: Pick<OutboxItem, 'id' | 'title' | 'space'>): string {
  return `Approved in the Workers pane: ${item.title} (${item.id}). It is saved as a page in ${item.space ?? 'its space'}.`
}
export function declineText(item: Pick<OutboxItem, 'id' | 'title'>): string {
  return `Declined: ${item.title} (${item.id}). Don't do it.`
}

/** The message that wakes a worker to run its charter; it carries the whole charter. */
export function wakeText(w: RegistryWorker, why: string): string {
  return [
    `${why}: run your charter now. Read what is new, draft what needs a move, and append each item ` +
      `to ~/.voicemode/call/outbox/${w.key}.jsonl. Drafts only: send, post or change nothing outward.`,
    '',
    'Your charter:',
    w.charter ?? '',
  ].join('\n')
}

/** A path as the activity view shows it: home as ~, a long one cut to its last two parts. */
function shortPath(path: string, home: string): string {
  let s = path
  if (home && (s === home || s.startsWith(`${home}/`))) s = `~${s.slice(home.length)}`
  if (s.length <= 44) return s
  const parts = s.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : s
}

function oneLine(s: string, max = 72): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The short argument of one tool call: a path, a pattern, the Bash description. */
export function shortArg(tool: string, input: unknown, home: string): string {
  const i = isObject(input) ? input : {}
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const base = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool
  switch (base) {
    case 'Bash':
      return oneLine(str('description') || str('command').split('\n')[0] || '')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'NotebookRead':
      return shortPath(str('file_path') || str('notebook_path') || str('path'), home)
    case 'Grep':
      return oneLine(`"${str('pattern')}"${str('path') ? ` in ${shortPath(str('path'), home)}` : ''}`)
    case 'Glob':
      return oneLine(`${str('pattern')}${str('path') ? ` in ${shortPath(str('path'), home)}` : ''}`)
    case 'WebFetch':
      return oneLine(str('url').replace(/^https?:\/\//, ''))
    case 'WebSearch':
      return oneLine(str('query'))
    case 'Skill':
      return oneLine(str('skill'))
    case 'Task':
    case 'Agent':
      return oneLine(str('description'))
    default: {
      for (const k of ['description', 'file_path', 'path', 'command', 'query', 'url', 'pattern', 'title', 'name', 'text']) {
        const v = str(k)
        if (v) return k.endsWith('path') ? shortPath(v, home) : oneLine(v)
      }
      return ''
    }
  }
}

/**
 * The last `limit` tool calls in a transcript's text (its tail: a cut first line is
 * skipped), newest first. Only the assistant's own rows count, each call once.
 */
export function parseSteps(text: string, home: string, limit = ACTIVITY_STEPS): ActivityStep[] {
  const steps: ActivityStep[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(o) || o.type !== 'assistant' || !isObject(o.message)) continue
    const row = o
    const content = o.message.content
    if (!Array.isArray(content)) continue
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    content.forEach((block, n) => {
      if (!isObject(block) || block.type !== 'tool_use' || typeof block.name !== 'string') return
      const id = typeof block.id === 'string' ? block.id : `${String(row.uuid ?? '')}-${n}`
      if (seen.has(id)) return
      seen.add(id)
      const tool = block.name.startsWith('mcp__') ? (block.name.split('__').pop() ?? block.name) : block.name
      steps.push({ id, tool, arg: shortArg(block.name, block.input, home), atMs: Number.isNaN(at) ? 0 : at })
    })
  }
  return steps.slice(-limit).reverse()
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * A worker as the pane draws it: its registry entry with the settings picked in the
 * pane and not yet written laid over it (a null value removes that key).
 */
export function withEdits(w: RegistryWorker, picked: Readonly<Record<string, PendingEdit>> | undefined): RegistryWorker {
  if (!picked || Object.keys(picked).length === 0) return w
  const out: Record<string, unknown> = { ...w }
  for (const [k, e] of Object.entries(picked)) {
    if (e.value === null) delete out[k]
    else out[k] = e.value
  }
  return out as RegistryWorker
}

/** Drops these fields of one worker's picked settings where `isMine` holds; the same object when nothing goes. */
function dropEdits(old: PendingEdits, key: string, fields: readonly string[], isMine: (field: string) => boolean): PendingEdits {
  const entry = old[key]
  if (!entry) return old
  const left = { ...entry }
  let isChanged = false
  for (const f of fields) {
    if (f in left && isMine(f)) {
      delete left[f]
      isChanged = true
    }
  }
  if (!isChanged) return old
  return Object.keys(left).length === 0 ? withoutKey(old, key) : { ...old, [key]: left }
}

/** The pane's width in cells: its body's, else the surface's, else what it opens at. */
export function paneColumns(props: { bodyColumns?: number }, viewport?: { columns?: number }): number {
  if (typeof props.bodyColumns === 'number' && props.bodyColumns > 0) return props.bodyColumns
  if (viewport && typeof viewport.columns === 'number' && viewport.columns > 0) return viewport.columns
  return COLUMNS
}

export const register: Register = on => {
  let timer: Timer | undefined
  // Every write of workers.json from this pane runs in turn on this chain: a settings
  // pick, a delete, a create's fill-in. Each one reads the file afresh, so two never
  // interleave their read-modify-write, and the last click is the last write.
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const run = chain.then(job)
    chain = run.catch(() => undefined)
    return run
  }
  // The newest pick per "<worker key>\n<field>": a queued write whose pick was overtaken
  // by a later one for the same field skips that field (last click wins).
  const ticket = { n: 0, latest: new Map<string, number>() }
  // What is typed per worker, so a status redraw does not wipe a half-typed task or name.
  const drafts = new Map<string, string>()
  const names = new Map<string, string>()
  // The New worker form's one field ("Name, then what it does"), kept here for the same reason.
  const form = { text: '' }
  // Wakes this instance has already handled ("<key>-<date>"), when an undelivered one
  // may try again, and the outbox item ids each worker has had announced (absent until
  // the first look, which only sets the baseline).
  const checked = new Set<string>()
  const retryAt = new Map<string, number>()
  const heard = new Map<string, Set<string>>()
  const cache: Cache = { where: new Map(), missAt: new Map(), steps: new Map() }
  let isPolling = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'workers', description: 'Show the Workers pane' })
    void $.ui.open({ id: PANE, title: 'Workers', columns: COLUMNS })
    // Picks from before a reload have no write left to settle them.
    await update($, edits, old => (Object.keys(old).length === 0 ? old : {}))

    timer?.cancel()
    let openedAt = await $.clock.now()
    const poll = async () => {
      const now = await $.clock.now()
      const p = await paths($ as unknown as Host)
      try {
        const flag = await $.fs.stat(p.openFlag)
        if (flag.mtimeMs > openedAt) {
          openedAt = flag.mtimeMs
          // A plain `touch` opens the pane; `{"outbox": "<key>"}` (the Spaces pane's
          // Review) also opens that worker's outbox.
          const key = await flagOutbox($ as unknown as Host, p)
          if (key) {
            await update($, panels, old => (old[key] === 'outbox' ? old : { ...old, [key]: 'outbox' as const }))
            await update($, selected, old => (old === key ? old : key))
          }
          void $.ui.open({ id: PANE, title: 'Workers', columns: COLUMNS, focus: true })
        }
      } catch {
        // no flag yet
      }
      const snap = await snapshot($ as unknown as Host, p, cache, now)
      // A pick whose write never settled (the module reloaded mid-write) gives way to
      // the registry after EDIT_TTL_MS.
      await update($, edits, old => {
        let out = old
        for (const [key, fields] of Object.entries(old)) {
          const stale = Object.entries(fields).filter(([, v]) => now - v.at > EDIT_TTL_MS).map(([f]) => f)
          if (stale.length > 0) out = dropEdits(out, key, stale, () => true)
        }
        return out
      })
      // A delete is done once the worker has left the registry.
      if (!snap.error) {
        await update($, removing, old => {
          const left = Object.entries(old).filter(([key]) => snap.workers.some(x => x.key === key))
          return left.length === Object.keys(old).length ? old : Object.fromEntries(left)
        })
      }
      const open = await read($, panels).catch(() => ({}) as Record<string, Panel>)
      const watched = new Set(Object.entries(open).filter(([, v]) => v === 'activity').map(([k]) => k))
      const sig = signature(snap, watched)
      await update($, roster, old => (old === sig ? old : sig))
      await syncShown($)
      // One poll at a time: a slow process.run must not let an older snapshot run last.
      if (isPolling) return
      isPolling = true
      try {
        await wakeDue(snap, now, p)
        announce(snap, p)
        if (!snap.error) await fillPending(snap, now, p)
      } finally {
        isPolling = false
      }
    }

    // Wakes each scheduled, unpaused worker once per due slot (a day, or an interval's
    // slot). `checked` spares the mkdir on every poll; the mkdir is what makes it once
    // across sessions. A wake that is not delivered (the chat not running yet) gives the
    // claim back and retries later, while its slot is still due.
    const wakeDue = async (snap: Snapshot, now: number, p: Paths) => {
      const self = await $.session.id().catch(() => '')
      for (const w of snap.workers) {
        if (!w.schedule || !w.session || !w.charter) continue
        if (w.paused === true) continue
        // The worker's own chat never wakes itself.
        if (self && w.transcript?.split('/').pop() === `${self}.jsonl`) continue
        const slot = dueSlot(w.schedule, now)
        if (!slot) continue
        const id = `${w.key}-${slot.id}`
        if (checked.has(id) || (retryAt.get(id) ?? 0) > now) continue
        checked.add(id)
        const claimDir = `${p.wakes}/${id}`
        try {
          await $.process.run(['/bin/mkdir', '-p', p.wakes])
          const claim = await $.process.run(['/bin/mkdir', claimDir])
          if (claim.exitCode !== 0) continue // this slot already woke it, from this or another session
        } catch {
          continue
        }
        let isDelivered = false
        let reason: string | undefined
        try {
          const result = await $.session.send({
            to: w.session,
            text: wakeText(w, `Scheduled run (${slot.date} ${slot.time} ${w.schedule.tz})`),
          })
          isDelivered = result.isDelivered !== false
          reason = result.isDelivered === false ? result.reason : undefined
        } catch (err) {
          reason = String(err)
        }
        if (!isDelivered) {
          await $.process.run(['/bin/rmdir', claimDir]).catch(() => undefined)
          checked.delete(id)
          retryAt.set(id, now + WAKE_RETRY_MS)
        } else {
          await $.fs
            .write(`${claimDir}/result.json`, JSON.stringify({ at: now, isDelivered, reason }))
            .catch(() => undefined)
        }
        await update($, sent, old => ({
          ...old,
          [w.key]: { text: 'Scheduled run of its charter', atMs: now, isDelivered, reason },
        }))
        $.ui.toast(isDelivered ? `${w.name} woke for its scheduled run` : `${w.name} didn't wake, retrying in 10 min: ${reason ?? 'not delivered'}`)
      }
    }

    // A new outbox item: a toast, and one spoken line if a call is live (outbox-say
    // checks the call and locks per item, so two sessions never say it twice). Items
    // are known by id, so a rewritten file re-announces nothing it already had.
    const announce = (snap: Snapshot, p: Paths) => {
      for (const w of snap.workers) {
        const items = snap.outbox[w.key] ?? []
        const known = heard.get(w.key)
        if (known === undefined) {
          heard.set(w.key, new Set(items.map(i => i.id))) // the first look sets the baseline
          continue
        }
        if (items.length === 0 && known.size > 0) continue // a failed read, not an emptied outbox
        for (const item of items) {
          if (known.has(item.id)) continue
          known.add(item.id)
          const line = headsUp(w.name, item)
          $.ui.toast(line)
          void $.process.run([p.outboxSay, w.key, item.id, line]).catch(() => undefined)
        }
      }
    }

    // A worker created from this pane: once the call session has registered it, the
    // god, voice and tools it was created with are filled in where the entry lacks them.
    const fillPending = async (snap: Snapshot, now: number, p: Paths) => {
      const waiting = await read($, pending)
      const done: string[] = []
      for (const [name, pc] of Object.entries(waiting)) {
        if (now - pc.atMs > PENDING_TTL_MS) {
          done.push(name)
          continue
        }
        const w = snap.workers.find(x => x.name === name && !pc.known.includes(x.key))
        if (!w) continue
        const patch: Record<string, unknown> = {}
        if (w.god === undefined) patch.god = pc.god
        if (w.voice === undefined) patch.voice = pc.voice
        if (w.tools === undefined) patch.tools = pc.tools
        if (Object.keys(patch).length > 0) await serial(() => patchWorker($ as unknown as Host, p, w.key, patch))
        done.push(name)
      }
      if (done.length > 0) {
        await update($, pending, old => {
          const left = { ...old }
          for (const d of done) delete left[d]
          return left
        })
      }
    }
    void poll()
    timer = $.clock.every(POLL_MS, () => void poll())

    return next(e)
  })

  on('command.run', { command: 'workers' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Workers', columns: COLUMNS })

    return { text: 'Workers pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Input?: any; Select?: any; Svg?: any }
    const { Box, Text, Button, Input, Select, Svg } = ui
    // The terminal paints no alpha hex and draws no Svg; tints, icons and gods are for
    // the graphical surfaces.
    const isGraphical = e.surface !== 'terminal'
    // Wide (the pane expanded): the list of workers beside the selected one's detail.
    const isWide = paneColumns(e.props, e.viewport) >= WIDE_AT
    const now = await $.clock.now()
    await read($, roster) // subscribe: the poll's signature change redraws the pane
    await read($, rev) // and the pane's own registry writes
    const p = await paths($ as unknown as Host)
    const snap = await snapshot($ as unknown as Host, p, cache, now)
    const tasks = await read($, sent)
    const fs = await read($, formState)
    const picked = await read($, selected)
    const armed = await read($, confirming)
    const leaving = await read($, removing)
    const open = await read($, panels)
    const busy = await read($, deciding)
    const picks = await read($, edits)

    const refresh = () => update($, rev, n => n + 1)

    // What the pane draws: each worker with its settings picks laid over the registry,
    // so a radio group's highlight moves on the click, not when the write lands.
    const live = snap.workers.filter(w => leaving[w.key] === undefined).map(w => withEdits(w, picks[w.key]))
    // The selected worker: the one last picked, else the first.
    const current = live.find(w => w.key === picked) ?? live[0]
    const tabOf = (w: RegistryWorker): Panel => (w.key === current?.key ? (open[w.key] ?? 'overview') : 'overview')

    const icon = (name: IconName, color = SUB, size = 13, key?: string) =>
      Svg && isGraphical ? <Svg key={key} source={iconSvg(name, color, size)} alt={name} width={size} height={size} /> : null

    const godAvatar = (kind: GodKind, size: number, isWorking: boolean, alt: string, key?: string) =>
      Svg && isGraphical ? (
        <Svg
          key={key}
          source={godSvg(kind, { size, state: isWorking ? 'work' : 'idle', animated: isWorking, halo: true })}
          alt={alt}
          width={size}
          height={size}
          {...(isWorking ? { isInteractive: true } : {})}
        />
      ) : (
        <Text bold color={GOD_ACCENT[kind]}>●</Text>
      )

    const select = (w: RegistryWorker) => update($, selected, old => (old === w.key ? old : w.key))

    const setTab = (w: RegistryWorker, tab: Panel) =>
      update($, panels, old => {
        if (tab === 'overview') return withoutKey(old, w.key)
        return old[w.key] === tab ? old : { ...old, [w.key]: tab }
      })

    // Opening the outbox marks its items seen (.seen.json, the newest item looked at).
    const markSeen = async (w: RegistryWorker) => {
      const newest = Math.max(0, ...(snap.outbox[w.key] ?? []).map(atMs))
      if (newest <= (snap.seen[w.key] ?? 0)) return
      try {
        await $.fs.write(p.seen, JSON.stringify({ ...(await readSeen($ as unknown as Host, p)), [w.key]: newest }))
      } catch {
        // looked at again next time
      }
    }

    // A tab is a radio: the press selects that worker and shows the tab.
    const showTab = async (w: RegistryWorker, tab: Panel) => {
      await select(w)
      await setTab(w, tab)
      if (tab === 'outbox') await markSeen(w)
    }

    // The tab a worker shows right now, read at the press (not the drawing's copy).
    const tabNow = async (w: RegistryWorker): Promise<Panel> => {
      const sel = await read($, selected)
      const isCurrent = sel === w.key || (!live.some(x => x.key === sel) && live[0]?.key === w.key)
      return isCurrent ? ((await read($, panels))[w.key] ?? 'overview') : 'overview'
    }

    // The card's Outbox chip: opens that tab, or closes it back to Overview.
    const toggleFeed = async (w: RegistryWorker) => {
      if ((await tabNow(w)) === 'outbox') await setTab(w, 'overview')
      else await showTab(w, 'outbox')
    }

    // A settings pick: drawn at once from `edits`, then written in turn on the one
    // queue. `decide` gets the worker as it is at that instant (every earlier pick laid
    // over the registry) and answers the change, or undefined for none; it runs inside
    // the atom's compare-and-swap, so two quick clicks see each other. A pick overtaken
    // by a later pick of the same setting is not written, so the last click is what
    // workers.json ends with; a failed write drops the pick and the registry shows again.
    const choose = async (
      w: RegistryWorker,
      decide: (now: RegistryWorker) => Record<string, unknown> | undefined,
    ): Promise<boolean> => {
      const at = await $.clock.now()
      let change: Record<string, unknown> | undefined
      let mine = 0
      // `update` retries `fn` until its write lands, so `change` and `mine` end as the
      // attempt that committed; a later pick commits later and draws a larger number.
      await update($, edits, old => {
        change = decide(withEdits(w, old[w.key]))
        if (!change || Object.keys(change).length === 0) return old
        const picked = change
        mine = ++ticket.n
        return {
          ...old,
          [w.key]: {
            ...(old[w.key] ?? {}),
            ...Object.fromEntries(Object.keys(picked).map(f => [f, { value: (picked[f] ?? null) as EditValue, at }])),
          },
        }
      })
      const picked: Record<string, unknown> | undefined = change
      if (!picked || Object.keys(picked).length === 0) return true
      const fields = Object.keys(picked)
      // The newest pick per field only ever rises, whatever order these lines run in.
      for (const f of fields) {
        const k = `${w.key}\n${f}`
        if ((ticket.latest.get(k) ?? 0) < mine) ticket.latest.set(k, mine)
      }
      const isMine = (f: string) => ticket.latest.get(`${w.key}\n${f}`) === mine
      return serial(async () => {
        const due = fields.filter(isMine)
        if (due.length === 0) return true
        const err = await patchWorker($ as unknown as Host, p, w.key, Object.fromEntries(due.map(f => [f, picked[f]])))
        await update($, edits, old => dropEdits(old, w.key, due, isMine))
        await refresh()
        if (err) {
          $.ui.toast(`Couldn't save ${w.name}: ${err}`)
          return false
        }
        return true
      })
    }

    const openChat = async (w: RegistryWorker) => {
      await select(w)
      if (!w.session) {
        $.ui.toast(`${w.name} has no chat yet`)
        return
      }
      try {
        const r = await $.process.run(['open', `claude://claude.ai/epitaxy/${w.session}`])
        if (r.exitCode !== 0) $.ui.toast(`Couldn't open ${w.name}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
      } catch (err) {
        $.ui.toast(`Couldn't open ${w.name}: ${String(err)}`)
      }
    }

    const record = async (w: RegistryWorker, text: string, result: { isDelivered?: boolean; reason?: string }) => {
      const entry: SentTask = {
        text,
        atMs: await $.clock.now(),
        isDelivered: result.isDelivered !== false,
        reason: result.isDelivered === false ? result.reason : undefined,
      }
      await update($, sent, old => ({ ...old, [w.key]: entry }))
      return entry
    }

    const send = async (w: RegistryWorker, text: string) => {
      const task = text.trim()
      if (!task) return
      if (!w.session) {
        $.ui.toast(`${w.name} has no chat yet`)
        return
      }
      drafts.set(w.key, '')
      const entry = await record(w, task, await $.session.send({ to: w.session, text: task }))
      $.ui.toast(entry.isDelivered ? `Sent to ${w.name}` : `${w.name} didn't get it: ${entry.reason ?? 'not delivered'}`)
    }

    // Run now: the same wake the schedule sends, at once (paused or not).
    const runNow = async (w: RegistryWorker) => {
      if (!w.session) {
        $.ui.toast(`${w.name} has no chat yet`)
        return
      }
      const result = await $.session.send({ to: w.session, text: wakeText(w, 'Run now, from the Workers pane') })
      const entry = await record(w, 'Run its charter now', result)
      $.ui.toast(entry.isDelivered ? `${w.name} is running its charter` : `${w.name} didn't get it: ${entry.reason ?? 'not delivered'}`)
    }

    const decide = async (w: RegistryWorker, item: OutboxItem, decision: Decision['decision']) => {
      const line: Decision = { id: item.id, decision, at: new Date(await $.clock.now()).toISOString() }
      const file = `${p.outbox}/${w.key}.decisions.jsonl`
      let before = ''
      try {
        before = String(await $.fs.read(file))
      } catch {
        // the first decision for this worker
      }
      const sep = before && !before.endsWith('\n') ? '\n' : ''
      try {
        await $.fs.write(file, `${before}${sep}${JSON.stringify(line)}\n`)
      } catch (err) {
        $.ui.toast(`Couldn't record the decision: ${String(err)}`)
        return false
      }
      await refresh()
      return true
    }

    // One decision at a time per item: the buttons give way to "Sending…" while it runs.
    const once = async (item: OutboxItem, work: () => Promise<void>) => {
      if ((await read($, deciding))[item.id] !== undefined) return
      const at = await $.clock.now()
      await update($, deciding, old => ({ ...old, [item.id]: at }))
      try {
        await work()
      } finally {
        await update($, deciding, old => withoutKey(old, item.id))
      }
    }

    // Approve: a page is published with `bin/pages`, then the worker is told; a draft
    // or a note is told to go ahead. Nothing is recorded unless that went through.
    const approve = (w: RegistryWorker, item: OutboxItem) =>
      once(item, async () => {
        if (item.kind === 'page') {
          if (!item.draft_path) {
            $.ui.toast(`Couldn't save "${item.title}": the item names no draft_path`)
            return
          }
          try {
            await $.fs.stat(p.pages)
          } catch {
            $.ui.toast(`Couldn't save "${item.title}": ~/.claude/skills/colleague/bin/pages is not installed yet`)
            return
          }
          let r: { exitCode: number; stdout: string; stderr: string }
          try {
            r = await $.process.run([
              p.pages, 'publish', expandHome(p, item.draft_path), ...(item.space ? ['--space', item.space] : []), '--json',
            ])
          } catch (err) {
            $.ui.toast(`Couldn't save "${item.title}": ${String(err)}`)
            return
          }
          // pages: 0 saved (a second publish of the same draft answers "already"), 3 the
          // page changed since the draft, 4 the worker may not write to that space.
          const why = r.stderr.trim().replace(/^pages:\s*/, '')
          if (r.exitCode === 3) {
            $.ui.toast('Page changed since this draft. Ask for a fresh one.')
            return
          }
          if (r.exitCode !== 0) {
            $.ui.toast(
              r.exitCode === 4
                ? why || `${w.name} may not write to ${item.space ?? 'that space'}`
                : `Couldn't save "${item.title}": ${why || `pages exited ${r.exitCode}`}`,
            )
            return
          }
          let space = item.space
          try {
            const receipt = JSON.parse(r.stdout) as unknown
            if (isObject(receipt) && typeof receipt.space === 'string') space = receipt.space
          } catch {
            // a receipt that is not JSON: the item's own space stands
          }
          const saved = { ...item, space }
          await decide(w, item, 'approved')
          if (!w.session) {
            $.ui.toast(`Saved "${item.title}" in ${space ?? 'its space'}. ${w.name} has no chat to tell.`)
            return
          }
          const told = await record(w, `Approved: ${item.title}`, await $.session.send({ to: w.session, text: pageSavedText(saved) }))
          $.ui.toast(told.isDelivered ? `Saved "${item.title}" in ${space ?? 'its space'}` : `Saved, but ${w.name} didn't get the news: ${told.reason ?? 'not delivered'}`)
          return
        }
        if (!w.session) {
          $.ui.toast(`${w.name} has no chat yet`)
          return
        }
        const told = await record(w, `Approved: ${item.title}`, await $.session.send({ to: w.session, text: approveText(item) }))
        if (!told.isDelivered) {
          $.ui.toast(`${w.name} didn't get the approval, so it still waits: ${told.reason ?? 'not delivered'}`)
          return
        }
        await decide(w, item, 'approved')
        $.ui.toast(`Approved: ${item.title}`)
      })

    // Decline: recorded at once; the worker is told not to do it.
    const decline = (w: RegistryWorker, item: OutboxItem) =>
      once(item, async () => {
        if (!(await decide(w, item, 'declined'))) return
        if (!w.session) {
          $.ui.toast(`Declined: ${item.title}`)
          return
        }
        const told = await record(w, `Declined: ${item.title}`, await $.session.send({ to: w.session, text: declineText(item) }))
        $.ui.toast(told.isDelivered ? `Declined: ${item.title}` : `Declined. ${w.name} didn't get the message: ${told.reason ?? 'not delivered'}`)
      })

    // Delete arms on the first press and fires on a second within CONFIRM_MS. The
    // call session archives the chat; the pane writes the request and drops the
    // registry entry at once, keeping everything else in the file.
    const remove = async (w: RegistryWorker) => {
      const at = await $.clock.now()
      const armedAt = (await read($, confirming))[w.key]
      if (armedAt === undefined || at - armedAt >= CONFIRM_MS) {
        await update($, confirming, old => ({ ...old, [w.key]: at }))
        // Disarm after CONFIRM_MS. The render also checks the age, so a timer that
        // never fires cannot leave a stale Confirm that deletes on a later press.
        try {
          $.clock.after(CONFIRM_MS, () => {
            void (async () => {
              const later = await $.clock.now()
              if (later - at < CONFIRM_MS) return
              await update($, confirming, old => (old[w.key] === at ? withoutKey(old, w.key) : old))
            })()
          })
        } catch {
          // no timer: the age check in the render still expires it on the next redraw
        }
        return
      }
      const request = { type: 'delete', key: w.key, session: w.session ?? '', at }
      try {
        await $.fs.write(`${p.requests}/${randomId()}.json`, JSON.stringify(request))
      } catch (err) {
        $.ui.toast(`Couldn't request the delete: ${String(err)}`)
        return
      }
      await update($, confirming, old => withoutKey(old, w.key))
      // Instant: the card leaves now, and the registry drops it now; the call session
      // archives the chat afterwards in the background.
      await update($, removing, old => ({ ...old, [w.key]: at }))
      await serial(() =>
        editRegistry($ as unknown as Host, p, workers => {
          const idx = workers.findIndex(x => isObject(x) && x.key === w.key)
          if (idx < 0) return false
          workers.splice(idx, 1)
          return true
        }),
      )
      await setTab(w, 'overview')
      await update($, edits, old => withoutKey(old, w.key))
      $.ui.toast(`${w.name} removed`)
    }

    const setForm = (patchForm: Partial<FormState>) =>
      update($, formState, old => {
        const nextState = { ...old, ...patchForm }
        return nextState.isOpen === old.isOpen && nextState.isValid === old.isValid &&
          nextState.isTried === old.isTried && nextState.god === old.god
          ? old
          : nextState
      })

    const typeEntry = (value: string) => {
      form.text = value
      void setForm({ isValid: isValidName(splitEntry(value).name) })
    }

    const closeForm = async () => {
      form.text = ''
      await setForm({ isOpen: false, isValid: false, isTried: false })
    }

    const create = async () => {
      const current = await read($, formState)
      const god = isGod(current.god) ? current.god : 'scribe'
      const { name, role } = splitEntry(form.text)
      if (!isValidName(name)) {
        await setForm({ isTried: true, isValid: false })
        return
      }
      // The app starts a new chat only from the person's own words, and treats a submit
      // by a mod as automated, so the request goes into the prompt box for their Enter.
      const filled = await $.prompt.fill({ text: createText({ name, role, god }), mode: 'replace' }).catch(() => ({ isFilled: false }))
      if (!filled.isFilled) {
        $.ui.toast(`Couldn't put the request for ${name} in the prompt box`)
        return
      }
      const at = await $.clock.now()
      await update($, pending, old => ({
        ...old,
        [name]: { god, voice: DEFAULT_VOICE[god], tools: 'drafts' as const, atMs: at, known: snap.workers.map(w => w.key) },
      }))
      $.ui.toast(`Press Enter to create ${name}`)
      await closeForm()
    }

    // An Input takes no flex props of its own: a growing column inside a full-width
    // row is what makes it span the pane as the pane widens.
    const fill = (child: RenderChildren) => (
      <Box flexDirection="row" width="100%">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {child}
        </Box>
      </Box>
    )

    // A radio group: one keyed tile per choice, exactly one drawn picked (its ring and
    // wash in the accent, its label at full strength; the rest dim). The pick handlers
    // compare with the worker as it is now, so pressing the picked one writes nothing.
    type Choice = { value: string; label: string; art?: RenderChildren }
    const radio = (
      prefix: string,
      value: string,
      choices: readonly Choice[],
      accent: string,
      onPick: (value: string) => void,
      isTile = false,
    ) => (
      <Box key={`${prefix}-group`} flexDirection="row" flexWrap="wrap" gap="xs" width="100%">
        {choices.map(c => {
          const isOn = c.value === value
          return (
            <Box
              key={`${prefix}-tile-${c.value}`}
              flexDirection={isTile ? 'column' : 'row'}
              alignItems="center"
              borderStyle="round"
              borderColor={isOn ? accent : undefined}
              borderDimColor={!isOn}
              backgroundColor={isOn && isGraphical ? tint(accent, 0.12) : undefined}
              hover={isGraphical && !isOn ? { borderColor: tint(accent, 0.5), borderDimColor: false } : undefined}
              paddingX="xs"
            >
              {c.art ?? null}
              <Button key={`${prefix}-${c.value}`} label={c.label} plain dimColor={!isOn} onPress={() => onPick(c.value)} />
            </Box>
          )
        })}
      </Box>
    )

    const godChoices = (): Choice[] =>
      GOD_KINDS.map(kind => ({
        value: kind,
        label: GOD_LABEL[kind],
        art:
          Svg && isGraphical ? (
            <Svg source={godSvg(kind, { size: 30, state: 'idle', animated: false, halo: true })} alt={GOD_LABEL[kind]} width={30} height={30} />
          ) : undefined,
      }))

    const formGod = isGod(fs.god) ? fs.god : 'scribe'
    const formAccent = GOD_ACCENT[formGod]
    const showHint = fs.isTried && !fs.isValid

    // The header's dot carries the selected worker's colour.
    const headAccent = current ? GOD_ACCENT[godOf(current)] : ACCENT
    const header = (
      <Box key="header" flexDirection="row" justifyContent="space-between" alignItems="center" width="100%">
        <Box flexDirection="row" gap="xs" alignItems="center">
          <Text key="header-dot" color={headAccent}>●</Text>
          <Text bold>Workers</Text>
          <Text dimColor size="footnote">
            {`· ${live.length === 1 ? '1 standing chat' : `${live.length} standing chats`}`}
          </Text>
        </Box>
        <Button
          key="new-worker"
          label="+ New worker"
          variant={fs.isOpen ? 'secondary' : 'primary'}
          dimColor={fs.isOpen}
          onPress={() => void setForm({ isOpen: true })}
        />
      </Box>
    )

    const newForm = fs.isOpen ? (
      <Box
        key="new-form"
        flexDirection="column"
        borderStyle="round"
        borderColor={formAccent}
        backgroundColor={isGraphical ? tint(formAccent, 0.04) : undefined}
        width="100%"
        paddingX="sm"
        paddingY="sm"
        gap="xs"
      >
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" width="100%">
          <Box flexDirection="row" gap="xs" alignItems="center">
            {godAvatar(formGod, 28, false, 'New worker')}
            <Text bold>New worker</Text>
          </Box>
          <Button key="nw-cancel" label="Cancel" plain dimColor onPress={() => void closeForm()} />
        </Box>
        {Input
          ? fill(
              <Input
                key="nw-entry"
                placeholder="Name, then what it does (optional)"
                value={form.text}
                submitLabel="create"
                autoFocus
                onInput={(value: string) => typeEntry(value)}
                onSubmit={(value: string) => {
                  typeEntry(value)
                  void create()
                }}
              />,
            )
          : null}
        {radio('nw-god', formGod, godChoices(), formAccent, kind => void setForm({ god: kind }), true)}
        <Text dimColor size="caption">{`Voice ${DEFAULT_VOICE[formGod]} · drafts only. Change both later in Settings.`}</Text>
        {showHint ? (
          <Text size="footnote" color={RED}>Name, before the comma: 1 to 24 letters, digits or spaces</Text>
        ) : null}
      </Box>
    ) : null

    const statusOf = (w: RegistryWorker) => {
      const s = snap.status[w.key]
      return s?.isNew
        ? { text: '✦ New', color: BLUE as string | undefined }
        : s?.isWorking
          ? { text: '● Working', color: GREEN as string | undefined }
          : { text: `○ Idle${s?.lastActiveMs ? ` · ${ago(now - s.lastActiveMs)}` : ''}`, color: undefined as string | undefined }
    }

    const badgeText = (w: RegistryWorker, tag: string, accent: string) =>
      tag ? (
        <Text key={`badge-${w.key}`} size="caption" color={accent} backgroundColor={isGraphical ? tint(accent, 0.14) : undefined}>
          {` ${tag} `}
        </Text>
      ) : null

    const askField = (w: RegistryWorker) =>
      Input
        ? fill(
            <Input
              key={`task-${w.key}`}
              placeholder={`Ask ${w.name}…`}
              value={drafts.get(w.key) ?? ''}
              submitLabel="send"
              onInput={(value: string) => void drafts.set(w.key, value)}
              onSubmit={(value: string) => void send(w, value)}
            />,
          )
        : null

    // The hours chip, in the worker's colour (amber while paused): it opens Settings.
    const hoursChip = (w: RegistryWorker, accent: string) => {
      const tone = w.paused === true ? AMBER : accent
      return (
        <Box
          key={`hours-chip-${w.key}`}
          flexDirection="row"
          alignItems="center"
          gap="xs"
          paddingX="xs"
          backgroundColor={isGraphical ? tint(tone, 0.12) : undefined}
        >
          {icon(w.paused === true ? 'pause' : 'clock', tone, 12)}
          <Button key={`hours-${w.key}`} label={chipLabel(w)} plain onPress={() => void showTab(w, 'settings')} />
        </Box>
      )
    }

    const lastLine = (w: RegistryWorker) => {
      const last = tasks[w.key]
      return last ? (
        <Text key={`last-${w.key}`} dimColor size="footnote" wrap="truncate-end">
          {`${last.isDelivered ? 'Last' : 'Not delivered'}: ${last.text} · ${ago(now - last.atMs)}`}
        </Text>
      ) : null
    }

    /** When it wakes, in words: the schedule with its days (and zone where there is room). */
    const hoursAbout = (w: RegistryWorker, withZone: boolean): string => {
      if (w.paused === true) return 'Paused: no scheduled wakes. Run now still works.'
      if (!w.schedule) return 'No schedule: it works when you ask.'
      const sentence = scheduleSentence(w.schedule)
      return withZone && w.schedule.tz ? `${sentence} (${w.schedule.tz})` : sentence
    }

    /** What it cannot do yet, or '' when nothing is missing. */
    const missing = (w: RegistryWorker): string => {
      if (!w.session) return 'Its chat has not started yet, so it cannot take tasks.'
      if (w.schedule && !w.charter) return 'It wakes only once it has a charter.'
      return ''
    }

    // The tabs of a worker's detail, drawn as a radio: exactly one shows picked.
    const TAB_KEY: Record<Panel, (key: string) => string> = {
      overview: k => `overview-${k}`,
      outbox: k => `outboxtab-${k}`,
      activity: k => `activity-${k}`,
      settings: k => `settings-${k}`,
    }
    const tabStrip = (w: RegistryWorker, tab: Panel, accent: string, waiting: number) => (
      <Box key={`tabs-${w.key}`} flexDirection="row" flexWrap="wrap" alignItems="center" gap="xs" width="100%">
        {TABS.map(t => {
          const isOn = t === tab
          return (
            <Box
              key={`tabbox-${t}-${w.key}`}
              flexDirection="row"
              alignItems="center"
              borderStyle={isGraphical ? 'round' : undefined}
              borderColor={isOn ? accent : undefined}
              borderDimColor={!isOn}
              backgroundColor={isOn && isGraphical ? tint(accent, 0.14) : undefined}
              paddingX="xs"
            >
              <Button
                key={TAB_KEY[t](w.key)}
                label={t === 'outbox' && waiting > 0 ? `Outbox · ${waiting}` : TAB_LABEL[t]}
                plain
                dimColor={!isOn}
                onPress={() => void showTab(w, t)}
              />
            </Box>
          )
        })}
      </Box>
    )

    // The outbox, newest first: a file icon, the title, "needs your yes" in amber and
    // Approve / Decline for what waits; a note shows with no buttons.
    function feed(w: RegistryWorker, items: readonly OutboxItem[], decided: Record<string, Decision>, accent: string) {
      const shown = [...items].reverse().slice(0, FEED_ITEMS)
      return (
        <Box key={`outbox-${w.key}`} flexDirection="column" gap="xs" width="100%">
          {shown.length === 0 ? (
            <Text dimColor size="footnote">{`Nothing here yet. What ${w.name} drafts or notes lands here for your yes.`}</Text>
          ) : null}
          {shown.map(item => {
            const d = decided[item.id]
            const isWaiting = item.needs_approval && d === undefined
            const isBusy = busy[item.id] !== undefined
            const lines = item.body.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2)
            const meta = [
              item.kind === 'page' ? `${item.page ? 'revision' : 'page'}${item.space ? ` in ${item.space}` : ''}` : item.kind,
              item.to ? `to ${item.to}` : '',
              ago(now - atMs(item)),
            ].filter(Boolean).join(' · ')
            const glyph: IconName = item.kind === 'note' ? 'note' : item.kind === 'page' ? 'fileText' : 'file'
            return (
              <Box
                key={`item-${w.key}-${item.id}`}
                flexDirection="column"
                borderStyle="round"
                borderColor={isWaiting ? tint(accent, 0.6) : undefined}
                borderDimColor={!isWaiting}
                width="100%"
                paddingX="sm"
                paddingY="xs"
                gap="xs"
              >
                <Box flexDirection="row" gap="xs" alignItems="center" width="100%">
                  {icon(glyph, isWaiting ? accent : SUB, 14)}
                  <Box flexGrow={1} flexShrink={1}>
                    <Text bold size="footnote" wrap="truncate-end">{item.title}</Text>
                  </Box>
                  {isWaiting ? (
                    <Text size="caption" color={AMBER}>needs your yes</Text>
                  ) : d ? (
                    <Text size="caption" color={d.decision === 'approved' ? GREEN : undefined} dimColor={d.decision !== 'approved'}>
                      {d.decision === 'approved' ? '✓ Approved' : 'Declined'}
                    </Text>
                  ) : null}
                </Box>
                <Text dimColor size="caption" wrap="truncate-end">{meta}</Text>
                {lines.map((l, n) => (
                  <Text key={`item-${w.key}-${item.id}-l${n}`} size="footnote" wrap="truncate-end">{l}</Text>
                ))}
                {isWaiting ? (
                  <Box flexDirection="row" gap="xs" alignItems="center" justifyContent="flex-end" width="100%">
                    {isBusy ? (
                      <Text dimColor size="caption">Sending…</Text>
                    ) : (
                      <Box flexDirection="row" gap="xs" alignItems="center">
                        <Button key={`decline-${w.key}-${item.id}`} label="Decline" variant="secondary" onPress={() => void decline(w, item)} />
                        <Button key={`approve-${w.key}-${item.id}`} label="Approve" variant="primary" onPress={() => void approve(w, item)} />
                      </Box>
                    )}
                  </Box>
                ) : null}
              </Box>
            )
          })}
          <Box flexDirection="row" alignItems="center" gap="xs" width="100%">
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor size="caption">{`Approve tells ${w.name} to go ahead. Decline tells it not to.`}</Text>
            </Box>
            <Button key={`feed-open-${w.key}`} label="Open chat" variant="secondary" onPress={() => void openChat(w)} />
          </Box>
        </Box>
      )
    }

    // The worker's last tool steps, newest first, read from its transcript's tail.
    async function activity(w: RegistryWorker) {
      const path = snap.transcripts[w.key]
      const mtimeMs = snap.status[w.key]?.lastActiveMs ?? 0
      let steps: ActivityStep[] = []
      let note = ''
      if (!path) {
        note = w.transcript ? 'Its transcript is not on this Mac yet' : 'No steps yet: the chat has not run'
      } else {
        const hit = cache.steps.get(path)
        if (hit && hit.mtimeMs === mtimeMs) {
          steps = hit.steps
        } else {
          try {
            const r = await $.process.run(['/usr/bin/tail', '-c', String(TAIL_BYTES), path])
            if (r.exitCode !== 0) {
              note = `Couldn't read the transcript: ${r.stderr.trim() || `tail exited ${r.exitCode}`}`
            } else {
              steps = parseSteps(r.stdout, p.home, ACTIVITY_STEPS)
              cache.steps.set(path, { mtimeMs, steps })
            }
          } catch (err) {
            note = `Couldn't read the transcript: ${String(err)}`
          }
        }
        if (!note && steps.length === 0) note = 'No tool steps yet'
      }
      return (
        <Box key={`activity-panel-${w.key}`} flexDirection="column" gap="xs" width="100%">
          {note ? <Text dimColor size="footnote">{note}</Text> : null}
          {steps.map((s, i) => (
            <Box
              key={`step-${w.key}-${i}`}
              flexDirection="row"
              alignItems="center"
              gap="xs"
              width="100%"
              backgroundColor={isGraphical ? tint(SUB, i === 0 && snap.status[w.key]?.isWorking ? 0.16 : 0.08) : undefined}
              paddingX="xs"
            >
              <Text mono bold size="caption">{s.tool}</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text mono dimColor size="caption" wrap="truncate-end">{s.arg}</Text>
              </Box>
              {s.atMs ? <Text dimColor size="caption">{ago(now - s.atMs)}</Text> : null}
            </Box>
          ))}
        </Box>
      )
    }

    const spaceList = current && tabOf(current) === 'settings' ? await listSpaces($ as unknown as Host, p) : []

    // A small section heading inside Settings.
    const heading = (key: string, text: string) => (
      <Text key={key} bold size="caption" dimColor>{text}</Text>
    )

    // Make them yours: name, god, voice, hours, tools, paused and spaces, each written
    // into the worker's registry entry as it is picked; then Delete, out of the way.
    function settings(w: RegistryWorker, accent: string) {
      const god = godOf(w)
      const voice = voiceOf(w)
      const tools = toolsOf(w)
      const toolsValue = Array.isArray(tools) ? 'custom' : tools
      const sched = w.schedule
      const mode = scheduleMode(sched)
      const modeOptions = MODES.some(m => m.value === mode) ? MODES : [...MODES, { value: mode, label: `Every ${mode}` }]
      const days = typeof sched?.days === 'string' ? sched.days.trim().toLowerCase() : 'mon-fri'
      const dayOptions = DAY_PRESETS.some(d => d.value === days) ? DAY_PRESETS : [{ value: days, label: daysLabel(days) }, ...DAY_PRESETS]
      const voiceOptions = (VOICES as readonly string[]).includes(voice) ? [...VOICES] : [voice, ...VOICES]
      const toolChoices: Choice[] = [
        ...TOOL_PRESETS.map(t => ({ value: t.value as string, label: t.label })),
        ...(Array.isArray(tools) ? [{ value: 'custom', label: `Custom: ${tools.length} tools` }] : []),
      ]
      const about = Array.isArray(tools)
        ? `Only: ${tools.join(', ') || 'nothing'}`
        : (TOOL_PRESETS.find(t => t.value === tools)?.about ?? '')
      const allowed = spacesOf(w)
      const mine = allowed.list
      const spaces = [...spaceList, ...mine.filter(s => !spaceList.some(x => x.slug === s)).map(s => ({ slug: s, name: s }))]
      const tz = typeof sched?.tz === 'string' && sched.tz ? sched.tz : defaultTz(snap.workers)
      const nameValue = names.get(w.key) ?? w.name
      const armedAt = armed[w.key]
      const isArmed = armedAt !== undefined && now - armedAt < CONFIRM_MS

      // Each pick is decided from the worker as it is at the click (its earlier picks
      // included), so quick picks build on each other instead of the second undoing the
      // first. A pick equal to what the entry already holds writes nothing; one equal
      // only to a default (a v1 worker's derived god, a god's voice) is written, so it sticks.
      const pickGod = (kind: string) =>
        choose(w, cur => (!isGod(kind) || cur.god === kind ? undefined : { god: kind, avatar: GOD_AVATAR[kind] }))
      const pickVoice = (value: string) => choose(w, cur => (cur.voice === value ? undefined : { voice: value }))
      const pickTools = (value: string) =>
        choose(w, cur => (value === 'custom' || cur.tools === value ? undefined : { tools: value }))
      const pickSchedule = (change: ScheduleChange) =>
        choose(w, cur => {
          const nextSched = editSchedule(cur.schedule, change, tz)
          return JSON.stringify(nextSched) === JSON.stringify(cur.schedule) ? undefined : { schedule: nextSched }
        })
      const togglePaused = () => choose(w, cur => ({ paused: cur.paused !== true }))
      // Turning one space off under "*" keeps every other listed space on.
      const toggleSpace = (slug: string) =>
        choose(w, cur => {
          const sp = spacesOf(cur)
          const list = sp.isAll ? spaces.map(s => s.slug) : sp.list
          return { spaces: list.includes(slug) ? list.filter(x => x !== slug) : [...list, slug] }
        })
      const toggleAll = () => choose(w, cur => ({ spaces: spacesOf(cur).isAll ? undefined : '*' }))

      const rename = async (value: string) => {
        const name = value.trim()
        if (!isValidName(name)) {
          if (name !== w.name) $.ui.toast('A name is 1 to 24 letters, digits or spaces')
          return
        }
        let isNew = false
        const isSaved = await choose(w, cur => {
          isNew = cur.name !== name
          return isNew ? { name } : undefined
        })
        if (isSaved && isNew) {
          names.delete(w.key)
          $.ui.toast(`Renamed to ${name}`)
        }
      }

      return (
        <Box key={`settings-panel-${w.key}`} flexDirection="column" gap="sm" width="100%">
          <Text bold size="footnote">{`Make ${w.name} yours`}</Text>
          {Input
            ? fill(
                <Input
                  key={`rename-${w.key}`}
                  label="Name"
                  value={nameValue}
                  submitLabel="save"
                  onInput={(value: string) => void names.set(w.key, value)}
                  onSubmit={(value: string) => void rename(value)}
                />,
              )
            : null}
          <Box key={`sec-god-${w.key}`} flexDirection="column" gap="xs" width="100%">
            {heading(`h-god-${w.key}`, 'Character')}
            {radio(`god-${w.key}`, god, godChoices(), accent, kind => void pickGod(kind), true)}
          </Box>
          {Select ? (
            <Select
              key={`voice-${w.key}`}
              label="Voice"
              value={voice}
              options={voiceOptions.map(v => ({ value: v, label: `${v}${VOICE_HINT[v.slice(0, 2)] ? ` · ${VOICE_HINT[v.slice(0, 2)]}` : ''}` }))}
              onSelect={(value: string) => void pickVoice(value)}
            />
          ) : null}
          <Box key={`sec-hours-${w.key}`} flexDirection="column" gap="xs" width="100%">
            {heading(`h-hours-${w.key}`, 'Hours')}
            <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center" width="100%">
              {Select ? (
                <Select
                  key={`mode-${w.key}`}
                  label="Wakes"
                  value={mode}
                  options={modeOptions}
                  onSelect={(value: string) => void pickSchedule({ mode: value })}
                />
              ) : null}
              {Select && sched ? (
                <Select
                  key={`days-${w.key}`}
                  label="on"
                  value={days}
                  options={dayOptions}
                  onSelect={(value: string) => void pickSchedule({ days: value })}
                />
              ) : null}
            </Box>
            {sched ? (
              <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center" width="100%">
                {Select && mode === 'daily' ? (
                  <Select
                    key={`time-${w.key}`}
                    label="at"
                    value={(sched.time ?? '09:00').trim()}
                    options={timeOptions((sched.time ?? '09:00').trim())}
                    onSelect={(value: string) => void pickSchedule({ time: value })}
                  />
                ) : null}
                {Select && mode !== 'daily' ? (
                  <Select
                    key={`from-${w.key}`}
                    label="from"
                    value={sched.from?.trim() || ALL_DAY}
                    options={fromOptions(sched.from?.trim() || undefined)}
                    onSelect={(value: string) => void pickSchedule({ from: value === ALL_DAY ? '' : value })}
                  />
                ) : null}
                {Select && mode !== 'daily' && sched.from?.trim() ? (
                  <Select
                    key={`to-${w.key}`}
                    label="to"
                    value={sched.to?.trim() || END_OF_DAY}
                    options={toOptions(sched.from.trim(), sched.to?.trim() || undefined)}
                    onSelect={(value: string) => void pickSchedule({ to: value === END_OF_DAY ? '' : value })}
                  />
                ) : null}
                <Text dimColor size="caption">{tz}</Text>
              </Box>
            ) : null}
            {sched ? <Text dimColor size="caption">{scheduleSentence(sched)}</Text> : null}
            {sched && !w.charter ? <Text dimColor size="caption">It wakes only once it has a charter.</Text> : null}
            <Box flexDirection="row" gap="xs" alignItems="center" width="100%">
              {icon('pause', w.paused === true ? AMBER : SUB, 13)}
              <Box flexGrow={1} flexShrink={1}>
                <Text size="footnote" color={w.paused === true ? AMBER : undefined} dimColor={w.paused !== true}>
                  {w.paused === true ? 'Paused: no scheduled wakes' : 'Wakes on its hours'}
                </Text>
              </Box>
              <Button
                key={`pause-${w.key}`}
                label={w.paused === true ? 'Resume' : 'Pause'}
                variant="secondary"
                onPress={() => void togglePaused()}
              />
            </Box>
          </Box>
          <Box key={`sec-tools-${w.key}`} flexDirection="column" gap="xs" width="100%">
            {heading(`h-tools-${w.key}`, 'Tools')}
            {radio(`tools-${w.key}`, toolsValue, toolChoices, accent, value => void pickTools(value))}
            <Text dimColor size="caption">{about}</Text>
          </Box>
          <Box key={`sec-spaces-${w.key}`} flexDirection="column" gap="xs" width="100%">
            <Box flexDirection="row" alignItems="center" gap="xs" width="100%">
              {icon('folder', SUB, 13)}
              <Box flexGrow={1} flexShrink={1}>
                <Text size="footnote" dimColor>
                  {allowed.isAll ? 'Spaces it may write to: all' : allowed.isDefault ? 'Spaces it may write to: Notes, the default' : 'Spaces it may write to'}
                </Text>
              </Box>
              <Button
                key={`spaces-all-${w.key}`}
                label={allowed.isAll ? '✓ All spaces' : 'All spaces'}
                variant={allowed.isAll ? 'primary' : 'secondary'}
                onPress={() => void toggleAll()}
              />
            </Box>
            {spaces.length === 0 ? (
              <Text dimColor size="caption">No spaces yet</Text>
            ) : (
              <Box flexDirection="row" flexWrap="wrap" gap="xs" width="100%">
                {spaces.map(s => {
                  const isOn = allowed.isAll || mine.includes(s.slug)
                  return (
                    <Button
                      key={`space-${w.key}-${s.slug}`}
                      label={isOn ? `✓ ${s.name}` : s.name}
                      variant={isOn ? 'primary' : 'secondary'}
                      onPress={() => void toggleSpace(s.slug)}
                    />
                  )
                })}
              </Box>
            )}
          </Box>
          <Box key={`danger-${w.key}`} flexDirection="row" alignItems="center" gap="xs" width="100%">
            <Box flexGrow={1} flexShrink={1}>
              <Text size="caption" color={isArmed ? RED : undefined} dimColor={!isArmed}>
                {isArmed ? 'Press again to delete it.' : 'Delete removes it here and archives its chat.'}
              </Text>
            </Box>
            {isArmed ? (
              <Button key={`delete-${w.key}`} label="Confirm delete" variant="secondary" onPress={() => void remove(w)}>
                <Text bold color={RED}>Confirm delete</Text>
              </Button>
            ) : (
              <Button key={`delete-${w.key}`} label="Delete" plain onPress={() => void remove(w)} />
            )}
            <Button key={`settings-done-${w.key}`} label="Done" variant="secondary" onPress={() => void setTab(w, 'overview')} />
          </Box>
        </Box>
      )
    }

    // What one worker's tab shows. Overview differs by layout: the wide detail holds
    // the Ask field and the actions; a narrow card already shows them above its tabs.
    const tabBody = async (w: RegistryWorker, tab: Panel, accent: string, isDetail: boolean) => {
      const items = snap.outbox[w.key] ?? []
      const decided = snap.decided[w.key] ?? {}
      if (tab === 'outbox') return feed(w, items, decided, accent)
      if (tab === 'activity') return await activity(w)
      if (tab === 'settings') return settings(w, accent)
      const gap = missing(w)
      if (!isDetail) {
        return (
          <Box key={`overview-${w.key}`} flexDirection="column" gap="xs" width="100%">
            <Text dimColor size="caption">{hoursAbout(w, false)}</Text>
            {gap ? <Text dimColor size="caption">{gap}</Text> : null}
          </Box>
        )
      }
      return (
        <Box key={`overview-${w.key}`} flexDirection="column" gap="sm" width="100%">
          {askField(w)}
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap="xs" width="100%">
            {hoursChip(w, accent)}
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor size="caption">{hoursAbout(w, true)}</Text>
            </Box>
          </Box>
          <Box flexDirection="row" alignItems="center" gap="xs" width="100%">
            {w.charter ? <Button key={`run-${w.key}`} label="Run now" variant="primary" onPress={() => void runNow(w)} /> : null}
            <Button key={`open-${w.key}`} label="Open chat" variant="secondary" onPress={() => void openChat(w)} />
            <Box flexGrow={1} />
          </Box>
          {gap ? <Text dimColor size="caption">{gap}</Text> : null}
          {lastLine(w)}
        </Box>
      )
    }

    // Narrow: the film's card, one per worker. The selected one carries its god's
    // colour and the tabbed detail under its footer.
    const card = async (w: RegistryWorker) => {
      const isWorking = snap.status[w.key]?.isWorking ?? false
      const isSelected = current?.key === w.key
      const items = snap.outbox[w.key] ?? []
      const decided = snap.decided[w.key] ?? {}
      const waiting = awaiting(items, decided).length
      const tag = badge(items, decided)
      const tab = tabOf(w)
      const god = godOf(w)
      const th = themeOf(god)
      const status = statusOf(w)

      return (
        <Box
          key={`card-${w.key}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={isSelected ? th.accent : undefined}
          borderDimColor={!isSelected}
          backgroundColor={isSelected && isGraphical ? th.wash : undefined}
          hover={isGraphical ? { borderColor: isSelected ? th.accent : th.hover, borderDimColor: false } : undefined}
          width="100%"
          paddingX="sm"
          paddingY="sm"
          gap="xs"
        >
          <Box flexDirection="row" alignItems="flex-start" gap="sm" width="100%">
            {godAvatar(god, 40, isWorking, `${w.name}, ${GOD_LABEL[god]}`, `avatar-${w.key}`)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" alignItems="center" gap="xs" width="100%">
                <Button key={`name-${w.key}`} plain onPress={() => void openChat(w)}>
                  <Text bold>{w.name}</Text>
                </Button>
                {badgeText(w, tag, th.accent)}
                <Box flexGrow={1} />
                <Text key={`status-${w.key}`} size="caption" color={status.color} dimColor={status.color === undefined}>
                  {status.text}
                </Text>
              </Box>
              {/* One dim line: what it does. The charter is the worker's instructions, not
                  display copy, so the card never shows it. */}
              {w.role ? <Text dimColor size="footnote" wrap="truncate-end">{w.role}</Text> : null}
            </Box>
          </Box>
          {askField(w)}
          {/* The film's footer: hours chip left; Run now, Outbox and Open right. */}
          <Box key={`footer-${w.key}`} flexDirection="row" flexWrap="wrap" alignItems="center" gap="xs" width="100%">
            {hoursChip(w, th.accent)}
            <Box flexGrow={1} />
            {w.charter ? (
              <Box flexDirection="row" alignItems="center" gap="xs">
                {icon('play', SUB, 11)}
                <Button key={`run-${w.key}`} label="Run now" plain onPress={() => void runNow(w)} />
              </Box>
            ) : null}
            <Box flexDirection="row" alignItems="center" gap="xs">
              {icon('inbox', waiting > 0 ? th.accent : SUB, 13)}
              <Button key={`feed-${w.key}`} label={outboxLabel(waiting, tab === 'outbox')} plain onPress={() => void toggleFeed(w)} />
            </Box>
            <Box flexDirection="row" alignItems="center" gap="xs">
              <Button key={`open-${w.key}`} label="Open" plain onPress={() => void openChat(w)} />
              {icon('external', SUB, 11)}
            </Box>
          </Box>
          {isSelected ? tabStrip(w, tab, th.accent, waiting) : null}
          {isSelected ? await tabBody(w, tab, th.accent, false) : null}
          {lastLine(w)}
        </Box>
      )
    }

    // Wide: one compact row per worker, its god, name, drafts badge and status.
    const row = (w: RegistryWorker) => {
      const isWorking = snap.status[w.key]?.isWorking ?? false
      const isSelected = current?.key === w.key
      const tag = badge(snap.outbox[w.key] ?? [], snap.decided[w.key] ?? {})
      const god = godOf(w)
      const th = themeOf(god)
      const status = statusOf(w)
      return (
        <Box
          key={`row-${w.key}`}
          flexDirection="row"
          alignItems="center"
          gap="xs"
          borderStyle="round"
          borderColor={isSelected ? th.accent : undefined}
          borderDimColor={!isSelected}
          backgroundColor={isSelected && isGraphical ? th.soft : undefined}
          hover={isGraphical ? { borderColor: isSelected ? th.accent : th.hover, borderDimColor: false } : undefined}
          width="100%"
          paddingX="xs"
        >
          {godAvatar(god, 28, isWorking, `${w.name}, ${GOD_LABEL[god]}`, `row-avatar-${w.key}`)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="xs" width="100%">
              <Button key={`pick-${w.key}`} label={w.name} plain onPress={() => void select(w)} />
              {badgeText(w, tag, th.accent)}
            </Box>
            <Text key={`status-${w.key}`} size="caption" color={status.color} dimColor={status.color === undefined} wrap="truncate-end">
              {status.text}
            </Text>
          </Box>
        </Box>
      )
    }

    // Wide: the selected worker's detail, its god large, then the tabs.
    const detail = async (w: RegistryWorker) => {
      const isWorking = snap.status[w.key]?.isWorking ?? false
      const items = snap.outbox[w.key] ?? []
      const decided = snap.decided[w.key] ?? {}
      const waiting = awaiting(items, decided).length
      const tag = badge(items, decided)
      const tab = tabOf(w)
      const god = godOf(w)
      const th = themeOf(god)
      const status = statusOf(w)
      return (
        <Box
          key={`detail-${w.key}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={th.accent}
          backgroundColor={isGraphical ? th.wash : undefined}
          width="100%"
          paddingX="sm"
          paddingY="sm"
          gap="sm"
        >
          <Box flexDirection="row" alignItems="center" gap="sm" width="100%">
            {godAvatar(god, 48, isWorking, `${w.name}, ${GOD_LABEL[god]}`, `detail-avatar-${w.key}`)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" alignItems="center" gap="xs" width="100%">
                <Text bold size="heading">{w.name}</Text>
                {badgeText(w, tag, th.accent)}
                <Box flexGrow={1} />
                <Text key={`detail-status-${w.key}`} size="caption" color={status.color} dimColor={status.color === undefined}>
                  {status.text}
                </Text>
              </Box>
              {w.role ? <Text dimColor size="footnote" wrap="truncate-end">{w.role}</Text> : null}
            </Box>
          </Box>
          {tabStrip(w, tab, th.accent, waiting)}
          {await tabBody(w, tab, th.accent, true)}
        </Box>
      )
    }

    const empty =
      live.length === 0 ? (
        <Box key="empty" flexDirection="column" gap="xs" width="100%">
          {snap.error ? <Text dimColor>{snap.error}</Text> : null}
          <Text dimColor size="footnote">No workers yet. + New worker makes one: a name, what it does, and a character.</Text>
        </Box>
      ) : snap.error ? (
        <Text dimColor>{snap.error}</Text>
      ) : null

    if (isWide && live.length > 0 && current) {
      return (
        <Box flexDirection="column" alignItems="stretch" width="100%" gap="sm">
          {header}
          {newForm}
          {empty}
          <Box key="split" flexDirection="row" alignItems="flex-start" gap="sm" width="100%">
            <Box key="list" flexDirection="column" gap="xs" width="34%" flexShrink={0}>
              {live.map(row)}
            </Box>
            <Box key="detail-column" flexDirection="column" flexGrow={1} flexShrink={1}>
              {await detail(current)}
            </Box>
          </Box>
        </Box>
      )
    }

    const cards = []
    for (const w of live) cards.push(await card(w))

    return (
      <Box flexDirection="column" alignItems="stretch" width="100%" gap="sm">
        {header}
        {newForm}
        {empty}
        {cards}
      </Box>
    )
  })

  on('ui.open', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await syncShown($)
    return result
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await syncShown($)
    return result
  })

  // The launcher sits in the footer, left of Claude's own mode labels (the model and
  // permission controls keep their place: the engine's drawing is passed through).
  // The app's top bar takes no mod buttons.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const theirs = await next(e)
    await read($, roster) // subscribe: the count and the god follow the registry
    await read($, rev)

    const ui = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Svg?: any }
    const { Box, Text, Button, Svg } = ui
    const { workers } = await readRegistry($ as unknown as Host, await paths($ as unknown as Host))
    const leaving = await read($, removing)
    const live = workers.filter(w => leaving[w.key] === undefined)
    const picked = await read($, selected)
    const lead = live.find(w => w.key === picked) ?? live[0]
    const god = lead ? godOf(lead) : 'colleague'
    const label = live.length > 0 ? `Workers · ${live.length}` : 'Workers'

    return (
      <Box flexDirection="row" alignItems="center" gap="sm">
        <Box flexDirection="row" alignItems="center" gap="xs">
          {Svg && e.surface !== 'terminal' ? (
            <Svg source={godSvg(god, { size: 16, state: 'idle', animated: false, halo: false })} alt="Workers" width={16} height={16} />
          ) : (
            <Text color={GOD_ACCENT[god]}>●</Text>
          )}
          <Button
            key="open-workers-band"
            label={label}
            plain
            onPress={() =>
              void (async () => {
                await $.ui.open({ id: PANE, title: 'Workers', columns: COLUMNS, focus: true })
                await syncShown($)
              })()
            }
          />
        </Box>
        {theirs}
      </Box>
    )
  })

  on('session.end', ($, e, next) => {
    timer?.cancel()
    timer = undefined
    return next(e)
  })
}

/** The time zone a new schedule takes: another worker's, else this Mac's, else UTC. */
function defaultTz(workers: readonly RegistryWorker[]): string {
  const other = workers.find(w => w.schedule?.tz)?.schedule?.tz
  if (other) return other
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The spaces a worker may be given: every `spaces/<slug>/space.json` there is. */
async function listSpaces($: Host, p: Paths): Promise<{ slug: string; name: string }[]> {
  let entries: readonly { name: string; kind: string }[]
  try {
    entries = await $.fs.list(p.spaces)
  } catch {
    return []
  }
  const out: { slug: string; name: string }[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
    try {
      const j = JSON.parse(String(await $.fs.read(`${p.spaces}/${entry.name}/space.json`))) as unknown
      const name = isObject(j) && typeof j.name === 'string' && j.name.trim() ? j.name.trim() : entry.name
      out.push({ slug: entry.name, name })
    } catch {
      // no space.json: not a space
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
