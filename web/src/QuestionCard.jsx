import { useEffect, useMemo, useState } from 'react'

/**
 * The other half of the permission card: when the session is not asking for
 * permission but asking *you* something, with options it already wrote down.
 *
 * The options are not a guess. AskUserQuestion carries them in its own input,
 * so every button here is a choice the session actually offered — there is no
 * parsing of prose and nothing to get wrong.
 *
 * Two rules the tool sets and this honours rather than styles away: an answer
 * you type yourself is always allowed (the tool's own description says the
 * "Other" escape is provided for you), and a question with several parts is
 * not answered until every part is.
 */

/** A choice becomes the string the model reads; multi-select joins with commas. */
function asAnswer(value) {
  return Array.isArray(value) ? value.join(', ') : value
}

function Option({ option, index, chosen, disabled, onPick }) {
  const [showPreview, setShowPreview] = useState(false)

  return (
    <div className={`qopt ${chosen ? 'is-chosen' : ''}`}>
      <button
        type="button"
        className="qopt-pick"
        disabled={disabled}
        onClick={() => onPick(option.label)}
      >
        <span className="qopt-key">{index + 1}</span>
        <span className="qopt-body">
          <span className="qopt-label">{option.label}</span>
          {option.description && <span className="qopt-desc">{option.description}</span>}
        </span>
      </button>
      {option.preview && (
        <>
          <button
            type="button"
            className="qopt-preview-toggle"
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? 'hide preview' : 'preview'}
          </button>
          {showPreview && <pre className="qopt-preview">{option.preview}</pre>}
        </>
      )}
    </div>
  )
}

function Question({ q, value, disabled, onPick, autoKeys }) {
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')

  const chosen = (label) =>
    Array.isArray(value) ? value.includes(label) : value === label

  function pick(label) {
    if (!q.multiSelect) return onPick(label, true)
    const current = Array.isArray(value) ? value : []
    onPick(current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label], true)
  }

  /*
   * Number keys, because the whole point of this card is not touching the
   * keyboard to *write* — needing the mouse instead would just move the chore.
   * Only wired when there is a single question on screen: with two, "2" would
   * be ambiguous, and a shortcut that picks the wrong answer is worse than no
   * shortcut. Ignored while you are typing your own answer.
   */
  useEffect(() => {
    if (!autoKeys || disabled) return
    function onKey(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const n = Number(event.key)
      if (!Number.isInteger(n) || n < 1 || n > q.options.length) return
      event.preventDefault()
      pick(q.options[n - 1].label)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="question">
      {q.header && <span className="question-chip">{q.header}</span>}
      <p className="question-text">{q.question}</p>

      <div className="qopts">
        {q.options.map((option, i) => (
          <Option
            key={option.label + i}
            option={option}
            index={i}
            chosen={chosen(option.label)}
            disabled={disabled}
            onPick={pick}
          />
        ))}
      </div>

      {writing ? (
        <div className="qother">
          {/* Typing stages the answer but never commits it: a single question
              sends on choice, and committing per keystroke would fire the
              answer on the first letter. Enter is the commit. */}
          <input
            autoFocus
            value={text}
            placeholder="Your own answer, then Enter..."
            disabled={disabled}
            onChange={(e) => { setText(e.target.value); onPick(e.target.value, false) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim()) { e.preventDefault(); onPick(text, true) }
              if (e.key === 'Escape') { setWriting(false); setText(''); onPick(null) }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="qother-open"
          disabled={disabled}
          onClick={() => { setWriting(true); onPick(null) }}
        >
          Something else...
        </button>
      )}
    </div>
  )
}

export default function QuestionCard({ pending, onAnswer }) {
  const questions = pending.questions || []
  const [picked, setPicked] = useState({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  // A new question reuses this component; last question's answers must not
  // survive into it.
  useEffect(() => { setPicked({}); setError(null); setSending(false) }, [pending.requestId])

  const complete = useMemo(
    () => questions.every((q) => {
      const v = picked[q.question]
      return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim()
    }),
    [questions, picked],
  )

  // One plain question is the common case, and there a click is the answer:
  // choosing and then confirming the same thing is a step that buys nothing.
  const oneShot = questions.length === 1 && !questions[0].multiSelect

  async function submit(answers) {
    if (sending) return
    setSending(true)
    setError(null)
    const payload = {}
    for (const q of questions) payload[q.question] = asAnswer(answers[q.question])
    const result = await onAnswer(pending.requestId, payload)
    if (!result?.ok) {
      setSending(false)
      setError(result?.error || 'Could not send that answer')
    }
  }

  function set(question, value, commit) {
    const next = { ...picked, [question]: value }
    if (value === null) delete next[question]
    setPicked(next)
    if (oneShot && commit && typeof value === 'string' && value.trim()) submit(next)
  }

  return (
    <section className="permission question-card">
      <header className="permission-head">
        <span className="permission-tool">it is asking you</span>
      </header>

      {questions.map((q, i) => (
        <Question
          key={q.question + i}
          q={q}
          value={picked[q.question]}
          disabled={sending}
          autoKeys={questions.length === 1}
          onPick={(value, commit) => set(q.question, value, commit)}
        />
      ))}

      {error && <p className="question-error">{error}</p>}

      {!oneShot && (
        <div className="permission-actions">
          <button
            className="btn btn-primary"
            disabled={!complete || sending}
            onClick={() => submit(picked)}
          >
            {sending ? 'Sending...' : 'Answer'}
          </button>
        </div>
      )}
    </section>
  )
}
