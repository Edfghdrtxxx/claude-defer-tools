import { expect, mock, test } from 'claude-code/testing'

import { ABOUT, aboutTool, firstSentence, toolOfFocus } from '../hooks/about'

const ENGINE = { plugin: 'engine', tier: 'core' } as const
const MCP = { plugin: 'github', tier: 'mcp' } as never
const FILE = '/home/t/.claude/defer-tools.json'


const PANE = {
  plugin: 'defer-tools',
  component: 'Pane',
  requestId: 'defer-tools-savings',
  props: {
    title: 'defer-tools',
    isFocused: false,
    bodyColumns: 110,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const PRESENTATION = { layout: 'main', columns: 100 } as never
const run = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' } as never, presentation: PRESENTATION })

test('each tool gets one plain line on what it is for', () => {
  expect(aboutTool('Bash', 'Executes a given bash command…')).toBe(ABOUT.Bash)
  expect(aboutTool('Artifact', '')).toMatch(/web pages, slide decks and documents/)
  // A tool the list does not know: the first sentence of its own description, without Markdown.
  expect(aboutTool('Frobnicate', '# Frob\n\nTurns **every** `widget` into a [gadget](https://x.test). Then more.')).toBe(
    'Turns every widget into a gadget.',
  )
  // An MCP tool says which connector it comes from.
  expect(aboutTool('mcp__github__create_issue', 'Create a new issue in a GitHub repository.')).toBe(
    'From the github connector: Create a new issue in a GitHub repository.',
  )
  expect(aboutTool('mcp__linear__x', '')).toBe('A tool from the linear connector.')
  // A long first sentence is cut at a word, never in the middle of one.
  const long = firstSentence(`Does ${'many things '.repeat(20)}all day.`)
  expect(long.length).toBeLessThanOrEqual(110)
  expect(long).toMatch(/ (many|things)…$/)
  // Every hand-written line is short enough for one tooltip line or two.
  for (const line of Object.values(ABOUT)) expect(line.length).toBeLessThanOrEqual(90)
})

test('settings: the pointer or the keyboard focus on a tool shows what it does', async ($, on) => {
  mock.clock(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  let hasPane = true
  on('ui.open', () => ({ value: { isPlaced: hasPane } }) as never)
  on('ui.invalidate', () => ({ value: undefined }))
  on('tool.describe', (_, e) => ({ description: e.description }))

  await $.tool.describe({ tool: 'Artifact', description: 'a'.repeat(4000), provider: ENGINE })
  await $.tool.describe({ tool: 'Bash', description: 'b'.repeat(800), provider: ENGINE })
  await $.tool.describe({
    tool: 'mcp__github__create_issue',
    description: 'Create a new issue in a GitHub repository. Needs write access.',
    provider: MCP,
  })
  await $.command.run(run('defer-settings'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const tree = JSON.stringify(await ui.drawn())
    // Each explanation sits under its row, hidden until the row is hovered (or focused).
    expect(tree).toContain(ABOUT.Bash)
    expect(tree).toContain('From the github connector: Create a new issue in a GitHub repository.')
    expect(tree).toContain('"hover":{"display":"flex"}')
    expect(tree).toContain(`"key":"row:Bash"`)
    const hint = surface === 'terminal' ? /Tab or the arrow keys/ : /Point at a tool/
    expect((await ui.find({ type: 'Text', text: hint }))?.text).toMatch(hint)
    await ui.unmount()
  }

  // The keyboard: the ui.focus hook names the row the focus lands on, and that row's line shows.
  // The test kit cannot press Tab, so only the naming is checked here; nothing shows before a move.
  expect(toolOfFocus('tool:Bash')).toBe('Bash')
  expect(toolOfFocus('reset:mcp__github__create_issue')).toBe('mcp__github__create_issue')
  expect(toolOfFocus('chart:hero')).toBe('')
  expect(toolOfFocus(undefined)).toBe('')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const lines = await ui.findAll({ type: 'Box', text: new RegExp(ABOUT.Bash!) })
  expect(lines.at(-1)?.props.display).toBe('none')
  await ui.unmount()

  // The text answer (no pane) carries the lines too.
  hasPane = false
  const answer = await $.command.run(run('defer-settings'))
  expect(answer.text).toContain(ABOUT.Artifact)
})

test('charts: a hover card on the desktop, a button for notes in the terminal', async ($, on) => {
  mock.clock(on)
  on('env.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('tool.describe', (_, e) => ({ description: e.description }))
  await $.tool.describe({ tool: 'Artifact', description: 'a'.repeat(4000), provider: ENGINE })
  await $.tool.describe({ tool: 'Workflow', description: 'w'.repeat(4000), provider: ENGINE })
  await $.command.run(run('defer-savings'))

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = String((await desk.find({ type: 'Svg' }))?.props.source)
  // Hidden cards, one per tool row, shown by CSS while the pointer is on that row.
  expect(svg).toContain('.tip{visibility:hidden')
  expect(svg).toContain('#tool0:hover~#tool0-tip')
  expect(svg).toContain('Publishes web pages, slide decks and documents')
  expect(svg).toContain('Hidden behind ToolSearch: saved on every request')
  expect((await desk.find({ type: 'Svg' }))?.props.isInteractive).toBe(true)
  await desk.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /Runs a script that sends many helper agents/ })).toBeUndefined()
  await term.press({ key: 'explain' })
  expect(await term.find({ type: 'Text', text: /Runs a script that sends many helper agents/ })).toBeDefined()
  expect((await term.find({ type: 'Button', key: 'explain' }))?.props.label).toBe('Hide tool notes')
  await term.unmount()
})
