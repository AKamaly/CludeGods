import type { On } from 'claude-code'

// A small file system the hooks see through `fs.*`, plus the other host calls the pane makes.
// Paths are absolute; directories exist wherever a file sits beneath them.

export const HOME = '/home/owner'
export const CALL = `${HOME}/.voicemode/call`
export const SPACES = `${CALL}/spaces`
export const PAGES_BIN = `${HOME}/.claude/skills/colleague/bin/pages`
export const NOW = Date.parse('2026-11-01T12:00:00.000Z')

export type File = { text: string; mtimeMs: number }
export type Files = Record<string, File>

export const iso = (ms: number) => new Date(ms).toISOString()

/** A page file with front matter, edited `minutesAgo` before NOW. */
export function page(title: string, body: string, opts: { by?: string; parent?: string; minutesAgo?: number } = {}): File {
  const at = NOW - (opts.minutesAgo ?? 5) * 60_000
  const head = ['---', `title: ${JSON.stringify(title)}`, `created: ${iso(at)}`, `updated: ${iso(at)}`, `by: ${opts.by ?? 'you'}`]
  if (opts.parent) head.push(`parent: ${opts.parent}`)
  head.push('---', '')
  return { text: `${head.join('\n')}\n${body}`, mtimeMs: at }
}

export const spaceJson = (name: string, emoji?: string): File => ({
  text: JSON.stringify(emoji ? { name, emoji } : { name }),
  mtimeMs: NOW - 86_400_000,
})

export const REGISTRY = {
  workers: [
    { key: 'scribe', name: 'Scribe', role: 'Drafts docs', session: 'local_scribe-1', avatar: 'blue', spaces: ['notes'] },
    { key: 'research', name: 'Research', role: 'Digs', session: 'local_research-2', god: 'research', spaces: [] },
    { key: 'scout', name: 'Scout', role: 'Watches', session: 'local_scout-3', avatar: 'lime', spaces: ['memory', 'notes', 'launch'] },
    { key: 'fresh', name: 'Fresh', role: 'No chat yet' },
  ],
}

/** Three spaces: Memory, Notes (a page tree) and Launch (empty), plus the registry. */
export function standardFiles(): Files {
  return {
    [`${CALL}/workers.json`]: { text: JSON.stringify(REGISTRY), mtimeMs: NOW - 3_600_000 },
    [`${SPACES}/memory/space.json`]: spaceJson('Memory'),
    [`${SPACES}/memory/tone.md`]: page('Tone', 'Short replies. No exclamation marks.', { minutesAgo: 600 }),
    [`${SPACES}/notes/space.json`]: spaceJson('Notes'),
    [`${SPACES}/notes/launch-brief.md`]: page('Launch brief', '# Launch brief\n\nShip **v2** on Monday.\n\n- [x] Notes\n- Demo', {
      by: 'scribe',
      minutesAgo: 3,
    }),
    [`${SPACES}/notes/risks.md`]: page('Risks', 'Late hardware is the main risk.', { parent: 'launch-brief', minutesAgo: 120 }),
    [`${SPACES}/notes/deep-risk.md`]: page('Deep risk', 'Nested twice.', { parent: 'risks', minutesAgo: 240 }),
    [`${SPACES}/notes/welcome.md`]: page('Welcome', 'Hello.', { minutesAgo: 2_880 }),
    [`${SPACES}/notes/.tmp-x.md`]: { text: 'half written', mtimeMs: NOW },
    [`${SPACES}/notes/notes.txt`]: { text: 'not a page', mtimeMs: NOW },
    [`${SPACES}/launch/space.json`]: spaceJson('Launch', '🚀'),
    [`${SPACES}/bad name/space.json`]: spaceJson('Bad'),
    [`${SPACES}/stray/readme.md`]: page('No space.json', 'skip'),
  }
}

export type Run = { argv: string[]; result?: { exitCode: number; stdout: string; stderr?: string } }

export type World = {
  files: Files
  links: Set<string>
  writes: { path: string; text: string }[]
  runs: string[][]
  sends: { to: unknown; text: string }[]
  opens: unknown[]
  toasts: string[]
  commands: string[]
  /** Answers `process.run` by argv; the default exits 0 with no output. */
  answer: (argv: string[]) => { exitCode: number; stdout: string; stderr?: string }
  deliver: boolean
}

function dirs(files: Files): Set<string> {
  const out = new Set<string>()
  for (const path of Object.keys(files)) {
    let cut = path.lastIndexOf('/')
    while (cut > 0) {
      out.add(path.slice(0, cut))
      cut = path.lastIndexOf('/', cut - 1)
    }
  }
  return out
}

export function world(on: On, files: Files = standardFiles()): World {
  const w: World = {
    files,
    links: new Set(),
    writes: [],
    runs: [],
    sends: [],
    opens: [],
    toasts: [],
    commands: [],
    answer: () => ({ exitCode: 0, stdout: '' }),
    deliver: true,
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: HOME }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    w.opens.push({ ...e })
    return { value: { isPlaced: true } }
  })
  on('command.register', (_, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('fs.read', (_, e) => {
    const f = w.files[e.path]
    return f ? { value: f.text } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.exists', (_, e) => ({ value: e.path in w.files || dirs(w.files).has(e.path) }))
  on('fs.write', (_, e) => {
    w.writes.push({ path: e.path, text: e.text })
    w.files[e.path] = { text: e.text, mtimeMs: NOW }
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const f = w.files[e.path]
    if (f) return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
    if (dirs(w.files).has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', (_, e) => {
    const base = e.path.replace(/\/+$/, '')
    const seen = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [path, f] of Object.entries(w.files)) {
      if (!path.startsWith(`${base}/`)) continue
      const rest = path.slice(base.length + 1)
      const cut = rest.indexOf('/')
      if (cut < 0) seen.set(rest, { name: rest, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })
      else if (!seen.has(rest.slice(0, cut))) {
        const name = rest.slice(0, cut)
        const isLink = w.links.has(`${base}/${name}`)
        seen.set(name, { name, kind: isLink ? ('other' as 'dir') : 'dir', size: 0, mtimeMs: 0, isLink })
      }
    }
    if (seen.size === 0 && !dirs(w.files).has(base)) return { deny: `ENOENT ${e.path}` }
    return { value: [...seen.values()] }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    const r = w.answer(argv)
    return { value: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', (_, e) => {
    w.sends.push({ to: e.to, text: e.text })
    return w.deliver ? { isDelivered: true } : { isDelivered: false, reason: 'not running' }
  })
  return w
}

export const PANE = {
  plugin: 'spaces-pane',
  component: 'Pane',
  requestId: 'spaces',
  props: {
    title: 'Spaces',
    isFocused: false,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

export const FOOTER = {
  plugin: 'spaces-pane',
  component: 'SessionMode',
  props: { modes: ['Bypass permissions'] },
} as const

export const start = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
export const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 50))
