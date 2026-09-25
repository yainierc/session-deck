import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Menu.jsx — a button and the list it opens.
 *
 * Shared rather than copied because the two places that need one are in
 * scroll containers with different shapes, and both got the same three things
 * wrong on the first try: the popover was clipped by the list it lived in, it
 * stayed put while that list scrolled away underneath, and it opened downward
 * off the bottom of the window for the last row.
 *
 * ### Why the popover is `fixed`
 *
 * The project list scrolls, and an absolutely positioned menu is clipped by
 * its scroll container — the last project's menu opened into a region that is
 * simply not drawn. Viewport coordinates escape the clip. The cost of that is
 * the menu no longer follows its anchor, which is why every event that could
 * move the anchor closes it: a menu pinned to the viewport while the list
 * moves under it is a menu pointing at the wrong row, and that is worse than
 * no menu at all.
 */
export default function Menu({ label, title, className = '', buttonClass = '', align = 'right', children, disabled, onOpen }) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState(null)
  const buttonRef = useRef(null)
  const menuRef = useRef(null)

  /*
   * Measured after render, then placed. The menu flips above its button when
   * there is no room below — the case that made viewport positioning
   * necessary in the first place — and is clamped to the window so it can
   * never open with its first item off-screen.
   */
  useLayoutEffect(() => {
    if (!open) return
    const anchor = buttonRef.current.getBoundingClientRect()
    const box = menuRef.current.getBoundingClientRect()
    const below = anchor.bottom + 5
    const fits = below + box.height <= window.innerHeight - 8
    setPlace({
      top: fits ? below : Math.max(8, anchor.top - box.height - 5),
      ...(align === 'left'
        ? { left: Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8)) }
        : { right: Math.max(8, window.innerWidth - anchor.right) }),
    })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (event) => {
      if (event.key === 'Escape') { close(); buttonRef.current?.focus() }
    }
    // Captured, so a click on another menu's button closes this one before
    // that one opens.
    const onDown = (event) => {
      if (menuRef.current?.contains(event.target)) return
      if (buttonRef.current?.contains(event.target)) return
      close()
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${buttonClass} ${open ? 'is-open' : ''}`.trim()}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        /* `onOpen` fires on the way open, for a menu whose contents have to
           be fetched. Asking on open rather than on mount means a session you
           only read costs nothing. */
        onClick={() => setOpen((o) => { if (!o) onOpen?.(); return !o })}
      >
        {label}
      </button>

      {open && (
        <div
          ref={menuRef}
          className={`menu ${className}`.trim()}
          role="menu"
          /* Hidden until measured, so it never flashes at the wrong place. */
          style={place || { visibility: 'hidden' }}
        >
          {/* Choosing something closes the menu. Passed down rather than
              wired onto every child so a menu can also hold things that are
              not choices — a heading, a note about what was granted. */}
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </>
  )
}
