// The person's choices: which tools wait behind ToolSearch, and what the display shows.
// Kept in a small JSON file (see the README), read when a session starts and when the
// settings view opens, so a hand edit counts too.

import type { DeferToolsChart, DeferToolsPlacement, DeferToolsSettings, DeferToolsStatusMode } from '../types'

export type Placement = DeferToolsPlacement
export type ChartId = DeferToolsChart
export type StatusMode = DeferToolsStatusMode
export type Settings = DeferToolsSettings

export const CHARTS: readonly ChartId[] = ['hero', 'firstRequest', 'perTool', 'conversation', 'toolSearch']

export const CHART_NAMES: Record<ChartId, string> = {
  hero: 'Big number (saved per request)',
  firstRequest: 'First request, with and without',
  perTool: 'Per tool',
  conversation: 'This conversation, net and cost',
  toolSearch: 'ToolSearch counts',
}

export const STATUS_MODES: readonly StatusMode[] = ['full', 'number', 'off']

export const defaultSettings = (statusLineOption = true): Settings => ({
  tools: {},
  charts: [...CHARTS],
  animate: true,
  statusLine: statusLineOption ? 'full' : 'off',
})

const isChart = (v: unknown): v is ChartId => typeof v === 'string' && (CHARTS as readonly string[]).includes(v)
const isStatus = (v: unknown): v is StatusMode => typeof v === 'string' && (STATUS_MODES as readonly string[]).includes(v)

/**
 * Reads a settings file's JSON. Anything missing or not understood keeps the default, so a typo
 * never breaks the mod; `problems` says what was skipped.
 */
export const parseSettings = (raw: unknown, base: Settings): { settings: Settings; problems: string[] } => {
  const problems: string[] = []
  const settings: Settings = { ...base, tools: { ...base.tools }, charts: [...base.charts] }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) problems.push('the file is not a JSON object')
    return { settings, problems }
  }
  const o = raw as Record<string, unknown>
  if (o.tools !== undefined) {
    if (o.tools !== null && typeof o.tools === 'object' && !Array.isArray(o.tools)) {
      settings.tools = {}
      for (const [name, value] of Object.entries(o.tools as Record<string, unknown>)) {
        if (value === 'defer' || value === 'keep') settings.tools[name] = value
        else problems.push(`tools.${name}: use "defer" or "keep"`)
      }
    } else problems.push('tools: use an object, like {"Workflow": "keep"}')
  }
  if (o.charts !== undefined) {
    if (Array.isArray(o.charts)) {
      const seen = new Set<ChartId>()
      for (const c of o.charts) {
        if (isChart(c)) seen.add(c)
        else problems.push(`charts: unknown chart ${JSON.stringify(c)}`)
      }
      settings.charts = [...seen]
    } else problems.push('charts: use a list, like ["hero", "perTool"]')
  }
  if (o.animate !== undefined) {
    if (typeof o.animate === 'boolean') settings.animate = o.animate
    else problems.push('animate: use true or false')
  }
  if (o.statusLine !== undefined) {
    if (isStatus(o.statusLine)) settings.statusLine = o.statusLine
    else problems.push('statusLine: use "full", "number" or "off"')
  }
  return { settings, problems }
}

/** The file's text: every field written out, so it is easy to edit by hand. */
export const settingsText = (s: Settings): string =>
  `${JSON.stringify({ tools: s.tools, charts: s.charts, animate: s.animate, statusLine: s.statusLine }, null, 2)}\n`

/**
 * Where a tool goes: the person's choice, else the default list, else wherever Claude Code put it.
 * `engineDeferred` is Claude Code's own placement before any plugin.
 */
export const placementOf = (
  tool: string,
  s: Settings,
  defaults: ReadonlySet<string>,
  engineDeferred: boolean,
): { isDeferred: boolean; isChosen: boolean } => {
  const chosen = s.tools[tool]
  if (chosen !== undefined) return { isDeferred: chosen === 'defer', isChosen: true }
  return { isDeferred: defaults.has(tool) || engineDeferred, isChosen: false }
}

/** Flips one tool: hidden becomes kept in front and back. */
export const toggleTool = (s: Settings, tool: string, isDeferredNow: boolean): Settings => ({
  ...s,
  tools: { ...s.tools, [tool]: isDeferredNow ? 'keep' : 'defer' },
})

export const resetTool = (s: Settings, tool: string): Settings => {
  const tools = { ...s.tools }
  delete tools[tool]
  return { ...s, tools }
}

export const toggleChart = (s: Settings, chart: ChartId): Settings => {
  if (s.charts.includes(chart)) return { ...s, charts: s.charts.filter(c => c !== chart) }
  // A chart shown again goes back to its place in the default order, among the ones shown.
  const charts = CHARTS.filter(c => c === chart || s.charts.includes(c))
  const ordered = [...s.charts]
  ordered.splice(charts.indexOf(chart), 0, chart)
  return { ...s, charts: ordered }
}

export const moveChartUp = (s: Settings, chart: ChartId): Settings => {
  const i = s.charts.indexOf(chart)
  if (i <= 0) return s
  const charts = [...s.charts]
  ;[charts[i - 1], charts[i]] = [charts[i]!, charts[i - 1]!]
  return { ...s, charts }
}

/**
 * The `/defer-settings` command's words, for the CLI or anyone who would rather type.
 * Returns the new settings and what to say, or an error with the usage.
 */
export const applyCommand = (s: Settings, args: string): { settings?: Settings; text: string } => {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  const list = (text: string) => text.split(/[,\s]+/).filter(Boolean)
  switch (verb.toLowerCase()) {
    case 'defer':
    case 'hide': {
      const tools = list(arg)
      if (tools.length === 0) break
      let next = s
      for (const t of tools) next = { ...next, tools: { ...next.tools, [t]: 'defer' as const } }
      return { settings: next, text: `${tools.join(', ')}: behind ToolSearch from the next /clear or new session.` }
    }
    case 'keep':
    case 'load': {
      const tools = list(arg)
      if (tools.length === 0) break
      let next = s
      for (const t of tools) next = { ...next, tools: { ...next.tools, [t]: 'keep' as const } }
      return { settings: next, text: `${tools.join(', ')}: kept in every request from the next /clear or new session.` }
    }
    case 'default':
    case 'reset': {
      const tools = list(arg)
      if (tools.length === 0) break
      let next = s
      for (const t of tools) next = resetTool(next, t)
      return { settings: next, text: `${tools.join(', ')}: back to the default list from the next /clear or new session.` }
    }
    case 'charts': {
      const charts = list(arg)
      if (charts.length === 0) break
      const bad = charts.filter(c => !isChart(c))
      if (bad.length > 0) return { text: `Unknown chart: ${bad.join(', ')}. Charts: ${CHARTS.join(', ')}.` }
      const settings = { ...s, charts: [...new Set(charts as ChartId[])] }
      return { settings, text: `Charts, in this order: ${settings.charts.join(', ')}.` }
    }
    case 'animate':
    case 'animation': {
      if (arg !== 'on' && arg !== 'off') break
      return { settings: { ...s, animate: arg === 'on' }, text: `Animation ${arg}.` }
    }
    case 'status':
    case 'statusline': {
      if (!isStatus(arg)) break
      return { settings: { ...s, statusLine: arg }, text: `Status line: ${arg}.` }
    }
  }
  return {
    text: [
      'Usage: /defer-settings, with nothing after it, opens the settings. Or:',
      '  defer <tool>[,<tool>]   list behind ToolSearch',
      '  keep <tool>[,<tool>]    send in every request',
      '  default <tool>          back to the default list',
      `  charts <list>           charts to show, in order: ${CHARTS.join(', ')}`,
      '  animate on|off',
      '  status full|number|off',
      'Tool changes apply from the next /clear or new session.',
    ].join('\n'),
  }
}
