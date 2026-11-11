import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { DeferToolsCatalogTool, DeferToolsSavings, DeferToolsSettings } from '../types'
import {
  emptySavings,
  reportLines,
  roughTokens,
  sessionRecord,
  statusLine,
  sumRecords,
  toolRow,
  trimRecords,
  savedNow,
  netNow,
  full,
} from './savings'
import type { SessionRecord, Totals } from './savings'
import {
  CHARTS,
  CHART_NAMES,
  STATUS_MODES,
  applyCommand,
  defaultSettings,
  moveChartUp,
  parseSettings,
  placementOf,
  resetTool,
  settingsText,
  toggleChart,
  toggleTool,
} from './settings'
import type { ChartId } from './settings'
import { aboutTool, placementWords, toolOfFocus } from './about'
import { FRAMES, FRAME_MS, barRaster, bigNumber, ease, pct, sourceTag, svgPanel, T, visualOf } from './visual'

// Tools whose full schema is sent with every request although most sessions never call them.
// Each is listed behind ToolSearch instead: it stays available, and its schema loads when the
// model asks for it by name. Descriptions are left exactly as the engine computed them.
// The hint after each name goes into one system-prompt line, so the model knows when to load it.
// The person can change the list in the settings view, with /defer-settings, or in the file.
const DEFAULTS: Record<string, string> = {
  Artifact: 'pages, slide decks and documents on claude.ai, and /slides',
  Workflow: 'multi-agent workflow scripts',
  ScheduleWakeup: 'self-paced /loop wake-ups',
  ReportFindings: 'code-review findings, when review instructions name this tool',
  SearchPlugins: 'search the plugin catalog',
  SuggestPluginInstall: 'show a plugin install card',
  SuggestSkills: 'show a skill suggestion card',
  mcp__visualize__read_me: 'setup notes for inline widgets, read before show_widget',
  mcp__visualize__show_widget: 'inline SVG or HTML widgets',
  mcp__ccd_session__read_widget_context: 'read the state of an inline widget',
}

const PANE = 'defer-tools-savings'
const COMMAND = 'defer-savings'
const SETTINGS_COMMAND = 'defer-settings'
const STORE_KEY = 'sessions-v1'
// Used only when the home folder is unknown: the settings then live in the mod's store.
const SETTINGS_STORE_KEY = 'settings-v1'

// Change a tag when the fields of its type change: a reload then starts fresh.
const savings = atom({ plugin: 'defer-tools', key: 'savings' } as const, emptySavings(), { shape: 'savings-1' })
const frame = atom({ plugin: 'defer-tools', key: 'frame' } as const, FRAMES)
const playedAt = atom({ plugin: 'defer-tools', key: 'playedAt' } as const, 0)
const settingsAtom = atom({ plugin: 'defer-tools', key: 'settings' } as const, defaultSettings(), { shape: 'settings-1' })
const catalog = atom({ plugin: 'defer-tools', key: 'catalog' } as const, [] as DeferToolsCatalogTool[], {
  shape: 'catalog-2',
})
const view = atom({ plugin: 'defer-tools', key: 'view' } as const, 'charts' as 'charts' | 'settings')
const focusedTool = atom({ plugin: 'defer-tools', key: 'focusedTool' } as const, '')
const explain = atom({ plugin: 'defer-tools', key: 'explain' } as const, false)

const names = (value: unknown): string[] =>
  typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : []

// Read once per process from the options; the settings file decides over them.
let baseSettings: DeferToolsSettings = defaultSettings()
// The default list after the keepInFront and alsoDefer options.
let defaults = new Set<string>()
// What the settings file said and whether it could be read, for the settings view.
let settingsPath: string | undefined
let settingsProblems: string[] = []
let settingsLoaded: Promise<DeferToolsSettings> | undefined

async function change($: EngineInterface, fn: (s: DeferToolsSavings) => DeferToolsSavings): Promise<DeferToolsSavings> {
  const next = await update($, savings, fn)
  await showStatus($, next)
  return next
}

// The status line counts up (or down) to a new figure over half a second.
let shownNet = 0
let latest: DeferToolsSavings = emptySavings()
let statusTimer: Timer | undefined
let statusMode: DeferToolsSettings['statusLine'] = 'full'
let animate = true
const STATUS_STEPS = 10

async function showStatus($: EngineInterface, s: DeferToolsSavings): Promise<void> {
  if (statusMode === 'off') return
  countStatus($, s)
}

function lineFor(s: DeferToolsSavings, shown?: number): string | undefined {
  return statusLine(s, shown ?? netNow(s), statusMode === 'number' ? 'number' : 'full')
}

function countStatus($: EngineInterface, s: DeferToolsSavings): void {
  latest = s
  const target = netNow(s)
  if (target === shownNet || !animate) {
    shownNet = target
    // Same figure: a running count picks up the new text as it goes; else show it now.
    if (statusTimer === undefined) $.ui.status(lineFor(s))
    return
  }
  const from = shownNet
  shownNet = target
  statusTimer?.cancel()
  statusTimer = undefined
  if (lineFor(s) === undefined) {
    $.ui.status(undefined)
    return
  }
  let step = 1
  $.ui.status(lineFor(s, from + (target - from) * ease(step / STATUS_STEPS)))
  try {
    const timer = $.clock.every(50, () => {
      step += 1
      const done = step >= STATUS_STEPS
      $.ui.status(lineFor(latest, done ? target : from + (target - from) * ease(step / STATUS_STEPS)))
      if (done) {
        timer.cancel()
        if (statusTimer === timer) statusTimer = undefined
      }
    })
    statusTimer = timer
  } catch {
    $.ui.status(lineFor(s))
  }
}

// Plays the pane's animation: the terminal steps through frames, the SVG surfaces run their own.
let playTimer: Timer | undefined

async function play($: EngineInterface): Promise<void> {
  playTimer?.cancel()
  playTimer = undefined
  if (!animate) {
    await update($, frame, () => FRAMES)
    return
  }
  const now = await $.clock.now()
  await update($, playedAt, () => now)
  await update($, frame, () => 0)
  let at = 0
  const timer = $.clock.every(FRAME_MS, () => {
    at += 1
    void update($, frame, () => Math.min(FRAMES, at))
    if (at >= FRAMES) timer.cancel()
  })
  playTimer = timer
}

// Asks Claude Code for its own estimate of each MCP tool's schema (a local estimate, no API call).
async function readEngineEstimates($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const mcp = usage.context.breakdown?.mcpTools ?? []
  if (mcp.length === 0) return
  const byName = new Map(mcp.map(t => [t.name, t]))
  await update($, catalog, rows =>
    rows.map(t => {
      const found = byName.get(t.name)
      return found && found.tokens > 0 ? { ...t, tokens: found.tokens, source: 'engine' as const } : t
    }),
  )
  await change($, s => ({
    ...s,
    tools: s.tools.map(t => {
      const found = byName.get(t.name)
      if (!found || found.tokens <= 0) return t
      return { ...t, tokens: found.tokens, source: 'engine' as const, isLoaded: t.isLoaded || found.isLoaded }
    }),
  }))
}

async function readRecords($: EngineInterface): Promise<Record<string, SessionRecord>> {
  const stored = await $.store.get(STORE_KEY)
  return stored !== null && typeof stored === 'object' ? (stored as Record<string, SessionRecord>) : {}
}

async function readTotals($: EngineInterface): Promise<Totals | undefined> {
  try {
    return sumRecords(await readRecords($))
  } catch {
    return undefined
  }
}

// ----------------------------------------------------------------------------------------------
// Settings: a JSON file in the home folder's .claude directory

async function findSettingsPath($: EngineInterface): Promise<string | undefined> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))
  if (!home) return undefined
  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  return `${home.replace(/[\\/]$/, '')}${sep}.claude${sep}defer-tools.json`
}

/** Reads the settings file (or the store), sets the display to match, and returns the settings. */
async function loadSettings($: EngineInterface): Promise<DeferToolsSettings> {
  settingsPath = await findSettingsPath($)
  let raw: unknown
  settingsProblems = []
  try {
    if (settingsPath !== undefined) {
      if (await $.fs.exists(settingsPath)) raw = JSON.parse(String(await $.fs.read(settingsPath)))
    } else raw = (await $.store.get(SETTINGS_STORE_KEY)) ?? undefined
  } catch (error) {
    settingsProblems = [`could not read it (${error instanceof Error ? error.message : 'unknown error'})`]
  }
  const { settings, problems } = parseSettings(raw, baseSettings)
  settingsProblems = [...settingsProblems, ...problems]
  await applyDisplay($, settings)
  return settings
}

function settingsNow($: EngineInterface): Promise<DeferToolsSettings> {
  settingsLoaded ??= loadSettings($).catch(() => baseSettings)
  return settingsLoaded
}

/** Takes the display settings into effect at once: the status line and the animation. */
async function applyDisplay($: EngineInterface, s: DeferToolsSettings): Promise<void> {
  await update($, settingsAtom, () => s)
  statusMode = s.statusLine
  animate = s.animate
  statusTimer?.cancel()
  statusTimer = undefined
  if (s.statusLine === 'off') $.ui.status(undefined)
  else {
    const current = await read($, savings)
    shownNet = netNow(current)
    $.ui.status(lineFor(current))
  }
}

/** Saves the settings and takes what can change now into effect; tool moves wait for /clear. */
async function saveSettings($: EngineInterface, s: DeferToolsSettings): Promise<void> {
  settingsLoaded = Promise.resolve(s)
  await applyDisplay($, s)
  const text = settingsText(s)
  if (settingsPath !== undefined) await $.fs.write(settingsPath, text)
  else await $.store.set(SETTINGS_STORE_KEY, JSON.parse(text))
  // Claude Code asks the hooks again, and takes the new placements at the next /clear or new session.
  try {
    $.ui.invalidate('tool.describe')
  } catch {
    // Without it, the change waits for a new session.
  }
}

async function editSettings($: EngineInterface, fn: (s: DeferToolsSettings) => DeferToolsSettings): Promise<void> {
  await saveSettings($, fn(await settingsNow($)))
}

/** The savings rows for the tools the mod moves behind ToolSearch in this conversation. */
function savingsRows(rows: DeferToolsCatalogTool[], s: DeferToolsSettings): DeferToolsSavings['tools'] {
  return rows
    .filter(t => t.appliedDeferred && (defaults.has(t.name) || s.tools[t.name] === 'defer'))
    .map(t => ({ name: t.name, tokens: t.tokens, source: t.source, wasInFront: !t.engineDeferred, isLoaded: false, isMcp: t.isMcp }))
}

// ----------------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const keep = new Set(names(options.keepInFront))
  defaults = new Set([...Object.keys(DEFAULTS), ...names(options.alsoDefer)].filter(t => !keep.has(t)))
  baseSettings = defaultSettings(options.statusLine !== false)
  settingsLoaded = undefined

  // Every tool: recorded for the picker, and placed where the person or the default list says.
  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    const engineDeferred = e.isDeferred === true
    let s: DeferToolsSettings
    try {
      s = await settingsNow($)
    } catch {
      s = baseSettings
    }
    const { isDeferred, isChosen } = placementOf(e.tool, s, defaults, engineDeferred)
    try {
      // Only the first description counts: an MCP tool behind ToolSearch is described again once loaded,
      // and a changed setting asks again; that placement waits for /clear.
      const rows = await read($, catalog)
      if (!rows.some(t => t.name === e.tool)) {
        const row = toolRow(e.tool, e.description, !engineDeferred)
        await update($, catalog, list => [
          ...list,
          {
            name: e.tool,
            tokens: row.tokens,
            source: row.source,
            isMcp: row.isMcp,
            engineDeferred,
            appliedDeferred: isDeferred,
            about: aboutTool(e.tool, e.description),
          },
        ])
        if (isDeferred && (defaults.has(e.tool) || isChosen))
          await change($, sv => (sv.tools.some(t => t.name === e.tool) ? sv : { ...sv, tools: [...sv.tools, row] }))
      }
    } catch {
      // The display is best effort: the placement below never waits on it.
    }
    if (isDeferred === engineDeferred && !isChosen && !defaults.has(e.tool)) return result
    return { ...result, isDeferred }
  }).catch(($, e, next) => next(e))

  // Name the tools the mod moved behind ToolSearch, so the model knows they exist.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    // The tools placed in this conversation; before any is described, the ones the settings defer.
    let ours: string[] = []
    try {
      ours = (await read($, savings)).tools.map(t => t.name)
      if (ours.length === 0) {
        const s = await settingsNow($)
        ours = e.tools.filter(t => s.tools[t] === 'defer' || (s.tools[t] === undefined && defaults.has(t)))
      }
    } catch {
      ours = [...defaults]
    }
    const offered = e.tools.filter(tool => ours.includes(tool))
    if (offered.length === 0) return result
    const items = offered.map(tool => (DEFAULTS[tool] ? `${tool} (${DEFAULTS[tool]})` : tool)).join('; ')
    const text =
      `These tools are available behind ToolSearch: ${items}. ` +
      'Before you call one, load it with ToolSearch, query "select:<name>".'
    try {
      await change($, s => ({ ...s, noteTokens: roughTokens(text) }))
    } catch {
      // Best effort.
    }
    return { ...result, sections: [...result.sections, { id: 'defer-tools:note', text, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // Each ToolSearch call of the main conversation: a hop that loaded the mod's tools, an empty search,
  // or a search for tools Claude Code defers by itself.
  on('tool.call', { tool: 'ToolSearch' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true) return ran
    const result = ran.result as { matches?: unknown } | undefined
    const matches = Array.isArray(result?.matches) ? result.matches.filter((m): m is string => typeof m === 'string') : []
    const cost = roughTokens(JSON.stringify({ query: e.query, max_results: e.max_results }) + (ran.text ?? ''))
    await change($, s => {
      if (matches.length === 0) return { ...s, emptySearches: s.emptySearches + 1, emptyTokens: s.emptyTokens + cost }
      const ours = new Set(matches.filter(m => s.tools.some(t => t.name === m && t.wasInFront)))
      if (ours.size === 0) return { ...s, otherSearches: s.otherSearches + 1 }
      return {
        ...s,
        hops: s.hops + 1,
        hopTokens: s.hopTokens + cost,
        tools: s.tools.map(t => (ours.has(t.name) ? { ...t, isLoaded: true } : t)),
      }
    })
    return ran
  }).catch(($, e, next) => next(e))

  // Each model request of the main conversation: what it left out, and what the API says it cost.
  on('turn.step', async function* ($, e, next) {
    const before = e.agentId === undefined ? await read($, savings) : undefined
    const response = yield* next(e)
    if (before === undefined) return response
    try {
      const notSent = savedNow(before)
      const usage = response.usage
      const isExtra = response.toolUses.length > 0 && response.toolUses.every(u => u.name === 'ToolSearch')
      await change($, s => ({
        ...s,
        requests: s.requests + 1,
        tokensNotSent: s.tokensNotSent + notSent,
        noteTokensSent: s.noteTokensSent + s.noteTokens,
        firstRequestTokens:
          s.firstRequestTokens ??
          (usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : null),
        extraRequests: s.extraRequests + (isExtra ? 1 : 0),
        extraOutputTokens: s.extraOutputTokens + (isExtra && usage ? usage.output_tokens : 0),
      }))
    } catch {
      // The display is best effort: the request itself is never touched.
    }
    return response
  })

  let hasEngineEstimates = false
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      if (!hasEngineEstimates) {
        hasEngineEstimates = true
        await readEngineEstimates($)
      }
      const s = await read($, savings)
      const id = await $.session.id()
      const records = await readRecords($)
      records[id] = sessionRecord(s, await $.clock.now())
      await $.store.set(STORE_KEY, trimRecords(records))
    } catch {
      // Best effort.
    }
    return result
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show the tokens defer-tools saves in this session' })
    await $.command.register({
      name: SETTINGS_COMMAND,
      description: 'Choose which tools defer-tools hides behind ToolSearch, and what its display shows',
      argumentHint: '[defer|keep|default <tool>] [charts <list>] [animate on|off] [status full|number|off]',
    })
    try {
      // Read the file afresh: a hand edit since the last session counts.
      settingsLoaded = loadSettings($)
      await settingsLoaded
    } catch {
      // The defaults stand.
    }
    return next(e)
  })

  // A /clear starts a new conversation: the counts start over, and tool changes take effect.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      hasEngineEstimates = false
      try {
        const s = await settingsNow($)
        const rows = await update($, catalog, list =>
          list.map(t => ({ ...t, appliedDeferred: placementOf(t.name, s, defaults, t.engineDeferred).isDeferred })),
        )
        await change($, sv => ({ ...emptySavings(), noteTokens: sv.noteTokens, tools: savingsRows(rows, s) }))
      } catch {
        await change($, sv => ({ ...emptySavings(), noteTokens: sv.noteTokens, tools: sv.tools.map(t => ({ ...t, isLoaded: false })) }))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => {
    await update($, view, () => 'charts' as const)
    const opened = await $.ui.open({ id: PANE, title: 'Token savings' })
    if (opened.isPlaced) {
      await play($).catch(() => undefined)
      return { text: 'Opened the defer-tools savings pane.' }
    }
    // No surface draws a pane here: answer with the report itself.
    return { text: reportLines(await read($, savings), await readTotals($)).join('\n') }
  })

  on('command.run', { command: SETTINGS_COMMAND }, async ($, e) => {
    settingsLoaded = loadSettings($)
    const s = await settingsLoaded
    if (e.args.trim() !== '') {
      const done = applyCommand(s, e.args)
      if (done.settings) await saveSettings($, done.settings)
      return { text: done.text }
    }
    await update($, view, () => 'settings' as const)
    // With the keys, Tab and the arrows walk the rows and each row says what its tool does.
    const opened = await $.ui.open({ id: PANE, title: 'defer-tools settings', focus: true })
    if (opened.isPlaced) return { text: 'Opened the defer-tools settings.' }
    return { text: settingsReport(s, await read($, catalog)) }
  })

  // The terminal has no pointer to hover with: the row under the keyboard focus explains its tool.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) await update($, focusedTool, () => toolOfFocus(e.element)).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if ((await read($, view)) === 'settings') {
      const { Box, Text, Button, Select } = $.ui.resolve(e) as ElementTable<'desktop'>
      const s = await read($, settingsAtom)
      const rows = [...(await read($, catalog))].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
      const NAME = 40
      // Under the name column: the button's width and the gap before the name.
      const ABOUT_INDENT = e.surface === 'terminal' ? 11 : 12
      const focused = await read($, focusedTool)
      const pending = rows.filter(t => placementOf(t.name, s, defaults, t.engineDeferred).isDeferred !== t.appliedDeferred)
      const nextSaved = rows.reduce((sum, t) => {
        const isDeferred = placementOf(t.name, s, defaults, t.engineDeferred).isDeferred
        return isDeferred && !t.engineDeferred ? sum + t.tokens : sum
      }, 0)
      return (
        <Box flexDirection="column">
          <Text bold>TOOLS</Text>
          <Text dimColor>
            Hidden tools wait behind ToolSearch and load when the model asks. Tokens are per request; changes apply from
            the next /clear or new session.
          </Text>
          <Text dimColor>
            {e.surface === 'terminal'
              ? 'Move with Tab or the arrow keys: the tool you are on says what it does.'
              : 'Point at a tool to see what it does.'}
          </Text>
          <Text>
            With these choices: about <Text bold color="#3987e5">{full(nextSaved)}</Text> schema tokens kept out of every
            request{pending.length > 0 ? ` · ${pending.length} change${pending.length === 1 ? '' : 's'} waiting for /clear` : ''}
          </Text>
          {rows.length === 0 && <Text dimColor>No tools described yet: send a first message, then open this again.</Text>}
          {rows.map((t, i) => {
            const { isDeferred, isChosen } = placementOf(t.name, s, defaults, t.engineDeferred)
            const isPending = isDeferred !== t.appliedDeferred
            // Each row is a hover scope: the pointer on it lights the name and shows the line under it,
            // which the keyboard focus shows too (the terminal's way in).
            return (
              <Box key={`row:${t.name}`} flexDirection="column">
              <Box flexDirection="row">
                <Button
                  key={`tool:${t.name}`}
                  label={isDeferred ? 'Hidden' : 'Loaded'}
                  variant={isDeferred ? 'primary' : undefined}
                  autoFocus={i === 0 ? true : undefined}
                  onPress={() => editSettings($, x => toggleTool(x, t.name, isDeferred)).catch(() => undefined)}
                />
                <Box width={NAME} marginLeft={1}>
                  <Text hover={{ bold: true, color: 'suggestion' }}>{t.name}</Text>
                </Box>
                <Box width={8} justifyContent="flex-end">
                  <Text>{full(t.tokens)}</Text>
                </Box>
                <Text dimColor>
                  {' '}
                  {sourceTag(t.source)}
                  {t.engineDeferred ? ' · Claude Code hides it too' : ''}
                  {isPending ? ` · now ${t.appliedDeferred ? 'hidden' : 'loaded'}` : ''}{isChosen ? ' ' : ''}
                </Text>
                {isChosen && (
                  <Button
                    key={`reset:${t.name}`}
                    label="Default"
                    dimColor
                    onPress={() => editSettings($, x => resetTool(x, t.name)).catch(() => undefined)}
                  />
                )}
              </Box>
              <Box
                display={focused === t.name ? 'flex' : 'none'}
                hover={{ display: 'flex' }}
                flexDirection="column"
                marginLeft={ABOUT_INDENT}
              >
                <Text>{t.about}</Text>
                <Text dimColor>
                  {placementWords(isDeferred)} · {full(t.tokens)} tokens per request
                </Text>
              </Box>
              </Box>
            )
          })}
          <Text> </Text>
          <Text bold>DISPLAY</Text>
          <Text dimColor>Display changes apply at once.</Text>
          {[...s.charts, ...CHARTS.filter(c => !s.charts.includes(c))].map((c: ChartId) => {
            const isShown = s.charts.includes(c)
            return (
              <Box flexDirection="row">
                <Button
                  key={`chart:${c}`}
                  label={isShown ? 'Shown' : 'Hidden'}
                  variant={isShown ? 'primary' : undefined}
                  onPress={() => editSettings($, x => toggleChart(x, c)).catch(() => undefined)}
                />
                <Box width={NAME} marginLeft={1}>
                  <Text dimColor={!isShown}>{isShown ? `${s.charts.indexOf(c) + 1}. ${CHART_NAMES[c]}` : `   ${CHART_NAMES[c]}`}</Text>
                </Box>
                {isShown && s.charts.indexOf(c) > 0 && (
                  <Button key={`up:${c}`} label="Move up" dimColor onPress={() => editSettings($, x => moveChartUp(x, c)).catch(() => undefined)} />
                )}
              </Box>
            )
          })}
          <Box flexDirection="row">
            <Button
              key="animate"
              label={s.animate ? 'On' : 'Off'}
              variant={s.animate ? 'primary' : undefined}
              onPress={() => editSettings($, x => ({ ...x, animate: !x.animate })).catch(() => undefined)}
            />
            <Text> Animation (count-up and growing bars)</Text>
          </Box>
          <Select
            key="status"
            label="Status line: "
            value={s.statusLine}
            options={STATUS_MODES.map(m => ({
              value: m,
              label: m === 'full' ? 'number and ToolSearch counts' : m === 'number' ? 'number only' : 'off',
            }))}
            onSelect={value =>
              void editSettings($, x => ({ ...x, statusLine: value as DeferToolsSettings['statusLine'] })).catch(() => undefined)
            }
          />
          <Text> </Text>
          <Text dimColor>
            Saved in {settingsPath ?? "the mod's own store (no home folder found)"}
            {settingsProblems.length > 0 ? `; skipped: ${settingsProblems.join('; ')}` : ''}
          </Text>
          <Box flexDirection="row">
            <Button key="back" label="Back to charts" onPress={() => showCharts($).catch(() => undefined)} />
          </Box>
        </Box>
      )
    }

    const s = await read($, savings)
    const settings = await read($, settingsAtom)
    const known = new Map((await read($, catalog)).map(t => [t.name, t.about]))
    const base = visualOf(s)
    const v = { ...base, tools: base.tools.map(t => ({ ...t, about: known.get(t.name) ?? aboutTool(t.name, '') })) }

    // Terminal: big block digits and coloured bars, stepped frame by frame.
    if (e.surface === 'terminal') {
      const { Box, Text, Button, Raster } = $.ui.resolve(e) as ElementTable<'terminal'>
      const p = ease((await read($, frame)) / FRAMES)
      const isExplaining = await read($, explain)
      const LABEL = 24
      const barW = Math.max(10, Math.min(48, e.props.bodyColumns - LABEL - 24))
      const label = (text: string) => <Text>{(text.length > LABEL - 1 ? `${text.slice(0, LABEL - 2)}…` : text).padEnd(LABEL)}</Text>
      const buttons = (
        <Box flexDirection="row">
          <Button key="replay" label="Replay" onPress={() => play($).catch(() => undefined)} />
          <Text> </Text>
          <Button key="refresh" label="Refresh estimates" onPress={() => readEngineEstimates($).catch(() => undefined)} />
          <Text> </Text>
          <Button key="settings" label="Settings" onPress={() => showSettings($).catch(() => undefined)} />
          <Text> </Text>
          <Button
            key="explain"
            label={isExplaining ? 'Hide tool notes' : 'What do these tools do?'}
            onPress={() => void update($, explain, x => !x).catch(() => undefined)}
          />
        </Box>
      )
      if (v.isEmpty)
        return (
          <Box flexDirection="column">
            <Text>No tool from the list was in front in this session, so defer-tools saves nothing here yet.</Text>
            {buttons}
          </Box>
        )
      const maxTool = Math.max(1, ...v.tools.map(t => t.tokens))
      const total = Math.max(1, v.session.notSent)
      const costShare = (p * v.session.overhead) / total
      const costBump = v.session.overhead > 0 ? Math.max(0, 0.5 / barW - costShare) : 0
      const blocks: Record<ChartId, () => RenderChildren[]> = {
        hero: () => [
          <Text dimColor>SAVED ON EVERY REQUEST (NET)</Text>,
          <Box flexDirection="row" alignItems="flex-end">
            <Raster key="hero" {...bigNumber(Math.round(v.net * p), T.saved)} />
            <Text> tokens</Text>
          </Box>,
          <Text dimColor>
            {full(v.schemas)} schema tokens minus {full(v.note)} for the prompt line (est.)
          </Text>,
        ],
        firstRequest: () =>
          v.before
            ? [
                <Text dimColor>FIRST REQUEST OF THIS CONVERSATION</Text>,
                <Box flexDirection="row">
                  {label('Without defer-tools')}
                  <Raster key="without" {...barRaster(barW, [{ fraction: p, color: T.without }])} />
                  <Text> {full(Math.round(v.before.without * p))} (about)</Text>
                </Box>,
                <Box flexDirection="row">
                  {label('With defer-tools')}
                  <Raster key="with" {...barRaster(barW, [{ fraction: (p * v.before.with) / Math.max(1, v.before.without), color: T.saved }])} />
                  <Text> {full(Math.round(v.before.with * p))} (live)</Text>
                </Box>,
                <Text color="#3987e5">
                  {''.padEnd(LABEL)}
                  {full(v.before.without - v.before.with)} fewer tokens ({pct(v.before.without - v.before.with, v.before.without)} smaller)
                </Text>,
              ]
            : [],
        perTool: () => [
          <Text dimColor>PER TOOL, TOKENS PER REQUEST</Text>,
          ...v.tools.flatMap(t => [
            <Box flexDirection="row">
              {label(t.name)}
              <Raster key={`tool-${t.name}`} {...barRaster(barW, [{ fraction: (p * t.tokens) / maxTool, color: t.isLoaded ? T.loaded : T.saved }])} />
              <Text> {full(t.tokens)} </Text>
              <Text dimColor>
                {sourceTag(t.source)}
                {t.isLoaded ? ' · loaded' : ''}
              </Text>
            </Box>,
            // The terminal has no hover: one press shows a line under each tool on what it does.
            ...(isExplaining
              ? [
                  <Text dimColor>
                    {''.padEnd(LABEL)}
                    {t.about}
                  </Text>,
                ]
              : []),
          ]),
          ...(v.notCounted.length > 0 ? [<Text dimColor>Not counted (Claude Code defers them anyway): {v.notCounted.join(', ')}</Text>] : []),
        ],
        conversation: () => [
          <Text dimColor>
            THIS CONVERSATION · {v.session.requests} REQUEST{v.session.requests === 1 ? '' : 'S'}
          </Text>,
          <Box flexDirection="row">
            {label('Net saved, all requests')}
            <Raster
              key="session"
              {...barRaster(barW, [
                // The cost gets at least half a cell so it shows; the net gives up that much.
                { fraction: Math.max(0, (p * Math.max(0, v.session.net)) / total - costBump), color: T.saved },
                { fraction: costShare + costBump, color: T.cost },
              ])}
            />
            <Text> {full(Math.round(v.session.net * p))} net</Text>
          </Box>,
          <Box flexDirection="row">
            <Text>{''.padEnd(LABEL)}</Text>
            <Text color="#3987e5">■</Text>
            <Text dimColor> net  </Text>
            <Text color="#d95926">■</Text>
            <Text dimColor>
              {' '}taken back {full(v.session.overhead)} ({pct(v.session.overhead, v.session.notSent)})
            </Text>
          </Box>,
        ],
        toolSearch: () => [
          <Text>
            {'ToolSearch  '}
            <Text bold>{Math.round(v.session.hops * p)}</Text>
            {` hop${v.session.hops === 1 ? '' : 's'} (~${full(v.session.hopTokens)} est.)  ·  `}
            <Text bold>{Math.round(v.session.empty * p)}</Text>
            {` empty (~${full(v.session.emptyTokens)} est.)  ·  `}
            <Text bold>{Math.round(v.session.extra * p)}</Text>
            {` extra request${v.session.extra === 1 ? '' : 's'} (${full(v.session.extraOut)} out, live)`}
          </Text>,
        ],
      }
      const shown = settings.charts.map(c => blocks[c]()).filter(b => b.length > 0)
      return (
        <Box flexDirection="column">
          {shown.flatMap((b, i) => (i === 0 ? b : [<Text> </Text>, ...b]))}
          {shown.length === 0 && <Text dimColor>Every chart is hidden: press Settings to show some.</Text>}
          <Text> </Text>
          <Text dimColor>live = API usage · table = README (2.1.318) · CC est. = Claude Code's estimate · rough = text ÷ 4</Text>
          {buttons}
        </Box>
      )
    }

    // Desktop, VS Code and mobile: one SVG with its own animation.
    const { Box, Button, Svg } = $.ui.resolve(e) as ElementTable<'desktop'>
    let isPlaying = false
    try {
      isPlaying = settings.animate && (await $.clock.now()) - (await read($, playedAt)) < 2000
    } catch {
      isPlaying = false
    }
    const totals = await readTotals($)
    return (
      <Box flexDirection="column">
        <Svg source={svgPanel(v, { animate: isPlaying, charts: settings.charts })} alt={reportLines(s, totals).join('\n')} isInteractive />
        <Box flexDirection="row">
          <Button key="replay" label="Replay" onPress={() => play($).catch(() => undefined)} />
          <Button key="refresh" label="Refresh estimates" onPress={() => readEngineEstimates($).catch(() => undefined)} />
          <Button key="settings" label="Settings" onPress={() => showSettings($).catch(() => undefined)} />
        </Box>
      </Box>
    )
  })
}

async function showSettings($: EngineInterface): Promise<void> {
  settingsLoaded = loadSettings($)
  await settingsLoaded
  await update($, view, () => 'settings' as const)
}

async function showCharts($: EngineInterface): Promise<void> {
  await update($, view, () => 'charts' as const)
  await play($)
}

/** The settings as text, where no pane can be drawn. */
function settingsReport(s: DeferToolsSettings, rows: DeferToolsCatalogTool[]): string {
  const lines = ['defer-tools settings', '', 'Tools (hidden = behind ToolSearch; changes apply from the next /clear or new session):']
  for (const t of [...rows].sort((a, b) => b.tokens - a.tokens)) {
    const { isDeferred, isChosen } = placementOf(t.name, s, defaults, t.engineDeferred)
    lines.push(`  ${isDeferred ? 'hidden' : 'loaded'}  ${t.name}: ${full(t.tokens)} (${sourceTag(t.source)})${isChosen ? ', your choice' : ''}`)
    lines.push(`          ${t.about}`)
  }
  lines.push('', `Charts, in order: ${s.charts.join(', ') || 'none'}`, `Animation: ${s.animate ? 'on' : 'off'}`, `Status line: ${s.statusLine}`)
  lines.push('', `Change one with /${SETTINGS_COMMAND} keep <tool>, defer <tool>, charts <list>, animate on|off or status full|number|off.`)
  return lines.join('\n')
}
