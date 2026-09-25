/**
 * One message, in the one shape the deck renders messages in.
 *
 * Shared rather than copied because a subagent's conversation is a
 * conversation: reading it should feel like reading the session it belongs
 * to, not like reading a log of it.
 *
 * The role labels are a parameter for one reason: in a subagent's transcript
 * the first message has role 'user', but you did not write it — the session
 * did. Calling that "you" would be a small lie in the one place the reader
 * has no other way to check.
 */
import { memo } from 'react'
import Prose from './Prose.jsx'

const SESSION_ROLES = { user: 'you', assistant: 'claude', system: 'summary' }

function Message({ message, roles = SESSION_ROLES }) {
  const label = roles[message.role] || SESSION_ROLES[message.role] || message.role
  return (
    <article className={`msg msg-${message.role}`}>
      <div className="msg-role">{label}</div>
      {/* Every role goes through the same renderer, including your own
          messages: you paste tables and code into the box too, and a panel
          that formatted only one side of the conversation would be a panel
          that made you check which side you were reading. */}
      <Prose className="msg-text" text={message.text} />
    </article>
  )
}

/*
 * Memoised, which it did not need to be while a message was a string in a
 * box. Parsing markdown is real work, and a live session appends to the
 * transcript every few hundred milliseconds — without this, every batch of
 * new lines re-parsed all sixty messages on screen to draw the one that
 * changed. The messages already on screen are the same objects from one
 * render to the next, and the role maps are module constants, so a shallow
 * comparison is enough to skip every one of them.
 */
export default memo(Message)
