import { useMemo, useRef, useState } from 'react'
import { CRITICAL, folderRanking } from './palette.js'

/**
 * Timeline — the same session, read as a story instead of a picture.
 *
 * The map answers "what is it working on". This answers "how did we get
 * here": one lane per file, time running left to right, so the rhythm of the
 * session is the shape on screen. The file it rewrote nine times is a dense
 * row; the forty minutes it spent stuck are a gap you can point at.
 *
 * The marks say the same things they say on the map — hollow is a read,
 * filled is a change, a white ring means created, red means it failed. One
 * grammar across both views is worth more than two clever ones.
 */

/** Lanes are this tall; dense enough to see a session at a glance. */
const LANE = 19
const GUTTER = 168
const PAD_RIGHT = 22
const TOP = 34

/** On a phone a fixed 168px name gutter leaves the plot a sliver, so the
 *  gutter takes a share of the width instead — never below this, or the
 *  names stop being names. */
const GUTTER_MIN = 76
const GUTTER_SHARE = 0.34

/** Advance of the monospace 10.5px used for lane names, for truncation. */
const NAME_CHAR = 6.3

/** A "22:35" tick needs about this much room before the next one collides. */
const TICK_ROOM = 56

/** A pause worth drawing. Below this it is just the pace of working. */
const IDLE_MS = 60_000

const STEPS = [
  15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000,
  15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000,
]

function niceStep(span, target = 6) {
  const ideal = span / target
  return STEPS.find((step) => step >= ideal) || STEPS[STEPS.length - 1]
}

function clock(ms) {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function duration(ms) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function relativeTo(cwd, path) {
  if (!cwd || !path.startsWith(cwd)) return path
  return path.slice(cwd.length).replace(/^\//, '') || path.split('/').pop()
}

export default function Timeline({ events, cwd, live }) {
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(900)
  const [hover, setHover] = useState(null)

  // Same story as the map: the element only exists once there is something
  // to draw, so the measurement has to attach when it appears.
  const attach = (node) => {
    wrapRef.current = node
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(node)
  }

  const model = useMemo(() => {
    const lanes = new Map()
    for (const event of events) {
      if (!event.path) continue
      const at = event.at ? Date.parse(event.at) : Date.now()
      if (Number.isNaN(at)) continue

      let lane = lanes.get(event.path)
      if (!lane) {
        const rel = relativeTo(cwd, event.path)
        const cut = rel.lastIndexOf('/')
        lane = {
          path: event.path,
          rel,
          name: rel.slice(cut + 1),
          dir: cut === -1 ? '.' : rel.slice(0, cut),
          marks: [],
          first: at,
          reads: 0,
          changes: 0,
          failures: 0,
          created: false,
        }
        lanes.set(event.path, lane)
      }

      const isWrite = event.action === 'write'
      if (isWrite && lane.reads === 0 && lane.changes === 0) lane.created = true
      if (event.action === 'read' || event.action === 'search') lane.reads += 1
      else lane.changes += 1
      if (event.failed) lane.failures += 1

      lane.marks.push({ at, action: event.action, failed: Boolean(event.failed) })
    }

    const rows = [...lanes.values()].sort((a, b) => a.first - b.first)
    const { colorOf } = folderRanking(rows.map((row) => row.dir))

    const times = rows.flatMap((row) => row.marks.map((mark) => mark.at))
    const start = times.length ? Math.min(...times) : Date.now()
    const end = live ? Date.now() : (times.length ? Math.max(...times) : Date.now())

    // A session that has only just started would otherwise divide by zero.
    const span = Math.max(end - start, 30_000)

    // Stretches where nothing was touched. They are the most informative
    // empty space on the chart, so they get named rather than left blank.
    const stamps = [...new Set(times)].sort((a, b) => a - b)
    const gaps = []
    for (let i = 1; i < stamps.length; i += 1) {
      const from = stamps[i - 1]
      const to = stamps[i]
      if (to - from >= IDLE_MS) gaps.push({ from, to })
    }

    // The stretch from the last touch to now counts too. Without it, a
    // session that has been thinking (or stuck, or waiting on you) for ten
    // minutes just looks like a chart with odd margins.
    const last = stamps[stamps.length - 1]
    if (live && last && end - last >= IDLE_MS) gaps.push({ from: last, to: end, open: true })

    return { rows, colorOf, start, end, span, gaps }
  }, [events, cwd, live])

  const { rows, colorOf, start, span, gaps } = model

  if (rows.length === 0) {
    return (
      <div className="river">
        <div className="map-empty">
          <p>Nothing to plot yet.</p>
          <p className="note">Each file gets a lane here as soon as it is touched.</p>
        </div>
      </div>
    )
  }

  const gutter = Math.max(GUTTER_MIN, Math.min(GUTTER, Math.round(width * GUTTER_SHARE)))
  const plotWidth = Math.max(width - gutter - PAD_RIGHT, 120)
  const height = TOP + rows.length * LANE + 10
  const x = (at) => gutter + ((at - start) / span) * plotWidth

  // Ask for as many ticks as actually fit. Asking for six regardless of width
  // is what smeared the axis into one unreadable run of digits on a phone.
  const step = niceStep(span, Math.max(2, Math.min(6, Math.floor(plotWidth / TICK_ROOM))))

  // Names are right-aligned against the plot, so trim the front and keep the
  // end: the extension and the distinguishing part of a filename live there.
  const nameMax = Math.max(6, Math.floor((gutter - 14) / NAME_CHAR))
  const shortName = (name) => (name.length <= nameMax ? name : `…${name.slice(-(nameMax - 1))}`)

  const ticks = []
  for (let t = Math.ceil(start / step) * step; t <= start + span; t += step) ticks.push(t)

  return (
    <div className="river" ref={attach}>
      <div className="river-scroll">
        <svg width={width} height={height} role="img" aria-label="File activity over time">
          {/* Idle stretches, behind everything. */}
          {gaps.map((gap) => (
            <g key={gap.from}>
              <rect
                x={x(gap.from)}
                y={TOP - 6}
                width={Math.max(x(gap.to) - x(gap.from), 1)}
                height={height - TOP}
                fill="rgba(98,108,125,0.07)"
              />
              {x(gap.to) - x(gap.from) > 46 && (
                <text
                  className="river-gap"
                  x={(x(gap.from) + x(gap.to)) / 2}
                  y={TOP - 23}
                  textAnchor="middle"
                >
                  {duration(gap.to - gap.from)} {gap.open ? 'since the last file' : 'idle'}
                </text>
              )}
            </g>
          ))}

          {/* Time axis: recessive, because it is a reference, not the point. */}
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={x(tick)}
                y1={TOP - 6}
                x2={x(tick)}
                y2={height - 10}
                stroke="var(--line)"
                strokeWidth="1"
              />
              <text className="river-tick" x={x(tick)} y={TOP - 10} textAnchor="middle">
                {clock(tick)}
              </text>
            </g>
          ))}

          {live && (
            <line
              x1={gutter + plotWidth}
              y1={TOP - 6}
              x2={gutter + plotWidth}
              y2={height - 10}
              stroke="var(--accent)"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
          )}

          {rows.map((row, i) => {
            const y = TOP + i * LANE + LANE / 2
            const color = colorOf.get(row.dir)
            return (
              <g key={row.path}>
                <line
                  x1={gutter}
                  y1={y}
                  x2={gutter + plotWidth}
                  y2={y}
                  stroke="var(--line)"
                  strokeWidth="1"
                  opacity="0.5"
                />
                <text className="river-name" x={gutter - 10} y={y + 3.5} textAnchor="end">
                  <title>{row.rel}</title>
                  {shortName(row.name)}
                </text>

                {row.marks.map((mark, m) => {
                  const cx = x(mark.at)
                  const read = mark.action === 'read' || mark.action === 'search'
                  const key = `${mark.at}-${m}`
                  return (
                    <g
                      key={key}
                      className="river-mark"
                      onMouseEnter={() => setHover({ row, mark, cx, y })}
                      onMouseLeave={() => setHover(null)}
                    >
                      {/* A hit target bigger than the mark, per the map's rule
                          that you should not have to aim. */}
                      <circle cx={cx} cy={y} r={7} fill="transparent" />
                      <circle
                        cx={cx}
                        cy={y}
                        r={mark.action === 'write' ? 5 : 4}
                        fill={read ? 'none' : color}
                        stroke={mark.failed ? CRITICAL : color}
                        strokeWidth={mark.failed ? 2 : 1.6}
                      />
                      {mark.action === 'write' && (
                        <circle cx={cx} cy={y} r={7.5} fill="none" stroke="var(--text)" strokeWidth="1" opacity="0.7" />
                      )}
                      {mark.failed && (
                        <path
                          d={`M${cx - 2.4} ${y - 2.4} L${cx + 2.4} ${y + 2.4} M${cx + 2.4} ${y - 2.4} L${cx - 2.4} ${y + 2.4}`}
                          stroke="var(--bg)"
                          strokeWidth="1.4"
                        />
                      )}
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>

        {hover && (
          <div
            className="map-tip"
            style={{ left: Math.min(Math.max(hover.cx, 80), width - 80), top: hover.y - 12 }}
          >
            <strong>{hover.row.name}</strong>
            <span className="map-tip-path">{hover.row.rel}</span>
            <span className="map-tip-counts">
              {hover.mark.action === 'write' ? 'written' : hover.mark.action === 'edit' ? 'edited' : hover.mark.action}
              {' at '}
              {new Date(hover.mark.at).toLocaleTimeString()}
            </span>
            {hover.mark.failed && <span className="map-tip-failed">✕ this call failed</span>}
          </div>
        )}
      </div>

      <div className="map-legend">
        <div className="map-legend-row">
          {[...new Set(rows.map((row) => row.dir))].slice(0, 6).map((dir) => (
            <span key={dir} className="map-key">
              <span className="map-swatch" style={{ background: colorOf.get(dir) }} />
              {dir === '.' ? './' : `${dir}/`}
            </span>
          ))}
        </div>
        <div className="map-legend-row map-legend-shapes">
          <span className="map-key"><span className="map-shape is-ring" /> read</span>
          <span className="map-key"><span className="map-shape is-solid" /> edited</span>
          <span className="map-key"><span className="map-shape is-new" /> written</span>
          <span className="map-key"><span className="map-shape is-failed">✕</span> failed</span>
          <span className="map-key map-key-note">time runs left to right, gaps are real</span>
        </div>
      </div>
    </div>
  )
}
