import { useEffect, useRef, useState } from 'react'

/** The four the Messages API takes. The server rejects anything else anyway. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/**
 * The text files you can attach, by extension.
 *
 * It is an extension list and not a MIME check because the browser is no help
 * here: a .md file arrives with an empty `type` on most systems, which is
 * exactly why the picker would not let you select one — an `accept` of image
 * types only greys out everything else. Extensions in `accept` fix the
 * picker; the same list is what drag, paste and the picker are then filtered
 * against, so all three routes agree on what is attachable.
 *
 * The rule for adding one: it must be something a text editor opens. Anything
 * read as text that is not text arrives as mojibake, and mojibake in a prompt
 * costs context and teaches Claude nothing.
 */
const TEXT_EXTENSIONS = [
  '.md', '.markdown', '.mdx', '.txt', '.text', '.rst', '.org', '.log',
  '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.xml', '.svg', '.html', '.htm', '.css', '.scss',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.graphql', '.prisma',
  '.bicep', '.tf', '.tfvars', '.dockerfile', '.gitignore', '.patch', '.diff',
]

/*
 * A markdown file is mostly prose, so this is far more text than it looks:
 * 256 KB is around sixty thousand tokens of context spent in one attachment.
 * The server enforces the same ceiling — this one only exists so you are told
 * which file was too big, by name, before anything is sent.
 */
const MAX_DOC_BYTES = 256 * 1024
const MAX_DOCS = 10

/*
 * A PDF, which is the one attachment that cannot be read as text.
 *
 * Everything in TEXT_EXTENSIONS arrives inline, inside a tag. A PDF read that
 * way is mojibake, so it travels as its own content block instead — which is
 * also why it is worth saying what it costs: a PDF is read page by page, as
 * pictures as well as words, so the same spec costs far more context than the
 * markdown version of it would. The server enforces the same ceilings; these
 * exist so you are told which file was too big, by name, before it uploads.
 */
const MAX_PDF_BYTES = 10 * 1024 * 1024
const MAX_PDFS = 5

function isPdf(file) {
  if (String(file?.type || '') === 'application/pdf') return true
  // Same reason the text list is extensions: the browser is not reliable about
  // the type on a dropped file, and on some systems it arrives empty.
  return String(file?.name || '').toLowerCase().endsWith('.pdf')
}

function isTextFile(file) {
  const name = String(file?.name || '').toLowerCase()
  const ext = name.slice(name.lastIndexOf('.'))
  if (TEXT_EXTENSIONS.includes(ext)) return true
  // Editor files with no extension at all: Dockerfile, Makefile, LICENSE.
  if (!name.includes('.') && String(file?.type || '').startsWith('text/')) return true
  return false
}

/*
 * Claude downsamples anything longer than this on its long edge, so sending
 * more pixels buys nothing and costs both upload time and context. A
 * full-screen Retina grab is about three times over the line.
 */
const MAX_EDGE = 1568
const MAX_BYTES = 5 * 1024 * 1024

let nextId = 1

/**
 * The file as bare base64, which is what the document block wants.
 *
 * `readAsDataURL` is used rather than `readAsArrayBuffer` + a manual encode
 * because the browser's encoder is the fast path and does not blow the stack
 * on a ten-megabyte file the way `String.fromCharCode(...bytes)` does. The
 * `data:...;base64,` prefix is cut off here; the API wants the payload alone,
 * with no newlines in it, which is what this produces.
 */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.onload = () => {
      const comma = String(reader.result).indexOf(',')
      resolve(comma >= 0 ? String(reader.result).slice(comma + 1) : '')
    }
    reader.readAsDataURL(file)
  })
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('could not read that file'))
    reader.readAsDataURL(file)
  })
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`could not read ${file.name}`))
    reader.readAsText(file)
  })
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('that file is not an image'))
    img.src = src
  })
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/**
 * Turn a pasted, dropped or picked file into an image block.
 *
 * Small images are passed through untouched; the rest are scaled to MAX_EDGE
 * and re-encoded. PNG is tried first because screenshots are mostly text and
 * JPEG smears text edges — JPEG is only the fallback when the PNG comes out
 * too heavy to be worth the fidelity.
 */
async function prepare(file) {
  const dataUrl = await readAsDataUrl(file)
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height))
  const passThrough =
    scale === 1 && file.size <= 1024 * 1024 && IMAGE_TYPES.includes(file.type)

  let mediaType = file.type
  let url = dataUrl

  if (!passThrough) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)

    let blob = await toBlob(canvas, 'image/png')
    mediaType = 'image/png'
    if (!blob || blob.size > 2 * 1024 * 1024) {
      const jpeg = await toBlob(canvas, 'image/jpeg', 0.85)
      if (jpeg) {
        blob = jpeg
        mediaType = 'image/jpeg'
      }
    }
    if (!blob) throw new Error('could not convert that image')
    url = await readAsDataUrl(blob)
  }

  // The API wants the bare base64, without the `data:...;base64,` prefix.
  const data = url.slice(url.indexOf(',') + 1)
  if (Math.floor(data.length * 0.75) > MAX_BYTES) {
    throw new Error('that image is too big to send')
  }
  return { id: nextId++, name: file.name || 'pasted image', url, media_type: mediaType, data }
}

/**
 * Whether we are on the layout the stylesheet calls a phone.
 *
 * Only for what CSS cannot do. Here it is the placeholder: "Reply to this
 * session..." wraps to two lines in a box that is one line tall next to
 * Interrupt and Send, so on a phone the hint you get is a sentence sliced in
 * half. A shorter one says the same thing and fits.
 */
function usePhone() {
  const query = '(max-width: 760px)'
  const [phone, setPhone] = useState(() => window.matchMedia?.(query).matches || false)
  useEffect(() => {
    const mql = window.matchMedia?.(query)
    if (!mql) return
    const onChange = (event) => setPhone(event.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return phone
}

/** Reply box for sessions the deck drives. */
export default function Composer({ disabled, onSend, onInterrupt, busy, blocked }) {
  const [text, setText] = useState('')
  const [images, setImages] = useState([])
  const [docs, setDocs] = useState([])
  const [pdfs, setPdfs] = useState([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [queued, setQueued] = useState(false)
  const fileRef = useRef(null)
  const phone = usePhone()

  async function attach(files) {
    const picked = Array.from(files || [])
    if (!picked.length) return
    setError('')
    for (const file of picked) {
      try {
        if (file?.type?.startsWith('image/')) {
          const image = await prepare(file)
          setImages((prev) => [...prev, image])
        } else if (isPdf(file)) {
          if (file.size > MAX_PDF_BYTES) {
            throw new Error(`${file.name} is too big to attach (10 MB max)`)
          }
          const data = await readAsBase64(file)
          if (!data) throw new Error(`Could not read ${file.name}`)
          setPdfs((prev) => (
            prev.length >= MAX_PDFS ? prev : [...prev, { id: nextId++, name: file.name, data, size: file.size }]
          ))
        } else if (isTextFile(file)) {
          if (file.size > MAX_DOC_BYTES) {
            throw new Error(`${file.name} is too big to attach`)
          }
          const text = await readAsText(file)
          if (!text.trim()) throw new Error(`${file.name} is empty`)
          setDocs((prev) =>
            prev.length >= MAX_DOCS ? prev : [...prev, { id: nextId++, name: file.name, text }],
          )
        } else {
          // Naming the file matters: with several dropped at once, "not a
          // file I can attach" alone leaves you guessing which one.
          throw new Error(`${file.name || 'that file'} is not a PDF, a text file or an image`)
        }
      } catch (err) {
        setError(err.message)
      }
    }
  }

  /*
   * The paste *event* brings the clipboard with it, which is why this works
   * over plain http. navigator.clipboard.read() would not: that one needs a
   * secure context, and the deck gets opened from a phone by LAN IP.
   */
  function onPaste(e) {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file) => file && (file.type.startsWith('image/') || isPdf(file) || isTextFile(file)))
    if (!files.length) return
    /*
     * Only swallow the paste when a real file came with it. `kind === 'file'`
     * is the whole distinction: copied prose arrives as a string item and
     * still lands in the textarea the normal way, which is what you want —
     * pasting a paragraph must not turn it into an attachment.
     */
    e.preventDefault()
    attach(files)
  }

  async function send(event) {
    event?.preventDefault()
    const value = text.trim()
    if ((!value && !images.length && !docs.length && !pdfs.length) || sending || disabled) return
    setSending(true)
    const payload = images.map(({ media_type, data }) => ({ media_type, data }))
    const files = docs.map(({ name, text: body }) => ({ name, text: body }))
    const documents = pdfs.map(({ name, data }) => ({ name, media_type: 'application/pdf', data }))
    const result = await onSend(value, payload, files, documents)
    setSending(false)
    if (result?.ok) {
      setText('')
      setImages([])
      setDocs([])
      setPdfs([])
      setError('')
      /*
       * Nothing you send shows up in the transcript until the session reads
       * it, and a session parked on a permission will not read anything until
       * that ask is answered. Without this the message just disappears: the
       * box empties, the panel does not change, and there is nothing on screen
       * that says where it went.
       */
      setQueued(Boolean(result.queued))
    } else {
      setError(result?.error || 'could not send that')
    }
  }

  const empty = !text.trim() && !images.length && !docs.length && !pdfs.length

  return (
    <form
      className="composer"
      onSubmit={send}
      onDragOver={(e) => { if (!disabled) e.preventDefault() }}
      onDrop={(e) => {
        if (disabled) return
        e.preventDefault()
        attach(e.dataTransfer?.files)
      }}
    >
      {(images.length > 0 || docs.length > 0 || pdfs.length > 0) && (
        <div className="composer-files">
          {docs.map((doc) => (
            <span key={doc.id} className="composer-doc" title={`${doc.name} — ${Math.max(1, Math.round(doc.text.length / 1024))} KB`}>
              <span className="composer-doc-name">{doc.name}</span>
              <button
                type="button"
                onClick={() => setDocs((prev) => prev.filter((d) => d.id !== doc.id))}
                title={`Remove ${doc.name}`}
              >
                ×
              </button>
            </span>
          ))}
          {pdfs.map((pdf) => (
            <span
              key={pdf.id}
              className="composer-doc is-pdf"
              title={`${pdf.name} — ${Math.max(1, Math.round(pdf.size / 1024))} KB`}
            >
              <span className="composer-doc-kind">PDF</span>
              <span className="composer-doc-name">{pdf.name}</span>
              <button
                type="button"
                onClick={() => setPdfs((prev) => prev.filter((p) => p.id !== pdf.id))}
                title={`Remove ${pdf.name}`}
              >
                ×
              </button>
            </span>
          ))}
          {images.map((image) => (
            <figure key={image.id} className="composer-file">
              <img src={image.url} alt={image.name} />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((i) => i.id !== image.id))}
                title={`Remove ${image.name}`}
              >
                ×
              </button>
            </figure>
          ))}
        </div>
      )}

      {error && <p className="composer-error">{error}</p>}
      {/* Only while the ask it is stuck behind is still on screen: once you
          answer, the message is on its way and the note has served its turn. */}
      {queued && blocked && (
        <p className="composer-note">Sent, and waiting its turn behind the permission above.</p>
      )}

      <div className="composer-row">
        <button
          type="button"
          className="btn btn-ghost btn-attach"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          title="Attach an image, a PDF, or a text file (.md, .txt, .json, source files...)"
        >
          +
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={[...IMAGE_TYPES, 'application/pdf', '.pdf', ...TEXT_EXTENSIONS].join(',')}
          multiple
          hidden
          onChange={(e) => { attach(e.target.files); e.target.value = '' }}
        />

        <textarea
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={
            disabled
              ? 'This session has finished'
              : phone ? 'Reply...' : 'Reply to this session...'
          }
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter makes a new line — the usual chat contract.
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
        />

        {/* "Interrupt", not "Stop": this ends the turn in flight and leaves the
            session open to talk to. Ending the session itself is Kill, up in
            the header, and confusing the two costs you a session. */}
        {busy && (
          <button
            type="button"
            className="btn btn-stop"
            onClick={onInterrupt}
            title="Stop what it is doing now. The session stays open."
          >
            Interrupt
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={empty || disabled || sending}>
          Send
        </button>
      </div>
    </form>
  )
}
