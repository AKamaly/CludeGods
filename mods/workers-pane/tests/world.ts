import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// A home folder in memory for the v0.4 tests: files with mtimes, folders that `mkdir`
// makes (atomically: a second mkdir of the same folder fails, as the wake claims rely
// on), `tee -a` appends, `tail -c` reads, and every send, toast and prompt recorded.

export const HOME = '/home/tester'
export const CALL = `${HOME}/.voicemode/call`
export const PROJECTS = `${HOME}/.claude/projects`
export const PROJ = `${PROJECTS}/-home-tester-work`
export const REG = `${CALL}/workers.json`

export type World = {
  now: number
  files: Map<string, { text: string; mtimeMs: number }>
  dirs: Map<string, number>
  env: Record<string, string>
  self: string
  deliver: boolean | ((to: string) => boolean)
  writes: { path: string; text: string }[]
  runs: { argv: string[]; stdin?: string }[]
  sends: { to: string; text: string }[]
  toasts: string[]
  prompts: string[]
  /** A fake command: answers a run before the built-ins (mkdir, rmdir, tee, tail), or undefined to fall through. */
  run?: (argv: string[], stdin?: string) => { exitCode: number; stdout?: string; stderr?: string } | undefined
}

export const PANE_PROPS = {
  title: 'Workers', isFocused: false, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {},
} as const
export const PANE = { plugin: 'workers-pane', component: 'Pane', requestId: 'workers', props: PANE_PROPS } as const

const parent = (path: string) => path.slice(0, path.lastIndexOf('/'))

export function makeWorld(on: On, init: { now: number; registry?: unknown; files?: Record<string, string>; env?: Record<string, string>; self?: string }): World {
  const w: World = {
    now: init.now,
    files: new Map(),
    dirs: new Map([[PROJECTS, 0], [PROJ, 0]]),
    env: { HOME, ...(init.env ?? {}) },
    self: init.self ?? 'me-cli',
    deliver: true,
    writes: [],
    runs: [],
    sends: [],
    toasts: [],
    prompts: [],
  }
  if (init.registry !== undefined) w.files.set(REG, { text: JSON.stringify(init.registry), mtimeMs: init.now - 3_600_000 })
  for (const [path, text] of Object.entries(init.files ?? {})) w.files.set(path, { text, mtimeMs: init.now - 600_000 })

  mock.env(on, w.env)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: w.self }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('clock.now', () => ({ value: w.now }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const f = w.files.get(e.path)
    return f === undefined ? { deny: `ENOENT ${e.path}` } : { value: f.text }
  })
  on('fs.write', (_, e) => {
    w.writes.push({ path: e.path, text: e.text })
    w.files.set(e.path, { text: e.text, mtimeMs: w.now })
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const f = w.files.get(e.path)
    if (f) return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
    const d = w.dirs.get(e.path)
    if (d !== undefined) return { value: { kind: 'dir', size: 0, mtimeMs: d, isLink: false } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', (_, e) => {
    if (!w.dirs.has(e.path)) return { deny: `ENOENT ${e.path}` }
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of w.files.keys()) if (parent(p) === e.path) names.set(p.slice(e.path.length + 1), 'file')
    for (const p of w.dirs.keys()) if (parent(p) === e.path) names.set(p.slice(e.path.length + 1), 'dir')
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    const stdin = e.init?.stdin
    w.runs.push({ argv, ...(stdin !== undefined ? { stdin } : {}) })
    const faked = w.run?.(argv, stdin)
    if (faked) {
      const value = { exitCode: faked.exitCode, stdout: faked.stdout ?? '', stderr: faked.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false }
      return { value }
    }
    let exitCode = 0
    let stdout = ''
    if (argv[0] === '/bin/mkdir') {
      if (argv[1] === '-p') {
        if (!w.dirs.has(argv[2]!)) w.dirs.set(argv[2]!, w.now)
      } else if (w.dirs.has(argv[1]!)) {
        exitCode = 1
      } else {
        w.dirs.set(argv[1]!, w.now)
      }
    } else if (argv[0] === '/bin/rmdir') {
      exitCode = w.dirs.delete(argv[1]!) ? 0 : 1
    } else if (argv[0] === '/usr/bin/tee' && argv[1] === '-a') {
      const path = argv[2]!
      const old = w.files.get(path)?.text ?? ''
      w.files.set(path, { text: old + (stdin ?? ''), mtimeMs: w.now })
      stdout = stdin ?? ''
    } else if (argv[0] === '/usr/bin/tail') {
      const f = w.files.get(argv[3]!)
      if (f) stdout = f.text.slice(-Number(argv[2]))
      else exitCode = 1
    }
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', (_, e) => {
    const to = String(e.to)
    w.sends.push({ to, text: e.text })
    const ok = typeof w.deliver === 'function' ? w.deliver(to) : w.deliver
    return ok ? { isDelivered: true } : { isDelivered: false, reason: 'not running' }
  })
  on('prompt.fill', (_, e) => {
    w.prompts.push(e.text)
    return { isFilled: true }
  })
  return w
}

export const registryOf = (w: World) =>
  JSON.parse(w.files.get(REG)?.text ?? '{}') as { workers: Record<string, unknown>[]; [k: string]: unknown }

export const start = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
export const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 50))
