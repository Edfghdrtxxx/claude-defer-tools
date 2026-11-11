// The values defer-tools keeps in $.state for its savings display.

/**
 * Where a tool's token figure comes from:
 * - `table`: measured once with `--disallowedTools` on Claude Code 2.1.318 (README table)
 * - `engine`: Claude Code's own estimate of the schema, read in this session
 * - `rough`: this mod's estimate from the description alone (the schema adds more)
 */
export type DeferToolsSource = 'table' | 'engine' | 'rough'

/** One tool in the mod's list that this session offers. */
export type DeferToolsTool = {
  name: string
  /** Tokens the tool's schema adds to every request while it is in front. */
  tokens: number
  source: DeferToolsSource
  /** True when Claude Code had the tool in front: only then does deferring it save anything. */
  wasInFront: boolean
  /** True once ToolSearch loaded it in this conversation: from then on it costs the same as before. */
  isLoaded: boolean
  isMcp: boolean
}

/** What the display shows for the current conversation. */
export type DeferToolsSavings = {
  tools: DeferToolsTool[]
  /** Estimated tokens of the one system-prompt line the mod adds. */
  noteTokens: number
  /** Input tokens of this conversation's first request, from the API's usage (live). */
  firstRequestTokens: number | null
  /** Main-conversation model requests so far. */
  requests: number
  /** Schema tokens not sent, summed over those requests (most would have been cache reads). */
  tokensNotSent: number
  /** Prompt-line tokens sent, summed over those requests. */
  noteTokensSent: number
  /** ToolSearch calls that loaded at least one of the mod's tools. */
  hops: number
  /** Estimated tokens of those calls and their results. */
  hopTokens: number
  /** ToolSearch calls that found nothing. */
  emptySearches: number
  /** Estimated tokens of those calls and their results. */
  emptyTokens: number
  /** ToolSearch calls that loaded only tools Claude Code defers by itself (not counted against the mod). */
  otherSearches: number
  /** Model requests whose only tool calls were ToolSearch: the extra round trips. */
  extraRequests: number
  /** Output tokens of those requests, from the API's usage (live). */
  extraOutputTokens: number
}

/** Where the person put a tool: `defer` behind ToolSearch, `keep` in every request. */
export type DeferToolsPlacement = 'defer' | 'keep'

/** The pane's charts. */
export type DeferToolsChart = 'hero' | 'firstRequest' | 'perTool' | 'conversation' | 'toolSearch'

/** `full`: the figure and the ToolSearch counts; `number`: the figure alone; `off`: none. */
export type DeferToolsStatusMode = 'full' | 'number' | 'off'

/** The person's choices, as the settings file holds them. */
export type DeferToolsSettings = {
  /** Only the tools the person chose; any other follows the default list. */
  tools: Record<string, DeferToolsPlacement>
  /** The charts shown, in this order; one left out is hidden. */
  charts: DeferToolsChart[]
  animate: boolean
  statusLine: DeferToolsStatusMode
}

/** Every tool this session offers, for the tool picker. */
export type DeferToolsCatalogTool = {
  name: string
  tokens: number
  source: DeferToolsSource
  isMcp: boolean
  /** Where Claude Code itself put the tool, before any plugin. */
  engineDeferred: boolean
  /** Where it is in this conversation: a change waits for /clear or a new session. */
  appliedDeferred: boolean
  /** What the tool is for, in one plain line (hooks/about.ts). */
  about: string
}

declare module 'claude-code' {
  interface PluginState {
    'defer-tools': {
      savings: Shaped<DeferToolsSavings>
      /** The terminal pane's animation frame, 0 to its last; the last is the still picture. */
      frame: number
      /** When the pane's animation last started (ms); SVG surfaces animate within a moment of it. */
      playedAt: number
      settings: Shaped<DeferToolsSettings>
      catalog: Shaped<DeferToolsCatalogTool[]>
      /** Which view the pane shows. */
      view: 'charts' | 'settings'
      /** The tool whose row holds the keyboard focus in the settings view, for its explanation. */
      focusedTool: string
      /** Whether the terminal's per-tool chart shows a line on what each tool does. */
      explain: boolean
    }
  }
}
