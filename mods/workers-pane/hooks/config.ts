// The Workers pane's part of ~/.voicemode/call/config.json, as pure functions.
//
// The file is shared: other parts of CludeGods own other top-level keys ("user_label",
// "approvals", ...). The pane owns "workers" alone:
//
//   { "workers": { "default_tools": "full" | "drafts" | "read" } }
//
// A missing file, a file that is not JSON, or a value the pane does not know all mean
// the defaults: new workers start with full tools. A write keeps every other key, and
// refuses to touch a file it cannot parse (so a hand edit in progress is never lost).

import type { ToolsPreset, WorkersConfig } from '../types'

export const DEFAULT_TOOLS: ToolsPreset = 'full'

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isPreset(v: unknown): v is ToolsPreset {
  return v === 'full' || v === 'drafts' || v === 'read'
}

/** The pane's settings from config.json's text (undefined: no file). Never throws. */
export function parseConfig(raw: string | undefined): WorkersConfig {
  if (raw === undefined) return { defaultTools: DEFAULT_TOOLS }
  try {
    const doc = JSON.parse(raw) as unknown
    const workers = isObject(doc) ? doc.workers : undefined
    const tools = isObject(workers) ? workers.default_tools : undefined
    return { defaultTools: isPreset(tools) ? tools : DEFAULT_TOOLS }
  } catch {
    return { defaultTools: DEFAULT_TOOLS }
  }
}

/**
 * config.json's new text with `workers.default_tools` set, every other key (top level
 * and inside "workers") kept; or an error to show when the file is not a JSON object.
 */
export function withDefaultTools(raw: string | undefined, tools: ToolsPreset): { text?: string; error?: string } {
  let doc: Record<string, unknown> = {}
  if (raw !== undefined && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isObject(parsed)) return { error: 'config.json is not a JSON object' }
      doc = parsed
    } catch {
      return { error: 'config.json is not valid JSON' }
    }
  }
  const workers = isObject(doc.workers) ? doc.workers : {}
  doc.workers = { ...workers, default_tools: tools }
  return { text: `${JSON.stringify(doc, null, 2)}\n` }
}
