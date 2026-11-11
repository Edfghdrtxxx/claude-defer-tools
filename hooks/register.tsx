import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeferToolsSavings } from '../types'
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
} from './savings'
import type { SessionRecord, Totals } from './savings'

// Tools whose full schema is sent with every request although most sessions never call them.
// Each is listed behind ToolSearch instead: it stays available, and its schema loads when the
// model asks for it by name. Descriptions are left exactly as the engine computed them.
// The hint after each name goes into one system-prompt line, so the model knows when to load it.
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
const STORE_KEY = 'sessions-v1'

// Change the tag when the fields of DeferToolsSavings change: a reload then starts fresh.
const savings = atom({ plugin: 'defer-tools', key: 'savings' } as const, emptySavings(), { shape: 'savings-1' })

const names = (value: unknown): string[] =>
  typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : []

// The status line shows only while this is true (the statusLine option).
let showStatus = true

async function change($: EngineInterface, fn: (s: DeferToolsSavings) => DeferToolsSavings): Promise<DeferToolsSavings> {
  const next = await update($, savings, fn)
  if (showStatus) $.ui.status(statusLine(next))
  return next
}

// Asks Claude Code for its own estimate of each MCP tool's schema (a local estimate, no API call).
async function readEngineEstimates($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const mcp = usage.context.breakdown?.mcpTools ?? []
  if (mcp.length === 0) return
  const byName = new Map(mcp.map(t => [t.name, t]))
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

export const register: Register = (on, options) => {
  const keep = new Set(names(options.keepInFront))
  const deferred = new Map<string, string>()
  for (const [tool, hint] of Object.entries(DEFAULTS)) if (!keep.has(tool)) deferred.set(tool, hint)
  for (const tool of names(options.alsoDefer)) if (!keep.has(tool) && !deferred.has(tool)) deferred.set(tool, '')
  if (deferred.size === 0) return
  showStatus = options.statusLine !== false

  on('tool.describe', { tool: [...deferred.keys()] }, async ($, e, next) => {
    const result = await next(e)
    try {
      // Only the first description counts: an MCP tool behind ToolSearch is described again once loaded.
      await change($, s =>
        s.tools.some(t => t.name === e.tool)
          ? s
          : { ...s, tools: [...s.tools, toolRow(e.tool, e.description, e.isDeferred !== true)] },
      )
    } catch {
      // The display is best effort: the deferral below never waits on it.
    }
    return { ...result, isDeferred: true }
  }).catch(($, e, next) => next(e))

  // Name the deferred tools the session offers (a deny rule removes a tool from that list).
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const offered = e.tools.filter(tool => deferred.has(tool))
    if (offered.length === 0) return result
    const items = offered.map(tool => (deferred.get(tool) ? `${tool} (${deferred.get(tool)})` : tool)).join('; ')
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
    if (showStatus) $.ui.status(statusLine(await read($, savings)))
    return next(e)
  })

  // A /clear starts a new conversation: the loaded tools and the counts start over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      hasEngineEstimates = false
      await change($, s => ({
        ...emptySavings(),
        noteTokens: s.noteTokens,
        tools: s.tools.map(t => ({ ...t, isLoaded: false })),
      }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Token savings' })
    if (opened.isPlaced) return { text: 'Opened the defer-tools savings pane.' }
    // No surface draws a pane here: answer with the report itself.
    return { text: reportLines(await read($, savings), await readTotals($)).join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, savings)
    const lines = reportLines(s, await readTotals($))
    return (
      <Box flexDirection="column">
        {lines.map((line, i) =>
          line === '' ? <Text> </Text> : i === 0 ? <Text bold>{line}</Text> : <Text>{line}</Text>,
        )}
        <Text> </Text>
        <Text dimColor>
          live = from this session's API usage. measured (table) = README figures, Claude Code 2.1.318. Estimates are about 4 characters per token.
        </Text>
        <Box>
          <Button key="refresh" label="Refresh estimates" onPress={() => readEngineEstimates($).catch(() => undefined)} />
        </Box>
      </Box>
    )
  })
}
