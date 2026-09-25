/**
 * Choosing how much a session asks before it acts.
 *
 * The descriptions say what actually happens rather than softening it.
 * Someone turning the asking off deserves to know what they traded for the
 * quiet, and the dangerous option is styled as dangerous instead of sitting
 * flush with the safe ones.
 */
export default function PermissionMode({ modes, value, onChange, disabled, compact }) {
  const current = modes.find((m) => m.id === value) || modes[0]

  return (
    <div className={`perm ${compact ? 'is-compact' : ''}`}>
      <div className="perm-options" role="radiogroup" aria-label="Permissions">
        {modes.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="radio"
            aria-checked={mode.id === value}
            disabled={disabled}
            className={`perm-option ${mode.id === value ? 'is-on' : ''} ${mode.dangerous ? 'is-danger' : ''}`}
            onClick={() => onChange(mode.id)}
            title={mode.description}
          >
            {mode.label}
          </button>
        ))}
      </div>
      {!compact && current && (
        <p className={`perm-note ${current.dangerous ? 'is-danger' : ''}`}>{current.description}</p>
      )}
    </div>
  )
}
