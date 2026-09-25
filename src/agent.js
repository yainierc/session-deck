/**
 * agent.js — the control plane: sessions the deck launches itself.
 *
 * Sessions started from a terminal can only be observed, because their
 * permission prompt lives on their TTY. A session started here is different:
 * we own its permission callback, so the prompt becomes a button.
 *
 * These sessions still register in ~/.claude/sessions and still write their
 * transcript, so the whole read path keeps working unchanged. All this file
 * adds is status, the pending permission, and a way to talk back.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
// Aliased: `peerName` is also the field it produces, and a function shadowed
// by a parameter of the same name inside register() is a trap to leave set.
import { peerName as composePeerName, withRoster } from './roster.js'

/**
 * What a managed session can be doing, from the panel's point of view.
 *
 * `detached` is the odd one and the reason this list grew: a session with no
 * process behind it, whose conversation is sitting on disk waiting to be
 * picked back up. Everything else here describes something that is running.
 */
export const MANAGED_STATUS = ['working', 'waiting', 'idle', 'detached', 'done', 'error']

/**
 * How long a session's label may be.
 *
 * The sidebar truncates past its own width anyway, so this is not about
 * layout: it is about not holding a whole pasted prompt in memory as a
 * "title", and not shipping one to every connected browser on every state
 * change.
 */
const MAX_TITLE = 80

/**
 * The few numbers a context gauge needs, out of a report carrying twenty.
 *
 * `percentage` is the CLI's own rather than one computed here. It is measured
 * against `rawMaxTokens` — the window the session will actually be compacted
 * at, which on a 1M-token model may be a 200K compaction boundary rather than
 * the model's limit. A percentage derived here from a context window we picked
 * ourselves would quietly disagree with the session it describes.
 *
 * `autoCompactThreshold` is deliberately not carried through. The SDK's types
 * declare it as a bare optional number with no documentation of its unit, and
 * a gauge that prints "compacts at 155000" while meaning a fraction is worse
 * than one that never says it. `isAutoCompactEnabled` is documented, so what
 * the top of the bar means — a summary, or the hard end of the window — is
 * still something the panel can say truthfully.
 */
export function shapeContextUsage(report) {
  if (!report || typeof report.percentage !== 'number') return null
  return {
    percentage: report.percentage,
    tokens: report.totalTokens ?? null,
    max: report.rawMaxTokens ?? null,
    model: report.model || null,
    compacts: Boolean(report.isAutoCompactEnabled),
  }
}

/**
 * One line, trimmed, bounded — or '' when there is nothing usable.
 *
 * Both the name you type and the prompt we fall back on go through here, so
 * a name can never be the thing that breaks a layout the derived title was
 * safe in.
 */
function cleanTitle(value) {
  return String(value || '').trim().split('\n')[0].slice(0, MAX_TITLE).trim()
}

/**
 * A push-driven async iterable. The SDK consumes it as the prompt stream, so
 * every follow-up message you type gets pushed in here.
 */
function createInputStream() {
  const queue = []
  let wake = null
  let closed = false

  return {
    push(content) {
      if (closed) return
      queue.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
      if (wake) { const w = wake; wake = null; w() }
    },
    close() {
      closed = true
      if (wake) { const w = wake; wake = null; w() }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) { yield queue.shift(); continue }
        if (closed) return
        await new Promise((resolve) => { wake = resolve })
      }
    },
  }
}

/**
 * What the Messages API accepts as an image block. Anything else fails
 * mid-turn with a 400, so it gets dropped here instead — the deck is
 * reachable from the phone over the LAN, and this is the trust boundary.
 */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_IMAGES = 10
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * Text attachments: the markdown note, the spec, the log you want read.
 *
 * There is no block type for these on this path — a `document` block takes a
 * PDF, and the file itself is on the machine holding the browser, which on a
 * phone is not the machine the session runs on, so "just Read the path" is
 * not available either. So the text travels inline, inside a tag: it is what
 * marks where the file ends and what you actually asked begins, and it is
 * what lets the panel show `[spec.md]` instead of the whole file pasted back
 * at you.
 */
const MAX_DOCS = 10
const MAX_DOC_BYTES = 256 * 1024
const MAX_DOCS_BYTES = 512 * 1024
const MAX_DOC_NAME = 120

/** A name safe to sit inside the tag's quotes, or a usable stand-in. */
function docName(value) {
  const clean = String(value || '').replace(/[\r\n"<>]/g, '').trim().slice(0, MAX_DOC_NAME)
  return clean || 'attachment'
}

/**
 * Build the content of a user message.
 *
 * With nothing attached this returns the plain string it has always returned,
 * so the common path stays byte-identical. Attachments turn it into a block
 * array, and they go first: Claude reads an instruction better when what it
 * refers to is already in front of it.
 */
export function buildContent(text, images = [], docs = []) {
  const blocks = []
  for (const image of Array.isArray(images) ? images.slice(0, MAX_IMAGES) : []) {
    const mediaType = image?.media_type
    const data = image?.data
    if (!IMAGE_TYPES.has(mediaType) || typeof data !== 'string' || !data) continue
    // base64 carries 4 characters per 3 bytes; this is the size the API sees.
    if (Math.floor(data.length * 0.75) > MAX_IMAGE_BYTES) continue
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })
  }

  let spent = 0
  for (const doc of Array.isArray(docs) ? docs.slice(0, MAX_DOCS) : []) {
    const raw = typeof doc?.text === 'string' ? doc.text : ''
    if (!raw.trim()) continue
    const size = Buffer.byteLength(raw, 'utf8')
    // The deck is reachable over the LAN, so the browser's own limits are a
    // courtesy, not a guarantee. These are the ones that hold.
    if (size > MAX_DOC_BYTES || spent + size > MAX_DOCS_BYTES) continue
    spent += size
    // A file that contains the closing tag would otherwise appear to end
    // early, and everything after it would read as your own words.
    const body = raw.replace(/<\/attached-file>/g, '<\\/attached-file>')
    blocks.push({
      type: 'text',
      text: `<attached-file name="${docName(doc?.name)}">\n${body}\n</attached-file>`,
    })
  }

  const body = typeof text === 'string' ? text.trim() : ''
  if (!blocks.length) return body
  // An empty text block is a 400, so only append one when it says something.
  if (body) blocks.push({ type: 'text', text: body })
  return blocks
}

/**
 * Build the sentence shown on the permission card.
 *
 * The SDK documents an `opts.title` with the full rendered prompt, but it
 * arrives undefined on this path, so we never rely on it: displayName and
 * description are what actually show up, and the tool input is the fallback.
 */
export function describePermission(toolName, input, opts = {}) {
  if (opts.title) return { title: opts.title, detail: opts.description || '' }

  const action = opts.displayName || toolName
  if (opts.description) return { title: action, detail: opts.description }

  const i = input || {}
  if (typeof i.command === 'string') return { title: action, detail: i.command }
  if (typeof i.file_path === 'string') return { title: action, detail: i.file_path }
  if (typeof i.pattern === 'string') return { title: action, detail: i.pattern }
  if (typeof i.url === 'string') return { title: action, detail: i.url }
  return { title: action, detail: '' }
}

/**
 * The tools "auto-accept edits" is about: the ones that change a file and
 * nothing else. Bash is deliberately not here — a command can do anything a
 * command can do, which is the whole distinction that mode is drawing.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Whether the mode a session is in already answers this call.
 *
 * Nothing read the mode here until now, so every tool call was parked and
 * answered by hand whatever you had chosen: the chip said "Never ask" and the
 * deck asked anyway. This is what makes those labels mean what they say.
 *
 * A question is never auto-answered, in any mode. AskUserQuestion arrives
 * through this same hook only because it is the one channel a headless session
 * has for collecting an answer, and the answer is content only you have —
 * letting it through would hand the model a blank where it asked something,
 * which reads as an answer and is not one.
 */
export function autoAllowed(permissionMode, toolName, isQuestion) {
  if (isQuestion) return false
  if (permissionMode === 'bypassPermissions') return true
  if (permissionMode === 'acceptEdits') return EDIT_TOOLS.has(toolName)
  return false
}

/**
 * A question is not a permission.
 *
 * AskUserQuestion is the model asking you something, and it reaches us through
 * canUseTool only because that is the single hook a headless session has for
 * collecting an answer. Its own input carries the options, and the SDK expects
 * the choice written back into an `answers` map keyed by the question text —
 * the field is documented in sdk-tools.d.ts as "User answers collected by the
 * permission component", which is exactly what this panel now is.
 *
 * Everything else has no questions and keeps the old allow/deny card.
 */
const MAX_TEXT = 2000

export function questionsFrom(toolName, input) {
  if (toolName !== 'AskUserQuestion') return null
  const raw = input?.questions
  if (!Array.isArray(raw) || !raw.length) return null

  const clean = []
  for (const q of raw) {
    if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) continue
    const options = q.options
      .filter((o) => o && typeof o.label === 'string' && o.label)
      .map((o) => ({
        label: o.label,
        description: typeof o.description === 'string' ? o.description : '',
        // Previews are ASCII diagrams and can run long; the card is not the
        // place to render a whole file.
        preview: typeof o.preview === 'string' ? o.preview.slice(0, MAX_TEXT) : null,
      }))
    if (options.length < 2) continue
    clean.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: Boolean(q.multiSelect),
      options,
    })
  }
  return clean.length ? clean : null
}

/**
 * `start` is the SDK's query(), and it is a parameter only so a test can hand
 * in something that does not spawn a CLI. The permission queue below is worth
 * a test: it is the difference between answering a prompt and losing an hour
 * of work to a session that will never move again.
 */
export function createAgentManager({ start = query } = {}) {
  const emitter = new EventEmitter()
  /** deckId -> managed session */
  const sessions = new Map()

  function publish(session) {
    emitter.emit('changed', toPublic(session))
  }

  /**
   * The ask you are being shown, out of everything parked right now.
   *
   * There can be more than one. Claude issues tool calls in parallel, and the
   * SDK asks about each of them independently — it does not wait for the
   * previous answer before asking the next question. They are shown oldest
   * first, which is the order they blocked the session in.
   */
  function head(s) {
    return s.pending.values().next().value || null
  }

  /**
   * Settle the status after one ask leaves the queue: still waiting if more
   * are parked behind it, back to working if that was the last one. Always
   * publishes, because the count changed even when the status did not.
   */
  function settle(session) {
    const next = session.pending.size ? 'waiting' : 'working'
    if (session.status === next) publish(session)
    else setStatus(session, next)
  }

  function toPublic(s) {
    const pending = head(s)
    return {
      deckId: s.deckId,
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      /*
       * The address, beside the label. They are different strings on purpose
       * and the panel shows both: the label is what you renamed it to a
       * minute ago, the address is what another session has to type, and it
       * was fixed when the process started. Null on a launch with no label,
       * where the CLI's derived name is the address instead.
       */
      peerName: s.peerName || null,
      status: s.status,
      permissionMode: s.permissionMode,
      modeNote: s.modeNote || null,
      error: s.error || null,
      startedAt: s.startedAt,
      managed: true,
      // Carried so a restart can put the session back under the same model it
      // was running, rather than silently dropping it to the default.
      model: s.model || null,
      /*
       * What was asked for, beside what was granted, so the panel can say so
       * when they differ. Both are null on a session nobody has chosen for:
       * it is running whatever the CLI's default is, and inventing a name for
       * that would be claiming a choice that was never made.
       */
      requestedModel: s.requestedModel || null,
      // null = this session sends no effort at all. undefined = this CLI does
      // not publish the field, so the panel shows nothing instead of guessing.
      effort: s.effortKnown ? s.effort ?? null : undefined,
      requestedEffort: s.requestedEffort || null,
      /*
       * No process behind it, but a conversation on disk that can get one.
       * The panel branches on this to offer a composer that says "resume"
       * instead of hiding it the way it does for a session that is over.
       */
      detached: s.status === 'detached',
      pending: pending
        ? {
            requestId: pending.requestId,
            toolName: pending.toolName,
            title: pending.title,
            detail: pending.detail,
            defaultToNo: Boolean(pending.defaultToNo),
            canAlwaysAllow: pending.canAlwaysAllow,
            askedAt: pending.askedAt,
            // Present only for AskUserQuestion. The browser branches on it to
            // draw buttons instead of allow/deny, so it is the one field that
            // decides which card you get.
            questions: pending.questions || null,
          }
        : null,
      // How many are parked in total, so the panel can say that answering this
      // one brings up another instead of appearing to finish the job.
      pendingCount: s.pending.size,
    }
  }

  function setStatus(session, status) {
    if (session.status === status) return
    session.status = status
    publish(session)
  }

  /**
   * Hold a session in memory before anything is running behind it.
   *
   * `title` is the label: what you call this session in the deck, and for a
   * long time the only thing a name here meant. It was deliberately kept out
   * of the SDK so it never competed with the name Claude Code derives on
   * disk, leaving `/rename` and `claude -n` as the way to change that one.
   *
   * `peerName` revisits exactly that decision, because what the on-disk name
   * is for has changed. It used to be a label too — now it is an address:
   * the string another session types into SendMessage to reach this one, and
   * the only part of a session's identity that crosses the gap between two
   * processes. Derived from the working directory alone it answers "which
   * project" and nothing else, which is how one repository ends up holding
   * three sessions called `-5f`, `-15` and `-be`. So the deck names what it
   * launches, and only what you labelled: see `peerName` in roster.js.
   *
   * It is fixed for the life of the process. Renaming a session in the deck
   * afterwards moves the label and not the address, because the address went
   * out as a flag at spawn — the panel must not imply otherwise.
   */
  function register({ deckId, cwd, title, derivedTitle, peerName = null, permissionMode, model, status, sessionId = null, startedAt = null }) {
    const session = {
      deckId,
      sessionId,
      cwd,
      peerName,
      derivedTitle,
      title,
      status,
      permissionMode,
      requestedMode: permissionMode,
      model: model || null,
      modeNote: null,
      startedAt: startedAt || Date.now(),
      /*
       * requestId -> parked ask. A Map and not a single slot: the SDK has
       * several permission requests in flight whenever Claude calls tools in
       * parallel, and holding only the newest one dropped the older promise on
       * the floor — its tool never returned, the turn never ended, and every
       * message typed afterwards queued up behind a session that was never
       * going to move again.
       */
      pending: new Map(),
      input: null,
      query: null,
      error: null,
    }
    sessions.set(deckId, session)
    return session
  }

  /**
   * Put a process behind a session and start reading from it.
   *
   * Shared by the two ways a session comes to life — started from scratch, or
   * resumed from a conversation already on disk — because from here down they
   * are the same thing: the only difference is the `resume` option, and that
   * one line is what makes a restart survivable.
   *
   * The input stream is built here rather than at registration because a
   * session can be spawned more than once over its life. Suspending closes the
   * old stream, and a closed stream is permanently closed — reusing it would
   * hand the SDK a prompt iterable that ends immediately, which reads to the
   * CLI as "this conversation is over".
   */
  function spawn(session, firstContent) {
    const input = createInputStream()
    session.input = input
    if (firstContent) input.push(firstContent)

    // The SDK refuses to bypass permissions unless this is set explicitly.
    // It is a second, deliberate step on purpose, and passing it silently
    // for every launch would throw that safeguard away.
    const bypassing = session.permissionMode === 'bypassPermissions'

    const q = start({
      prompt: input,
      options: {
        cwd: session.cwd,
        permissionMode: session.permissionMode,
        /*
         * Resuming keeps the session id, so the transcript the panel is
         * already streaming carries on in the same file rather than forking
         * into a second one. `forkSession` stays off for exactly that reason:
         * this is the same conversation continuing, not a copy of it.
         */
        ...(session.sessionId ? { resume: session.sessionId } : {}),
        /*
         * The address other sessions reach this one by, as `claude --name`
         * would set it. There is no SDK option for it — `title` is the
         * transcript's title, a different field — so it goes through the
         * documented escape hatch for CLI flags.
         *
         * Sent on every spawn and not only the first: waking a resumed
         * session starts a new process, and a process that came back without
         * its name would be addressable under one name before the deck
         * restarted and another after. Unlabelled sessions pass nothing and
         * keep the name the CLI derives for them.
         */
        ...(session.peerName ? { extraArgs: { name: session.peerName } } : {}),
        ...(bypassing ? { allowDangerouslySkipPermissions: true } : {}),
        ...(session.model ? { model: session.model } : {}),
        // Load the same CLAUDE.md and permission rules a normal session sees,
        // so what auto-allows here matches what auto-allows in the terminal.
        settingSources: ['user', 'project', 'local'],
        canUseTool: (toolName, toolInput, opts) => park(session, toolName, toolInput, opts),
      },
    })
    session.query = q
    session.suspending = false
    /*
     * Woken with nothing to say, a session is not working on anything — it is
     * a process standing by, which is what 'idle' means here. Calling it
     * 'working' would put a blue dot and a "working" label on a session that
     * is doing nothing, and the deck's whole job is that those labels are
     * true.
     */
    session.status = firstContent ? 'working' : 'idle'

    consume(session, q)
    publish(session)
    return session
  }

  function launch({ cwd, prompt, name, permissionMode = 'default', model, taken = [], peers = [] }) {
    if (!cwd) throw new Error('cwd is required')
    if (!prompt || !prompt.trim()) throw new Error('prompt is required')

    // Kept past launch so clearing the name can put this back, rather than
    // leaving the session with no label at all.
    //
    // Derived from what you typed and not from what is sent, which are no
    // longer the same string: the roster goes in front of the prompt, so a
    // title taken afterwards would name every introduced session after the
    // first line of the briefing instead of after its own task.
    const derivedTitle = cleanTitle(prompt)

    const session = register({
      deckId: randomUUID().slice(0, 8),
      cwd,
      derivedTitle,
      title: cleanTitle(name) || derivedTitle,
      /*
       * Composed from the label and not from the first prompt. A prompt makes
       * a fine title and a terrible address: it is long, it is a sentence,
       * and the session that has to type it back has only ever seen it
       * through a listing that truncates.
       */
      peerName: composePeerName(cwd, name, taken),
      permissionMode,
      model,
      status: 'working',
    })

    spawn(session, withRoster(prompt, peers))
    return toPublic(session)
  }

  /**
   * Take charge of a conversation that already exists on disk.
   *
   * This is the other door into the panel, and it closes the oldest gap in the
   * deck: a session it did not launch — or launched before the last restart —
   * was readable and nothing else. Resuming by session id makes it drivable
   * again, with its full context, under the same id it always had.
   *
   * Nothing is started here. The CLI is not spawned until there is something
   * to say to it, for two reasons: resuming reloads the entire conversation
   * into context, which is not a thing to spend on a panel entry nobody has
   * clicked; and the SDK does not surface a resumed session at all until the
   * first message arrives, so a process started early would sit there proving
   * nothing while it burned a slot.
   */
  function adopt({ sessionId, cwd, name, permissionMode = 'default', model, deckId, startedAt }) {
    if (!sessionId) return { ok: false, error: 'sessionId is required' }
    if (!cwd) return { ok: false, error: 'cwd is required' }

    // Already on screen: adopting it twice would give one conversation two
    // panel entries, each able to spawn its own process against the same
    // transcript.
    for (const s of sessions.values()) {
      if (s.sessionId === sessionId && s.status !== 'done' && s.status !== 'error') {
        return { ok: true, deckId: s.deckId, already: true }
      }
    }

    const title = cleanTitle(name)
    const session = register({
      deckId: deckId || randomUUID().slice(0, 8),
      cwd,
      sessionId,
      derivedTitle: title,
      title,
      permissionMode,
      model,
      status: 'detached',
      startedAt,
    })
    publish(session)
    return { ok: true, deckId: session.deckId }
  }

  /**
   * Hold the tool call until somebody answers in the UI — unless the mode this
   * session is in has already answered it.
   *
   * Once parked, the promise is deliberately never auto-resolved on a timer:
   * the SDK warns that a missing answer blocks the tool forever, and silently
   * allowing or denying on a timeout would be worse than waiting. It only
   * settles on a human answer, on abort, or when the session is stopped.
   */
  function park(session, toolName, toolInput, opts) {
    const questions = questionsFrom(toolName, toolInput)

    /*
     * The mode answers first. Read at the moment of the call and not at launch,
     * because changing the mode mid-task is the point of being able to change
     * it: a call arriving after you switched to "Never ask" is answered by the
     * mode you are in now, not the one the session started in.
     */
    if (autoAllowed(session.permissionMode, toolName, Boolean(questions))) {
      return Promise.resolve({ behavior: 'allow' })
    }

    const { title, detail } = describePermission(toolName, toolInput, opts)

    return new Promise((resolve) => {
      // Every parked ask needs an id of its own: it is what the browser hands
      // back when you answer, and what keeps two of them from being mistaken
      // for each other. Never let it be undefined — that is one bucket, and
      // two asks in one bucket is the bug this Map exists to prevent.
      const requestId = opts.requestId || opts.toolUseID || randomUUID()

      const pending = {
        requestId,
        toolUseID: opts.toolUseID,
        toolName,
        title,
        detail,
        questions,
        // Kept whole because answering means handing this same input back with
        // `answers` filled in, not rebuilding it from the parts we show.
        input: toolInput,
        defaultToNo: opts.defaultToNo,
        // Some asks must not offer "always allow": the rule they would write
        // grants more than the action being asked about.
        canAlwaysAllow: Boolean(opts.suggestions?.length) && !opts.suppressAlwaysAllowRule,
        suggestions: opts.suggestions || [],
        askedAt: Date.now(),
        resolve,
      }

      /*
       * This signal is per request, not per session: the CLI cancels an
       * individual ask whenever it stops wanting the answer, and it goes on
       * running afterwards. Ending the whole session here — which is what
       * status 'done' meant — greyed out the composer and hid the Kill button
       * on a session that was still very much alive. Fail closed on the one
       * ask, and let the queue decide what the session is now.
       */
      opts.signal?.addEventListener('abort', () => {
        if (session.pending.get(requestId) !== pending) return
        session.pending.delete(requestId)
        resolve({ behavior: 'deny', message: 'The request was cancelled' })
        settle(session)
      }, { once: true })

      session.pending.set(requestId, pending)
      setStatus(session, 'waiting')
      publish(session)
      emitter.emit('permission', { ...toPublic(session) })
    })
  }

  /** Answer a parked permission: 'allow', 'always', or 'deny'. */
  function respond(deckId, requestId, decision) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }

    // Answer the one you were shown. Without an id — an older client, or a
    // card rendered before ids existed — the oldest is the one on screen.
    const pending = requestId ? session.pending.get(requestId) : head(session)
    if (!pending) {
      return {
        ok: false,
        error: session.pending.size ? 'stale request' : 'no pending permission',
      }
    }
    /*
     * Allowing a question is not answering it. AskUserQuestion let through
     * with no `answers` would come back to the model as a blank where it
     * asked something, which reads as an answer and is not one. Declining is
     * still meaningful — "do not ask me this" — so only the yes paths are
     * refused here.
     */
    if (pending.questions && decision !== 'deny') {
      return { ok: false, error: 'this is a question: answer it with a choice' }
    }

    session.pending.delete(pending.requestId)
    settle(session)

    if (decision === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'Denied from the deck' })
    } else if (decision === 'always' && pending.canAlwaysAllow) {
      pending.resolve({ behavior: 'allow', updatedPermissions: pending.suggestions })
    } else {
      pending.resolve({ behavior: 'allow' })
    }
    return { ok: true }
  }

  /**
   * Answer a parked AskUserQuestion from the panel.
   *
   * `answers` maps question text to the chosen label. Every question the tool
   * asked must appear: a partial map leaves the model reading silence where it
   * asked something, and it cannot tell that apart from an answer.
   *
   * The values are deliberately not restricted to the offered labels. The tool
   * always grants you an "Other" escape, and typing your own answer is the
   * point of having one. The keys are restricted, because a key matching no
   * question answers nothing while looking like it did.
   */
  function answerQuestion(deckId, requestId, answers) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }

    const pending = requestId ? session.pending.get(requestId) : head(session)
    if (!pending) {
      return {
        ok: false,
        error: session.pending.size ? 'stale request' : 'no pending question',
      }
    }
    if (!pending.questions) return { ok: false, error: 'this prompt is not a question' }
    if (!answers || typeof answers !== 'object') return { ok: false, error: 'no answers' }

    const filled = {}
    for (const q of pending.questions) {
      const value = answers[q.question]
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, error: `"${q.header || q.question}" is unanswered` }
      }
      filled[q.question] = value.trim().slice(0, MAX_TEXT)
    }

    session.pending.delete(pending.requestId)
    settle(session)
    pending.resolve({
      behavior: 'allow',
      updatedInput: { ...pending.input, answers: filled },
    })
    return { ok: true }
  }

  /** Send a follow-up message to a running session. */
  function say(deckId, text, images = [], docs = []) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }
    if (session.status === 'done' || session.status === 'error') {
      return { ok: false, error: 'session has finished' }
    }
    const content = buildContent(text, images, docs)
    // Works for both shapes: '' and [] are the same "nothing to say" here.
    if (!content.length) return { ok: false, error: 'nothing to send' }

    /*
     * A detached session has no process and no input stream — typing at it is
     * what brings it back. Spawning with the message as its first content is
     * not an optimisation: the SDK holds a resumed session silent until
     * something is said to it, so starting the process and then pushing would
     * park the message behind a CLI that is waiting for that very message.
     */
    if (!session.query) {
      spawn(session, content)
      return { ok: true, queued: false, resumed: true }
    }

    session.input.push(content)

    /*
     * A session parked on a permission has not started working again just
     * because you typed at it. The message sits in the queue until the ask is
     * answered, and calling that 'working' is how the deck lost the one signal
     * it exists to give you: the project stopped counting as waiting, dropped
     * out of the top of the sidebar, and the session looked busy while it was
     * in fact blocked on you.
     *
     * `queued` travels back so the composer can say where the message went.
     * Nothing you send appears in the panel until the CLI reads it and writes
     * it to the transcript — so a message parked behind an ask simply vanishes
     * unless something says so.
     */
    const queued = session.pending.size > 0
    if (!queued) setStatus(session, 'working')
    return { ok: true, queued }
  }

  /**
   * Put the process back behind a session without saying anything to it.
   *
   * Restarting the deck leaves its sessions resumable: the conversation is on
   * disk and the deck knows how to reopen it, but nothing is running. Until
   * now the only way back was to type at it — which works, and which is the
   * wrong shape when what you want is the session ready rather than the
   * session answering. You had to think of something to say in order to be
   * able to say nothing.
   *
   * It is the same spawn a message would have done, minus the message. The
   * SDK holds a resumed session silent until it is spoken to, so this starts
   * the CLI, reopens the conversation under the same id, and stops there.
   * Waking costs a process and no tokens; nothing is sent, so nothing is
   * charged, and the session sits at idle until you or a schedule gives it
   * something to do.
   *
   * What it buys beyond being ready: the session's `init` arrives, which is
   * where the deck learns the model and the granted permission mode, and the
   * context meter has something to ask.
   */
  function wake(deckId) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }
    if (session.status === 'done' || session.status === 'error') {
      return { ok: false, error: 'session has finished' }
    }
    // Already awake. Not an error: it is the outcome that was wanted, and two
    // panels racing the same button should not produce a failure in one.
    if (session.query) return { ok: true, already: true }

    try {
      spawn(session)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err?.message || 'Could not wake this session' }
    }
  }

  /**
   * Relabel a running session.
   *
   * Only the deck's own label moves. Nothing is written to disk and nothing is
   * said to the session itself, so this is safe to do while it is mid-task and
   * cannot collide with what Claude Code calls the session in its own terminal.
   *
   * An empty name is not an error — it is how you undo one, and it restores the
   * first line of the task the session started from.
   */
  function rename(deckId, name) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }

    const next = cleanTitle(name) || session.derivedTitle
    if (next === session.title) return { ok: true, title: next }

    session.title = next
    publish(session)
    return { ok: true, title: next }
  }

  /**
   * Change a running session's permission mode.
   *
   * Only available in streaming input mode, which is how every deck session
   * runs — so "stop asking me" works mid-task without restarting the work.
   */
  async function setMode(deckId, mode) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }

    /*
     * Nothing is running yet, so there is nothing to tell. Recording it is
     * still the right answer rather than an error: this is the mode the
     * session will be resumed under, and choosing it before waking a session
     * is the sensible order to do it in — you decide how much it may do before
     * you let it start doing it.
     */
    if (!session.query) {
      session.permissionMode = mode
      session.requestedMode = mode
      session.modeNote = null
      publish(session)
      return { ok: true, permissionMode: mode }
    }

    try {
      await session.query.setPermissionMode(mode)
      session.permissionMode = mode
      session.requestedMode = mode
      session.modeNote = null
      publish(session)
      return { ok: true, permissionMode: mode }
    } catch (err) {
      return { ok: false, error: err?.message || 'Could not change the mode' }
    }
  }

  /**
   * The models this session can actually be switched to.
   *
   * Asked of the session rather than written down here. The SDK answers with
   * a display name, a description and — the part that matters — which effort
   * levels each model supports, so the panel can offer a list that is true of
   * the CLI you are running instead of one that was true when this file was
   * written. A hand-kept list of model names is wrong the day a model ships.
   */
  async function models(deckId) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }
    if (!session.query) return { ok: true, models: [] }

    try {
      const list = await withTimeout(session.query.supportedModels(), 5000)
      return {
        ok: true,
        models: (list || []).map((m) => ({
          value: m.value,
          resolvedModel: m.resolvedModel || null,
          displayName: m.displayName || m.value,
          description: m.description || '',
          supportsEffort: m.supportsEffort !== false && Boolean(m.supportedEffortLevels?.length),
          effortLevels: m.supportedEffortLevels || [],
        })),
      }
    } catch (err) {
      return { ok: false, error: err?.message || 'Could not read the model list' }
    }
  }

  /**
   * Change the model mid-conversation.
   *
   * Nothing is thrown away: the next turn runs on the new model and the one
   * already in flight finishes on the old one. What comes back here is only
   * whether the instruction was accepted — the model the session ends up
   * actually sending arrives on the next `init`, which is where every other
   * granted value in this file comes from too.
   */
  async function setModel(deckId, model) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }

    // Not running yet. Recording it is the right answer rather than an error,
    // the same as choosing a permission mode before waking a session: this is
    // the model it will come back under.
    if (!session.query) {
      session.model = model || null
      session.requestedModel = model || null
      publish(session)
      return { ok: true, model: model || null }
    }

    try {
      await session.query.setModel(model || undefined)
      session.requestedModel = model || null
      publish(session)
      return { ok: true, model: model || null }
    } catch (err) {
      return { ok: false, error: err?.message || 'Could not change the model' }
    }
  }

  /**
   * How hard the model should think, from here on.
   *
   * `applyFlagSettings` is the session-scoped layer — it changes this run
   * without writing anything into your settings files, which is the right
   * scope for a control that sits in a session's header. `null` clears it
   * back to the model's own default rather than picking a level on your
   * behalf.
   *
   * What you asked for is not necessarily what runs: `max` is session-only
   * and falls back to `high` on a model without it, and an organisation can
   * cap the level. That is why nothing here writes `session.effort` — the
   * granted level comes back on the next `init` and only that one is shown.
   */
  async function setEffort(deckId, level) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }
    if (!session.query) return { ok: false, error: 'this session is not running' }

    try {
      await session.query.applyFlagSettings({ effortLevel: level || null })
      session.requestedEffort = level || null
      publish(session)
      return { ok: true, effort: level || null }
    } catch (err) {
      return { ok: false, error: err?.message || 'Could not change the effort' }
    }
  }

  /**
   * How full this session's context window is.
   *
   * `detail: 'summary'` rather than `'full'`: the full breakdown counts every
   * category through the token-count API, which is a network round trip per
   * category. That is a price worth paying for a `/context` report somebody
   * asked for, and not for a bar in a header. The summary answers from the
   * last response's usage and local estimates, and costs nothing.
   *
   * Only the deck's own sessions can answer. One running in a terminal is
   * observed through the registry, not driven — there is no query handle to
   * ask, and an estimate dressed up as a reading would be worse than no bar.
   */
  async function contextUsage(deckId) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }

    /*
     * Suspended, or not yet woken. That is a real state rather than a failure,
     * so it answers with no reading: a zero here would draw an empty bar and
     * read as a session with all its context still ahead of it.
     */
    if (!session.query) return { ok: true, usage: null }

    try {
      const report = await withTimeout(session.query.getContextUsage({ detail: 'summary' }), 5000)
      // withTimeout resolves undefined rather than rejecting when it wins.
      if (!report) return { ok: false, error: 'the session did not answer in time' }
      return { ok: true, usage: shapeContextUsage(report) }
    } catch (err) {
      return { ok: false, error: err?.message || 'Could not read the context usage' }
    }
  }

  /**
   * Never let a wedged CLI hold the teardown hostage.
   *
   * Both control requests below wait on a reply from the subprocess, which is
   * exactly the thing we are stopping because it stopped behaving. A kill that
   * can hang is not a kill.
   */
  function withTimeout(promise, ms) {
    let timer
    const guard = new Promise((resolve) => { timer = setTimeout(resolve, ms) })
    // Cleared once the race is over: an armed timer keeps Node's event loop
    // alive, so without this every kill held the process open for the full
    // grace period it did not need.
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
  }

  /**
   * Stop the turn in flight, leaving the session open to talk to.
   *
   * Parked asks are answered first, for the same reason stop() does it: a
   * session frozen inside canUseTool is not running a turn, so the interrupt
   * lands on nothing and the panel goes on claiming 'idle' while the session
   * is still blocked. Denying is the honest reading of "stop what you are
   * doing" — you are not approving anything by interrupting it.
   */
  async function interrupt(deckId) {
    const session = sessions.get(deckId)
    if (!session?.query) return { ok: false, error: 'unknown session' }

    const denied = session.pending.size
    for (const [id, pending] of session.pending) {
      session.pending.delete(id)
      pending.resolve({ behavior: 'deny', message: 'Interrupted from the deck' })
    }

    try {
      await session.query.interrupt()
      const was = session.status
      setStatus(session, 'idle')
      // setStatus is silent when the status did not move, and the queue
      // emptying is news of its own.
      if (denied && was === 'idle') publish(session)
      return { ok: true, denied }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  /**
   * End a session for good, and take its process with it.
   *
   * Closing the input stream alone is not a kill: it only says "no more
   * messages are coming", so the CLI keeps working through whatever it was
   * already doing — still editing files, still spending tokens — while the
   * panel claims it is done. Stopping means the work actually stops.
   *
   * The order matters:
   *   1. Answer any parked permission. A session frozen inside canUseTool
   *      ignores an interrupt, because it is not running a turn to interrupt.
   *   2. Interrupt the turn in flight, so the CLI stops at a boundary it
   *      chose rather than having the floor pulled out mid-tool-call.
   *   3. return() the query: the SDK's own cleanup closes the transport,
   *      which ends the subprocess, and waits for it to exit.
   *
   * Idempotent, because the button is reachable twice before the first call
   * has finished tearing anything down.
   */
  async function stop(deckId) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }
    if (session.stopping) return { ok: true }
    session.stopping = true

    // Detached: there is no process to end, so ending it is bookkeeping. This
    // is also the only way to say "I am finished with this one" about a
    // resumable session, which is what keeps it out of the next handoff.
    if (!session.query) {
      setStatus(session, 'done')
      return { ok: true }
    }

    // Every one of them, not just the one on screen: an ask left unanswered
    // is a promise the CLI is still waiting on, and it would hold the
    // teardown open behind a tool call that can never return.
    for (const [id, pending] of session.pending) {
      session.pending.delete(id)
      pending.resolve({ behavior: 'deny', message: 'Session stopped' })
    }

    try { await withTimeout(session.query?.interrupt(), 3000) } catch {}

    session.input?.close()
    // consume() is parked in for-await on this same generator; return() is
    // queued behind that pending next(), and the transport closing is what
    // lets the pending read finish. Both paths end at status 'done'.
    try { await withTimeout(session.query?.return(undefined), 5000) } catch {}

    setStatus(session, 'done')
    return { ok: true }
  }

  /**
   * Wait for a session to stop working, for at most `ms`.
   *
   * "Working" is the only status it is genuinely rude to cut off: the CLI is
   * mid-turn, possibly mid-tool-call, and the tail of that turn is the part
   * that never makes it to the transcript. Every other status is already a
   * resting point.
   */
  function turnBoundary(session, ms) {
    if (session.status !== 'working') return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        emitter.off('changed', onChange)
        resolve()
      }
      const onChange = (view) => {
        if (view.deckId === session.deckId && view.status !== 'working') finish()
      }
      const timer = setTimeout(finish, ms)
      emitter.on('changed', onChange)
    })
  }

  /**
   * Let go of a session without ending it.
   *
   * This is what the deck does to its sessions on the way out, and the whole
   * difference between it and stop() is what it leaves behind: stop() means
   * the work is over, suspend() means the process is going away and the
   * conversation is not. The session stays in the list as `detached`, which is
   * what gets written to the handoff file and what comes back on screen after
   * the restart.
   *
   * The grace period is spent waiting for a turn to end on its own, because a
   * turn cut mid-tool-call loses whatever it had not yet written down. Only
   * when that runs out do we interrupt — and an interrupt is still the polite
   * version, since the CLI picks the boundary rather than having the transport
   * pulled out from under it.
   */
  async function suspend(deckId, { grace = 20000 } = {}) {
    const session = sessions.get(deckId)
    if (!session) return { ok: false, error: 'unknown session' }
    if (session.stopping || session.suspending) return { ok: true }
    if (!session.query) return { ok: true, already: true }
    session.suspending = true

    if (session.status === 'working') {
      await turnBoundary(session, grace)
      if (session.status === 'working') {
        try { await withTimeout(session.query.interrupt(), 3000) } catch {}
        // A short second wait: the interrupt lands at the next boundary, and
        // the message that records it is worth having on disk before we go.
        await turnBoundary(session, 3000)
      }
    }

    /*
     * Parked asks have to be answered or the teardown hangs behind a tool call
     * that can never return. Denying is the honest answer — the deck is going
     * away and cannot carry an approval across the restart — and it says so,
     * because that sentence is what the session reads in its own transcript
     * when you resume it and wonder what happened.
     */
    for (const [id, pending] of session.pending) {
      session.pending.delete(id)
      pending.resolve({ behavior: 'deny', message: 'The deck is restarting; this can be resumed' })
    }

    session.input?.close()
    try { await withTimeout(session.query.return(undefined), 5000) } catch {}

    session.query = null
    session.input = null
    setStatus(session, 'detached')
    return { ok: true }
  }

  /**
   * Suspend everything, in parallel, under one shared deadline.
   *
   * Shared and not per-session on purpose: five sessions each given twenty
   * seconds must not add up to a restart that takes a minute and a half. They
   * all get the same wall clock, and whatever has not settled by the end is
   * interrupted rather than waited on.
   */
  function suspendAll({ grace = 20000 } = {}) {
    return Promise.all([...sessions.keys()].map((deckId) => suspend(deckId, { grace })))
  }

  /** How many sessions are mid-turn right now — what a restart would cut off. */
  function busyCount() {
    return [...sessions.values()].filter((s) => s.status === 'working').length
  }

  /** Drain the SDK message stream, tracking status and the session id. */
  async function consume(session, q) {
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          session.sessionId = msg.session_id

          // A requested mode is not a granted mode. bypassPermissions in
          // particular is refused outright in some environments and silently
          // comes back as 'default' — showing the request instead of the
          // grant would tell you permissions are off when they are not.
          const granted = msg.permissionMode
          if (granted && granted !== session.requestedMode) {
            session.permissionMode = granted
            session.modeNote =
              `Asked for "${session.requestedMode}", but this environment only allowed ` +
              `"${granted}". Permissions are still being enforced.`
          } else if (granted) {
            session.permissionMode = granted
          }

          /*
           * The model and the effort, as granted — the same distinction the
           * permission mode above has always made, and for the same reason.
           *
           * This message is re-emitted at the start of every turn, so both
           * stay current without asking for them. `model` is what the session
           * will actually send. `effort` is documented as the level it will
           * send next "after env overrides, session state, org caps and
           * model-support downgrades", which is exactly the granted value and
           * not the requested one: ask for `max` on a model without it and
           * this comes back `high`.
           *
           * Absent is not the same as null, and the difference is worth
           * keeping. `null` means the session will send no effort at all —
           * a model that has no such parameter. Absent means this CLI does
           * not publish the field, and the honest thing to show for that is
           * nothing, rather than a level we would be inventing.
           */
          if (msg.model) session.model = msg.model
          if ('effort' in msg) session.effort = msg.effort ?? null
          session.effortKnown = 'effort' in msg || session.effortKnown === true

          publish(session)
        }
        if (msg.type === 'assistant') setStatus(session, 'working')
        if (msg.type === 'result') {
          // The turn ended but the stream stays open for follow-ups.
          setStatus(session, session.pending.size ? 'waiting' : 'idle')
        }
      }
      // A stream that ended because we suspended it is not a session that
      // ended. Calling it 'done' here is what would drop it from the handoff
      // and from the panel, which is precisely the conversation we are going
      // to all this trouble to keep.
      setStatus(session, session.suspending ? 'detached' : 'done')
    } catch (err) {
      // Tearing the transport down under a live read can surface as a throw.
      // A session you killed on purpose is finished, not broken, and showing
      // it as an error would send you looking for a failure that never
      // happened.
      if (session.suspending) {
        setStatus(session, 'detached')
      } else if (session.stopping) {
        setStatus(session, 'done')
      } else {
        session.error = err?.message || String(err)
        setStatus(session, 'error')
      }
    } finally {
      if (session.pending.size) {
        for (const [id, pending] of session.pending) {
          session.pending.delete(id)
          pending.resolve({ behavior: 'deny', message: 'Session ended' })
        }
        publish(session)
      }
    }
  }

  function list() {
    return [...sessions.values()].map(toPublic)
  }

  /** Index by the Claude session id, to merge into the observed registry. */
  function bySessionId() {
    const map = new Map()
    for (const s of sessions.values()) {
      if (s.sessionId) map.set(s.sessionId, toPublic(s))
    }
    return map
  }

  /**
   * Shutting the deck down must not leave its sessions running behind it.
   * Awaited so the caller can hold the process open until the children are
   * actually gone; they are stopped in parallel, since one wedged session
   * should not delay the rest.
   */
  function stopAll() {
    return Promise.all([...sessions.keys()].map((deckId) => stop(deckId)))
  }

  return {
    emitter, launch, adopt, rename, respond, answerQuestion, say, setMode,
    interrupt, stop, stopAll, suspend, suspendAll, busyCount, list, bySessionId,
    contextUsage, models, setModel, setEffort, wake,
  }
}
