import type { DeferToolsSavings, DeferToolsSource, DeferToolsTool } from '../types'

// Input tokens each tool adds to every request, measured as a `claude -p` run minus the same
// run with `--disallowedTools <tool>`, on Claude Code 2.1.318 (see the README).
export const MEASURED: Record<string, number> = {
  Artifact: 12773,
  Workflow: 1952,
  ScheduleWakeup: 1698,
  ReportFindings: 821,
}

// Characters per token for the rough estimates: English prose and JSON run near 4.
const CHARS_PER_TOKEN = 4

export const roughTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

export const emptySavings = (): DeferToolsSavings => ({
  tools: [],
  noteTokens: 0,
  firstRequestTokens: null,
  requests: 0,
  tokensNotSent: 0,
  noteTokensSent: 0,
  hops: 0,
  hopTokens: 0,
  emptySearches: 0,
  emptyTokens: 0,
  otherSearches: 0,
  extraRequests: 0,
  extraOutputTokens: 0,
})

/** A row for a tool the first time Claude Code describes it in this session. */
export const toolRow = (name: string, description: string, wasInFront: boolean): DeferToolsTool => {
  const measured = MEASURED[name]
  const source: DeferToolsSource = measured !== undefined ? 'table' : 'rough'
  return {
    name,
    tokens: measured ?? roughTokens(description),
    source,
    wasInFront,
    isLoaded: false,
    isMcp: name.startsWith('mcp__'),
  }
}

/** Schema tokens the mod keeps out of each request right now. */
export const savedNow = (s: DeferToolsSavings): number =>
  s.tools.reduce((sum, t) => (t.wasInFront && !t.isLoaded ? sum + t.tokens : sum), 0)

/** Schema tokens the mod kept out of the first request. */
export const savedAtStart = (s: DeferToolsSavings): number =>
  s.tools.reduce((sum, t) => (t.wasInFront ? sum + t.tokens : sum), 0)

/** Per request, after the prompt line the mod adds. */
export const netNow = (s: DeferToolsSavings): number => savedNow(s) - s.noteTokens

/**
 * Over the conversation: schemas not sent, minus the prompt line on every request, the searches
 * and their results (estimates), and the output of the extra requests that only searched (live).
 */
export const netSession = (s: DeferToolsSavings): number =>
  s.tokensNotSent - s.noteTokensSent - s.hopTokens - s.emptyTokens - s.extraOutputTokens

/** Sums by source, for the "where the numbers come from" line. */
export const bySource = (s: DeferToolsSavings): Record<DeferToolsSource, number> => {
  const sums: Record<DeferToolsSource, number> = { table: 0, engine: 0, rough: 0 }
  for (const t of s.tools) if (t.wasInFront && !t.isLoaded) sums[t.source] += t.tokens
  return sums
}

/** 16811 -> "16.8k", 950 -> "950", -120 -> "-120". */
export const short = (n: number): string => {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)}k`
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`
  return `${sign}${abs}`
}

/** 16811 -> "16,811". */
export const full = (n: number): string => Math.round(n).toLocaleString('en-US')

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The one status-line entry. */
export const statusLine = (s: DeferToolsSavings, shown = netNow(s)): string | undefined => {
  if (!s.tools.some(t => t.wasInFront)) return undefined
  const parts = [`defer-tools: ▼ ${short(Math.round(shown))} tokens saved per request`]
  if (s.hops > 0 || s.emptySearches > 0)
    parts.push(`${plural(s.hops, 'ToolSearch hop')}, ${plural(s.emptySearches, 'empty search', 'empty searches')}`)
  return parts.join(' · ')
}

const SOURCE_WORD: Record<DeferToolsSource, string> = {
  table: 'README table',
  engine: 'Claude Code estimate',
  rough: 'rough estimate',
}

export const sourceWord = (source: DeferToolsSource): string => SOURCE_WORD[source]

/** The whole report as plain lines: the pane draws them, and the command answers with them where no pane is drawn. */
export const reportLines = (s: DeferToolsSavings, totals?: Totals): string[] => {
  const lines: string[] = []
  const inFront = s.tools.filter(t => t.wasInFront)
  if (inFront.length === 0) {
    lines.push('No tool from the list was in front in this session, so defer-tools saves nothing here yet.')
    return lines
  }
  const sums = bySource(s)
  lines.push(`Saved per request now: ${full(netNow(s))} tokens (net)`)
  lines.push(`  Schemas not sent: ${full(savedNow(s))}`)
  const parts = (['table', 'engine', 'rough'] as const).filter(k => sums[k] > 0).map(k => `${full(sums[k])} ${SOURCE_WORD[k]}`)
  if (parts.length > 0) lines.push(`    by source: ${parts.join(', ')}`)
  lines.push(`  Minus the prompt line the mod adds: -${full(s.noteTokens)} (estimate)`)
  if (s.firstRequestTokens !== null) {
    lines.push(`First request of this conversation: ${full(s.firstRequestTokens)} tokens (live)`)
    lines.push(`  Without defer-tools: about ${full(s.firstRequestTokens + savedAtStart(s) - s.noteTokens)}`)
  }
  lines.push('')
  lines.push('Tools')
  for (const t of inFront) {
    const state = t.isLoaded ? 'loaded by ToolSearch' : 'not loaded'
    lines.push(`  ${t.name}: ${full(t.tokens)} (${SOURCE_WORD[t.source]}), ${state}`)
  }
  const behind = s.tools.filter(t => !t.wasInFront)
  if (behind.length > 0)
    lines.push(`  Already behind ToolSearch without the mod (not counted): ${behind.map(t => t.name).join(', ')}`)
  lines.push('')
  lines.push('ToolSearch')
  lines.push(`  Hops for the mod's tools: ${s.hops}, about ${full(s.hopTokens)} tokens (estimate)`)
  lines.push(`  Empty searches: ${s.emptySearches}, about ${full(s.emptyTokens)} tokens (estimate)`)
  lines.push(`  Extra model requests: ${s.extraRequests}, ${full(s.extraOutputTokens)} output tokens (live)`)
  if (s.otherSearches > 0) lines.push(`  Searches for tools Claude Code defers by itself: ${s.otherSearches} (not counted)`)
  lines.push('')
  lines.push(`This conversation: ${plural(s.requests, 'request')}`)
  lines.push(`  Schema tokens not sent: ${full(s.tokensNotSent)} (mostly cache reads)`)
  lines.push(`  Net after the prompt line, the searches and the extra requests: ${full(netSession(s))}`)
  if (totals && totals.sessions > 0) {
    lines.push('')
    lines.push(`All sessions on this computer: ${plural(totals.sessions, 'session')}`)
    lines.push(`  Net tokens not sent: ${full(totals.net)}, ${plural(totals.hops, 'hop')}, ${plural(totals.emptySearches, 'empty search', 'empty searches')}`)
  }
  return lines
}

/** What is kept per session in $.store, and summed for the "all sessions" line. */
export type SessionRecord = { at: number; requests: number; net: number; hops: number; emptySearches: number }
export type Totals = { sessions: number; requests: number; net: number; hops: number; emptySearches: number }

export const sessionRecord = (s: DeferToolsSavings, at: number): SessionRecord => ({
  at,
  requests: s.requests,
  net: netSession(s),
  hops: s.hops,
  emptySearches: s.emptySearches,
})

export const sumRecords = (records: Record<string, SessionRecord>): Totals => {
  const totals: Totals = { sessions: 0, requests: 0, net: 0, hops: 0, emptySearches: 0 }
  for (const r of Object.values(records)) {
    if (r.requests === 0) continue
    totals.sessions += 1
    totals.requests += r.requests
    totals.net += r.net
    totals.hops += r.hops
    totals.emptySearches += r.emptySearches
  }
  return totals
}

/** Keeps the newest `limit` records. */
export const trimRecords = (records: Record<string, SessionRecord>, limit = 200): Record<string, SessionRecord> =>
  Object.fromEntries(
    Object.entries(records)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, limit),
  )
