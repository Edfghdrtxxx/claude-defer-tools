# defer-tools

A Claude Code mod that lists rarely used tools behind ToolSearch, so their schemas stop being sent with every request. The tools stay available: when the model needs one, it loads it by name with ToolSearch (`select:<name>`).

## Why

Claude Code sends the full JSON schema of every tool it lists "in front" with each request. A few built-in tools are large and seldom used. Removing one tool at a time with `--disallowedTools` and comparing the input tokens of `claude -p "Reply with the single word OK." --output-format json` gave:

| Tool | Input tokens it adds to every request |
| --- | ---: |
| `Artifact` | 12,773 |
| `Workflow` | 1,952 |
| `ScheduleWakeup` | 1,698 |
| `ReportFindings` | 821 |

A `permissions.deny` rule saves those tokens too, but it removes the tool. This mod keeps every tool usable.

## Results

![Start-up tokens with and without defer-tools, and what each deferred built-in tool costs per request](assets/comparison.png)

| Where | Without the mod | With the mod | Saved |
| --- | ---: | ---: | ---: |
| CLI, `claude -p` as above (two runs each) | 37,971 / 37,973 | 21,160 / 21,161 | 16,811 (44%) |
| Desktop app, Code tab, new session at its first tool call | 73,794 | 54,260 | 19,534 (26%) |

In the desktop app's context breakdown, "System tools" fell from 16,802 tokens to none and "MCP tools" from 6,508 to 4,434, while "System prompt" grew by 286 for the line this mod adds. The desktop run with the mod also deferred three Claude Docs connector tools through the `alsoDefer` option.

Tests that pass:

- `select:Artifact,Workflow,ScheduleWakeup,ReportFindings` loads all four tools.
- An MCP tool deferred by the mod loads and runs.
- In the desktop app, all 13 deferred tools load on request, and `mcp__visualize__read_me` and a Docs connector tool ran after loading.

Measured on macOS with Claude Code 2.1.318 (CLI) and the Claude desktop app 5.1231.2, on one user's settings, so your numbers will differ.

## What it changes

- A `tool.describe` hook returns `isDeferred: true` for each tool in its list. The tool's description is left as Claude Code computed it.
- A `prompt.compose` hook adds one system-prompt line that names the deferred tools the session offers, each with a short hint. In the CLI tests, Claude Code's own list of deferred tools did not name tools deferred this way, so without this line the model would not know they exist.

Default list:

- Built-in: `Artifact`, `Workflow`, `ScheduleWakeup`, `ReportFindings`
- Desktop app: `SearchPlugins`, `SuggestPluginInstall`, `SuggestSkills`, `mcp__visualize__read_me`, `mcp__visualize__show_widget`, `mcp__ccd_session__read_widget_context`

A name the session does not offer is ignored, and a tool removed by a deny rule is not named in the line.

## Install

At the prompt of a terminal session:

```
/plugin install defer-tools --marketplace Edfghdrtxxx/claude-defer-tools
```

From a shell:

```bash
claude plugin install defer-tools --marketplace Edfghdrtxxx/claude-defer-tools
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Edfghdrtxxx/claude-defer-tools`, then Add plugin.

Answer `y` to add the marketplace, then pick the user scope. The change applies to sessions started afterwards and after `/clear`.

## Options

- `alsoDefer`: comma-separated tool names to defer as well, for example the tools of an MCP connector you rarely use.
- `keepInFront`: comma-separated names from the default list to leave in the prompt.

Set them with `/plugin configure defer-tools@defer-tools`, or from a shell:

```bash
printf '%s' '{"keepInFront":"Workflow"}' | claude plugin configure defer-tools@defer-tools --values-stdin
```

## Costs and limits

- The first call of a deferred tool in a session takes one extra ToolSearch step.
- The added line costs about 130 tokens in the CLI and about 290 in the desktop app.
- The mod uses the mods API (`tool.describe`, `prompt.compose`) of the builds above; a later build may change it.
- Some MCP connectors expect their tools to stay in front. The Claude Docs connector's own help says its `batch`, `guide` and `update` tools are "always listed"; deferring them worked in the test above, but if a connector misbehaves, put its tools in `keepInFront` or leave them out of `alsoDefer`.

## Uninstall

```bash
claude plugin uninstall defer-tools@defer-tools
```

## Related

Feature request for loading the Artifact tool on demand: [anthropics/claude-code#102032](https://github.com/anthropics/claude-code/issues/102032).

## License

MIT
