import { expect, mock, test } from 'claude-code/testing'

import { applyCommand, defaultSettings, moveChartUp, parseSettings, toggleChart } from '../hooks/settings'

const ENGINE = { plugin: 'engine', tier: 'core' } as const
const FILE = '/home/t/.claude/defer-tools.json'

const PANE = {
  plugin: 'defer-tools',
  component: 'Pane',
  requestId: 'defer-tools-savings',
  props: {
    title: 'defer-tools settings',
    isFocused: false,
    bodyColumns: 110,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const PRESENTATION = { layout: 'main', columns: 100 } as never
const run = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' } as never, presentation: PRESENTATION })

test('the settings file: a typo keeps the default and says what it skipped', () => {
  const base = defaultSettings()
  const { settings, problems } = parseSettings(
    { tools: { Workflow: 'keep', Bash: 'hide' }, charts: ['perTool', 'pie'], animate: 'yes', statusLine: 'number' },
    base,
  )
  expect(settings.tools).toEqual({ Workflow: 'keep' })
  expect(settings.charts).toEqual(['perTool'])
  expect(settings.animate).toBe(true)
  expect(settings.statusLine).toBe('number')
  expect(problems).toEqual([
    'tools.Bash: use "defer" or "keep"',
    'charts: unknown chart "pie"',
    'animate: use true or false',
  ])
  expect(parseSettings(undefined, base).settings).toEqual(base)
})

test('the /defer-settings words and the chart order', () => {
  const s = defaultSettings()
  expect(applyCommand(s, 'keep Workflow,Artifact').settings?.tools).toEqual({ Workflow: 'keep', Artifact: 'keep' })
  expect(applyCommand(s, 'defer mcp__github__create_issue').settings?.tools).toEqual({ mcp__github__create_issue: 'defer' })
  expect(applyCommand({ ...s, tools: { Workflow: 'keep' } }, 'default Workflow').settings?.tools).toEqual({})
  expect(applyCommand(s, 'charts perTool hero').settings?.charts).toEqual(['perTool', 'hero'])
  expect(applyCommand(s, 'charts pie').settings).toBeUndefined()
  expect(applyCommand(s, 'animate off').settings?.animate).toBe(false)
  expect(applyCommand(s, 'status off').settings?.statusLine).toBe('off')
  expect(applyCommand(s, 'what').text).toMatch(/^Usage/)

  const hidden = toggleChart(s, 'firstRequest')
  expect(hidden.charts).toEqual(['hero', 'perTool', 'conversation', 'toolSearch'])
  expect(toggleChart(hidden, 'firstRequest').charts).toEqual(['hero', 'firstRequest', 'perTool', 'conversation', 'toolSearch'])
  expect(moveChartUp(s, 'perTool').charts).toEqual(['hero', 'perTool', 'firstRequest', 'conversation', 'toolSearch'])
})

test('the file decides which tools wait behind ToolSearch; the picker changes it for the next /clear', async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map<string, string>([[FILE, JSON.stringify({ tools: { Workflow: 'keep', Bash: 'defer' } })]])
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.describe', (_, e) => ({ description: e.description }))

  // The defaults hide Artifact; the file keeps Workflow in front and hides Bash.
  expect((await $.tool.describe({ tool: 'Artifact', description: 'a', provider: ENGINE })).isDeferred).toBe(true)
  expect((await $.tool.describe({ tool: 'Workflow', description: 'w', provider: ENGINE })).isDeferred).toBe(false)
  expect((await $.tool.describe({ tool: 'Bash', description: 'b'.repeat(800), provider: ENGINE })).isDeferred).toBe(true)
  expect((await $.tool.describe({ tool: 'Read', description: 'r'.repeat(400), provider: ENGINE })).isDeferred).toBeUndefined()

  // /defer-settings opens the settings view: every tool, with its tokens and where it is.
  await $.command.run(run('defer-settings'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', key: 'tool:Artifact' }))?.props.label).toBe('Hidden')
    expect((await ui.find({ type: 'Button', key: 'tool:Workflow' }))?.props.label).toBe('Loaded')
    expect((await ui.find({ type: 'Button', key: 'tool:Bash' }))?.props.label).toBe('Hidden')
    expect((await ui.find({ type: 'Button', key: 'tool:Read' }))?.props.label).toBe('Loaded')
    expect(await ui.find({ type: 'Button', key: 'reset:Workflow' })).toBeDefined()
    await ui.unmount()
  }

  // Press Workflow: hidden from the next /clear, saved in the file.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tool:Workflow' })
  expect(JSON.parse(files.get(FILE)!).tools).toEqual({ Workflow: 'defer', Bash: 'defer' })
  expect((await ui.find({ type: 'Button', key: 'tool:Workflow' }))?.props.label).toBe('Hidden')
  expect((await ui.find({ type: 'Text', text: /now loaded/ }))?.text).toMatch(/now loaded/)
  expect((await ui.find({ type: 'Text', text: /waiting for \/clear/ }))?.text).toMatch(/1 change waiting for \/clear/)

  // Display: hide the per-tool chart, numbers only in the status line, no animation.
  await ui.press({ key: 'chart:perTool' })
  await ui.select({ key: 'status', value: 'number' })
  await ui.press({ key: 'animate' })
  const saved = JSON.parse(files.get(FILE)!)
  expect(saved.charts).toEqual(['hero', 'firstRequest', 'conversation', 'toolSearch'])
  expect(saved.statusLine).toBe('number')
  expect(saved.animate).toBe(false)
  await ui.unmount()

  // After /clear, Workflow counts as saved too.
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { sessionId: 's' } as never })
  await clock.advance(1000)
  expect(statuses.at(-1)).toBe('defer-tools: ▼ 15k tokens saved per request')

  // The charts view follows the display settings: no per-tool chart.
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'back' })
  const svg = String((await desk.find({ type: 'Svg' }))?.props.source)
  expect(svg).toContain('TOKENS SAVED ON EVERY REQUEST')
  expect(svg).not.toContain('PER TOOL')
  expect(svg).not.toContain('<animate')
  await desk.unmount()

  // The command words work too, and turn the status line off.
  const answer = await $.command.run(run('defer-settings', 'status off'))
  expect(answer.text).toBe('Status line: off.')
  expect(statuses.at(-1)).toBeUndefined()
  expect(JSON.parse(files.get(FILE)!).statusLine).toBe('off')
})
