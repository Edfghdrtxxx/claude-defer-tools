import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'defer-tools',
  component: 'Pane',
  requestId: 'defer-tools-savings',
  props: {
    title: 'Token savings',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const ENGINE = { plugin: 'engine', tier: 'core' } as const
const USAGE = { input_tokens: 5, cache_read_input_tokens: 21000, cache_creation_input_tokens: 156, output_tokens: 40, model: 'm' }

test('counts what it defers, a hop, an empty search and the requests, on every surface', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.describe', (_, e) => ({ description: e.description }))
  let matches: string[] = []
  on('tool.call', () => ({
    result: { matches, query: 'q', total_deferred_tools: 5 },
    text: matches.length ? '' : 'No matching deferred tools found',
  }))
  let toolUses: { name: string; input: unknown }[] = []
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses, stopReason: 'tool_use' as const, usage: USAGE }
  })

  // Artifact and Workflow are in front without the mod; the MCP tool is already behind ToolSearch.
  const deferred = await $.tool.describe({ tool: 'Artifact', description: 'a', provider: ENGINE })
  expect(deferred.isDeferred).toBe(true)
  await $.tool.describe({ tool: 'Workflow', description: 'w', provider: ENGINE })
  await $.tool.describe({ tool: 'mcp__visualize__read_me', description: 'x'.repeat(400), isDeferred: true, provider: ENGINE })
  expect(statuses.at(-1)).toBe('defer-tools: saves 15k tokens per request')

  // First request: one ToolSearch call only, so it is an extra round trip.
  toolUses = [{ name: 'ToolSearch', input: { query: 'select:Workflow' } }]
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of step) void _
  await step.result

  matches = ['Workflow']
  await $.tool.call({ tool: 'ToolSearch', query: 'select:Workflow', max_results: 5 })
  matches = []
  await $.tool.call({ tool: 'ToolSearch', query: 'nothing like this', max_results: 5 })
  matches = ['mcp__other__tool']
  await $.tool.call({ tool: 'ToolSearch', query: 'other', max_results: 5 })

  toolUses = []
  const second = $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 3 })
  for await (const _ of second) void _
  await second.result

  // Workflow is loaded now, so only Artifact still saves.
  expect(statuses.at(-1)).toBe('defer-tools: saves 13k tokens per request · 1 ToolSearch hop, 1 empty search')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Saved per request now/ }))?.text).toBe('Saved per request now: 12,773 tokens (net)')
    expect((await ui.find({ type: 'Text', text: /First request/ }))?.text).toBe('First request of this conversation: 21,161 tokens (live)')
    expect((await ui.find({ type: 'Text', text: /Without defer-tools/ }))?.text).toBe('  Without defer-tools: about 35,886')
    expect((await ui.find({ type: 'Text', text: /Workflow:/ }))?.text).toBe('  Workflow: 1,952 (README table), loaded by ToolSearch')
    expect((await ui.find({ type: 'Text', text: /Already behind/ }))?.text).toContain('mcp__visualize__read_me')
    expect((await ui.find({ type: 'Text', text: /Empty searches/ }))?.text).toMatch(/^  Empty searches: 1, about \d+ tokens \(estimate\)$/)
    expect((await ui.find({ type: 'Text', text: /Extra model requests/ }))?.text).toBe('  Extra model requests: 1, 40 output tokens (live)')
    expect((await ui.find({ type: 'Text', text: /defers by itself/ }))?.text).toBe('  Searches for tools Claude Code defers by itself: 1 (not counted)')
    expect((await ui.find({ type: 'Text', text: /not sent: 27/ }))?.text).toBe('  Schema tokens not sent: 27,498 (mostly cache reads)')
    await ui.unmount()
  }
})

test('a tool kept in front is not deferred and not counted', { options: { keepInFront: 'Artifact' } }, async ($, on) => {
  on('ui.status', () => ({ value: undefined }))
  on('tool.describe', (_, e) => ({ description: e.description }))
  const kept = await $.tool.describe({ tool: 'Artifact', description: 'a', provider: ENGINE })
  expect(kept.isDeferred).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/saves nothing here yet/)
  await ui.unmount()
})

test('a /clear starts the counts over and unloads the tools', async ($, on) => {
  on('tool.describe', (_, e) => ({ description: e.description }))
  on('tool.call', () => ({ result: { matches: ['Artifact'], query: 'q', total_deferred_tools: 1 }, text: '' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('ui.status', () => ({ value: undefined }))
  await $.tool.describe({ tool: 'Artifact', description: 'a', provider: ENGINE })
  await $.tool.call({ tool: 'ToolSearch', query: 'select:Artifact', max_results: 1 })
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { sessionId: 's' } as never })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Saved per request now/ }))?.text).toBe('Saved per request now: 12,773 tokens (net)')
  expect((await ui.find({ type: 'Text', text: /Hops for/ }))?.text).toBe("  Hops for the mod's tools: 0, about 0 tokens (estimate)")
  await ui.unmount()
})

test('the prompt line is subtracted, an MCP tool takes Claude Code estimate, and the session is kept', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 200000,
        breakdown: { mcpTools: [{ name: 'mcp__visualize__show_widget', serverName: 'visualize', tokens: 900, isLoaded: false }] },
      },
    } as never,
  }))
  on('tool.describe', (_, e) => ({ description: e.description }))
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.tool.describe({ tool: 'mcp__visualize__show_widget', description: 'w'.repeat(40), provider: ENGINE })
  const composed = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: ['mcp__visualize__show_widget', 'Bash'],
    outputStyle: null,
    traits: [],
  })
  const line = composed.sections.find(s => s.id === 'defer-tools:note')
  expect(line?.text).toContain('mcp__visualize__show_widget (inline SVG or HTML widgets)')
  expect(line?.text).not.toContain('Artifact')

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const note = Math.ceil((line?.text.length ?? 0) / 4)
  expect((await ui.find({ type: 'Text', text: /^Saved per request now/ }))?.text).toBe(
    `Saved per request now: ${(900 - note).toLocaleString('en-US')} tokens (net)`,
  )
  expect((await ui.find({ type: 'Text', text: /show_widget:/ }))?.text).toBe(
    '  mcp__visualize__show_widget: 900 (Claude Code estimate), not loaded',
  )
  await ui.unmount()
  expect(stored.get('sessions-v1')).toEqual({
    'session-1': { at: 1000, requests: 0, net: 0, hops: 0, emptySearches: 0 },
  })
})
