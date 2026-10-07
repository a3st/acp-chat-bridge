# ACP Chat Bridge

Connect [Agent Client Protocol](https://agentclientprotocol.com/) agents to the native VS Code chat using `@acp-agent`. No custom chat panels or webviews.

## Features

- Open ACP from the chat toolbar or its **...** menu with **ACP: Open Chat**.
- Select CLI models (including OpenCode models) from the model picker below the chat input.
- Add and remove connections through **ACP: Manage Connections**. Adding **ACP** in **Manage Models** opens the connection form directly.
- Stream responses, preserve conversation sessions, and cancel requests.
- Handle permissions, text attachments, and workspace file operations.
- English and Russian UI, selected automatically from the VS Code display language.

## Quick start

Requires **VS Code 1.140+**, a trusted workspace, and a separately installed **ACP v1 agent with stdio support**.

1. Install the VSIX via **Extensions → Install from VSIX…**.
2. Run **ACP: Manage Connections**, select **Add ACP**, and enter the agent executable and arguments as a JSON array of strings.
3. Click **ACP: Open Chat** in the chat toolbar or its **...** menu, or run it from the Command Palette. It opens a new local chat in **Agent** mode and selects your ACP connection.
4. Send `@acp-agent` followed by your request.

Use **ACP: Manage Connections** to manage connections and **ACP: Open Chat** to start a new conversation. Agent installation and authentication are separate from the extension.

On Windows, use an `.exe` or `node.exe` with the CLI entry file in its arguments; `.cmd` and `.bat` launchers are not supported. HTTP/WebSocket connections and image inputs are not supported.

If chat says **Language model unavailable**, run **ACP: Open Chat** from the Command Palette. This configures the first connection if necessary and selects its model, replacing an unavailable previously selected model. Manage Models and the model picker display the CLI models advertised by each configured ACP agent. Model names include the connection name. When an agent exposes models, its connection is not listed as a separate model; agents without model discovery retain a default connection entry. With no connections, run **ACP: Manage Connections** or **ACP: Open Chat** to configure the first agent. ACP connections support both **Agent** and **Ask**, and remain available when switching between these modes. With `@acp-agent`, the participant streams ACP responses, handles permissions, and applies workspace file changes. When using the ACP model without the tag in Agent mode, enable **ACP: Workspace Task** in the tools picker; VS Code delegates the task through that tool and displays its completed result. The ACP agent owns its internal tools; arbitrary VS Code tools are not forwarded to the ACP process. The `@acp-agent` tag is required to route requests to the participant. This release uses stable extension APIs; the command is in the chat toolbar and its **...** menu, outside the **+ / New Chat** dropdown. Adding entries to that dropdown requires the proposed Chat Session Provider API.

If the agent finishes without a text response, chat reports a missing response instead of showing `(empty)`. A provider authorization error must be resolved in the CLI; inspect **Output > ACP** for its diagnostics.

If the error persists, run **ACP: Show Diagnostics** and copy the report from **Output > ACP**. It includes model availability and extension/runtime versions, but no prompts, launch arguments, or environment variables.

## CLI models

For OpenCode, launch `opencode acp`. The bridge reads the model selector from ACP `session/new` (`configOptions`, category `model`) and selects the chosen value with `session/set_config_option` before prompting. Older agents using `models` and `session/set_model` are also supported.

Model discovery starts a temporary ACP session without sending a prompt. Automatic discovery never opens an authentication dialog; authenticate the CLI separately when needed. The model catalog uses the first workspace folder and is cached for this window. After changing OpenCode providers or credentials, run **ACP: Manage Connections > Refresh ACP models**. Multi-root projects may advertise different models per directory; a model unavailable in the actual session is rejected before prompting.

## ACP modes

Send `@acp-agent /mode` to choose a mode advertised by the CLI, such as OpenCode **Build** or **Plan**. The choice is saved per connection in the workspace and applied before the next prompt, including when using the ACP workspace task tool. Canceling the picker leaves the previous choice unchanged.

The bridge uses ACP `session/set_config_option` (category `mode`), with `session/set_mode` for older agents. OpenCode modes remain independent from the VS Code **Agent/Ask/Plan** selector. If the CLI does not advertise modes, the bridge reports that mode selection is unavailable.

## CLI commands

Send CLI slash commands as plain text after the participant: `@acp-agent /compact` or `@acp-agent /your-command arguments`. OpenCode executes commands that it exposes through ACP, including configured project commands. TUI-only actions and shell CLI subcommands are not automatically available over ACP. Dynamic CLI commands do not appear in VS Code's slash autocomplete; type their names manually. `/mode` is reserved by the bridge; other slash commands, including `/new` when supported, are forwarded to the CLI.

CLI commands are forwarded without prepending replayed conversation history. When an advertised ACP command finishes successfully without a text response, the bridge displays a completion message.

## Development

```sh
npm ci
npm run compile
npm test
npm run package
```

Use `npm.cmd` in Windows PowerShell if script execution is restricted. Press **F5** in VS Code to launch the Extension Development Host. Packaging creates `acp-chat-bridge-0.1.16.vsix`.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.txt` for project and bundled dependency licenses.
