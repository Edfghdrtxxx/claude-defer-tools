// One plain line per tool: what it is for, for someone who has never read its schema.
// Shown when the pointer rests on a tool (desktop) or the keyboard focus is on it (terminal).

/** Written by hand for the tools Claude Code ships and the mod's default list. */
export const ABOUT: Record<string, string> = {
  Agent: 'Starts a helper agent that works on a task by itself and reports back.',
  Task: 'Starts a helper agent that works on a task by itself and reports back.',
  Artifact: 'Publishes web pages, slide decks and documents on claude.ai.',
  AskUserQuestion: 'Asks you a question with a few answers to pick from.',
  Bash: 'Runs commands in a terminal, like installing, building or testing.',
  BashOutput: 'Reads what a command running in the background has printed.',
  KillShell: 'Stops a command running in the background.',
  CronCreate: 'Schedules a prompt to run again at set times.',
  CronDelete: 'Removes a scheduled prompt.',
  CronList: 'Lists the prompts scheduled to run later.',
  Edit: 'Changes part of a file by replacing exact text.',
  EnterPlanMode: 'Switches to planning: Claude looks and plans before changing anything.',
  ExitPlanMode: 'Shows you the plan and asks you to approve it before work starts.',
  EnterWorktree: 'Moves the work into a separate copy of the repository (a git worktree).',
  ExitWorktree: 'Leaves the separate copy of the repository and goes back.',
  Glob: 'Finds files by their names, for example every file ending in .ts.',
  Grep: 'Searches inside files for a word or pattern.',
  ListMcpResourcesTool: 'Lists the files and data a connected app (MCP server) offers.',
  ReadMcpResourceTool: 'Reads one file or piece of data a connected app (MCP server) offers.',
  LSP: 'Asks the code editor’s language tools, for example where a function is defined.',
  Monitor: 'Watches a background command and says when something happens.',
  NotebookEdit: 'Changes cells in a Jupyter notebook.',
  PushNotification: 'Sends you a notification on your phone or computer.',
  Read: 'Opens a file so Claude can read it, including pictures and PDFs.',
  ReportFindings: 'Hands code-review results to the app as a list it can show.',
  ScheduleWakeup: 'Picks when Claude wakes up next while it runs a self-paced /loop.',
  SearchPlugins: 'Searches the plugin catalog for one that fits your task.',
  SendMessage: 'Sends a message to another agent that is already running.',
  Skill: 'Loads a skill: ready-made instructions for one kind of job.',
  SlashCommand: 'Runs one of your slash commands.',
  SuggestPluginInstall: 'Shows a card that offers to install a plugin.',
  SuggestSkills: 'Shows a card that suggests skills you could add.',
  TaskCreate: 'Adds a step to Claude’s task list for this work.',
  TaskGet: 'Reads one step of Claude’s task list.',
  TaskList: 'Shows Claude’s task list for this work.',
  TaskUpdate: 'Marks a step of the task list as started or done.',
  TaskStop: 'Stops a task running in the background.',
  TodoWrite: 'Keeps a to-do list for the current work.',
  ToolSearch: 'Finds a hidden tool and loads it when Claude needs it.',
  WebFetch: 'Downloads a web page and reads it.',
  WebSearch: 'Searches the web.',
  Workflow: 'Runs a script that sends many helper agents to work at once.',
  Write: 'Creates a file, or replaces everything in one.',
  mcp__visualize__read_me: 'Setup notes Claude reads before it draws a widget in the chat.',
  mcp__visualize__show_widget: 'Draws a chart or small interactive widget in the chat.',
  mcp__ccd_session__read_widget_context: 'Reads what a widget in the chat is showing.',
}

const MAX = 110

/** The first sentence of a tool's own description, cleaned of Markdown and kept short. */
export const firstSentence = (description: string): string => {
  const text = description
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#') && !line.startsWith('<') && !line.startsWith('```'))
    .join(' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const end = text.search(/[.!?](\s|$)/)
  let sentence = end >= 0 ? text.slice(0, end + 1) : text
  if (sentence.length > MAX) {
    const cut = sentence.slice(0, MAX - 1)
    const space = cut.lastIndexOf(' ')
    sentence = `${(space > 40 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, '')}…`
  }
  return sentence === '' ? '' : sentence[0]!.toUpperCase() + sentence.slice(1)
}

/** `mcp__github__create_issue` → `github`; undefined for a built-in tool. */
export const mcpServer = (tool: string): string | undefined => {
  const m = /^mcp__(.+?)__/.exec(tool)
  return m ? m[1]!.replace(/_/g, ' ') : undefined
}

/** What the tool is for, in one plain line. */
export const aboutTool = (tool: string, description: string): string => {
  const known = ABOUT[tool]
  if (known) return known
  const said = firstSentence(description)
  const server = mcpServer(tool)
  if (server !== undefined) return said ? `From the ${server} connector: ${said}` : `A tool from the ${server} connector.`
  return said || 'No description given.'
}

/** "Hidden: waits behind ToolSearch" or "Loaded: sent with every request". */
export const placementWords = (isDeferred: boolean): string =>
  isDeferred ? 'Hidden: waits behind ToolSearch until Claude needs it' : 'Loaded: its schema is sent with every request'

/** The tool a focused element's key names: `tool:Bash` and `reset:Bash` are Bash's row. */
export const toolOfFocus = (key: string | undefined): string => {
  const m = /^(?:tool|reset):(.+)$/.exec(key ?? '')
  return m ? m[1]! : ''
}
