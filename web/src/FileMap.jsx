import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CRITICAL, INK, DIM, folderRanking } from './palette.js'

/**
 * FileMap — watching a session work, instead of reading about it.
 *
 * Every file the session touches is a node orbiting its folder. A read sends
 * a pulse out from the agent at the centre and lights the file's ring; an
 * edit fills its core; a file written for the first time is born with a
 * flash. What you get is the shape of the work — which corner of the codebase
 * it is living in, what it keeps going back to, where it is stuck.
 *
 * Two rules hold the design together:
 *
 *   1. **Colour means one thing: which folder.** It never also means what
 *      happened, because a colour cannot carry two meanings at once. What
 *      happened is carried by shape and motion, which stack on top of hue
 *      instead of fighting it.
 *   2. **Nothing is ever colour alone.** Every folder is directly labelled,
 *      the shapes are in the legend, and a failure is a red ring *and* a cross
 *      *and* the word "failed" in the tooltip.
 */

/** A touch is fully bright for this long, then fades to the floor. */
const HOT_MS = 90_000
const ALPHA_FLOOR = 0.32

/** Golden angle: the reason a sunflower packs without gaps, and the reason a
 *  file added later never shoves the ones already on screen. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5))

const ACTION_LABEL = {
  read: 'read',
  edit: 'edited',
  write: 'written',
  search: 'searched',
  touch: 'touched',
}

function relativeTo(cwd, path) {
  if (!cwd || !path.startsWith(cwd)) return path
  const rest = path.slice(cwd.length).replace(/^\//, '')
  return rest || path.split('/').pop()
}

/**
 * Fold the event stream into what the map draws.
 *
 * Recomputed from scratch whenever events change, which sounds wasteful and
 * is not: a few hundred events over a handful of files is nothing, and a
 * derived structure that cannot drift out of sync with its source is worth
 * far more than the microseconds.
 */
function buildModel(events, cwd) {
  const files = new Map()
  const dirCounts = new Map()
  let reads = 0
  let edits = 0
  let writes = 0
  let failures = 0
  let lastRun = null

  for (const event of events) {
    if (!event.path) {
      if (event.action === 'run') lastRun = event
      continue
    }

    const rel = relativeTo(cwd, event.path)
    const cut = rel.lastIndexOf('/')
    const dir = cut === -1 ? '.' : rel.slice(0, cut)
    const name = rel.slice(cut + 1)

    let file = files.get(event.path)
    if (!file) {
      file = {
        path: event.path,
        rel,
        name,
        dir,
        reads: 0,
        edits: 0,
        writes: 0,
        failures: 0,
        touches: 0,
        // Birth order inside its folder, which is what fixes its seat.
        seat: 0,
        lastAt: null,
        lastAction: null,
        createdHere: false,
      }
      files.set(event.path, file)
      const seen = dirCounts.get(dir) || 0
      file.seat = seen
      dirCounts.set(dir, seen + 1)
    }

    file.touches += 1
    file.lastAt = event.at ? Date.parse(event.at) : Date.now()
    file.lastAction = event.action

    if (event.action === 'read' || event.action === 'search') { file.reads += 1; reads += 1 }
    else if (event.action === 'edit') { file.edits += 1; edits += 1 }
    else if (event.action === 'write') {
      file.writes += 1
      writes += 1
      // Written before it was ever read: as close to "created" as the
      // transcript can honestly tell us.
      if (file.reads === 0 && file.edits === 0) file.createdHere = true
    }

    if (event.failed) { file.failures += 1; failures += 1 }
  }

  // Folders ranked by how much of the work happened in them, so the three
  // that get a hue are the three you are actually watching.
  const { dirs, colorOf } = folderRanking(
    [...files.values()].map((file) => file.dir),
  )

  return {
    files: [...files.values()],
    dirs,
    colorOf,
    totals: { files: files.size, reads, edits, writes, failures },
    lastRun,
  }
}

/**
 * `compact` strips the map back to the picture alone — no counters, no
 * caption, no legend — for the deck-wide atlas, where a dozen of these sit
 * in a grid and the chrome would outweigh the thing it frames.
 */
/*
 * Zoom bounds. Below 0.45 the labels stop being legible and you are looking
 * at coloured dust; above 3 a single file fills the pane, which is further
 * than anyone needs to go to read one name.
 */
/**
 * How long a command, skill or subagent stays on the map, and how many are
 * kept. Long enough to notice on a phone you glance at; short enough that a
 * busy session does not bury its own files under a crowd of finished work.
 */
const SATELLITE_MS = 14000
const MAX_SATELLITES = 6

/** Labels out on the ring are a glance, not a log line. */
function shortLabel(text) {
  const line = String(text || '').split('\n')[0].trim()
  return line.length > 24 ? `${line.slice(0, 23)}…` : line
}

/**
 * One shape per kind of work.
 *
 * Shape rather than colour, for the same reason the files are labelled
 * directly: the folder hues are a validated all-pairs set, and anything else
 * wearing one would read as belonging to that folder.
 */
function drawKind(ctx, kind, x, y, r) {
  ctx.beginPath()
  if (kind === 'command') {
    // A square: the block cursor of a terminal.
    ctx.rect(x - r, y - r, r * 2, r * 2)
    ctx.fill()
  } else if (kind === 'agent') {
    // A triangle: something pointed somewhere on your behalf.
    ctx.moveTo(x, y - r * 1.2)
    ctx.lineTo(x + r * 1.1, y + r * 0.9)
    ctx.lineTo(x - r * 1.1, y + r * 0.9)
    ctx.closePath()
    ctx.fill()
  } else if (kind === 'skill') {
    // A diamond: a square that was given a turn.
    ctx.moveTo(x, y - r * 1.3)
    ctx.lineTo(x + r * 1.3, y)
    ctx.lineTo(x, y + r * 1.3)
    ctx.lineTo(x - r * 1.3, y)
    ctx.closePath()
    ctx.fill()
  } else if (kind === 'web') {
    // A ring: hollow, because it reached outside and brought something back.
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.stroke()
  } else {
    ctx.arc(x, y, r * 0.8, 0, Math.PI * 2)
    ctx.fill()
  }
}

const MIN_ZOOM = 0.45
const MAX_ZOOM = 3

export default function FileMap({ events, cwd, live, compact = false }) {
  const wrapRef = useRef(null)
  const observerRef = useRef(null)
  const canvasRef = useRef(null)
  const [hover, setHover] = useState(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  const model = useMemo(() => buildModel(events, cwd), [events, cwd])

  // Everything the animation loop mutates lives in refs: React re-rendering
  // sixty times a second to move a circle would be absurd.
  const nodesRef = useRef(new Map())
  const cometsRef = useRef([])
  const satellitesRef = useRef([])
  const satelliteSlot = useRef(0)
  const dragRef = useRef(null)
  const pinchRef = useRef(null)

  /*
   * Pan and zoom.
   *
   * The map sizes itself to its box, which works until the box is a phone and
   * the session has touched thirty files — then everything is technically on
   * screen and none of it is readable. So the view gets its own transform,
   * and the layout keeps laying out for the box as before.
   *
   * Held as state because the tooltip is a DOM element positioned from world
   * coordinates, and mirrored into a ref because the draw loop must not
   * restart every time you drag.
   */
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const seenRef = useRef(new Set())
  const modelRef = useRef(model)
  modelRef.current = model
  // The loop reads the hover through a ref, never through its dependencies:
  // restarting a sixty-per-second animation on every mouse move would throw
  // away the comets in flight.
  const hoverRef = useRef(null)
  hoverRef.current = hover

  const reduceMotion = useMemo(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  /*
   * New events fire the animation. This watches the event list rather than
   * the model so a repeat touch of the same file still pulses — the model
   * would only show a counter going up.
   */
  useEffect(() => {
    const seen = seenRef.current
    const fresh = []
    for (const event of events) {
      const key = `${event.id}:${event.path || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push(event)
    }
    // The first load is history, not news: light it up, do not replay it.
    if (fresh.length === events.length) return

    for (const event of fresh) {
      /*
       * Work with no file — a Bash command, a subagent, a fetch — used to
       * leave the map completely still, which reads as "nothing is
       * happening" exactly when the session is busiest. It gets a ring out
       * from the centre instead: no destination to fly to, so the shape is a
       * ripple rather than a comet.
       */
      if (!event.path) {
        if (event.action !== 'run') continue
        /*
         * Work with no file — a command, a skill, a subagent, a fetch — gets
         * a node of its own out on the ring, reached by the same line a file
         * is reached by. An anonymous ripple said "something happened"; this
         * says what, and keeps one grammar for everything the session does.
         */
        const sats = satellitesRef.current
        satelliteSlot.current += 1
        sats.push({
          id: event.id,
          kind: event.kind || 'tool',
          label: event.label || event.tool,
          slot: satelliteSlot.current,
          born: Date.now(),
          t: reduceMotion ? 1 : 0,
          pulse: 1,
        })
        // Only the last few: a session that shells out constantly would
        // otherwise bury its own files under a crowd of finished commands.
        while (sats.length > MAX_SATELLITES) sats.shift()
        continue
      }
      const node = nodesRef.current.get(event.path)
      if (node) {
        node.pulse = 1
        node.flash = event.action === 'write' ? 1 : node.flash
      }
      if (!reduceMotion) {
        cometsRef.current.push({ path: event.path, t: 0, action: event.action })
      }
    }
  }, [events, reduceMotion])

  /**
   * Keep the canvas the size of its box, in real device pixels.
   *
   * A callback ref rather than an effect, and that is load-bearing: a session
   * whose events have not arrived yet renders the empty state, which has no
   * canvas at all. An effect with no dependencies would run once against a
   * box that does not exist, return, and never look again — leaving a
   * zero-sized canvas for the rest of the session's life. This runs exactly
   * when the element appears, and again when it goes away.
   */
  const attachWrap = useCallback((node) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    wrapRef.current = node
    if (!node) return

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ w: Math.round(width), h: Math.round(height) })
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  /** The draw loop. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.w || !size.h) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    // No ctx.scale(dpr) here: each frame sets its full transform below.

    let frame = 0
    let stopped = false
    let spin = 0

    /*
     * A card in the atlas is a fifth of the size of the full map, and simply
     * shrinking the box does not shrink what is in it: the same nodes at the
     * same radius turn into a knot. Everything that is measured in pixels
     * scales, and the per-file labels stop being drawn at all — in a card the
     * folder names carry identity, and the file names are what hovering is
     * for.
     */
    const scale = compact ? 0.66 : 1

    function layout() {
      const current = modelRef.current
      const cx = size.w / 2
      const cy = size.h / 2
      const nodes = nodesRef.current

      /*
       * The ring sizes itself to the work, not to the window.
       *
       * Spacing the folders by a fraction of the pane looked right with six
       * of them and left two marooned in opposite corners with a void
       * between. Measuring the widest folder and parking the others just
       * clear of it keeps a small session compact and lets a big one spread,
       * which is the behaviour you want in both cases.
       */
      const orbit = Math.min(size.w, size.h) * 0.058 * scale
      const widest = current.dirs.reduce((max, entry) => Math.max(max, entry.count - 1), 0)
      const reach = orbit * (1.15 + Math.sqrt(widest))
      const gap = compact ? 40 : 78
      const ring = Math.min(reach + gap, size.w / 2 - reach - 12, size.h / 2 - reach - 12)
      const ringX = Math.max(ring, 0)
      const ringY = Math.max(ring, 0)

      const count = Math.max(current.dirs.length, 1)
      // Two folders read best side by side; three or more read best with the
      // busiest at the top, which is where the eye lands first.
      const start = count === 2 ? Math.PI : -Math.PI / 2

      const hubs = new Map()
      current.dirs.forEach((entry, i) => {
        const angle = start + (i / count) * Math.PI * 2 + spin
        hubs.set(entry.dir, {
          x: cx + Math.cos(angle) * (current.dirs.length === 1 ? 0 : ringX),
          y: cy + Math.sin(angle) * (current.dirs.length === 1 ? 0 : ringY),
          color: entry.color,
          dir: entry.dir,
          label: entry.label,
          count: entry.count,
        })
      })

      for (const file of current.files) {
        const hub = hubs.get(file.dir)
        if (!hub) continue

        // Phyllotaxis: seat N is always in the same place, so a file added in
        // the tenth minute never rearranges the nine that came before it.
        // The +1.15 keeps the innermost seat clear of the folder's own label.
        const angle = file.seat * GOLDEN + spin * 1.6
        const radius = orbit * (1.15 + Math.sqrt(file.seat))
        const tx = hub.x + Math.cos(angle) * radius
        const ty = hub.y + Math.sin(angle) * radius

        let node = nodes.get(file.path)
        if (!node) {
          // Born at its hub and drifting out to its seat, rather than
          // appearing from nowhere.
          node = { x: hub.x, y: hub.y, pulse: 1, flash: file.createdHere ? 1 : 0 }
          nodes.set(file.path, node)
        }
        node.tx = tx
        node.ty = ty
        node.file = file
        node.color = hub.color
        node.radius = Math.min(4 + 2.1 * Math.sqrt(file.touches), 15) * scale
      }

      // Files can leave the window when the event cap drops the oldest ones.
      for (const path of [...nodes.keys()]) {
        if (!current.files.some((f) => f.path === path)) nodes.delete(path)
      }

      return { hubs, cx, cy }
    }

    function draw() {
      if (stopped) return
      frame += 1
      if (!reduceMotion) spin += 0.0004

      const current = modelRef.current
      const { hubs, cx, cy } = layout()
      const nodes = nodesRef.current
      const now = Date.now()

      /*
       * Clear in screen space, draw in world space. Set outright rather than
       * saved and restored: this runs every frame, and a transform stack that
       * leaks by one push is a drift you only notice an hour in.
       */
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.w, size.h)
      const view = viewRef.current
      ctx.translate(view.x, view.y)
      ctx.scale(view.k, view.k)

      // ---- folder hubs: the halo and the label ----
      const halo = 78 * scale
      for (const hub of hubs.values()) {
        const glow = ctx.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, halo)
        glow.addColorStop(0, `${hub.color}22`)
        glow.addColorStop(1, `${hub.color}00`)
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(hub.x, hub.y, halo, 0, Math.PI * 2)
        ctx.fill()
      }

      // ---- the tether from each file to its folder ----
      ctx.lineWidth = 1
      for (const node of nodes.values()) {
        const hub = hubs.get(node.file.dir)
        if (!hub) continue
        ctx.strokeStyle = `${node.color}1f`
        ctx.beginPath()
        ctx.moveTo(hub.x, hub.y)
        ctx.lineTo(node.x, node.y)
        ctx.stroke()
      }

      // ---- the agent at the centre ----
      const beat = reduceMotion ? 0.5 : 0.5 + Math.sin(frame / 26) * 0.5
      const coreR = 7 + (live ? beat * 3 : 0)
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, 46)
      core.addColorStop(0, live ? 'rgba(230,232,235,0.22)' : 'rgba(98,108,125,0.14)')
      core.addColorStop(1, 'rgba(230,232,235,0)')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx, cy, 46, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = live ? INK : DIM
      ctx.beginPath()
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
      ctx.fill()

      /*
       * ---- satellites: commands, skills and subagents ----
       *
       * Same grammar as a file: a line out from the centre, a mark at the
       * end, a label. What differs is the shape, never the colour — the
       * folder palette is a validated set and a command wearing one of its
       * hues would read as belonging to that directory.
       *
       * They sit on their own ring, inside the folders, and fade once they
       * have had their moment: these are events, not places.
       */
      {
        const sats = satellitesRef.current
        const ring = Math.min(size.w, size.h) * 0.2 * scale

        for (let i = sats.length - 1; i >= 0; i -= 1) {
          const sat = sats[i]
          const age = (now - sat.born) / SATELLITE_MS
          if (age >= 1) { sats.splice(i, 1); continue }

          if (!reduceMotion && sat.t < 1) sat.t = Math.min(1, sat.t + 0.05)
          if (sat.pulse > 0) sat.pulse = Math.max(0, sat.pulse - 0.02)

          // Golden angle: consecutive commands land far apart instead of
          // stacking on the same spoke.
          const angle = sat.slot * 2.399963 + spin * 4
          const tx = cx + Math.cos(angle) * ring
          const ty = cy + Math.sin(angle) * ring

          // Ease out, so it leaves fast and arrives gently — the files' comet.
          const p = 1 - (1 - sat.t) ** 2
          const x = cx + (tx - cx) * p
          const y = cy + (ty - cy) * p

          // Fade over the last third of its life, not the whole of it: a
          // command should look present while it is the latest thing done.
          const alpha = age < 0.66 ? 1 : 1 - (age - 0.66) / 0.34

          const tail = ctx.createLinearGradient(cx, cy, x, y)
          tail.addColorStop(0, 'rgba(230,232,235,0)')
          tail.addColorStop(1, `rgba(230,232,235,${0.5 * alpha})`)
          ctx.strokeStyle = tail
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.lineTo(x, y)
          ctx.stroke()

          const r = (4 + sat.pulse * 3) * scale
          ctx.fillStyle = `rgba(230,232,235,${0.85 * alpha})`
          ctx.strokeStyle = `rgba(230,232,235,${0.85 * alpha})`
          ctx.lineWidth = 1.4
          drawKind(ctx, sat.kind, x, y, r)

          // Name it once it has arrived. In a card there is no room.
          if (!compact && sat.t > 0.6) {
            ctx.globalAlpha = alpha
            ctx.fillStyle = DIM
            ctx.font = '10.5px ui-sans-serif, -apple-system, system-ui, sans-serif'
            ctx.textAlign = Math.cos(angle) < 0 ? 'right' : 'left'
            ctx.textBaseline = 'middle'
            const pad = (r + 6) * (Math.cos(angle) < 0 ? -1 : 1)
            ctx.fillText(shortLabel(sat.label), x + pad, y)
            ctx.globalAlpha = 1
            ctx.textAlign = 'left'
          }
        }
      }

      // ---- comets: the agent reaching for a file ----
      if (!reduceMotion) {
        const comets = cometsRef.current
        for (let i = comets.length - 1; i >= 0; i -= 1) {
          const comet = comets[i]
          const node = nodes.get(comet.path)
          if (!node) { comets.splice(i, 1); continue }

          comet.t += 0.045
          if (comet.t >= 1) {
            node.pulse = 1
            if (comet.action === 'write') node.flash = 1
            comets.splice(i, 1)
            continue
          }

          // Ease out, so it leaves fast and arrives gently.
          const p = 1 - (1 - comet.t) ** 2
          const x = cx + (node.x - cx) * p
          const y = cy + (node.y - cy) * p
          const tail = ctx.createLinearGradient(cx, cy, x, y)
          tail.addColorStop(0, `${node.color}00`)
          tail.addColorStop(1, `${node.color}cc`)
          ctx.strokeStyle = tail
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.lineTo(x, y)
          ctx.stroke()

          ctx.fillStyle = node.color
          ctx.beginPath()
          ctx.arc(x, y, 2.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // ---- the files ----
      for (const node of nodes.values()) {
        // Drift toward the seat rather than snapping to it.
        node.x += (node.tx - node.x) * (reduceMotion ? 1 : 0.08)
        node.y += (node.ty - node.y) * (reduceMotion ? 1 : 0.08)
        node.pulse = Math.max(0, node.pulse - 0.016)
        node.flash = Math.max(0, (node.flash || 0) - 0.012)

        const file = node.file
        const age = file.lastAt ? now - file.lastAt : HOT_MS
        const heat = Math.max(0, 1 - age / HOT_MS)
        const alpha = ALPHA_FLOOR + (1 - ALPHA_FLOOR) * heat
        const r = node.radius
        const hovered = hoverRef.current?.path === file.path

        // The pulse ring: a touch, expanding and fading.
        if (node.pulse > 0) {
          ctx.strokeStyle = `${node.color}${Math.round(node.pulse * 200).toString(16).padStart(2, '0')}`
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(node.x, node.y, r + (1 - node.pulse) * 26, 0, Math.PI * 2)
          ctx.stroke()
        }

        // A newly written file burns white for a moment before settling.
        if (node.flash > 0) {
          ctx.fillStyle = `rgba(255,255,255,${node.flash * 0.5})`
          ctx.beginPath()
          ctx.arc(node.x, node.y, r + node.flash * 7, 0, Math.PI * 2)
          ctx.fill()
        }

        ctx.globalAlpha = alpha
        // Shape carries what happened, so hue is left free to mean "folder":
        // a file only ever read is a hollow ring; one that has been changed
        // is filled in.
        const changed = file.edits > 0 || file.writes > 0
        ctx.beginPath()
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
        if (changed) {
          ctx.fillStyle = node.color
          ctx.fill()
        } else {
          ctx.strokeStyle = node.color
          ctx.lineWidth = 1.8
          ctx.stroke()
        }

        // A file this session created gets a ring of its own.
        if (file.createdHere) {
          ctx.strokeStyle = `${INK}aa`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2)
          ctx.stroke()
        }

        /*
         * Failure: a reserved red ring, a cross, and the word "failed" in the
         * tooltip. Three channels for one meaning is not belt and braces — a
         * red cross drawn straight onto an orange node is nearly invisible,
         * which is how a failure gets missed.
         */
        if (file.failures > 0) {
          ctx.strokeStyle = CRITICAL
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(node.x, node.y, r + 4.5, 0, Math.PI * 2)
          ctx.stroke()

          // The cross sits outside the node, on the surface, where nothing
          // competes with it.
          const bx = node.x + (r + 4.5) * 0.72
          const by = node.y - (r + 4.5) * 0.72
          ctx.fillStyle = 'rgba(12,14,17,0.9)'
          ctx.beginPath()
          ctx.arc(bx, by, 5.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = CRITICAL
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.moveTo(bx - 2.6, by - 2.6)
          ctx.lineTo(bx + 2.6, by + 2.6)
          ctx.moveTo(bx + 2.6, by - 2.6)
          ctx.lineTo(bx - 2.6, by + 2.6)
          ctx.stroke()
        }

        ctx.globalAlpha = 1

        if (hovered) {
          ctx.strokeStyle = INK
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2)
          ctx.stroke()
        }

        // Name the ones worth naming: the busy, the hovered, the just-touched.
        // Labelling every node at once turns the map into a word cloud — and
        // in a card there is no room for any of them but the hovered one.
        if (hovered || (!compact && (file.touches >= 3 || file.failures > 0 || node.pulse > 0.2))) {
          ctx.globalAlpha = hovered ? 1 : 0.55 + heat * 0.45
          ctx.fillStyle = INK
          ctx.font = '11px ui-sans-serif, -apple-system, system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(file.name, node.x, node.y - r - 7)
          ctx.globalAlpha = 1
        }
      }

      /*
       * Folder labels last, each on its own plate.
       *
       * They are the one thing on the map that must never be unreadable —
       * they are what stops colour from being the only way to tell the
       * folders apart — so they get painted over everything, on a scrim of
       * the surface colour rather than trusting the gaps.
       */
      for (const hub of hubs.values()) {
        const label = hub.label
        ctx.font = `600 ${compact ? 9.5 : 11}px ui-sans-serif, -apple-system, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'

        const width = ctx.measureText(label).width + (compact ? 9 : 12)
        const tall = compact ? 15 : 18
        ctx.fillStyle = 'rgba(12,14,17,0.82)'
        ctx.beginPath()
        // roundRect is recent enough that an older browser would throw here,
        // and a throw inside the draw loop takes the whole map down.
        if (ctx.roundRect) ctx.roundRect(hub.x - width / 2, hub.y - tall / 2, width, tall, tall / 2)
        else ctx.rect(hub.x - width / 2, hub.y - tall / 2, width, tall)
        ctx.fill()

        ctx.fillStyle = hub.color
        ctx.fillText(label, hub.x, hub.y)
        ctx.textBaseline = 'alphabetic'
      }

      requestAnimationFrame(draw)
    }

    const handle = requestAnimationFrame(draw)
    return () => { stopped = true; cancelAnimationFrame(handle) }
  }, [size, reduceMotion, live, compact])

  /** Screen pixels to the coordinates the nodes are laid out in. */
  const toWorld = useCallback((clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - rect.left - v.x) / v.k,
      y: (clientY - rect.top - v.y) / v.k,
    }
  }, [])

  /**
   * Zoom about a point on screen, keeping whatever is under it still.
   *
   * Zooming about the centre instead is what makes a map feel like it is
   * fighting you: the thing you were looking at slides away exactly when you
   * lean in to see it.
   */
  const zoomAt = useCallback((factor, sx, sy) => {
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor))
      if (k === v.k) return v
      const ratio = k / v.k
      return { k, x: sx - (sx - v.x) * ratio, y: sy - (sy - v.y) * ratio }
    })
  }, [])

  /*
   * Wheel zooms; a trackpad pinch arrives here too, as a wheel event with
   * ctrlKey set. Both are the same gesture to the person doing it.
   */
  function onWheel(event) {
    const rect = canvasRef.current.getBoundingClientRect()
    zoomAt(Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top)
  }

  /** Distance and midpoint of a two-finger touch, in screen pixels. */
  function pinchOf(touches, rect) {
    const [a, b] = touches
    return {
      d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      x: (a.clientX + b.clientX) / 2 - rect.left,
      y: (a.clientY + b.clientY) / 2 - rect.top,
    }
  }

  function onTouchStart(event) {
    const rect = canvasRef.current.getBoundingClientRect()
    if (event.touches.length === 2) {
      pinchRef.current = pinchOf(event.touches, rect)
      dragRef.current = null
    } else if (event.touches.length === 1) {
      // One finger pans only once there is something to pan to. Otherwise a
      // tap-and-slide on an un-zoomed map would drag it off its own pane.
      dragRef.current = viewRef.current.k > 1
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : null
    }
  }

  function onTouchMove(event) {
    const rect = canvasRef.current.getBoundingClientRect()

    if (event.touches.length === 2 && pinchRef.current) {
      const next = pinchOf(event.touches, rect)
      const previous = pinchRef.current
      if (previous.d > 0) zoomAt(next.d / previous.d, next.x, next.y)
      pinchRef.current = next
      return
    }

    if (event.touches.length === 1 && dragRef.current) {
      const touch = event.touches[0]
      const drag = dragRef.current
      setView((v) => ({ ...v, x: v.x + (touch.clientX - drag.x), y: v.y + (touch.clientY - drag.y) }))
      dragRef.current = { x: touch.clientX, y: touch.clientY }
    }
  }

  function onTouchEnd(event) {
    if (event.touches.length < 2) pinchRef.current = null
    if (event.touches.length === 0) dragRef.current = null
  }

  /** Hit-testing for the hover layer. */
  function onMove(event) {
    if (dragRef.current) {
      const drag = dragRef.current
      setView((v) => ({ ...v, x: v.x + (event.clientX - drag.x), y: v.y + (event.clientY - drag.y) }))
      dragRef.current = { x: event.clientX, y: event.clientY }
      return
    }
    const { x: mx, y: my } = toWorld(event.clientX, event.clientY)

    let best = null
    let bestDist = Infinity
    for (const node of nodesRef.current.values()) {
      const dist = Math.hypot(node.x - mx, node.y - my)
      // The 8px of slack is a fingertip on screen, so it scales with the view.
      if (dist < node.radius + 8 / viewRef.current.k && dist < bestDist) {
        best = node
        bestDist = dist
      }
    }
    setHover(best ? { ...best.file, x: best.x, y: best.y } : null)
  }

  const { totals, dirs, lastRun } = model
  const sawActivity = Boolean(lastRun)

  if (model.files.length === 0) {
    return (
      <div className={`map ${compact ? 'is-compact' : ''}`}>
        <div className="map-empty">
          <p>{compact ? 'No files yet' : 'No files touched yet.'}</p>
          {!compact && (
            <p className="note">
              Reads, edits and writes appear here as the session works.
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`map ${compact ? 'is-compact' : ''}`}>
      {!compact && (
      <div className="map-stats">
        <Stat value={totals.files} label={totals.files === 1 ? 'file' : 'files'} />
        <Stat value={totals.reads} label="reads" />
        <Stat value={totals.edits} label="edits" />
        <Stat value={totals.writes} label="writes" />
        {totals.failures > 0 && <Stat value={totals.failures} label="failed" critical />}
      </div>
      )}

      <div className="map-canvas" ref={attachWrap}>
        {/*
          Buttons as well as gestures, and inside the canvas box rather than
          the panel: this is the one region with no counters above it and no
          legend below. A pinch is the natural move on a phone, but it fails
          silently when a stray finger lands on the pane, and it offers no
          discoverable way back to 1:1.
        */}
        {!compact && (
          <div className="map-zoom">
            <button onClick={() => zoomAt(1 / 1.35, size.w / 2, size.h / 2)} aria-label="Zoom out">−</button>
            <button
              className="map-zoom-level"
              onClick={() => setView({ k: 1, x: 0, y: 0 })}
              disabled={view.k === 1 && view.x === 0 && view.y === 0}
              title="Back to fit"
            >
              {Math.round(view.k * 100)}%
            </button>
            <button onClick={() => zoomAt(1.35, size.w / 2, size.h / 2)} aria-label="Zoom in">+</button>
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{ width: size.w, height: size.h, cursor: view.k > 1 ? 'grab' : 'default' }}
          onMouseMove={onMove}
          onMouseLeave={() => { setHover(null); dragRef.current = null }}
          onMouseDown={(e) => { if (view.k > 1) dragRef.current = { x: e.clientX, y: e.clientY } }}
          onMouseUp={() => { dragRef.current = null }}
          onWheel={onWheel}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onDoubleClick={(e) => {
            const rect = canvasRef.current.getBoundingClientRect()
            zoomAt(1.6, e.clientX - rect.left, e.clientY - rect.top)
          }}
        />
        {hover && (
          <div
            className="map-tip"
            style={{
              left: Math.min(Math.max(hover.x * view.k + view.x, 90), Math.max(size.w - 90, 90)),
              top: Math.max(hover.y * view.k + view.y - 18, 8),
            }}
          >
            <strong>{hover.name}</strong>
            <span className="map-tip-path">{hover.rel}</span>
            <span className="map-tip-counts">
              {hover.reads > 0 && `${hover.reads} read${hover.reads > 1 ? 's' : ''}`}
              {hover.reads > 0 && (hover.edits > 0 || hover.writes > 0) && ' · '}
              {hover.edits > 0 && `${hover.edits} edit${hover.edits > 1 ? 's' : ''}`}
              {hover.edits > 0 && hover.writes > 0 && ' · '}
              {hover.writes > 0 && `${hover.writes} write${hover.writes > 1 ? 's' : ''}`}
            </span>
            {hover.failures > 0 && (
              <span className="map-tip-failed">✕ {hover.failures} failed</span>
            )}
            <span className="map-tip-last">
              last {ACTION_LABEL[hover.lastAction] || hover.lastAction}
            </span>
          </div>
        )}
      </div>

      {lastRun && !compact && (
        <p className="map-caption" title={lastRun.label}>
          <span className="map-caption-tool">{lastRun.tool}</span>
          {lastRun.label}
        </p>
      )}

      {/*
        Identity never rests on colour: the folders are named here and again
        on the map itself, and the shapes say what happened. The compact map
        drops this row and keeps the labels on the map, which is the half of
        the pairing that cannot be dropped.
      */}
      {!compact && (
      <div className="map-legend">
        <div className="map-legend-row">
          {dirs.slice(0, 6).map((entry) => (
            <span key={entry.dir} className="map-key">
              <span className="map-swatch" style={{ background: entry.color }} />
              {entry.label}
              <span className="map-key-count">{entry.count}</span>
            </span>
          ))}
          {dirs.length > 6 && <span className="map-key">+{dirs.length - 6} more</span>}
        </div>
        <div className="map-legend-row map-legend-shapes">
          <span className="map-key"><span className="map-shape is-ring" /> read only</span>
          <span className="map-key"><span className="map-shape is-solid" /> changed</span>
          <span className="map-key"><span className="map-shape is-new" /> created here</span>
          <span className="map-key"><span className="map-shape is-failed">✕</span> failed</span>
          <span className="map-key map-key-note">size = times touched</span>
        </div>
        {/*
          The satellites need naming too, or a square on the ring is just a
          square. Only shown once something has actually run: a legend for
          something not on screen is noise.
        */}
        {sawActivity && (
          <div className="map-legend-row map-legend-shapes">
            <span className="map-key"><span className="map-act is-command" /> command</span>
            <span className="map-key"><span className="map-act is-skill" /> skill</span>
            <span className="map-key"><span className="map-act is-agent" /> subagent</span>
            <span className="map-key"><span className="map-act is-web" /> web</span>
          </div>
        )}
      </div>
      )}
    </div>
  )
}

function Stat({ value, label, critical }) {
  return (
    <div className="map-stat">
      <span className={`map-stat-value ${critical ? 'is-critical' : ''}`}>{value}</span>
      <span className="map-stat-label">{label}</span>
    </div>
  )
}
