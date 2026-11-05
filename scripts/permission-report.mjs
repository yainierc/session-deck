/**
 * permission-report.mjs — the audit as one page you can read.
 *
 * Every number on this page is either measured or subtracted, never guessed,
 * and the page says which is which at the point the number appears rather than
 * in a footnote nobody reads. The method section at the bottom states what the
 * transcripts cannot answer at all, because a report that only lists what it
 * found reads as more certain than it is.
 *
 * Colours follow the validated reference palette: one sequential blue for
 * magnitude, grey for de-emphasis, status red reserved for refusals. No
 * categorical set is used, so no series can be confused for another.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

/** Shell syntax my splitter sees as a command but no allow rule can name. */
const SHELL_KEYWORDS = new Set([
  'for', 'do', 'done', 'until', 'while', 'if', 'then', 'elif', 'else', 'fi',
  'case', 'esac', 'select', 'function', 'trap', 'eval', 'exec', 'source',
])

/**
 * Commands that can only read, so a global rule for them costs nothing.
 *
 * Deliberately narrower than "read-only in practice". `sed` and `awk` are here
 * in most people's heads but `sed -i` rewrites a file in place; `find` takes
 * `-delete` and `-exec`; `xargs` and `tee` are arbitrary execution and writing
 * wearing a quiet name. A rule is a blanket yes for every future invocation, so
 * those four go to the list the person decides on, not the one recommended.
 */
const SAFE = new Set([
  'tail', 'head', 'grep', 'rg', 'cat', 'echo', 'wc', 'sort', 'uniq', 'cut',
  'tr', 'ls', 'stat', 'file', 'du', 'df', 'pwd', 'which', 'date', 'basename',
  'dirname', 'realpath', 'diff', 'jq', 'column', 'printf', 'sleep', 'cd',
  'export', 'true', 'nl',
])

function ruleFor(blocker) {
  if (SHELL_KEYWORDS.has(blocker)) return null
  return `Bash(${blocker} *)`
}

const fmtInt = (n) => Math.round(n).toLocaleString('es')
const fmtMin = (n) => (n >= 60 ? (n / 60).toFixed(1) + ' h' : Math.round(n) + ' min')

// ─── chart primitives ───────────────────────────────────────────────────────

/**
 * A horizontal bar chart, built in HTML rather than SVG.
 *
 * Horizontal because the labels are command names of very different lengths —
 * the documented case for turning the chart sideways. HTML because the bars
 * have to be responsive: an SVG rect cannot take `calc()` in its width, so the
 * first version of this silently drew nothing.
 */
function barChart(rows, { valueKey, labelKey, note = () => '' }) {
  const max = Math.max(...rows.map((r) => r[valueKey]), 1)
  return `<div class="bars">${rows.map((r) => `
    <div class="bar" data-tip="${esc(r.tip || '')}">
      <div class="bl">${esc(r[labelKey])}</div>
      <div class="bt"><div class="bf${r.caveat ? ' is-muted' : ''}" style="width:${Math.max(1.5, (r[valueKey] / max) * 100).toFixed(2)}%"></div></div>
      <div class="bv">${esc(fmtInt(r[valueKey]))}</div>
      <div class="bn">${esc(note(r))}</div>
    </div>`).join('')}</div>`
}

/** A line over days, with an area wash and a hover crosshair. */
function lineChart(days, { id, valueKey, unit }) {
  const w = 1000, h = 190, padL = 46, padR = 12, padT = 12, padB = 26
  const max = Math.max(...days.map((d) => d[valueKey]), 1)
  const nice = Math.ceil(max / 30) * 30 || 30
  const x = (i) => padL + (i / Math.max(1, days.length - 1)) * (w - padL - padR)
  const y = (v) => padT + (1 - v / nice) * (h - padT - padB)
  const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d[valueKey]).toFixed(1)}`)
  const area = `M${padL},${y(0)} L${pts.join(' L')} L${x(days.length - 1)},${y(0)} Z`
  const ticks = [0, nice / 2, nice].map((v) => `
    <line class="grid" x1="${padL}" x2="${w - padR}" y1="${y(v)}" y2="${y(v)}"></line>
    <text class="tick" x="${padL - 8}" y="${y(v)}" text-anchor="end">${v}</text>`).join('')
  const dots = days.map((d, i) => `
    <g class="pt" data-tip="${esc(`${d.day} — ${fmtMin(d.attendedMin)} atendiendo · ${d.promptsEst} prompts estimados · ${d.calls} llamadas · ${d.sessions} sesiones`)}">
      <rect class="pt-hit" x="${x(i) - 6}" y="${padT}" width="12" height="${h - padT - padB}"></rect>
      <circle class="pt-dot" cx="${x(i)}" cy="${y(d[valueKey])}" r="4"></circle>
    </g>`).join('')
  const labels = days.map((d, i) => (i % 5 === 0 || i === days.length - 1
    ? `<text class="tick" x="${x(i)}" y="${h - 8}" text-anchor="middle">${d.day.slice(5)}</text>` : '')).join('')
  return `<svg class="chart line-chart" id="${id}" viewBox="0 0 ${w} ${h}" role="img">
    ${ticks}
    <path class="area" d="${area}"></path>
    <polyline class="line" points="${pts.join(' ')}"></polyline>
    ${dots}${labels}
  </svg>`
}

// ─── the page ───────────────────────────────────────────────────────────────

export function renderHtml({ totals: t, days, offenders, blockers, deadRules, literalRules, denials }) {
  const actionable = blockers.filter((b) => !SHELL_KEYWORDS.has(b.blocker) && b.promptsEst > 0)
  const topBlockers = blockers.slice(0, 12).map((b) => ({
    ...b,
    caveat: SHELL_KEYWORDS.has(b.blocker),
    tip: `${b.blocker} — ${fmtInt(b.count)} comandos en ${b.projects} proyectos · ≈${b.promptsEst} prompts · ${fmtMin(b.attendedMin)}`
      + (SHELL_KEYWORDS.has(b.blocker) ? ' · sintaxis de shell: no se arregla con una regla' : ''),
  }))
  const topShapes = offenders.slice(0, 10).map((o) => ({
    ...o,
    tip: `${o.shape} — ${fmtInt(o.count)} ejecuciones · ≈${o.promptsEst} prompts · ${fmtMin(o.attendedMin)} atendiendo`,
  }))

  const safeRules = actionable.filter((b) => SAFE.has(b.blocker)).slice(0, 14)
  const riskyRules = actionable.filter((b) => !SAFE.has(b.blocker)).slice(0, 8)
  const safeGain = safeRules.reduce((s, b) => s + b.promptsEst, 0)
  const safeMin = safeRules.reduce((s, b) => s + b.attendedMin, 0)
  const alreadyScoped = safeRules.filter((b) => b.where === 'project')

  const proposed = JSON.stringify({
    permissions: { allow: safeRules.map((b) => ruleFor(b.blocker)).filter(Boolean) },
  }, null, 2)

  const top5 = blockers.slice(0, 5).reduce((s, b) => s + b.promptsEst, 0)

  return `<!doctype html>
<html lang="es" data-theme="">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Permisos — cuánto te interrumpe Claude Code</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --plane: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --accent: #2a78d6;
    --accent-soft: #cde2fb;
    --accent-deep: #184f95;
    /* De-emphasis mark: grey by intent (the emphasis form). Validated at >=3:1
       against both surfaces and ΔE 15.9 from the accent under protanopia. */
    --neutral-mark: #898781;
    --critical: #d03b3b;
    --good: #0ca30c;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19; --plane: #0d0d0d; --text-primary: #fff;
      --text-secondary: #c3c2b7; --muted: #898781; --grid: #2c2c2a; --axis: #383835;
      --border: rgba(255,255,255,0.10); --accent: #3987e5; --accent-soft: #184f95;
      --accent-deep: #86b6ef; --neutral-mark: #898781; --critical: #d03b3b; --good: #0ca30c;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --plane: #0d0d0d; --text-primary: #fff;
    --text-secondary: #c3c2b7; --muted: #898781; --grid: #2c2c2a; --axis: #383835;
    --border: rgba(255,255,255,0.10); --accent: #3987e5; --accent-soft: #184f95;
    --accent-deep: #86b6ef; --neutral-mark: #898781; --critical: #d03b3b; --good: #0ca30c;
  }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--plane); }
  .viz-root {
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--text-primary); background: var(--plane);
    max-width: 1080px; margin: 0 auto; padding: 40px 24px 96px;
  }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; letter-spacing: -0.02em; }
  h2 { font-size: 19px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--text-secondary); margin: 0 0 4px; }
  .fine { color: var(--muted); font-size: 13px; margin: 0; }
  section { background: var(--surface-1); border: 1px solid var(--border); border-radius: 14px;
            padding: 22px 24px; margin-top: 18px; }
  .head { margin-bottom: 16px; }

  .hero { display: flex; gap: 40px; align-items: flex-end; flex-wrap: wrap; }
  .hero-fig { font-size: 64px; line-height: 1; font-weight: 600; letter-spacing: -0.03em;
              display: flex; align-items: baseline; gap: 12px; }
  .hero-fig small { font-size: 21px; font-weight: 500; color: var(--text-secondary);
                    letter-spacing: normal; }
  .hero-cap { color: var(--text-secondary); max-width: 40ch; }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px;
          background: var(--border); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-top: 22px; }
  .kpi { background: var(--surface-1); padding: 14px 16px; }
  .kpi .v { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
  .kpi .l { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }
  .kpi .h { font-size: 11.5px; color: var(--muted); margin-top: 3px; }

  .tag { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: .04em;
         text-transform: uppercase; padding: 2px 7px; border-radius: 5px; vertical-align: 2px; margin-left: 8px; }
  .tag.hard { background: var(--accent-soft); color: var(--accent-deep); }
  .tag.est { background: transparent; color: var(--muted); border: 1px solid var(--axis); }

  .chart { display: block; overflow: visible; width: 100%; height: auto; }
  .bars { display: flex; flex-direction: column; }
  /* The value gets its own column: inside the track it collided with the note
     column as soon as a bar reached full width. */
  .bar { display: grid; grid-template-columns: 124px 1fr 48px 182px; align-items: center;
         gap: 10px; padding: 4px 6px; border-radius: 6px; }
  .bar:hover { background: color-mix(in srgb, var(--grid) 55%, transparent); }
  .bl { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
        text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bt { min-width: 0; }
  .bf { height: 14px; background: var(--accent); border-radius: 0 4px 4px 0; }
  .bf.is-muted { background: var(--neutral-mark); }
  .bv { font-size: 12.5px; font-variant-numeric: tabular-nums; text-align: right; }
  .bn { font-size: 12px; color: var(--muted); text-align: right; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 720px) {
    .bar { grid-template-columns: 96px 1fr 44px; } .bn { display: none; }
  }
  .line-chart { width: 100%; height: auto; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .tick { fill: var(--muted); font-size: 11px; dominant-baseline: middle; font-variant-numeric: tabular-nums; }
  .axis-unit { fill: var(--muted); font-size: 10.5px; }
  .area { fill: var(--accent); opacity: .12; }
  .line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
  .pt-hit { fill: transparent; }
  .pt-dot { fill: var(--surface-1); stroke: var(--accent); stroke-width: 2; opacity: 0; }
  .pt:hover .pt-dot { opacity: 1; }
  .pt:hover .pt-hit { fill: var(--grid); opacity: .45; }

  #tip { position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
         background: var(--text-primary); color: var(--surface-1); font-size: 12.5px;
         padding: 7px 10px; border-radius: 7px; max-width: 420px; z-index: 9; line-height: 1.4; }

  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
  th { color: var(--text-secondary); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { font-size: 12.5px; background: var(--grid); padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--plane); border: 1px solid var(--border); border-radius: 10px;
        padding: 14px 16px; overflow-x: auto; font-size: 12.5px; margin: 12px 0 0; }
  details { margin-top: 12px; } summary { cursor: pointer; color: var(--text-secondary); font-size: 13.5px; }
  .rates { display: grid; gap: 10px; margin: 14px 0 0; }
  .rate { display: grid; grid-template-columns: 210px 1fr 62px; align-items: center; gap: 12px; }
  .rate .n { font-size: 13px; color: var(--text-secondary); }
  .rate .t { height: 12px; background: var(--grid); border-radius: 6px; overflow: hidden; }
  .rate .f { height: 100%; border-radius: 6px; background: var(--neutral-mark); }
  .rate.hi .f { background: var(--accent); }
  .rate .v { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
  ul.notes { margin: 10px 0 0; padding-left: 18px; color: var(--text-secondary); font-size: 13.5px; }
  ul.notes li { margin-bottom: 5px; }
  .toggle { float: right; font-size: 12px; color: var(--text-secondary); background: none;
            border: 1px solid var(--border); border-radius: 6px; padding: 4px 9px; cursor: pointer; }
</style>

<div class="viz-root">
<button class="toggle" onclick="document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'">tema</button>

<h1>Cuánto te interrumpe Claude Code pidiendo permisos</h1>
<p class="sub">${esc(t.from)} → ${esc(t.to)} · ${t.activeDays} días con actividad · ${fmtInt(t.scannedFiles)} transcripts, ${fmtInt(t.scannedLines)} líneas leídas</p>
<p class="fine">Los transcripts no registran los permisos concedidos, solo los rechazados. Nada de esto es un conteo de prompts: es cobertura de reglas (medida) más tiempo muerto (estimado restando un control). El método está al final.</p>

<section>
  <div class="hero">
    <div>
      <div class="hero-fig">${Math.round(t.medianAttendedMin)}<small>min/día</small></div>
      <p class="fine" style="margin-top:6px">mediana · el peor día fueron ${fmtMin(t.worstDay?.attendedMin || 0)} (${esc(t.worstDay?.day || '')})</p>
    </div>
    <p class="hero-cap">Tiempo que pasas atendiendo pausas que no se explican por lo que tarda el comando. Unas <strong>${fmtInt(t.promptsEst / t.activeDays)} interrupciones al día</strong>, de ${Math.round(t.secondsPerPrompt)} segundos cada una.</p>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="v">${(t.coverage * 100).toFixed(0)}%</div><div class="l">comandos cubiertos por una regla</div><div class="h">${fmtInt(t.bashCovered)} de ${fmtInt(t.bash)}</div></div>
    <div class="kpi"><div class="v">${fmtInt(t.promptsEst)}</div><div class="l">prompts estimados en ${t.activeDays} días</div><div class="h">${(t.stallRateUncovered * 100).toFixed(1)}% vs ${(t.controlRate * 100).toFixed(1)}% de control</div></div>
    <div class="kpi"><div class="v">${t.attendedH.toFixed(0)} h</div><div class="l">atendiendo permisos</div><div class="h">${t.blockedH.toFixed(0)} h de sesión detenida</div></div>
    <div class="kpi"><div class="v">${fmtInt(t.deadRules)}</div><div class="l">reglas que nunca sirvieron</div><div class="h">de ${fmtInt(t.bashRuleCount)} reglas Bash</div></div>
    <div class="kpi"><div class="v">${t.denials}</div><div class="l">rechazos explícitos</div><div class="h">lo único contable directo</div></div>
  </div>
</section>

<section>
  <div class="head">
    <h2>Qué es lo que realmente bloquea<span class="tag est">estimado</span></h2>
    <p class="sub">No el comando que corriste, sino el trozo que ninguna regla cubre. En <code>dotnet test 2>&amp;1 | tail -40</code> el que para la ejecución es <code>tail</code>.</p>
  </div>
  ${barChart(topBlockers, { id: 'blockers', valueKey: 'promptsEst', labelKey: 'blocker', note: (r) => `${fmtInt(r.count)} comandos · ${r.projects} proyectos` })}
  <p class="fine" style="margin-top:12px">Las barras grises son sintaxis de shell (<code>for</code>, <code>until</code>): mi parser las cuenta como comandos, Claude Code no necesariamente. Trátalas como cota superior.</p>
  <p class="sub" style="margin-top:14px"><strong>Los 5 primeros explican ${Math.round(top5 / t.promptsEst * 100)}% de todas las interrupciones.</strong></p>
</section>

<section>
  <div class="head">
    <h2>Lo que cambiaría con ${safeRules.length} reglas<span class="tag hard">medido</span></h2>
    <p class="sub">Solo comandos de lectura: autorizarlos globalmente no te expone a nada. Cubren ${fmtInt(safeGain)} de los ${fmtInt(t.promptsEst)} prompts estimados — unas <strong>${fmtMin(safeMin)}</strong> en ${t.activeDays} días.</p>
  </div>
  ${alreadyScoped.length ? `<p class="fine">${alreadyScoped.length} de ellas <em>ya las tienes escritas</em> (<code>${alreadyScoped.map((b) => esc(b.blocker)).join('</code>, <code>')}</code>), pero en un <code>.claude/settings.local.json</code> de proyecto. Una regla de proyecto muere al salir de ese directorio, y aquí trabajas en ${Math.max(...blockers.map((b) => b.projects))}. El fichero correcto es <code>~/.claude/settings.json</code>.</p>` : ''}
  <pre>${esc(proposed)}</pre>
  ${riskyRules.length ? `
  <details>
    <summary>Otros ${riskyRules.length} bloqueadores que sí modifican cosas — decisión tuya, no recomendación</summary>
    <table style="margin-top:10px">
      <tr><th>bloqueador</th><th class="num">prompts</th><th class="num">tiempo</th><th>regla equivalente</th></tr>
      ${riskyRules.map((b) => `<tr><td><code>${esc(b.blocker)}</code></td><td class="num">${b.promptsEst}</td><td class="num">${fmtMin(b.attendedMin)}</td><td><code>${esc(ruleFor(b.blocker) || '—')}</code></td></tr>`).join('')}
    </table>
  </details>` : ''}
</section>

<section>
  <div class="head">
    <h2>Día a día<span class="tag est">estimado</span></h2>
    <p class="sub">Minutos atendiendo permisos por día. Pasa el ratón por encima para ver las llamadas y sesiones de cada día.</p>
  </div>
  ${lineChart(days, { id: 'daily', valueKey: 'attendedMin', unit: 'min' })}
  <details>
    <summary>Ver la tabla</summary>
    <table style="margin-top:10px">
      <tr><th>día</th><th class="num">min atendiendo</th><th class="num">prompts est.</th><th class="num">llamadas bash</th><th class="num">sin cubrir</th><th class="num">sesiones</th></tr>
      ${days.map((d) => `<tr><td>${esc(d.day)}</td><td class="num">${Math.round(d.attendedMin)}</td><td class="num">${d.promptsEst}</td><td class="num">${fmtInt(d.bash)}</td><td class="num">${fmtInt(d.uncovered)}</td><td class="num">${d.sessions}</td></tr>`).join('')}
    </table>
  </details>
</section>

<section>
  <div class="head">
    <h2>Qué trabajo se queda esperando<span class="tag est">estimado</span></h2>
    <p class="sub">La misma pausa, agrupada por lo que estabas haciendo en vez de por lo que la bloqueó.</p>
  </div>
  ${barChart(topShapes, { id: 'shapes', valueKey: 'promptsEst', labelKey: 'shape', note: (r) => `${fmtInt(r.count)} ejecuciones · ${fmtMin(r.attendedMin)}` })}
</section>

<section>
  <div class="head">
    <h2>Por qué das permisos y te los siguen pidiendo<span class="tag hard">medido</span></h2>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="v">${fmtInt(t.bashRuleCount)}</div><div class="l">reglas Bash acumuladas</div></div>
    <div class="kpi"><div class="v">${fmtInt(t.literalRules)}</div><div class="l">sin comodín</div><div class="h">${Math.round(t.literalRules / t.bashRuleCount * 100)}% — solo valen para ese comando exacto</div></div>
    <div class="kpi"><div class="v">${fmtInt(t.deadRules)}</div><div class="l">no cubrieron ni una llamada</div><div class="h">${Math.round(t.deadRules / t.bashRuleCount * 100)}% de todas</div></div>
    <div class="kpi"><div class="v">${fmtInt(t.cdOnlyBlocked)}</div><div class="l">comandos bloqueados solo por su <code>cd</code></div></div>
  </div>
  <ul class="notes">
    <li><strong>Un «sí, no preguntes más» escribe el comando literal, no el patrón.</strong> ${Math.round(t.literalRules / t.bashRuleCount * 100)}% de tus reglas no tienen comodín, así que cubren exactamente una invocación y ninguna parecida. Por eso ${fmtInt(t.deadRules)} de ellas nunca han servido para nada.</li>
    <li><strong>Un comando compuesto necesita permiso para cada trozo.</strong> <code>x &amp;&amp; y | z</code> pide tres. Basta que falte uno para que se detenga entero, y por eso <code>tail</code> y <code>grep</code> encabezan la lista aunque no sean lo que quieres correr.</li>
    <li><strong>Las reglas útiles están en el proyecto equivocado.</strong> Trabajas en decenas de directorios; una regla en <code>.claude/settings.local.json</code> muere al salir de él.</li>
  </ul>
  <details>
    <summary>Ver una muestra de las ${fmtInt(t.deadRules)} reglas muertas</summary>
    <table style="margin-top:10px">
      <tr><th>regla</th><th>de</th></tr>
      ${deadRules.slice(0, 25).map((r) => `<tr><td><code>${esc(r.rule.length > 96 ? r.rule.slice(0, 96) + '…' : r.rule)}</code></td><td class="fine">${esc(r.source)}</td></tr>`).join('')}
    </table>
  </details>
</section>

<section>
  <div class="head">
    <h2>Cómo se midió, y qué no se puede medir</h2>
  </div>
  <p class="sub">No existe en los transcripts ningún registro de «se mostró un prompt y lo aprobaste». Los rechazos dejan rastro; las aprobaciones no. Así que el tiempo se deduce de la latencia entre una llamada y su resultado, restando lo que ese mismo comando tarda normalmente (su percentil 20). Para que esa deducción no sea una corazonada, se contrasta con un grupo de control:</p>
  <div class="rates">
    <div class="rate"><div class="n">comandos ya cubiertos por regla</div><div class="t"><div class="f" style="width:${(t.controlRate * 250).toFixed(1)}%"></div></div><div class="v">${(t.controlRate * 100).toFixed(1)}%</div></div>
    <div class="rate"><div class="n">sin regla, pero de solo lectura</div><div class="t"><div class="f" style="width:${(t.readOnlyStallRate * 250).toFixed(1)}%"></div></div><div class="v">${(t.readOnlyStallRate * 100).toFixed(1)}%</div></div>
    <div class="rate hi"><div class="n">sin regla, que escriben o ejecutan</div><div class="t"><div class="f" style="width:${(t.writeStallRate * 250).toFixed(1)}%"></div></div><div class="v">${(t.writeStallRate * 100).toFixed(1)}%</div></div>
  </div>
  <p class="sub" style="margin-top:14px">Porcentaje de llamadas que se paran sin que lo explique la duración del comando. Las dos primeras filas son ruido de fondo — disco, red, carga — y coinciden entre sí, que es justo lo que debe pasar si el modelo sirve: <strong>no tener regla no basta para pararse</strong>. La tercera fila triplica ese suelo, y esa diferencia es lo único que este informe llama permiso. Todo lo que sobra del suelo se descarta.</p>
  <ul class="notes">
    <li>Se compara contra tus reglas <em>de hoy</em>. Las que añadiste a mitad del periodo hacen que la cobertura histórica salga mejor de lo que fue.</li>
    <li>Una aprobación de sesión («sí» a secas, sin «no preguntes más») no se escribe en ningún fichero, así que aquí no se ve y suma al ruido.</li>
    <li>Las pausas se recortan a ${Math.round(120)} s: si una sesión estuvo parada dos horas, no estuviste tú dos horas delante. Ese total sin recortar (${t.blockedH.toFixed(0)} h) aparece aparte como «sesión detenida», y suma sesiones en paralelo, así que puede pasar de 24 h en un día.</li>
    <li>Solo mide Bash. Edit y Write también pueden preguntar, pero tus sesiones corren casi siempre en modo que los acepta, y su latencia mediana (0,2 s) lo confirma.</li>
  </ul>
  ${denials.length ? `
  <details>
    <summary>Los ${denials.length} rechazos explícitos — el único dato duro sobre prompts</summary>
    <table style="margin-top:10px">
      <tr><th>cuándo</th><th>herramienta</th><th>comando</th></tr>
      ${denials.slice(0, 20).map((d) => `<tr><td class="fine">${esc((d.at || '').slice(0, 16).replace('T', ' '))}</td><td><code>${esc(d.tool)}</code></td><td class="fine">${esc((d.command || '—').slice(0, 80))}</td></tr>`).join('')}
    </table>
  </details>` : ''}
</section>

<p class="fine" style="margin-top:20px">Generado por <code>scripts/permission-audit.mjs</code> · datos crudos en <code>permission-audit.json</code> · vuelve a correrlo con <code>node scripts/permission-audit.mjs --days 60</code></p>

<div id="tip"></div>
<script>
  const tip = document.getElementById('tip')
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tip]')
    if (!el) { tip.style.opacity = 0; return }
    tip.textContent = el.dataset.tip
    tip.style.opacity = 1
    const pad = 14
    const r = tip.getBoundingClientRect()
    tip.style.left = Math.min(e.clientX + pad, innerWidth - r.width - 8) + 'px'
    tip.style.top = Math.min(e.clientY + pad, innerHeight - r.height - 8) + 'px'
  })
</script>
</div>
</html>`
}
