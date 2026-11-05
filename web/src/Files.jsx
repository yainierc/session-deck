import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readLocal, writeLocal } from './localKey.js'

/**
 * The project's files, the way the VS Code explorer shows them: a tree on the
 * left that loads a folder when you open it, names coloured by git, and the
 * file you click read back on the right. Read-only — design/archivos-v1.html,
 * variant B.
 *
 * The tree has two shapes. Browsing is folder by folder from the disk. A
 * search, or "only changes", is a flat list of paths from the server drawn as
 * a tree with every folder open — because filtering only what happens to be
 * loaded would miss everything you have not clicked into yet.
 */

const HIDDEN_KEY = 'deck.files.hidden'

const STATUS_LABEL = { M: 'modified', U: 'untracked', A: 'added', D: 'deleted', R: 'renamed' }

const WITHHELD = {
  secret: ['Not shown: named like a secret', 'Files like .env, keys and certificates never leave the machine, even when they are committed.'],
  ignored: ['Not shown: ignored by git', 'Ignored files are where local settings and secrets live, so their contents stay on the machine.'],
  binary: ['Binary file', 'There is nothing here to read as text.'],
  large: ['Too large to preview', 'Over 512 KB. Open it in your editor instead.'],
  deleted: ['Deleted', 'This file is gone from the working tree; git still has the last committed version.'],
}

function api(endpoint, root, params) {
  return fetch(`/api/${endpoint}?${new URLSearchParams({ root, ...params })}`).then((r) => r.json())
}

/* ---------- icons ---------- */

const FOLDER_COLOR = {
  src: '#e8a85f', app: '#e06c5f', web: '#5aa9e6', server: '#e8c35f', infra: '#e8c35f', shared: '#a274d8',
  test: '#3bb3a0', tests: '#3bb3a0', docs: '#4b8bd6', design: '#c678dd', scripts: '#9aa5b5',
  '.github': '#9aa5b5', '.claude': '#d97757', '.venv': '#7cb342', node_modules: '#7cb342', dist: '#d9534f', build: '#d9534f',
}
const EXT = {
  js: ['#e8d44d', 'JS'], mjs: ['#e8d44d', 'JS'], cjs: ['#e8d44d', 'JS'], ts: ['#3178c6', 'TS'], tsx: ['#3178c6', 'TS'],
  jsx: ['#61dafb', '⚛'], json: ['#cbcb41', '{}'], md: ['#4b8bd6', 'M'], html: ['#e44d26', '<>'], css: ['#7c5cc4', '#'],
  sh: ['#89e051', '$'], py: ['#4b8bd6', 'Py'], toml: ['#9aa5b5', 'T'], yaml: ['#cb4b6a', 'Y'], yml: ['#cb4b6a', 'Y'],
  lock: ['#c678dd', '▮'], cs: ['#68217a', 'C#'], sql: ['#e38c00', 'SQ'], txt: ['#8b94a3', '≡'],
}

function FolderIcon({ name, open }) {
  const c = FOLDER_COLOR[name] || '#8b94a3'
  return open ? (
    <svg className="fx-ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 3.5h4.2l1.4 1.5h6.4v1.5H4L1.5 12.5z" fill={c} opacity=".7" />
      <path d="M4 6.5h11l-2.5 6.5h-11z" fill={c} />
    </svg>
  ) : (
    <svg className="fx-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4.2l1.4 1.5h7.4v8h-13z" fill={c} /></svg>
  )
}

function FileIcon({ name }) {
  if (name === '.gitignore' || name === '.gitattributes') {
    return <svg className="fx-ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" transform="rotate(45 8 8)" fill="#e5533d" /></svg>
  }
  const ext = /\.lock$|lock\.json$/.test(name) ? 'lock' : name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  const [c, t] = EXT[ext] || ['#8b94a3', '']
  return (
    <svg className="fx-ico" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="1.5" width="11" height="13" rx="2" fill={c} opacity=".18" stroke={c} />
      <text x="8" y="11" textAnchor="middle" fontSize={t.length > 1 ? 6 : 8} fontWeight="700" fill={c} fontFamily="ui-monospace,Menlo,monospace">{t}</text>
    </svg>
  )
}

const Chevron = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" /></svg>
)

/** A flat list of paths as nested folders, each marked if anything inside changed. */
function treeFromPaths(list) {
  const root = { kids: new Map() }
  for (const { path, status } of list) {
    const parts = path.split('/')
    let node = root
    parts.forEach((name, i) => {
      const p = parts.slice(0, i + 1).join('/')
      const dir = i < parts.length - 1
      if (!node.kids.has(name)) node.kids.set(name, { name, path: p, dir, kids: dir ? new Map() : null })
      node = node.kids.get(name)
      if (dir && status) node.changed = true
      if (!dir) node.status = status
    })
  }
  const sorted = (n) => [...n.kids.values()]
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  return { root, sorted }
}

function Highlight({ text, query }) {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (i < 0) return text
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + query.length)}</mark>{text.slice(i + query.length)}</>
}

export function ProjectFiles({ root }) {
  const [dirs, setDirs] = useState({})
  const [open, setOpen] = useState(() => new Set())
  const [selected, setSelected] = useState(null)
  const [showHidden, setShowHidden] = useState(() => readLocal(HIDDEN_KEY) === '1')
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState(null)
  const [file, setFile] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const rowsRef = useRef(null)
  const filterRef = useRef(null)

  const loadDir = useCallback((rel) => {
    setDirs((d) => ({ ...d, [rel]: { ...d[rel], loading: true } }))
    return api('files', root, { path: rel, ...(showHidden ? { hidden: '1' } : {}) })
      .then((data) => setDirs((d) => ({ ...d, [rel]: data.ok ? { entries: data.entries } : { error: data.error } })))
      .catch(() => setDirs((d) => ({ ...d, [rel]: { error: 'Could not read this folder' } })))
  }, [root, showHidden])

  // A new project, or hidden files switched: start again from the top.
  useEffect(() => {
    setDirs({})
    setOpen(new Set())
    setSelected(null)
    setFile(null)
    setPreviewOpen(false)
    loadDir('')
  }, [loadDir])

  // Search and "only changes" ask the server for paths, not the tree.
  const flatMode = Boolean(query.trim()) || onlyChanged
  const loadHits = useCallback(() => {
    const q = query.trim()
    const req = onlyChanged
      ? api('files', root, { changed: '1' }).then((d) => ({ ...d, files: (d.files || []).filter((f) => !q || f.path.split('/').pop().toLowerCase().includes(q.toLowerCase())) }))
      : api('files', root, { find: q, ...(showHidden ? { hidden: '1' } : {}) })
    return req.then((d) => setHits(d.ok ? d : { files: [], error: d.error })).catch(() => setHits({ files: [], error: 'Could not search this project' }))
  }, [root, query, onlyChanged, showHidden])

  useEffect(() => {
    if (!flatMode) { setHits(null); return }
    const t = setTimeout(loadHits, 180)
    return () => clearTimeout(t)
  }, [flatMode, loadHits])

  const openFile = useCallback((path, status) => {
    setSelected(path)
    setPreviewOpen(true)
    // Listed by "only changes", gone from the disk: nothing to ask for.
    if (status === 'D') return setFile({ path, ok: true, status, withheld: 'deleted' })
    setFile({ path, loading: true })
    api('file', root, { path })
      .then((data) => setFile({ path, ...data }))
      .catch(() => setFile({ path, ok: false, error: 'Could not read this file' }))
  }, [root])

  const toggleDir = (path) => {
    setSelected(path)
    const opening = !open.has(path)
    if (opening && !dirs[path]?.entries) loadDir(path)
    setOpen((prev) => {
      const next = new Set(prev)
      if (opening) next.add(path)
      else next.delete(path)
      return next
    })
  }

  const refresh = () => {
    loadDir('')
    open.forEach((p) => loadDir(p))
    if (flatMode) loadHits()
    if (file?.path) openFile(file.path, file.status === 'D' ? 'D' : undefined)
  }

  /* The rows on screen, in order: what the keyboard walks and what renders. */
  const rows = useMemo(() => {
    const out = []
    if (flatMode) {
      if (!hits) return out
      const { root: tree, sorted } = treeFromPaths(hits.files || [])
      const walk = (n, depth) => sorted(n).forEach((k) => {
        out.push({ ...k, depth, open: k.dir })
        if (k.dir) walk(k, depth + 1)
      })
      walk(tree, 0)
      return out
    }
    const walk = (rel, depth) => {
      const dir = dirs[rel]
      if (!dir) return
      if (dir.error) { out.push({ note: dir.error, depth, path: `${rel}#error` }); return }
      if (!dir.entries) { out.push({ note: 'Loading…', depth, path: `${rel}#loading` }); return }
      if (!dir.entries.length && rel) out.push({ note: 'Empty folder', depth, path: `${rel}#empty` })
      for (const e of dir.entries) {
        const isOpen = e.dir && open.has(e.path)
        out.push({ ...e, depth, open: isOpen })
        if (isOpen) {
          if (e.ignored) out.push({ note: 'Ignored by git — not listed', depth: depth + 1, path: `${e.path}#ignored` })
          else walk(e.path, depth + 1)
        }
      }
    }
    walk('', 0)
    return out
  }, [flatMode, hits, dirs, open])

  const items = rows.filter((r) => !r.note)

  const onKeyDown = (e) => {
    const i = items.findIndex((r) => r.path === selected)
    const cur = items[i]
    if (e.key === 'ArrowDown') setSelected(items[Math.min(items.length - 1, i + 1)]?.path)
    else if (e.key === 'ArrowUp') setSelected(items[Math.max(0, i - 1)]?.path)
    else if (e.key === 'ArrowRight' && cur?.dir && !cur.open && !flatMode) toggleDir(cur.path)
    else if (e.key === 'ArrowLeft' && cur) {
      if (cur.dir && cur.open && !flatMode) toggleDir(cur.path)
      else { const up = cur.path.split('/').slice(0, -1).join('/'); if (up) setSelected(up) }
    } else if (e.key === 'Enter' && cur) cur.dir ? (!flatMode && toggleDir(cur.path)) : openFile(cur.path, cur.status)
    else return
    e.preventDefault()
  }

  useEffect(() => {
    rowsRef.current?.querySelector('.fx-row.is-sel')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // `/` jumps to the filter, as in GitHub. Not while typing somewhere else.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return
      const t = e.target
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      filterRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const projectName = root.split(/[\\/]/).filter(Boolean).pop() || root

  return (
    <div className={`fx${previewOpen ? ' show-preview' : ''}`}>
      <div className="fx-tree">
        <div className="fx-tbar">
          <span className="fx-root" title={root}>{projectName}</span>
          <button
            className={`fx-ibtn${showHidden ? ' is-on' : ''}`}
            title={showHidden ? 'Hide dotfiles' : 'Show dotfiles (.github, .gitignore…)'}
            aria-pressed={showHidden}
            onClick={() => { writeLocal(HIDDEN_KEY, showHidden ? '0' : '1'); setShowHidden(!showHidden) }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>
          </button>
          <button
            className={`fx-ibtn${onlyChanged ? ' is-on' : ''}`}
            title="Only files with changes"
            aria-pressed={onlyChanged}
            onClick={() => setOnlyChanged(!onlyChanged)}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="2.4" fill="currentColor" /><circle cx="8" cy="8" r="6" /></svg>
          </button>
          <button className="fx-ibtn" title="Read the disk again" onClick={refresh}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" /></svg>
          </button>
          <button className="fx-ibtn" title="Collapse all" onClick={() => setOpen(new Set())}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5 8h6" /></svg>
          </button>
        </div>
        <label className="fx-filter">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
          <input
            ref={filterRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setQuery(''); rowsRef.current?.focus() }
              if (e.key === 'ArrowDown') { e.preventDefault(); rowsRef.current?.focus(); if (!selected) setSelected(items[0]?.path) }
            }}
            placeholder="Filter by name…  (/)"
            autoComplete="off"
            spellCheck="false"
          />
        </label>

        <div className="fx-rows" ref={rowsRef} role="tree" tabIndex={0} onKeyDown={onKeyDown}>
          {flatMode && !hits && <div className="fx-note">Searching…</div>}
          {flatMode && hits?.error && <div className="fx-note">{hits.error}</div>}
          {flatMode && hits && !hits.error && !hits.files.length && (
            <div className="fx-note">{onlyChanged ? (hits.git === false ? 'Not a git repository.' : 'Nothing has changed.') : `No file name contains “${query.trim()}”.`}</div>
          )}
          {rows.map((r) => {
            const pad = 8 + r.depth * 12
            const guides = Array.from({ length: r.depth }, (_, i) => <span key={i} className="fx-guide" style={{ left: 16 + i * 12 }} />)
            if (r.note) return <div key={r.path} className="fx-note" style={{ paddingLeft: pad + 22 }}>{guides}{r.note}</div>
            const cls = ['fx-row', r.open && 'is-open', r.path === selected && 'is-sel', r.status && `st-${r.status}`,
              r.dir && r.changed && 'has-changes', r.ignored && 'is-ignored'].filter(Boolean).join(' ')
            return (
              <div
                key={r.path}
                className={cls}
                role="treeitem"
                aria-expanded={r.dir ? Boolean(r.open) : undefined}
                aria-selected={r.path === selected}
                style={{ paddingLeft: pad }}
                title={r.path}
                onClick={() => (r.dir ? (flatMode ? setSelected(r.path) : toggleDir(r.path)) : openFile(r.path, r.status))}
              >
                {guides}
                <span className="fx-chev">{r.dir && <Chevron />}</span>
                {r.dir ? <FolderIcon name={r.name} open={r.open} /> : <FileIcon name={r.name} />}
                <span className="fx-name"><Highlight text={r.name} query={query.trim()} /></span>
                {r.status && <span className={`fx-gs ${r.status}`} title={STATUS_LABEL[r.status]}>{r.status}</span>}
                {r.dir && r.changed && !r.open && <span className="fx-gdot" title="Has changes inside" />}
              </div>
            )
          })}
          {flatMode && hits?.truncated && <div className="fx-note">Showing the first {hits.files.length}. Type more to narrow it.</div>}
        </div>
      </div>

      <Preview root={root} file={file} onBack={() => setPreviewOpen(false)} />
    </div>
  )
}

function Preview({ root, file, onBack }) {
  const [copied, setCopied] = useState(false)
  if (!file) {
    return (
      <div className="fx-preview">
        <div className="fx-empty"><div><b>Pick a file</b>It opens here, read-only.</div></div>
      </div>
    )
  }

  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const abs = `${root.replace(/[\\/]+$/, '')}${sep}${file.path.split('/').join(sep)}`
  const parts = file.path.split('/')
  const name = parts.pop()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(abs)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // No clipboard over plain http from another device. The path is in the
      // header's tooltip and selectable, which is the fallback Pairing uses too.
      window.prompt('Copy the path:', abs)
    }
  }

  let body
  if (file.loading) body = <div className="fx-empty">Reading…</div>
  else if (!file.ok) body = <div className="fx-empty"><div><b>Could not open it</b>{file.error}</div></div>
  else if (file.withheld) {
    const [title, why] = WITHHELD[file.withheld] || ['Not shown', '']
    body = <div className="fx-empty"><div><b>{title}</b>{why}</div></div>
  } else {
    const lines = file.text.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    body = (
      <div className="fx-code">
        <div className="fx-gutter" aria-hidden="true">{lines.map((_, i) => <div key={i}>{i + 1}</div>)}</div>
        <pre className="fx-text">{file.text}</pre>
      </div>
    )
  }

  return (
    <div className="fx-preview">
      <div className="fx-pbar">
        <button className="btn btn-slim fx-back" onClick={onBack}>← Files</button>
        <span className="fx-path" title={abs}>{parts.length > 0 && `${parts.join('/')}/`}<b>{name}</b></span>
        {file.status && <span className={`fx-pill ${file.status}`}>{STATUS_LABEL[file.status]}</span>}
        <button className="btn btn-slim fx-wide" onClick={copy}>{copied ? 'Copied' : 'Copy path'}</button>
        <a className="btn btn-slim fx-wide" href={`vscode://file${abs.startsWith('/') ? '' : '/'}${abs}`} title="Open in VS Code on this computer">
          Open in editor
        </a>
      </div>
      {body}
    </div>
  )
}
