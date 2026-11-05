/**
 * progress.js — the checklist a session keeps about its own work.
 *
 * The CLI has `TodoWrite` and the panel never saw it, because a session the
 * deck starts is not the CLI: it is the SDK, and the SDK's tool set does not
 * include that one. So the list the terminal draws above its prompt had no
 * counterpart here — on a task of fifteen steps the panel could say "working"
 * and nothing else, for twenty minutes.
 *
 * This file gives the session a tool to say it. Not by reading the transcript
 * afterwards, but as an in-process MCP server whose handler runs inside the
 * deck: the session calls it, the handler writes straight to the session
 * object, and the browser has the new list before the tool has returned.
 *
 * ### The whole list, every time
 *
 * The tool takes the complete list on every call and replaces what was there.
 * A protocol of deltas — "item 3 is done now" — needs both sides to agree on
 * what item 3 is, across a restart, a resume, and a model that renumbers its
 * own plan halfway through. Sending eight short strings again costs nothing
 * and cannot drift. The description says so in those words, because this is
 * the one thing the model has to get right.
 *
 * ### It is not in the conversation
 *
 * The call is bookkeeping, not speech. The panel already drops tool blocks
 * from the chat — `textOf` keeps only text — so the list does not appear
 * twice; what it would otherwise do is flicker "working mcp__panel__progress"
 * in the activity line, which is why `transcripts.js` knows this tool's name.
 */
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'

/**
 * The name the session calls, and the name the panel hides.
 *
 * MCP tools are addressed `mcp__<server>__<tool>`, so this string is a
 * consequence of the two below rather than a choice. It is exported because
 * three files need to agree on it exactly — the one that auto-allows it, the
 * one that keeps it out of the activity line, and this one.
 */
export const SERVER_NAME = 'panel'
export const TOOL_NAME = 'progress'
export const PROGRESS_TOOL = `mcp__${SERVER_NAME}__${TOOL_NAME}`

/**
 * What a step may say, and how many there may be.
 *
 * Both are small on purpose. The list is rendered in a strip above the
 * composer, so a step that runs to three lines pushes the thing you are
 * typing off the screen; and a plan of eighty steps is not a plan you read,
 * it is a log. The model is told the same numbers in the guide below, so it
 * aims inside the limit rather than being cut at it.
 */
export const MAX_TEXT = 140
export const MAX_ITEMS = 30

/** The three states a step can be in, in the order they happen. */
export const STATUS = ['pending', 'in_progress', 'completed']

/**
 * Make a list safe to store, show, and write to disk — or give back an empty
 * one.
 *
 * Called on both edges and not only on the way in. The tool's own input is
 * already validated by the schema, but the same list comes back from
 * `handoff.json` after a restart, and that file is a file: it can be edited,
 * truncated, or left behind by an older version of the deck that wrote a
 * shape this one does not expect. A reader that trusts it would turn a bad
 * line in a JSON file into a crashed panel.
 *
 * Unknown statuses become 'pending' rather than being dropped. A step whose
 * state we cannot read is still a step the session said it had, and silently
 * losing it would make the total wrong — and the total is the one number the
 * collapsed panel shows.
 */
export function cleanTodos(items) {
  if (!Array.isArray(items)) return []
  const out = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const text = String(item.text ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT)
    if (!text) continue
    const status = STATUS.includes(item.status) ? item.status : 'pending'
    out.push({ text, status })
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

/** How many of them are done, and how many there are. Used in the reply. */
export function countTodos(todos) {
  const total = todos.length
  const done = todos.filter((t) => t.status === 'completed').length
  return { done, total }
}

/**
 * What the session is told about the list, appended to Claude Code's own
 * system prompt.
 *
 * It has to say three things, and the third is the one that is easy to
 * forget: do not also write the list out in the reply. A model that narrates
 * its checklist in prose turns a panel that was meant to replace the noise
 * into the noise plus a panel.
 */
export const PROGRESS_GUIDE = `## The progress list

The panel shows the list you send with ${PROGRESS_TOOL} live, above the user's
composer. For any task of three steps or more, call it as you start with the
whole plan (3 to 8 short items; on long tasks, one entry per phase, up to
${MAX_ITEMS}), and call it again — always with the complete list — every time a
step becomes in_progress or completed, or a new step appears.

Send the full list every time; it replaces the previous one. Keep each item
under ${MAX_TEXT} characters and written as the work, not as a status report.
Do not repeat the list in your messages: the user is already looking at it.`

/**
 * The in-process MCP server a session is given, wired to one callback.
 *
 * Built per session rather than once for the deck. The handler's job is to
 * write to *this* session's list, and the only way an MCP tool knows which
 * session called it is to have been built knowing — there is no caller
 * identity in the handler's arguments that would survive two sessions
 * calling at the same moment.
 *
 * `onTodos` is handed the cleaned list and is expected to be synchronous:
 * it stores and publishes, which is a memory write and a `JSON.stringify` to
 * the open sockets. The tool's reply is deliberately tiny — "ok (2/8)" — and
 * goes back into the session's context on every call, so anything longer
 * would be a paragraph per step, paid for all turn.
 */
export function progressTool(onTodos) {
  return tool(
    TOOL_NAME,
    'Progress list the user sees above the chat, live. ALWAYS send the complete ' +
      'list every time a step changes state.',
    {
      items: z
        .array(
          z.object({
            text: z.string().max(MAX_TEXT).describe('The step, as the work it is'),
            status: z.enum(STATUS).describe('Where this step stands right now'),
          }),
        )
        .max(MAX_ITEMS)
        .describe('The whole list, in order. Replaces the previous one.'),
    },
    async (args) => {
      const todos = cleanTodos(args?.items)
      onTodos(todos)
      const { done, total } = countTodos(todos)
      return { content: [{ type: 'text', text: `ok (${done}/${total})` }] }
    },
  )
}

/**
 * The server itself, which is only the tool above in the wrapper the SDK's
 * `mcpServers` option takes. Split in two so a test can call the handler
 * without standing up an MCP transport to reach it.
 */
export function progressServer(onTodos) {
  return createSdkMcpServer({ name: SERVER_NAME, tools: [progressTool(onTodos)] })
}
