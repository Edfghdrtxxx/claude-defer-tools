import type { Register } from 'claude-code'

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

const names = (value: unknown): string[] =>
  typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : []

export const register: Register = (on, options) => {
  const keep = new Set(names(options.keepInFront))
  const deferred = new Map<string, string>()
  for (const [tool, hint] of Object.entries(DEFAULTS)) if (!keep.has(tool)) deferred.set(tool, hint)
  for (const tool of names(options.alsoDefer)) if (!keep.has(tool) && !deferred.has(tool)) deferred.set(tool, '')
  if (deferred.size === 0) return

  on('tool.describe', { tool: [...deferred.keys()] }, async ($, e, next) => {
    return { ...(await next(e)), isDeferred: true }
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
    return { ...result, sections: [...result.sections, { id: 'defer-tools:note', text, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))
}
