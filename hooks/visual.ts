// The savings drawn as figures: an SVG for the desktop app, VS Code and mobile (animated with
// SMIL), and coloured cells for the terminal (animated frame by frame by the hooks module).
import { aboutTool } from './about'
import { CHARTS } from './settings'
import type { ChartId } from './settings'
import type { DeferToolsSavings, DeferToolsSource } from '../types'
import { bySource, full, netNow, netSession, savedAtStart, savedNow } from './savings'

/** Frames of the terminal count-up; the last one is the still picture. */
export const FRAMES = 24
/** How long one terminal frame shows, in milliseconds. */
export const FRAME_MS = 40
/** How long the SVG animation runs, in seconds. */
const SVG_SECONDS = 1.2

// Reference palette (dataviz skill), dark steps by default and light steps under the light scheme.
const DARK = {
  surface: '#1a1a19',
  text: '#f0efec',
  text2: '#c3c2b7',
  muted: '#8f8e86',
  grid: '#383835',
  saved: '#3987e5', // slot 1, blue: what the mod keeps out
  cost: '#d95926', // slot 2, orange: what deferring costs back
  without: '#6f6e68', // neutral: the request without the mod
}
const LIGHT = {
  surface: '#fcfcfb',
  text: '#0b0b0b',
  text2: '#52514e',
  muted: '#7a7975',
  grid: '#e6e5e0',
  saved: '#2a78d6',
  cost: '#eb6834',
  without: '#b4b3ad',
}

export type VisualTool = { name: string; tokens: number; source: DeferToolsSource; isLoaded: boolean; about?: string }

/** What the figures show, computed once from the savings. */
export type Visual = {
  isEmpty: boolean
  net: number
  schemas: number
  note: number
  sources: Record<DeferToolsSource, number>
  before: { without: number; with: number } | null
  tools: VisualTool[]
  notCounted: string[]
  session: {
    requests: number
    notSent: number
    net: number
    overhead: number
    hops: number
    hopTokens: number
    empty: number
    emptyTokens: number
    extra: number
    extraOut: number
    noteSent: number
  }
}

export const visualOf = (s: DeferToolsSavings): Visual => {
  const inFront = s.tools.filter(t => t.wasInFront)
  const net = netSession(s)
  return {
    isEmpty: inFront.length === 0,
    net: netNow(s),
    schemas: savedNow(s),
    note: s.noteTokens,
    sources: bySource(s),
    before:
      s.firstRequestTokens === null
        ? null
        : { with: s.firstRequestTokens, without: s.firstRequestTokens + savedAtStart(s) - s.noteTokens },
    tools: inFront
      .map(t => ({ name: t.name, tokens: t.tokens, source: t.source, isLoaded: t.isLoaded }))
      .sort((a, b) => b.tokens - a.tokens),
    notCounted: s.tools.filter(t => !t.wasInFront).map(t => t.name),
    session: {
      requests: s.requests,
      notSent: s.tokensNotSent,
      net,
      overhead: s.tokensNotSent - net,
      hops: s.hops,
      hopTokens: s.hopTokens,
      empty: s.emptySearches,
      emptyTokens: s.emptyTokens,
      extra: s.extraRequests,
      extraOut: s.extraOutputTokens,
      noteSent: s.noteTokensSent,
    },
  }
}

const SOURCE_TAG: Record<DeferToolsSource, string> = { table: 'table', engine: 'CC est.', rough: 'rough' }

/** Ease-out: fast start, gentle stop. */
export const ease = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((100 * part) / whole).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '0%'

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---------------------------------------------------------------------------------------------
// SVG (desktop, VS Code, mobile)

export type SvgOptions = {
  /** SMIL count-up and growing bars; off, a still picture at `progress`. */
  animate: boolean
  /** 0 to 1, for a still picture partway through (the GIF's frames). */
  progress?: number
  /** Fixed colours for a still picture rendered outside an app; absent, follows the app's scheme. */
  theme?: 'dark' | 'light'
  /** The charts to draw, in order; absent, all of them. */
  charts?: readonly ChartId[]
  /** Shows one row's hover card as if pointed at, for a still picture: `tool0` is the first row. */
  showTip?: string
}

const TIP_W = 400
const TIP_CHARS = 62

/** Splits text into lines of at most `width` characters, at spaces. */
export const wrapWords = (text: string, width: number): string[] => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line === '' ? word : `${line} ${word}`
  }
  if (line !== '') lines.push(line)
  return lines
}

/** Characters that fit before the bars at 13px, digits and hyphens included (about 7.4px each). */
export const NAME_CHARS = 24

/**
 * A tool's name as the chart's label column can hold it. An MCP tool keeps its own name first and
 * its connector after, since names like `mcp__1a59c906-…__batch` differ only at the end.
 * The hover card shows the full name.
 */
export const chartName = (name: string, max = NAME_CHARS): string => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  const label = m ? `${m[2]} · ${m[1]}` : name
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

/**
 * The width and height on a chart's root `<svg>`, for the `Svg` element's props. The desktop app
 * draws an interactive Svg in a frame that has no size of its own (2.1.321): without these props
 * the frame is 150 pixels tall and the chart shrinks to fit it.
 */
export const svgSize = (svg: string): { width: number; height: number } => {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? ''
  const read = (name: string): number => Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(root)?.[1] ?? 0)
  return { width: read('width'), height: read('height') }
}

export const svgPanel = (v: Visual, o: SvgOptions): string => {
  const W = 680
  const p = o.animate ? 1 : ease(o.progress ?? 1)
  const parts: string[] = []
  let y = 0
  const LABEL_X = 16
  const BAR_X = 210
  const BAR_W = 330
  const VALUE_X = BAR_X + BAR_W + 10

  // Hover cards for the per-tool rows, drawn last so they paint over every row; CSS shows one
  // while the pointer is on its row (the row comes first among the same siblings, so `~` reaches it).
  const tips: { id: string; rowY: number; lines: { text: string; cls: string }[] }[] = []

  // A bar that grows from zero, with a hover title.
  let barIndex = 0
  const bar = (x: number, yy: number, w: number, h: number, cls: string, title: string): string => {
    const width = Math.max(0, w)
    const delay = (0.08 * barIndex++).toFixed(2)
    const shown = o.animate ? width : width * p
    const anim =
      o.animate && width > 0
        ? `<animate attributeName="width" from="0" to="${width.toFixed(1)}" begin="${delay}s" dur="0.9s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.2 0.8 0.2 1"/><set attributeName="width" to="0" begin="0s" dur="${delay}s"/>`
        : ''
    return `<rect class="${cls}" x="${x}" y="${yy}" width="${shown.toFixed(1)}" height="${h}" rx="${Math.min(4, h / 2)}">${title ? `<title>${esc(title)}</title>` : ''}${anim}</rect>`
  }

  // A number that counts up from zero.
  const counter = (x: number, yy: number, value: number, cls: string, anchor = 'start'): string => {
    if (!o.animate)
      return `<text class="${cls}" x="${x}" y="${yy}" text-anchor="${anchor}">${full(Math.round(value * p))}</text>`
    const steps = 20
    const frames: string[] = []
    for (let i = 0; i < steps; i++) {
      const begin = ((SVG_SECONDS * i) / steps).toFixed(3)
      const v = Math.round(value * ease(i / steps))
      frames.push(
        `<text class="${cls}" x="${x}" y="${yy}" text-anchor="${anchor}" visibility="hidden">${full(v)}<set attributeName="visibility" to="visible" begin="${begin}s" dur="${(SVG_SECONDS / steps).toFixed(3)}s"/></text>`,
      )
    }
    frames.push(
      `<text class="${cls}" x="${x}" y="${yy}" text-anchor="${anchor}">${full(value)}<set attributeName="visibility" to="hidden" begin="0s" dur="${SVG_SECONDS}s"/></text>`,
    )
    return frames.join('')
  }

  const section = (title: string) => {
    y += 30
    parts.push(`<text class="eyebrow" x="${LABEL_X}" y="${y}">${esc(title)}</text>`)
    y += 12
  }

  if (v.isEmpty) {
    y = 40
    parts.push(
      `<text class="t2" x="${LABEL_X}" y="${y}">No tool from the list was in front in this session, so nothing is saved here yet.</text>`,
    )
    y += 20
  } else {
    const draw: Record<ChartId, () => void> = {
      // Hero: tokens saved per request, net.
      hero: () => {
        y += y === 0 ? 26 : 40
        parts.push(`<text class="eyebrow" x="${LABEL_X}" y="${y}">TOKENS SAVED ON EVERY REQUEST (NET)</text>`)
        y += 56
        parts.push(counter(LABEL_X, y, v.net, 'hero'))
        y += 22
        const src = (['table', 'engine', 'rough'] as const)
          .filter(k => v.sources[k] > 0)
          .map(k => `${full(v.sources[k])} ${SOURCE_TAG[k]}`)
          .join(' · ')
        parts.push(
          `<text class="small" x="${LABEL_X}" y="${y}">${full(v.schemas)} schema tokens (${esc(src)}) minus ${full(v.note)} for the prompt line (est.)</text>`,
        )
      },
      // Before and after: the first request.
      firstRequest: () => {
        if (v.before) {
          section('FIRST REQUEST OF THIS CONVERSATION')
          const max = Math.max(v.before.without, v.before.with, 1)
          const rows: [string, number, string, string][] = [
            ['Without defer-tools', v.before.without, 'without', 'about (live + saved)'],
            ['With defer-tools', v.before.with, 'saved', 'live'],
          ]
          for (const [label, value, cls, how] of rows) {
            parts.push(`<text class="t2" x="${LABEL_X}" y="${y + 15}">${label}</text>`)
            parts.push(bar(BAR_X, y + 2, (BAR_W * value) / max, 18, cls, `${label}: ${full(value)} tokens (${how})`))
            parts.push(counter(VALUE_X, y + 16, value, 'value'))
            y += 26
          }
          const cut = v.before.without - v.before.with
          parts.push(
            `<text class="delta" x="${BAR_X}" y="${y + 10}">${full(cut)} fewer tokens (${pct(cut, v.before.without)} smaller)</text>`,
          )
          y += 14
        }
      },
      // Per tool.
      perTool: () => {
        section('PER TOOL, TOKENS PER REQUEST')
        const maxTool = Math.max(1, ...v.tools.map(t => t.tokens))
        v.tools.forEach((t, i) => {
          const id = `tool${i}`
          const name = chartName(t.name)
          const cls = t.isLoaded ? 'loaded' : 'saved'
          const state = t.isLoaded
            ? 'Loaded by ToolSearch in this conversation, so no longer saved'
            : 'Hidden behind ToolSearch: saved on every request'
          // The whole row is the hover target: a faint band behind it lights up.
          parts.push(`<g class="row" id="${id}"><rect class="hit" x="${LABEL_X - 6}" y="${y - 1}" width="${W - 2 * LABEL_X + 12}" height="20" rx="4"/>`)
          parts.push(`<text class="t2 name" x="${LABEL_X}" y="${y + 13}" clip-path="url(#names)">${esc(name)}</text>`)
          parts.push(bar(BAR_X, y + 2, Math.max(3, (BAR_W * t.tokens) / maxTool), 14, cls, ''))
          parts.push(
            `<text class="value" x="${VALUE_X}" y="${y + 14}">${full(t.tokens)}<tspan class="tag"> ${SOURCE_TAG[t.source]}${t.isLoaded ? ' · loaded' : ''}</tspan></text></g>`,
          )
          tips.push({
            id,
            rowY: y,
            lines: [
              { text: t.name, cls: 'tip-name' },
              ...wrapWords(t.about ?? aboutTool(t.name, ''), TIP_CHARS).map(text => ({ text, cls: 'tip-text' })),
              { text: `${full(t.tokens)} tokens per request (${SOURCE_TAG[t.source]})`, cls: 'tip-small' },
              { text: state, cls: 'tip-small' },
            ],
          })
          y += 22
        })
        if (v.notCounted.length > 0) {
          parts.push(
            `<text class="small" x="${LABEL_X}" y="${y + 8}">Not counted (Claude Code defers them anyway): ${esc(v.notCounted.join(', '))}</text>`,
          )
          y += 14
        }
      },
      // This conversation: net against what ToolSearch took back.
      conversation: () => {
        section(`THIS CONVERSATION · ${v.session.requests} REQUEST${v.session.requests === 1 ? '' : 'S'}`)
        const total = Math.max(1, v.session.notSent)
        // The cost sits at the right end; the net grows toward it.
        const costW = Math.max(v.session.overhead > 0 ? 3 : 0, (BAR_W * v.session.overhead) / total)
        const netW = Math.max(0, Math.min((BAR_W * Math.max(0, v.session.net)) / total, BAR_W - costW - 2))
        parts.push(`<text class="t2" x="${LABEL_X}" y="${y + 16}">Net saved, all requests</text>`)
        parts.push(bar(BAR_X, y + 2, netW, 20, 'saved', `Net: ${full(v.session.net)} tokens`))
        parts.push(
          bar(
            BAR_X + BAR_W - costW,
            y + 2,
            costW,
            20,
            'cost',
            `Taken back by the prompt line and ToolSearch: ${full(v.session.overhead)} tokens`,
          ),
        )
        parts.push(counter(VALUE_X, y + 17, v.session.net, 'value'))
        y += 38
        parts.push(
          `<text class="small" x="${BAR_X}" y="${y}"><tspan class="key-saved">■</tspan> net ${full(v.session.net)}   <tspan class="key-cost">■</tspan> taken back ${full(v.session.overhead)} (${pct(v.session.overhead, v.session.notSent)}) of ${full(v.session.notSent)} schema tokens not sent</text>`,
        )
        y += 12
      },

      // Stat tiles: what ToolSearch cost.
      toolSearch: () => {
        y += 16
        const tiles: [string, number, string][] = [
          ['ToolSearch hops', v.session.hops, `~${full(v.session.hopTokens)} tokens (est.)`],
          ['Empty searches', v.session.empty, `~${full(v.session.emptyTokens)} tokens (est.)`],
          ['Extra requests', v.session.extra, `${full(v.session.extraOut)} output tokens (live)`],
        ]
        const tileW = (W - 2 * LABEL_X - 2 * 12) / 3
        tiles.forEach(([label, count, sub], i) => {
          const x = LABEL_X + i * (tileW + 12)
          parts.push(`<rect class="tile" x="${x}" y="${y}" width="${tileW}" height="64" rx="8"/>`)
          parts.push(`<text class="small" x="${x + 12}" y="${y + 18}">${label}</text>`)
          parts.push(counter(x + 12, y + 44, count, 'count'))
          parts.push(`<text class="small" x="${x + 12}" y="${y + 58}">${esc(sub)}</text>`)
        })
        y += 64
      },
    }
    for (const chart of o.charts ?? CHARTS) draw[chart]()
  }

  y += 22
  parts.push(
    `<text class="small" x="${LABEL_X}" y="${y}">live = this session's API usage · table = README, Claude Code 2.1.318</text>`,
  )
  y += 15
  parts.push(
    `<text class="small" x="${LABEL_X}" y="${y}">CC est. = Claude Code's estimate · rough = description ÷ 4 · tokens not sent were mostly cache reads</text>`,
  )
  y += 12

  // The hover cards: under their row, or above it where the picture would end first.
  for (const tip of tips) {
    const h = 14 + 17 * tip.lines.length
    const top = tip.rowY + 22 + h <= y ? tip.rowY + 22 : tip.rowY - h - 4
    const x = BAR_X - 40
    parts.push(`<g class="tip" id="${tip.id}-tip"><rect class="tip-box" x="${x}" y="${top}" width="${TIP_W}" height="${h}" rx="8"/>`)
    tip.lines.forEach((line, i) =>
      parts.push(`<text class="${line.cls}" x="${x + 12}" y="${top + 21 + 17 * i}">${esc(line.text)}</text>`),
    )
    parts.push('</g>')
  }
  const tipCss = tips.map(t => `#${t.id}:hover~#${t.id}-tip`).join(',')

  const css = (c: typeof DARK) =>
    `.bg{fill:${c.surface}}.eyebrow{fill:${c.muted};font-size:11px;letter-spacing:.08em;font-weight:600}` +
    `.hero{fill:${c.text};font-size:52px;font-weight:700}` +
    `.t2{fill:${c.text2};font-size:13px}.value{fill:${c.text};font-size:13px;font-weight:600}` +
    `.tag{fill:${c.muted};font-weight:400;font-size:11px}.small{fill:${c.muted};font-size:11px}` +
    `.delta{fill:${c.saved};font-size:12px;font-weight:600}.count{fill:${c.text};font-size:24px;font-weight:700}` +
    `.saved{fill:${c.saved}}.cost{fill:${c.cost}}.without{fill:${c.without}}.loaded{fill:${c.grid};stroke:${c.muted};stroke-dasharray:3 2}` +
    `.tile{fill:none;stroke:${c.grid}}.key-saved{fill:${c.saved}}.key-cost{fill:${c.cost}}` +
    `.hit{fill:${c.grid};fill-opacity:0}.row:hover .hit{fill-opacity:.55}.row:hover .name{fill:${c.text}}` +
    `.tip-box{fill:${c.surface};stroke:${c.muted};stroke-width:1}.tip-name{fill:${c.text};font-size:13px;font-weight:700}` +
    `.tip-text{fill:${c.text};font-size:12px}.tip-small{fill:${c.muted};font-size:11px}`
  const shape =
    `.tip{visibility:hidden;pointer-events:none}` +
    (tipCss ? `${tipCss}{visibility:visible}` : '') +
    (o.showTip ? `#${o.showTip}-tip{visibility:visible}#${o.showTip} .hit{fill-opacity:.55}` : '')
  const style =
    shape +
    (o.theme === 'light'
      ? css(LIGHT)
      : o.theme === 'dark'
        ? css(DARK)
        : `${css(DARK)}@media (prefers-color-scheme: light){${css(LIGHT)}}`)
  return (
    // A frame narrower than W shrinks the chart to its width: keep it at the top, the spare room below.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" preserveAspectRatio="xMidYMin meet" font-family="system-ui, -apple-system, 'Segoe UI', 'DejaVu Sans', sans-serif">` +
    `<style>${style}</style>` +
    // A label that is still too wide is cut at the bars instead of running under them.
    `<defs><clipPath id="names"><rect x="0" y="0" width="${BAR_X - 8}" height="${y}"/></clipPath></defs>` +
    (o.theme ? `<rect class="bg" width="${W}" height="${y}"/>` : '') +
    parts.join('') +
    `</svg>`
  )
}

// ---------------------------------------------------------------------------------------------
// Terminal: coloured cells

/** One terminal cell: a character and its colours (0x00RRGGBB, or DEFAULT). */
type Cell = [codePoint: number, fg: number, bg: number]
export const DEFAULT = 0x01000000
const hex = (h: string): number => parseInt(h.slice(1), 16)
export const T = {
  saved: hex(DARK.saved),
  cost: hex(DARK.cost),
  without: hex(DARK.without),
  loaded: hex(DARK.muted),
  track: hex(DARK.grid),
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

/** Rows of cells as RasterProps' `cells`. */
export const encodeCells = (rows: Cell[][]): string => {
  const columns = rows[0]?.length ?? 0
  const words = new Uint32Array(columns * rows.length * 3)
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      words.set(cell, (r * columns + c) * 3)
    }),
  )
  return base64(new Uint8Array(words.buffer))
}

export type RasterSpec = { columns: number; rows: number; cells: string }

const PARTIAL = [0x20, 0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589] // eighth blocks, left aligned
const FULL_BLOCK = 0x2588

/** A one-row bar of `width` cells, filled to `fraction`, with eighth-block ends. Segments draw left to right. */
export const barRaster = (width: number, segments: { fraction: number; color: number }[]): RasterSpec => {
  // Where each segment ends, in eighths of a cell.
  const ends: { end: number; color: number }[] = []
  let cursor = 0
  for (const seg of segments) {
    cursor = Math.min(width * 8, cursor + Math.max(0, Math.round(seg.fraction * width * 8)))
    ends.push({ end: cursor, color: seg.color })
  }
  const colorAt = (eighth: number): number | undefined => ends.find(e => eighth < e.end)?.color
  const row: Cell[] = []
  for (let c = 0; c < width; c++) {
    const first = colorAt(c * 8)
    if (first === undefined) {
      row.push([0x20, DEFAULT, DEFAULT])
      continue
    }
    // How many eighths of this cell the first colour fills.
    let n = 1
    while (n < 8 && colorAt(c * 8 + n) === first) n++
    if (n === 8) row.push([FULL_BLOCK, first, DEFAULT])
    else {
      // A left block in the first colour; the rest of the cell takes the next colour, if any.
      const next = colorAt(c * 8 + n)
      row.push([PARTIAL[n]!, first, next ?? DEFAULT])
    }
  }
  return { columns: width, rows: 1, cells: encodeCells([row]) }
}

// 3x5 digits drawn with full blocks; ',' is one column wide.
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  ',': ['.', '.', '.', '#', '#'],
  '-': ['...', '...', '###', '...', '...'],
}

/** A number in big block digits, 5 rows tall. */
export const bigNumber = (value: number, color: number): RasterSpec => {
  const text = full(value)
  const rows: Cell[][] = [[], [], [], [], []]
  for (const ch of text) {
    const glyph = GLYPHS[ch]
    if (!glyph) continue
    glyph.forEach((line, r) => {
      for (const px of line) rows[r]!.push(px === '#' ? [FULL_BLOCK, color, DEFAULT] : [0x20, DEFAULT, DEFAULT])
      rows[r]!.push([0x20, DEFAULT, DEFAULT])
    })
  }
  return { columns: rows[0]!.length, rows: 5, cells: encodeCells(rows) }
}

/** The terminal's text beside each figure, so a reader without colours still gets every number. */
export const sourceTag = (source: DeferToolsSource): string => SOURCE_TAG[source]
export { pct }
