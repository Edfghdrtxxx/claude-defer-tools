// Drives the mod through a made-up session and prints what it draws, for docs/screenshots.
// scripts/render-screenshots.py turns the printed lines into the PNGs. The numbers are test
// data shaped like the README's measurements, not a real session.
import { mock, test } from 'claude-code/testing'

import { FRAMES, FRAME_MS, svgPanel, visualOf } from '../hooks/visual'
import type { DeferToolsSavings } from '../types'

declare const console: { log: (line: string) => void }

const ENGINE = { plugin: 'engine', tier: 'core' } as const

const PANE = {
  plugin: 'defer-tools',
  component: 'Pane',
  requestId: 'defer-tools-savings',
  props: {
    title: 'Token savings',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

type Scenario = {
  name: string
  tools: { tool: string; description: string; isDeferred?: true }[]
  mcpEstimates: { name: string; tokens: number }[]
  firstRequest: number
}

const CLI: Scenario = {
  name: 'cli',
  tools: ['Artifact', 'Workflow', 'ScheduleWakeup', 'ReportFindings'].map(tool => ({ tool, description: tool })),
  mcpEstimates: [],
  firstRequest: 21161,
}

const DESKTOP: Scenario = {
  name: 'desktop',
  tools: [
    ...CLI.tools,
    { tool: 'SearchPlugins', description: 'Search the plugin catalog by keyword. '.repeat(12) },
    { tool: 'SuggestPluginInstall', description: 'Render an inline card of plugins the user can add. '.repeat(14) },
    { tool: 'SuggestSkills', description: 'Render a card of standalone skills the user can add. '.repeat(10) },
    { tool: 'mcp__visualize__read_me', description: 'Setup notes for widgets.' },
    { tool: 'mcp__visualize__show_widget', description: 'Show an inline widget.' },
    { tool: 'mcp__ccd_session__read_widget_context', description: 'Read widget state.', isDeferred: true },
  ],
  mcpEstimates: [
    { name: 'mcp__visualize__read_me', tokens: 412 },
    { name: 'mcp__visualize__show_widget', tokens: 1662 },
  ],
  firstRequest: 54260,
}

for (const scenario of [CLI, DESKTOP]) {
  test(`screenshot data: ${scenario.name}`, async ($, on) => {
    const clock = mock.clock(on)
    // Keep the mod's latest savings, to draw stills of the SVG along its animation.
    let latest: DeferToolsSavings | undefined
    on('state.set', ($, e, next) => {
      if (e.key === 'savings') latest = (e.value as { value: DeferToolsSavings }).value
      return next(e)
    })
    const statuses: string[] = []
    on('ui.status', (_, e) => {
      if (e.text !== undefined) statuses.push(e.text)
      return { value: undefined }
    })
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ value: undefined }))
    on('session.id', () => ({ value: 's' }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        rateLimits: [],
        context: {
          window: 200000,
          breakdown: { mcpTools: scenario.mcpEstimates.map(t => ({ ...t, serverName: 'visualize', isLoaded: false })) },
        },
      } as never,
    }))
    on('tool.describe', (_, e) => ({ description: e.description }))
    on('prompt.compose', () => ({ sections: [] }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    let matches: string[] = []
    on('tool.call', () => ({
      result: { matches, query: 'q', total_deferred_tools: 20 },
      text: matches.length ? '' : 'No matching deferred tools found',
    }))
    let toolUses: { name: string; input: unknown }[] = []
    let request = 0
    on('turn.step', async function* (_, e) {
      request += 1
      const total = request === 1 ? scenario.firstRequest : scenario.firstRequest + 900 * request
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses,
        stopReason: 'tool_use' as const,
        usage: { input_tokens: 4, cache_creation_input_tokens: 300, cache_read_input_tokens: total - 304, output_tokens: 48, model: 'm' },
      }
    })
    const step = async (index: number) => {
      const s = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: index + 1 })
      for await (const _ of s) void _
      await s.result
    }

    for (const t of scenario.tools) await $.tool.describe({ ...t, provider: ENGINE })
    await $.prompt.compose({
      model: 'm',
      promptModel: 'm',
      surfaces: ['terminal'],
      tools: scenario.tools.map(t => t.tool),
      outputStyle: null,
      traits: [],
    })

    // Request 1 asks for Workflow, request 2 searches for something that is not there, then three plain requests.
    toolUses = [{ name: 'ToolSearch', input: { query: 'select:Workflow' } }]
    await step(0)
    matches = ['Workflow']
    await $.tool.call({ tool: 'ToolSearch', query: 'select:Workflow', max_results: 5 })
    await step(1)
    matches = []
    await $.tool.call({ tool: 'ToolSearch', query: 'kubernetes deploy', max_results: 5 })
    toolUses = []
    for (const index of [2, 3, 4]) await step(index)
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

    await clock.advance(1000)
    const status = statuses.at(-1)

    // Terminal: press Replay and keep each frame of the count-up.
    const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await term.press({ key: 'replay' })
    for (let f = 0; f <= FRAMES; f++) {
      const root = await term.find({ type: 'Box' })
      console.log(`FRAME ${JSON.stringify({ scenario: scenario.name, frame: f, tree: root })}`)
      await clock.advance(FRAME_MS)
    }
    await term.unmount()

    // Status line frames: the count-up from zero after the first tool is described.
    console.log(`STATUS ${JSON.stringify({ scenario: scenario.name, frames: statuses, final: status })}`)

    // Desktop, VS Code, mobile: the SVG the pane draws (animated), and stills along the way.
    const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const svg = await desk.find({ type: 'Svg' })
    await desk.unmount()
    const v = visualOf(latest!)
    console.log(`SVG ${JSON.stringify({ scenario: scenario.name, animated: svg?.props.source, alt: svg?.props.alt })}`)
    for (let f = 0; f <= 30; f++) {
      for (const theme of ['dark', 'light'] as const)
        console.log(`SVGFRAME ${JSON.stringify({ scenario: scenario.name, theme, frame: f, svg: svgPanel(v, { animate: false, progress: f / 30, theme }) })}`)
    }
  })
}
