/**
 * The sign-in handoff, shared by both settings panels.
 *
 * Kept in one place because the honesty rules matter more than the markup and
 * must not drift apart between the two screens: the panel never performs a
 * login, it opens the real command in a real terminal, and when it cannot do
 * that it says so and shows you the command instead of claiming success.
 */

/** Ask the server to open a terminal. Resolves to what actually happened. */
export async function signIn(payload) {
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return await response.json()
  } catch {
    return { ok: false, error: 'The deck did not answer' }
  }
}

/** Three states, not two: null is "not checked", which is neither pass nor fail. */
export function Dot({ ok }) {
  const kind = ok === true ? 'ok' : ok === false ? 'bad' : 'unknown'
  return <span className={`acct-dot is-${kind}`} aria-hidden="true" />
}

export function SignInNotice({ started, local }) {
  return (
    <>
      {started && (
        <div className={`acct-started ${started.ok ? '' : 'is-bad'}`}>
          {started.ok ? (
            <>
              A terminal is open running <code>{started.command}</code>.{' '}
              {/* A login is a conversation you finish in the terminal; a logout
                  is over by the time you read this. Telling someone to go
                  finish something that already happened sends them looking for
                  a prompt that is not there. */}
              {started.signingOut
                ? 'It needs nothing from you — this page re-checks itself when you come back.'
                : 'Finish there — this page re-checks itself when you come back.'}
            </>
          ) : (
            <>
              Could not open a terminal{started.error ? ` (${started.error})` : ''}. Run this
              yourself: <code>{started.command || 'see the command above'}</code>
            </>
          )}
        </div>
      )}

      {/* Said once, at the top, rather than next to every missing button. */}
      {local === false && (
        <p className="note">
          You are viewing this from another device, so signing in from here would only open a
          terminal you cannot see. Run the commands below on the machine itself.
        </p>
      )}
    </>
  )
}
