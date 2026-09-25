import { useCallback, useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

/**
 * The pairing half of settings.
 *
 * The deck can start sessions and run commands on the machine it sits on, so
 * it does not answer without a key. This is where you hand that key to a
 * second device, and where you take it back.
 *
 * Local-only, and not as a formality: a paired phone may *use* this deck, but
 * showing it the pairing link would let it pair further devices, and a
 * credential that can mint copies of itself is not something to hold on a
 * café network. The server enforces this; the panel just explains it.
 */

/** The link is long and full of base64. Never break it across a copy. */
function Link({ url }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard permission. The link is on screen and selectable, which
      // was always the fallback.
      setCopied(false)
    }
  }

  return (
    <div className="pair-link">
      <code className="pair-url">{url}</code>
      <button className="btn btn-slim" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * The same link, as something a camera can read.
 *
 * The CLI draws one of these too, but only at startup and only into a terminal
 * that has since scrolled past it — which is the whole reason this panel
 * exists. Here it survives.
 *
 * Black on white inside an otherwise dark panel, on purpose. A QR is read by a
 * camera hunting for contrast, and the spec only asks scanners to handle dark
 * modules on a light background; inverting it to match the theme would be
 * trading a code that always scans for one that usually does. The white card
 * is the mandatory quiet zone, made visible rather than fought with.
 */
function Qr({ url }) {
  return (
    <div className="pair-qr">
      <QRCodeSVG
        value={url}
        size={196}
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#000000"
        title="Pairing link for this deck"
      />
    </div>
  )
}

/**
 * The unlock PIN.
 *
 * The QR is the good way in and stays the default: it carries 256 bits nobody
 * can guess. It only fails when there is nobody at this machine to show it —
 * a phone that was wiped, or one that was never paired and you are not here.
 * The PIN is for that, and it is a real trade: six digits are a million
 * guesses against a port that runs commands on this machine, so the server
 * throttles hard and locks out, and this section says so rather than letting
 * the box imply it is free.
 */
function PinSection({ data, onChanged }) {
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  const min = data.pinMin || 6

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/auth/pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      const body = await res.json()
      if (!body.ok) { setMessage(body.error || 'Could not set the PIN'); return }
      setPin('')
      onChanged()
    } catch {
      setMessage('Could not set the PIN')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setMessage(null)
    try {
      await fetch('/api/auth/pin', { method: 'DELETE' })
      onChanged()
    } catch {
      setMessage('Could not remove the PIN')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel-block">
      <h3>
        Unlock PIN
        <span className="group-hint">{data.pin ? 'Set' : 'Off'}</span>
      </h3>

      {data.pin ? (
        <p className="note">
          A device that reaches this deck can type this PIN instead of scanning
          the QR. Typing a new one below replaces it. Revoking the key above
          clears it too — a lost phone knew the PIN as well as the link, so
          leaving it standing would not be much of a revocation.
        </p>
      ) : (
        <p className="note">
          Off. Pairing is by QR or link only, which is the safer default: those
          carry a key nobody can guess. Set a PIN when you need to get in from a
          device you cannot pair from here — one that was wiped, or one in your
          pocket while you are not at this machine.
        </p>
      )}

      <p className="note">
        {min} digits or more. Five wrong tries shut the PIN off for a minute,
        then two, then four — so guessing it is not a thing anyone can sit and
        do. Being locked out never locks <em>you</em> out: the link and the QR
        on this page keep working.
      </p>

      <form className="pin-form" onSubmit={save}>
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          value={pin}
          placeholder={data.pin ? 'New PIN' : `${min}+ digits`}
          aria-label={data.pin ? 'New unlock PIN' : 'Unlock PIN'}
          onChange={(e) => setPin(e.target.value)}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy || !pin}>
          {data.pin ? 'Replace' : 'Set PIN'}
        </button>
        {data.pin && (
          <button className="btn btn-danger" type="button" onClick={remove} disabled={busy}>
            Remove
          </button>
        )}
      </form>

      {message && <p className="note pin-error">{message}</p>}
    </section>
  )
}

export default function Pairing({ tabs }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [rotating, setRotating] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/auth')
      .then(async (r) => ({ status: r.status, body: await r.json() }))
      .then(({ status, body }) => {
        // 403 is the expected answer on a paired phone, not a fault. It gets
        // its own explanation rather than the generic failure line.
        if (status === 403) { setData(null); setError('remote'); return }
        if (body.error) throw new Error(body.error)
        setData(body)
        setError(null)
      })
      .catch(() => setError('unavailable'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function revoke() {
    setRotating(true)
    try {
      const res = await fetch('/api/auth/rotate', { method: 'POST' })
      const body = await res.json()
      if (!body.ok) throw new Error(body.error)
      // Re-read rather than adopting the response. Rotating clears the PIN, so
      // this section is stale the moment it returns — and the rotate endpoint
      // answers in a slightly different shape from /api/auth anyway, which used
      // to blank the QR until the next reload.
      load()
      setConfirming(false)
    } catch {
      setError('unavailable')
    } finally {
      setRotating(false)
    }
  }

  let summary
  if (loading && !data) summary = 'checking...'
  else if (error === 'remote') summary = 'managed on the machine running the deck'
  else if (error) summary = 'unavailable'
  else if (data?.via === 'public') summary = 'reachable at the address you published'
  else if (data?.reachable) summary = 'reachable from your local network'
  else summary = 'reachable from this machine only'

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <h2>Settings</h2>
          {tabs}
          <p className="stage-sub">{summary}</p>
        </div>
      </header>

      <div className="transcript">
        {error === 'remote' && (
          <p className="note">
            The pairing link is only shown on the machine running the deck. This
            device is paired and can use the panel, but it cannot pair others.
          </p>
        )}

        {error === 'unavailable' && <p className="note">Could not read the pairing key.</p>}

        {data && (
          <>
            <section className="panel-block">
              <h3>
                Pair a device
                <span className="group-hint">One link carries the key</span>
              </h3>

              {data.reachable && data.remote ? (
                <>
                  <p className="note">
                    Point your phone's camera at this, or open the link on the
                    other device. Anything that can reach this deck and holds
                    the link can drive every session here, so treat the code
                    like the password it is — a photo of this screen pairs a
                    device just as well as standing in front of it.
                  </p>
                  <Qr url={data.remote} />
                  <Link url={data.remote} />
                </>
              ) : (
                <>
                  <p className="note">
                    Nothing outside this machine can reach the deck, so there is
                    no second device to pair and no QR worth drawing. Two ways to
                    change that.
                  </p>
                  <p className="note">
                    On the same network, open the port and the deck works out its
                    own address.
                    <code>session-deck --host 0.0.0.0</code>
                  </p>
                  <p className="note">
                    That leaves the port open to everything on that network. To
                    reach the deck from your phone anywhere, and without opening
                    the port at all, install{' '}
                    <a
                      className="linkish"
                      href="https://tailscale.com/download"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Tailscale
                    </a>{' '}
                    here and on the phone — it puts your own devices on a private
                    network of their own — then forward this port onto it.
                    <code>tailscale serve 4317</code>
                  </p>
                  <p className="note">
                    Either way the deck cannot tell it is being forwarded, so the
                    last step is naming the address it now answers at. The QR
                    appears once it knows.
                    <code>session-deck --public-url http://your-machine:4317</code>
                  </p>
                </>
              )}
            </section>

            <PinSection data={data} onChanged={load} />

            <section className="panel-block">
              <h3>
                Revoke
                <span className="group-hint">Kick every other device</span>
              </h3>

              {confirming ? (
                <>
                  <p className="note">
                    Every paired device is signed out immediately, including any
                    phone with the panel open. This browser stays signed in, and
                    the old link stops working for good.
                  </p>
                  <div className="project-actions">
                    <button className="btn btn-danger" onClick={revoke} disabled={rotating}>
                      {rotating ? 'Revoking...' : 'Revoke and re-key'}
                    </button>
                    <button className="btn" onClick={() => setConfirming(false)} disabled={rotating}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="note">
                    Use this if a paired device was lost, or if the link was seen by
                    somebody it should not have been.
                  </p>
                  <button className="btn" onClick={() => setConfirming(true)}>
                    Revoke and re-key
                  </button>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  )
}
