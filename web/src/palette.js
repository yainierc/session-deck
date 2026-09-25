/**
 * palette.js — the colours the activity views are allowed to use.
 *
 * Shared because the map, the timeline and the deck-wide atlas are three
 * views of one thing: a file that is blue in one of them has to be blue in
 * the others, and a rule that only lives in one file is a rule that drifts.
 */

/*
 * Three hues, and three is not a stylistic choice.
 *
 * Every folder is compared against every other one in these views — it is a
 * scatter, not a bar chart — and on this surface (#0c0e11) only these three
 * clear the colour-blind separation and normal-vision floors as an all-pairs
 * set. A fourth fails both. Proof:
 *
 *   node scripts/validate_palette.js "#3987e5,#d95926,#199e70" \
 *     --mode dark --surface "#0c0e11" --pairs all
 *
 * So folders past the third share one neutral and lean on their labels,
 * which every view draws whether or not the folder has a hue of its own.
 */
export const FOLDER_HUES = ['#3987e5', '#d95926', '#199e70']
export const FOLDER_OTHER = '#626c7d'

/** Reserved status colour. Never a folder, never a series. */
export const CRITICAL = '#d03b3b'

export const INK = '#e6e8eb'
export const DIM = '#626c7d'

/**
 * Rank folders by how much of the work happened in them, and hand the top
 * three a hue.
 *
 * Ties break on the name so the colours do not swap around between renders
 * when two folders are level — a colour that moves is a colour that lies.
 *
 * @param dirs one entry per file, repeats included
 */
/** The last `depth` segments of a folder path. */
function tailOf(dir, depth) {
  if (dir === '.') return '.'
  return dir.split('/').filter(Boolean).slice(-depth).join('/')
}

/**
 * The shortest tail of a folder path that still tells it apart from the rest.
 *
 * A deep tree produces labels like `web/src/components/`, and a session that
 * touches six of those turns the map into a wall of text whose one
 * distinguishing word is at the very end. The last segment is what anyone
 * actually reads. Files outside the session's cwd are worse still: their path
 * does not shorten against it at all, so the label is absolute and swamps
 * everything drawn near it.
 *
 * Shortening is only safe while it stays unique. These labels are what keeps
 * colour from being the only way to tell one folder from another — a
 * requirement of this view, not a preference — so two folders ending in the
 * same word each take another segment until they differ, and a folder that
 * cannot be distinguished any other way keeps its whole path.
 */
function shortestUnique(dir, all) {
  if (dir === '.') return './'
  const parts = dir.split('/').filter(Boolean)
  for (let depth = 1; depth < parts.length; depth += 1) {
    const mine = parts.slice(-depth).join('/')
    if (!all.some((other) => other !== dir && tailOf(other, depth) === mine)) {
      return `${mine}/`
    }
  }
  return `${parts.join('/')}/`
}

export function folderRanking(dirs) {
  const counts = new Map()
  for (const dir of dirs) counts.set(dir, (counts.get(dir) || 0) + 1)

  const ranked = [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))

  const colorOf = new Map()
  const all = ranked.map((entry) => entry.dir)
  ranked.forEach((entry, i) => {
    entry.color = i < FOLDER_HUES.length ? FOLDER_HUES[i] : FOLDER_OTHER
    entry.label = shortestUnique(entry.dir, all)
    colorOf.set(entry.dir, entry.color)
  })

  return { dirs: ranked, colorOf }
}
