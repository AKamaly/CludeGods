/**
 * One line of `~/.voicemode/call/inbox/<worker>.jsonl`, as a bridge appends it
 * (SPEC "Bridges"). The Slack bridge also writes `user`, `channel_id`, `ts` and
 * `worker`; the relay reads only the fields below.
 */
export type InboxLine = {
  /** The inbox id the worker passes to `bin/reply` ("in_" and 12 hex for Slack). */
  id: string
  at: string
  /** Which bridge: "slack". */
  source: string
  /** The sender's display name, or their Slack id when the allow-list names none. */
  from: string
  /** The channel's name without "#", or "dm". */
  channel: string
  /** The thread the reply goes into (Slack's thread_ts). */
  thread: string
  text: string
  /** Always false from the bridge; the relay records delivery in `<worker>.delivered`. */
  delivered: boolean
  /** True for a direct message. */
  dm?: boolean
}

/** The fields of one `workers.json` entry the relay reads; the rest is left alone. */
export type RelayWorker = {
  key: string
  name: string
  /** The app's chat id (`local_…`), what `$.session.send` takes. */
  session?: string
  /** The CLI transcript file; it tells the worker's own chat apart. */
  transcript?: string
  /** True: hold its messages and tell the owner. */
  paused?: boolean
}
