/** Where the pane is: the spaces list (`space` empty), a space's library, or one page. */
export type Nav = { space: string; page: string }

/** Which inline "new" form is open: none, a space, a page, or a subpage of the open page. */
export type FormKind = '' | 'space' | 'page' | 'subpage'

/** `spaces/<slug>/space.json` and what the pane counts beside it. */
export type Space = {
  slug: string
  name: string
  emoji?: string
  /** Markdown pages in the folder. */
  pages: number
  /** The newest page file's modification time (ms), 0 for an empty space. */
  newestMs: number
}

/** One `spaces/<space>/<slug>.md`: its front matter and its Markdown body. */
export type Page = {
  space: string
  slug: string
  title: string
  created: string
  updated: string
  /** A worker key, or "you". */
  by: string
  /** The parent page's slug in the same space; '' for a top-level page. */
  parent: string
  body: string
  path: string
  /** `updated` as ms, else the file's modification time. */
  editedMs: number
}

/** A draft in `spaces/.drafts/` that has no decision yet. */
export type PendingDraft = { id: string; title: string; by: string; space: string; page: string }

/**
 * One worker as `~/.voicemode/call/workers.json` lists it: the fields this pane reads.
 * The file carries more; this pane never writes it.
 */
export type RegistryWorker = {
  key: string
  name: string
  role?: string
  /** The app's chat id (`local_…`): where an Ask is sent. */
  session?: string
  god?: string
  avatar?: string
  /** The spaces this worker may write to: slugs, or "*". Absent: Notes only. */
  spaces?: string[] | string
}

/** The last question sent about a page from its Ask box. */
export type AskReceipt = { worker: string; text: string; atMs: number; isDelivered: boolean; reason?: string }

declare module 'claude-code' {
  interface PluginState {
    'spaces-pane': {
      /** A signature of the spaces folder, the drafts and the registry: the poll's redraw trigger. */
      sig: Shaped<string>
      /** Drafts awaiting review, for the footer launcher. */
      pending: Shaped<number>
      nav: Shaped<Nav>
      /** The library's search text. */
      query: Shaped<string>
      form: Shaped<FormKind>
      /** The last failure of a "new" form, shown under its field. */
      formError: Shaped<string>
      /** The worker key the Ask box sends to; '' for the first one listed. */
      asker: Shaped<string>
      /** `space/slug` to the last question asked about that page. */
      asked: Shaped<Record<string, AskReceipt>>
    }
  }
}
