/**
 * One worker as `~/.voicemode/call/workers.json` lists it: the fields the pane reads.
 * The file may carry more (a model, an effort); the user picks the model inside the chat.
 */
export type RegistryWorker = {
  key: string
  name: string
  role?: string
  /** The app's chat id (`local_…`): what SendMessage and the claude:// link take. */
  session?: string
  /**
   * The CLI transcript file the live status reads: absolute, `~/`-relative, or relative to
   * `~/.claude/projects/`. Absent for a chat not yet started.
   */
  transcript?: string
  /** An avatar preset name (blue, violet, orange, rose, lime, gold; one coloured-circle emoji each). */
  avatar?: string
  /** The worker's standing brief. The card never shows it; every wake carries all of it. */
  charter?: string
  /** When the pane wakes the worker to run its charter. */
  schedule?: Schedule
}

/**
 * A wake time: `days` like "mon-fri", "sun-thu", "mon,wed,fri" or "daily"; `time`
 * "HH:MM" in the IANA zone `tz`.
 */
export type Schedule = { days: string; time: string; tz: string }

/**
 * One line of `~/.voicemode/call/outbox/<key>.jsonl`, as the worker appends it. A draft
 * waits for the user's typed yes in the worker's chat; the pane only shows it.
 */
export type OutboxItem = {
  at: string
  kind: 'draft' | 'note'
  title: string
  body: string
  to?: string
  needs_approval: boolean
}

/** What the pane knows about one worker right now. */
export type WorkerStatus = { isWorking: boolean; lastActiveMs: number; isNew: boolean }

/** The last task the user sent a worker from the pane. */
export type SentTask = { text: string; atMs: number; isDelivered: boolean; reason?: string }

/**
 * The New worker form's drawn state; the typed "Name, role" line lives in the hook.
 * `isTried` turns on once a create was attempted with an invalid name, so the
 * hint shows only after a failed try, never before typing. `avatar` is a preset name.
 */
export type FormState = { isOpen: boolean; isValid: boolean; isTried: boolean; avatar: string }

declare module 'claude-code' {
  interface PluginState {
    'workers-pane': {
      /** A signature of the registry and statuses: the poll's redraw trigger. */
      roster: Shaped<string>
      sent: Shaped<Record<string, SentTask>>
      form: Shaped<FormState>
      /** The key of the card last opened (name or Open): drawn with the glow. '' for none. */
      selected: Shaped<string>
      /** Worker key to when its Delete was armed (ms); a second press within 5 s deletes. */
      confirming: Shaped<Record<string, number>>
      /** Worker key to when its delete request was written; cleared once it leaves the registry. */
      removing: Shaped<Record<string, number>>
      /** Whether the Workers pane is the one shown: the AbovePrompt launcher hides then. */
      paneShown: Shaped<boolean>
      /** Worker key to whether its outbox feed is expanded on the card. */
      feeds: Shaped<Record<string, boolean>>
    }
  }
}
