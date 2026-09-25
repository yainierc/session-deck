import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

/**
 * Prose.jsx — a message read the way it was written.
 *
 * The panel used to print every message as plain text in a `pre-wrap` box.
 * For a paragraph that is fine. For the thing Claude actually answers a hard
 * question with — a table — it is unreadable: you get the pipes, the
 * `|---|---|` rule, the `**` around the words that were meant to be bold and
 * the backticks around the ones that were meant to be code, and you are left
 * parsing a grid by eye across a wrapped line.
 *
 * So the markdown is rendered. Tables become tables, and the formatting
 * inside their cells comes with them, which matters more than it sounds:
 * the cells are where the identifiers live, and an identifier is exactly
 * what you do not want to read out of a wall of asterisks.
 *
 * ### Why this library, and not an HTML string
 *
 * The text being rendered is model output, and this panel is reachable from
 * the phone on your network. Anything that turned a message into an HTML
 * string and handed it to `innerHTML` would be one prompt away from running
 * script in a page that can launch sessions and answer their permission
 * prompts.
 *
 * react-markdown never builds that string. It renders React elements, and
 * raw HTML inside a message is *escaped and shown*, which is the behaviour
 * worth having for two separate reasons. Verified, not assumed:
 *
 *     'usa <div> y <system-reminder>'  ->  usa &lt;div&gt; y &lt;system-reminder&gt;
 *     'antes <script>alert(1)</script>' ->  antes &lt;script&gt;alert(1)&lt;/script&gt;
 *     '[x](javascript:alert(1))'        ->  <a href="">x</a>
 *
 * The first line is the one that is easy to miss. A renderer that *dropped*
 * raw HTML instead of escaping it would silently eat any message explaining
 * an XML tag — which, in a panel whose whole subject is Claude Code, is most
 * of the interesting ones. Losing a sentence is a worse bug than showing a
 * pipe.
 */

/*
 * GFM is what gets tables, strikethrough and task lists — plain CommonMark
 * has none of them, and tables are the reason this file exists.
 *
 * Breaks is the one that keeps the old behaviour honest. Markdown treats a
 * single newline as a space, so without it every message that laid itself out
 * in short lines would reflow into a paragraph, and the panel would have
 * fixed tables by breaking everything else. A newline the model typed is a
 * newline you see, the same as before.
 */
const PLUGINS = [remarkGfm, remarkBreaks]

const COMPONENTS = {
  /*
   * A wide table does not get to squash itself into a phone. It scrolls
   * sideways inside its own box, which keeps the columns at a width you can
   * read and keeps the message at the width of the conversation.
   */
  table: ({ node, ...props }) => (
    <div className="md-scroll">
      <table {...props} />
    </div>
  ),
  /*
   * A link in a transcript points somewhere else by definition — a PR, a
   * doc, a file on a host. Opening it over the panel would take the
   * conversation off the screen, and `noreferrer` is there because the page
   * it opens has no business knowing it came from a machine on your network.
   */
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
}

export default function Prose({ text, className = '' }) {
  return (
    <div className={`md ${className}`.trim()}>
      {/* An empty string rather than null: react-markdown wants a string
          child, and a message with no text is a real thing — an attachment
          sent on its own, for one. */}
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text || ''}
      </Markdown>
    </div>
  )
}
