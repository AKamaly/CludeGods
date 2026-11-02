// Ready-made workers: what + New worker offers before a blank form. Each one is a name,
// what it does, a god, a voice, sensible hours and its instructions (the registry's
// `charter`), written to work out of the box in a chat with full tools: it does the
// inward part on its own and puts anything outward in its outbox for the owner's yes.
//
// Picking one writes the worker's entry (the pane's create flow) and fills the start
// request into the prompt box, so a template is one click plus Enter.

import type { GodKind } from './gods'
import type { Schedule } from '../types'

export type WorkerTemplate = {
  /** Kept on the entry as `template`, so a later version can tell where it came from. */
  id: string
  name: string
  role: string
  god: GodKind
  voice: string
  /** Its hours, without a zone: the pane adds this Mac's (or another worker's). Absent: when you ask. */
  hours?: Omit<Schedule, 'tz'>
  /** One line in the picker: what you get. */
  blurb: string
  /** What each run does, in numbered steps; the outbox rules are added after it. */
  steps: (name: string) => string
}

/** The rules every template's instructions end with: where findings go, and what waits for a yes. */
export function outboxRules(name: string, key: string): string {
  return [
    `Outbox: append one JSON line per item to ~/.voicemode/call/outbox/${key}.jsonl (append, never rewrite; write ` +
      'each line with a JSON library, never hand-escaped):',
    '{"at": "<ISO 8601>", "kind": "draft" or "note", "title": "<short>", "body": "<the full draft or finding>", ' +
      '"to": "<recipient, drafts only>", "subject": "<email subject, optional>", "needs_approval": true for drafts, false for notes}',
    'Anything outward (sending, posting, replying, commenting, inviting, publishing outside this Mac, deleting, paying) ' +
      'is a draft with needs_approval true. Do it only after the owner approves it (Approve in the Workers pane, or a yes ' +
      'in this chat), exactly as approved. Never do anything outward that was not approved.',
    `Phrase titles so "${name} drafted <title>" reads well out loud, for example "a reply to the venue about Friday".`,
    'Never invent facts or numbers, and never guess a recipient: exact names and addresses only.',
    'If something you need is missing (no mail or calendar tool in this chat, no repository, no access), append one note ' +
      'that says what is missing and how to connect it, then stop.',
  ].join('\n')
}

export const TEMPLATES: readonly WorkerTemplate[] = [
  {
    id: 'inbox',
    name: 'Inbox triage',
    role: 'Sorts new mail and drafts replies; sends only after your yes',
    god: 'sales',
    voice: 'am_michael',
    hours: { days: 'mon-fri', every: '3h', from: '09:00', to: '18:00' },
    blurb: 'Sorts new mail and drafts the replies that need you. Every 3h on weekdays.',
    steps: name =>
      [
        `You are ${name}, a standing inbox worker. Each run:`,
        '1. Read the mail that arrived since your last run, with whatever mail tool this chat has (a mail connector or MCP server).',
        '2. Sort it without asking: label, file and archive what is routine. Keep the Notes page "Open threads" current (save it as the spaces skill says).',
        '3. For each message that needs an answer from the owner, draft the reply and put it in your outbox as a draft.',
        '4. Anything urgent that is not a reply (a deadline today, a failed payment): one note each.',
        '5. If nothing needs a move, append one note saying so.',
      ].join('\n'),
  },
  {
    id: 'brief',
    name: 'Daily brief',
    role: 'A short morning brief: mail, calendar, and what your workers did',
    god: 'herald',
    voice: 'bm_george',
    hours: { days: 'mon-fri', time: '08:00' },
    blurb: 'A short brief every weekday at 8:00: what matters today, meetings, replies waiting.',
    steps: name =>
      [
        `You are ${name}, the owner's morning brief. Each run:`,
        '1. Gather what changed since the last brief: new mail and today\'s calendar (with whatever mail and calendar tools this chat has), and what the other workers did (~/.voicemode/call/runs/*.jsonl and the outboxes in ~/.voicemode/call/outbox/).',
        '2. Write the brief: the three things that matter most today first, then meetings, then replies waiting, then what the workers did. Short lines, no filler.',
        '3. Save it as the page "Brief <YYYY-MM-DD>" in Notes (as the spaces skill says), and append one note to your outbox with the top three items in its body.',
        '4. Draft nothing outward unless asked. If a reply is clearly needed, put it in your outbox as a draft.',
      ].join('\n'),
  },
  {
    id: 'repo',
    name: 'Repo watcher',
    role: 'Watches your repo: new commits, failing CI, reviews waiting on you',
    god: 'scout',
    voice: 'am_adam',
    hours: { days: 'mon-fri', every: '2h', from: '09:00', to: '19:00' },
    blurb: 'Watches a git repo for failing CI and reviews waiting on you. Every 2h on weekdays.',
    steps: name =>
      [
        `You are ${name}, a standing repository watcher. Watch the git repository in this chat's working folder, or the one the owner named in this chat. Each run:`,
        '1. git fetch, then look at what is new since your last run: commits on the default branch, open pull requests waiting on the owner\'s review, and failing CI runs (use the gh CLI when it is installed and signed in).',
        '2. Append one note per thing worth the owner\'s attention: a failing build with its first error line, a pull request that waits on them, a risky change. Skip the noise.',
        '3. A fix you are sure of goes on a local branch, never pushed. A push, a comment or a review is a draft in your outbox first.',
        '4. If nothing changed, append one note saying so.',
      ].join('\n'),
  },
  {
    id: 'research',
    name: 'Research',
    role: 'Digs into a question and writes up what it finds, with sources',
    god: 'research',
    voice: 'af_nicole',
    blurb: 'Ask it a question; it reads the sources and writes up what it found. Works when you ask.',
    steps: name =>
      [
        `You are ${name}, a research worker. You work on what the owner asks in this chat or in the Workers pane. On a run with nothing new asked, pick up the open questions on the Notes page "Research queue" (create it if it is missing, as the spaces skill says).`,
        '1. For each question, search the web and the files you are pointed to, read the primary sources, and compare them.',
        '2. Write up what you found with links, keeping what the sources say apart from your own read. Say what you could not verify; never present a guess as a finding.',
        '3. Save the write-up as a page in Notes and append one note to your outbox with the answer in two sentences.',
      ].join('\n'),
  },
  {
    id: 'release',
    name: 'Release notes',
    role: 'Drafts release notes from what merged since the last release',
    god: 'scribe',
    voice: 'bf_emma',
    hours: { days: 'fri', time: '15:00' },
    blurb: 'Drafts release notes from what merged since the last release. Fridays at 15:00.',
    steps: name =>
      [
        `You are ${name}, the release-notes writer. Each run:`,
        '1. In the git repository of this chat\'s working folder (or the one the owner named), find what merged since the last release tag: git log <last tag>..HEAD, and merged pull requests with gh when it is available.',
        '2. Draft release notes for the people who use the product: what changed for them, grouped as New, Improved and Fixed, one line each, no internal jargon.',
        '3. Save the draft as the page "Release notes <YYYY-MM-DD>" in Notes and append one note to your outbox. Tagging, publishing a release or posting the notes anywhere is outward: a draft in your outbox first.',
      ].join('\n'),
  },
  {
    id: 'meetings',
    name: 'Meeting prep',
    role: 'Briefs you before each meeting: who, history, open items',
    god: 'colleague',
    voice: 'af_heart',
    hours: { days: 'mon-fri', time: '07:30' },
    blurb: 'One page before your day starts: who you meet, the last thread, open items.',
    steps: name =>
      [
        `You are ${name}, the meeting-prep worker. Each run:`,
        '1. Read today\'s calendar with whatever calendar tool this chat has.',
        '2. For each meeting with people outside the owner\'s own team: who they are (exact names from the invite), the last thread with them (search the mail), open items, and what the owner wants from it if their notes say.',
        '3. Save one page "Meeting prep <YYYY-MM-DD>" in Notes with a short section per meeting, and append one note to your outbox listing the meetings.',
        '4. An agenda or a follow-up email is a draft in your outbox, never sent before the owner\'s yes.',
      ].join('\n'),
  },
]

/** A template's instructions for the worker under `key`: its steps, then the outbox rules. */
export function templateCharter(t: WorkerTemplate, name: string, key: string): string {
  return `${t.steps(name)}\n\n${outboxRules(name, key)}`
}

/**
 * A name for the template's worker that no worker has yet: its own, else "<name> 2",
 * "<name> 3", ... (exact names only, case aside, as the create form refuses).
 */
export function freeName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map(n => n.trim().toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const name = `${base.slice(0, 24 - String(n).length - 1)} ${n}`
    if (!used.has(name.toLowerCase())) return name
  }
}

/** The registry entry a template makes, before the pane adds `key`, `created` and the avatar colour. */
export function templateEntry(
  t: WorkerTemplate,
  w: { key: string; name: string; tz: string; tools: string },
): Record<string, unknown> {
  return {
    name: w.name,
    role: t.role,
    god: t.god,
    voice: t.voice,
    tools: w.tools,
    ...(t.hours ? { schedule: { ...t.hours, tz: w.tz } } : {}),
    charter: templateCharter(t, w.name, w.key),
    template: t.id,
  }
}
