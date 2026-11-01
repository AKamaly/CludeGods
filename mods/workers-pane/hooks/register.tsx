import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren, Timer } from 'claude-code'

import type { FormState, RegistryWorker, SentTask, WorkerStatus } from '../types'

// The user's standing worker chats come from the call session's registry, read on every
// poll. `session` is the app's chat id (what SendMessage and the claude:// link
// take); `transcript` is the CLI transcript the live status reads. Claude (the call
// session) owns the file: it adds workers there. The user picks a worker's model inside
// its chat, so the pane neither shows nor switches one.
//
// Every path hangs off $HOME, read once per call through `$.env.get`. The call session
// opens the pane from the shell with `touch ~/.voicemode/call/open-workers`, so the user
// is never told to type a command.
type Paths = { home: string; registry: string; requests: string; openFlag: string; projects: string }
type Env = { env: { get: (name: string) => Promise<string | undefined> } }

async function paths($: Env): Promise<Paths> {
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {
    // no HOME: the reads below fail and the pane shows "No workers.json yet"
  }
  home = home.replace(/\/+$/, '')
  const call = `${home}/.voicemode/call`
  return {
    home,
    registry: `${call}/workers.json`,
    requests: `${call}/requests`,
    openFlag: `${call}/open-workers`,
    projects: `${home}/.claude/projects`,
  }
}

/** A registry `transcript`: absolute, `~/`-relative, or relative to ~/.claude/projects. */
function transcriptPath(p: Paths, t: string): string {
  if (t.startsWith('/')) return t
  if (t.startsWith('~/')) return `${p.home}/${t.slice(2)}`
  return `${p.projects}/${t}`
}

const PANE = 'workers'
const COLUMNS = 46
const WORKING_WINDOW_MS = 10_000 // a transcript written this recently means a turn is running
const POLL_MS = 3_000

const CONFIRM_MS = 5_000 // how long an armed Delete waits for its second press

const GREEN = '#34d399'
const BLUE = '#60a5fa'
const RED = '#f87171'

const AVATARS = {
  blue: ['#60a5fa', '#2563eb'],
  violet: ['#a78bfa', '#6d28d9'],
  orange: ['#fb923c', '#ea580c'],
  rose: ['#fb7185', '#e11d48'],
  lime: ['#a3e635', '#65a30d'],
  gold: ['#facc15', '#ca8a04'],
} as const
type Avatar = keyof typeof AVATARS
const AVATAR_NAMES = Object.keys(AVATARS) as Avatar[]
// A Desktop Button draws its own text colour, so each colour is shown as an emoji,
// which keeps its own colour on every surface.
const SWATCH: Record<string, string> = {
  blue: '🔵', violet: '🟣', orange: '🟠', rose: '🔴', lime: '🟢', gold: '🟡',
}

const NAME_RE = /^[\p{L}\p{N} ]{1,24}$/u

const roster = atom({ plugin: 'workers-pane', key: 'roster' } as const, '', { shape: 'roster-1' })
const sent = atom({ plugin: 'workers-pane', key: 'sent' } as const, {}, { shape: 'sent-1' })
const formState = atom(
  { plugin: 'workers-pane', key: 'form' } as const,
  { isOpen: false, isValid: false, isTried: false, avatar: 'blue' } as FormState,
  { shape: 'form-4' },
)
const selected = atom({ plugin: 'workers-pane', key: 'selected' } as const, '', { shape: 'selected-1' })
const confirming = atom({ plugin: 'workers-pane', key: 'confirming' } as const, {}, { shape: 'confirming-1' })
const removing = atom({ plugin: 'workers-pane', key: 'removing' } as const, {}, { shape: 'removing-1' })
const paneShown = atom({ plugin: 'workers-pane', key: 'paneShown' } as const, false, { shape: 'pane-shown-1' })

type Snapshot = { workers: RegistryWorker[]; status: Record<string, WorkerStatus>; error?: string }

// The minimal surface `$` offers this file's helpers; typed loosely so a helper
// can take the hook's `$` from any event.
type Fs = Env & {
  fs: {
    read: (path: string) => Promise<unknown>
    stat: (path: string) => Promise<{ mtimeMs: number }>
  }
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

function colours(avatar: string | undefined): readonly [string, string] {
  return AVATARS[(avatar ?? '') as Avatar] ?? AVATARS.blue
}

/** A hex colour at a low alpha, for a tint behind a card or a pill. */
function tint(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0')
  return `${hex}${a}`
}

function withoutKey<T>(old: Record<string, T>, key: string): Record<string, T> {
  if (!(key in old)) return old
  const { [key]: _gone, ...rest } = old
  return rest
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

/** The one-line prompt the call session acts on. `;` and newlines would break its fields. */
function createText(f: { name: string; role: string; avatar: string }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/;/g, ',').trim()
  return `Create worker: name=${clean(f.name)}; role=${clean(f.role)}; avatar=${f.avatar}`
}

async function readRegistry($: Fs): Promise<{ workers: RegistryWorker[]; error?: string }> {
  let raw: unknown
  try {
    raw = await $.fs.read((await paths($)).registry)
  } catch {
    return { workers: [], error: 'No workers.json yet' }
  }
  try {
    const parsed = JSON.parse(String(raw)) as { workers?: unknown }
    const list = Array.isArray(parsed.workers) ? parsed.workers : []
    const workers = list.filter(
      (w): w is RegistryWorker =>
        typeof w === 'object' && w !== null && typeof (w as RegistryWorker).key === 'string' &&
        typeof (w as RegistryWorker).name === 'string',
    )
    return { workers }
  } catch {
    return { workers: [], error: 'workers.json is not valid JSON' }
  }
}

async function snapshot($: Fs, now: number): Promise<Snapshot> {
  const { workers, error } = await readRegistry($)
  const p = await paths($)
  const status: Record<string, WorkerStatus> = {}
  for (const w of workers) {
    if (!w.transcript) {
      status[w.key] = { isWorking: false, lastActiveMs: 0, isNew: true }
      continue
    }
    try {
      const st = await $.fs.stat(transcriptPath(p, w.transcript))
      status[w.key] = { isWorking: now - st.mtimeMs < WORKING_WINDOW_MS, lastActiveMs: st.mtimeMs, isNew: false }
    } catch {
      status[w.key] = { isWorking: false, lastActiveMs: 0, isNew: false }
    }
  }
  return { workers, status, error }
}

/** What a redraw depends on, coarse enough that an idle pane is not redrawn every poll. */
function signature(s: Snapshot): string {
  return JSON.stringify([
    s.error ?? '',
    s.workers.map(w => [w.key, w.name, w.role, w.session, w.transcript, w.avatar]),
    s.workers.map(w => {
      const st = s.status[w.key]
      return [st?.isWorking, st?.isNew, Math.floor((st?.lastActiveMs ?? 0) / 60_000)]
    }),
  ])
}

// The avatar: the call orb's look rebuilt as SVG (gradients, blur, SMIL), since a
// pane draws SVG and not WebGL. It spins faster and its halo breathes while busy;
// its halo is bright while busy or while its card is the selected one.
function orb(id: string, avatar: string | undefined, isBusy: boolean, size = 44, isLit = isBusy): string {
  const [c, c2] = colours(avatar)
  const sid = id.replace(/[^A-Za-z0-9_-]/g, '_')
  const dur = isBusy ? 6 : 16
  const glow = isLit ? 0.75 : 0.35
  const breathe = isBusy
    ? '<animate attributeName="r" values="22;25.5;22" dur="1.8s" repeatCount="indefinite"/>'
    : ''
  return `<svg viewBox="0 0 52 52" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="h-${sid}" cx="50%" cy="50%" r="50%">
      <stop offset="55%" stop-color="${c}" stop-opacity="${glow}"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="b-${sid}" cx="40%" cy="35%" r="70%">
      <stop offset="0%" stop-color="#fff" stop-opacity=".9"/><stop offset="35%" stop-color="${c}"/><stop offset="100%" stop-color="${c2}"/>
    </radialGradient>
    <filter id="f-${sid}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>
    <clipPath id="k-${sid}"><circle cx="26" cy="26" r="17"/></clipPath>
  </defs>
  <circle cx="26" cy="26" r="25" fill="url(#h-${sid})">${breathe}</circle>
  <circle cx="26" cy="26" r="17" fill="url(#b-${sid})"/>
  <g clip-path="url(#k-${sid})" filter="url(#f-${sid})" opacity=".85">
    <g>
      <ellipse cx="20" cy="22" rx="11" ry="6" fill="#fff" opacity=".45"/>
      <ellipse cx="33" cy="31" rx="9" ry="5" fill="${c2}" opacity=".9"/>
      <ellipse cx="24" cy="34" rx="8" ry="4" fill="${c}" opacity=".9"/>
      <animateTransform attributeName="transform" type="rotate" from="0 26 26" to="360 26 26" dur="${dur}s" repeatCount="indefinite"/>
    </g>
  </g>
  <ellipse cx="21" cy="17" rx="7" ry="3.2" fill="#fff" opacity=".35"/>
  <circle cx="26" cy="26" r="17" fill="none" stroke="#fff" stroke-opacity=".18"/>
</svg>`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

export const register: Register = on => {
  let timer: Timer | undefined
  // What the user has typed per worker, so a status redraw does not wipe a half-typed task.
  const drafts = new Map<string, string>()
  // The New worker form's one field ("Name, then what it does"), kept here for the same reason.
  const form = { text: '' }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'workers', description: 'Show the Workers pane' })
    void $.ui.open({ id: PANE, title: 'Workers', columns: COLUMNS })

    timer?.cancel()
    let openedAt = await $.clock.now()
    const poll = async () => {
      const now = await $.clock.now()
      try {
        const flag = await $.fs.stat((await paths($)).openFlag)
        if (flag.mtimeMs > openedAt) {
          openedAt = flag.mtimeMs
          void $.ui.open({ id: PANE, title: 'Workers', columns: COLUMNS, focus: true })
        }
      } catch {
        // no flag yet
      }
      const snap = await snapshot($ as unknown as Fs, now)
      // A delete is done once the call session has dropped the worker from the registry.
      if (!snap.error) {
        await update($, removing, old => {
          const left = Object.entries(old).filter(([key]) => snap.workers.some(x => x.key === key))
          return left.length === Object.keys(old).length ? old : Object.fromEntries(left)
        })
      }
      const sig = signature(snap)
      await update($, roster, old => (old === sig ? old : sig))
      await syncShown($)
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
    const ui = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Input?: any; Svg?: any }
    const { Box, Text, Button, Input, Svg } = ui
    // The terminal paints no alpha hex; tints and hovers are for the graphical surfaces.
    const isGraphical = e.surface !== 'terminal'
    const now = await $.clock.now()
    await read($, roster) // subscribe: the poll's signature change redraws the pane
    const snap = await snapshot($ as unknown as Fs, now)
    const tasks = await read($, sent)
    const fs = await read($, formState)
    const picked = await read($, selected)
    const armed = await read($, confirming)
    const leaving = await read($, removing)

    const open = async (w: RegistryWorker) => {
      await update($, selected, old => (old === w.key ? old : w.key))
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

    const send = async (w: RegistryWorker, text: string) => {
      const task = text.trim()
      if (!task) return
      if (!w.session) {
        $.ui.toast(`${w.name} has no chat yet`)
        return
      }
      drafts.set(w.key, '')
      const result = await $.session.send({ to: w.session, text: task })
      const entry: SentTask = {
        text: task,
        atMs: await $.clock.now(),
        isDelivered: result.isDelivered !== false,
        reason: result.isDelivered === false ? result.reason : undefined,
      }
      await update($, sent, old => ({ ...old, [w.key]: entry }))
      $.ui.toast(entry.isDelivered ? `Sent to ${w.name}` : `${w.name} didn't get it: ${entry.reason ?? 'not delivered'}`)
    }

    // Delete arms on the first press and fires on a second within CONFIRM_MS. The
    // call session archives the chat and drops the registry entry; the pane only
    // writes the request and shows Removing… until the worker leaves the registry.
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
      const p = await paths($)
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
      try {
        const { workers } = await readRegistry($ as unknown as Fs)
        const kept = workers.filter(x => x.key !== w.key)
        await $.fs.write(p.registry, JSON.stringify({ workers: kept }, null, 2))
      } catch {
        // the call session drops it from the registry too
      }
      $.ui.toast(`${w.name} removed`)
    }

    const setForm = (patch: Partial<FormState>) =>
      update($, formState, old => {
        const nextState = { ...old, ...patch }
        return nextState.isOpen === old.isOpen && nextState.isValid === old.isValid &&
          nextState.isTried === old.isTried && nextState.avatar === old.avatar
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
      const { name, role } = splitEntry(form.text)
      if (!isValidName(name)) {
        await setForm({ isTried: true, isValid: false })
        return
      }
      const text = createText({ name, role, avatar: current.avatar })
      // The app starts a new chat only from the user's own words, and treats a submit by a
      // mod as automated, so the request goes into the prompt box for their Enter.
      const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => ({ isFilled: false }))
      if (!filled.isFilled) {
        $.ui.toast(`Couldn't put the request for ${name} in the prompt box`)
        return
      }
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

    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" width="100%">
        <Box flexDirection="row" gap="xs" alignItems="center">
          <Text bold>Workers</Text>
          <Text dimColor size="footnote">
            {snap.workers.length === 1 ? '1 standing chat' : `${snap.workers.length} standing chats`}
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

    const [fc] = colours(fs.avatar)
    const showHint = fs.isTried && !fs.isValid
    const newForm = fs.isOpen ? (
      <Box
        key="new-form"
        flexDirection="column"
        borderStyle="round"
        borderColor={fc}
        backgroundColor={isGraphical ? tint(fc, 0.06) : undefined}
        width="100%"
        paddingX="sm"
        paddingY="sm"
        gap="xs"
      >
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" width="100%">
          <Box flexDirection="row" gap="xs" alignItems="center">
            {Svg ? (
              <Svg source={orb('new-form', fs.avatar, false, 28, true)} alt="New worker avatar" width={28} height={28} isInteractive />
            ) : (
              <Text bold color={fc}>●</Text>
            )}
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
        <Box flexDirection="row" gap="xs" alignItems="center" width="100%">
          {AVATAR_NAMES.map(a => {
            const isPicked = fs.avatar === a
            return (
              <Button
                key={`avatar-${a}`}
                label={SWATCH[a]}
                {...(isPicked ? { variant: 'primary' as const } : { plain: true as const })}
                onPress={() => void setForm({ avatar: a })}
              />
            )
          })}
        </Box>
        {showHint ? (
          <Text size="footnote" color={RED}>Name, before the comma: 1 to 24 letters, digits or spaces</Text>
        ) : null}
      </Box>
    ) : null

    const card = (w: RegistryWorker) => {
      const s = snap.status[w.key]
      const isRemoving = leaving[w.key] !== undefined
      const isBusy = s?.isWorking ?? false
      const isSelected = picked === w.key
      const armedAt = armed[w.key]
      const isArmed = armedAt !== undefined && now - armedAt < CONFIRM_MS
      const [c] = colours(w.avatar)
      const last = tasks[w.key]
      const draft = drafts.get(w.key) ?? ''
      const pill = isRemoving
        ? { text: 'Removing…', color: RED }
        : s?.isNew
          ? { text: '✦ New', color: BLUE }
          : isBusy
            ? { text: '● Working', color: GREEN }
            : { text: `○ Idle${s?.lastActiveMs ? ` · ${ago(now - s.lastActiveMs)}` : ''}`, color: undefined }

      return (
        <Box
          key={`card-${w.key}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={isSelected ? c : undefined}
          borderDimColor={!isSelected}
          backgroundColor={isSelected && isGraphical ? tint(c, 0.08) : undefined}
          hover={
            isGraphical
              ? { borderColor: c, borderDimColor: false, backgroundColor: tint(c, isSelected ? 0.12 : 0.05) }
              : undefined
          }
          width="100%"
          paddingX="sm"
          paddingY="sm"
          gap="xs"
        >
          <Box flexDirection="row" alignItems="center" gap="sm" width="100%">
            {Svg ? (
              <Svg
                source={orb(w.key, w.avatar, isBusy, 44, isBusy || isSelected)}
                alt={`${w.name} avatar`}
                width={44}
                height={44}
                isInteractive
              />
            ) : (
              <Text bold color={c}>●</Text>
            )}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap="xs" width="100%">
                <Button key={`name-${w.key}`} plain onPress={() => void open(w)}>
                  <Text bold color={c}>{w.name}</Text>
                </Button>
                <Text
                  size="caption"
                  color={pill.color}
                  dimColor={pill.color === undefined}
                  backgroundColor={pill.color && isGraphical ? tint(pill.color, 0.16) : undefined}
                >
                  {` ${pill.text} `}
                </Text>
              </Box>
              {w.role ? <Text dimColor size="footnote" wrap="truncate-end">{w.role}</Text> : null}
            </Box>
          </Box>
          {Input && !isRemoving
            ? fill(
                <Input
                  key={`task-${w.key}`}
                  placeholder={`Ask ${w.name}…`}
                  value={draft}
                  submitLabel="send"
                  onInput={(value: string) => void drafts.set(w.key, value)}
                  onSubmit={(value: string) => void send(w, value)}
                />,
              )
            : null}
          {isRemoving ? null : (
            <Box flexDirection="row" gap="xs" alignItems="center" width="100%">
              <Box flexGrow={1} />
              <Button key={`open-${w.key}`} label="Open" variant="secondary" onPress={() => void open(w)} />
              {isArmed ? (
                <Button key={`delete-${w.key}`} label="Confirm delete" variant="secondary" onPress={() => void remove(w)}>
                  <Text bold color={RED}>Confirm delete</Text>
                </Button>
              ) : (
                <Button key={`delete-${w.key}`} label="Delete" variant="secondary" dimColor onPress={() => void remove(w)} />
              )}
            </Box>
          )}
          {last ? (
            <Text dimColor size="footnote" wrap="truncate-end">
              {`${last.isDelivered ? 'Last' : 'Not delivered'}: ${last.text} · ${ago(now - last.atMs)}`}
            </Text>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" alignItems="stretch" width="100%" gap="sm">
        {header}
        {newForm}
        {snap.error && snap.workers.length === 0 ? <Text dimColor>{snap.error}</Text> : null}
        {snap.workers.filter(w => leaving[w.key] === undefined).map(card)}
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
    await read($, roster) // subscribe: the count and colour follow the registry

    const ui = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Svg?: any }
    const { Box, Text, Button, Svg } = ui
    const { workers } = await readRegistry($ as unknown as Fs)
    const leaving = await read($, removing)
    const live = workers.filter(w => leaving[w.key] === undefined)
    const picked = await read($, selected)
    const lead = live.find(w => w.key === picked) ?? live[0]
    const [c] = colours(lead?.avatar)
    const label = live.length > 0 ? `Workers · ${live.length}` : 'Workers'

    return (
      <Box flexDirection="row" alignItems="center" gap="sm">
        <Box flexDirection="row" alignItems="center" gap="xs">
          {Svg ? (
            <Svg source={orb('band', lead?.avatar, false, 16)} alt="Workers" width={16} height={16} />
          ) : (
            <Text color={c}>●</Text>
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
