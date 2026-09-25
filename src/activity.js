/**
 * activity.js — what a session is doing to your files.
 *
 * The conversation view answers "what did it say". This answers a different
 * question: "what is it touching, right now". Both come out of the same
 * .jsonl, but the transcript reader deliberately throws tool detail away —
 * you do not want to read the `git status` it ran — and that is exactly the
 * detail the map needs.
 *
 * So this is a second, narrow reading of the same lines: tool calls in, file
 * events out. Nothing here parses conversation, and nothing in the
 * conversation path parses tools.
 *
 * It reads nothing itself: the transcript reader already walks every line for
 * the conversation, so it hands each one here on the way past.
 */

/**
 * Which tool means what.
 *
 * The action, not the tool name, is what the map draws — Edit and MultiEdit
 * are the same event to someone watching, and a tool we have never heard of
 * is still worth showing if it names a file.
 */
const ACTIONS = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Glob: 'search',
  Grep: 'search',
}

/** Tools whose work is not about one file, kept only as a caption. */
const NAMELESS = new Set(['Bash', 'Task', 'Agent', 'Skill', 'WebFetch', 'WebSearch'])

/**
 * What kind of work it is, for a map that draws these as shapes.
 *
 * Deliberately a kind and not a colour: the folder palette is a validated
 * all-pairs set and borrowing from it would make a command look like it
 * belonged to a directory. Anything unrecognised is still work worth drawing.
 */
const KINDS = {
  Bash: 'command',
  Task: 'agent',
  Agent: 'agent',
  Skill: 'skill',
  WebFetch: 'web',
  WebSearch: 'web',
}

/** The path a tool call is about, if it is about one. */
function pathOf(input) {
  if (!input || typeof input !== 'object') return null
  const value = input.file_path || input.notebook_path || input.path
  return typeof value === 'string' && value.startsWith('/') ? value : null
}

/**
 * A short caption for work that has no file: the command, the subagent's
 * task. Truncated hard — this is a label on a map, not a log line.
 */
function captionOf(name, input) {
  if (!input || typeof input !== 'object') return name
  // `skill` first: a skill call carries no description, and falling through to
  // its prompt would caption it with somebody else's sentence.
  const raw = input.skill || input.description || input.command
    || input.prompt || input.query || input.url || ''
  const text = String(raw).split('\n')[0].trim()
  return text ? text.slice(0, 80) : name
}

/**
 * File events and failures from one already-parsed transcript line.
 *
 * Failures arrive later than the call they belong to, on a different line, so
 * they come back separately and are matched by tool_use id — which is also
 * why an event is never rewritten here, only annotated by the caller.
 */
export function eventsFromLine(raw) {
  const events = []
  const failed = []

  const blocks = raw?.message?.content
  if (!Array.isArray(blocks)) return { events, failed }

  if (raw.type === 'assistant') {
    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue

      const path = pathOf(block.input)
      const action = ACTIONS[block.name]

      if (path) {
        events.push({
          id: block.id,
          at: raw.timestamp || null,
          tool: block.name,
          // A tool we do not know that still names a file: call it a touch
          // rather than dropping it, and let the map show something honest.
          action: action || 'touch',
          path,
        })
        continue
      }

      // Work with no file still says what the session is busy with.
      if (NAMELESS.has(block.name) || !action) {
        events.push({
          id: block.id,
          at: raw.timestamp || null,
          tool: block.name,
          action: 'run',
          path: null,
          kind: KINDS[block.name] || 'tool',
          label: captionOf(block.name, block.input),
        })
      }
    }
  } else if (raw.type === 'user') {
    for (const block of blocks) {
      if (block?.type === 'tool_result' && block.is_error && block.tool_use_id) {
        failed.push(block.tool_use_id)
      }
    }
  }

  return { events, failed }
}

