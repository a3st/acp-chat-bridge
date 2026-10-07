# ACP Chat Bridge

Connect [Agent Client Protocol](https://agentclientprotocol.com/) agents to the native VS Code chat using `@acp-agent`. No custom chat panels or webviews.

## Features

- Open ACP from the chat toolbar or its **...** menu with **ACP: Open Chat**.
- Select agents from the model picker below the chat input.
- Add and remove connections through **ACP: Manage Connections**. Adding ACP Chat Bridge in **Manage Models** opens the connection form directly.
- Stream responses, preserve conversation sessions, and cancel requests.
- Handle permissions, text attachments, and workspace file operations.
- English and Russian UI, selected automatically from the VS Code display language.

## Quick start

Requires **VS Code 1.140+**, a trusted workspace, and a separately installed **ACP v1 agent with stdio support**.

1. Install the VSIX via **Extensions → Install from VSIX…**.
2. Run **ACP: Manage Connections**, select **Add ACP**, and enter the agent executable and arguments as a JSON array of strings.
3. Click **ACP: Open Chat** in the chat toolbar or its **...** menu, or run it from the Command Palette. It opens a new local chat in **Agent** mode and selects your ACP connection.
4. Send `@acp-agent` followed by your request.

Use `@acp-agent /connections` to manage connections and `@acp-agent /new` to reset the current agent session. Agent installation and authentication are separate from the extension.

On Windows, use an `.exe` or `node.exe` with the CLI entry file in its arguments; `.cmd` and `.bat` launchers are not supported. HTTP/WebSocket connections and image inputs are not supported.

If chat says **Language model unavailable**, run **ACP: Open Chat** from the Command Palette. This configures the first connection if necessary and selects its model, replacing an unavailable previously selected model. Manage Models and the model picker list only configured ACP connections. With no connections, run **ACP: Manage Connections** or **ACP: Open Chat** to configure the first agent. ACP connections support both **Agent** and **Ask**, and remain available when switching between these modes. With `@acp-agent`, the participant streams ACP responses, handles permissions, and applies workspace file changes. When using the ACP model without the tag in Agent mode, enable **ACP: Workspace Task** in the tools picker; VS Code delegates the task through that tool and displays its completed result. The ACP agent owns its internal tools; arbitrary VS Code tools are not forwarded to the ACP process. The `@acp-agent` tag is required to route requests to the participant. This release uses stable extension APIs; the command is in the chat toolbar and its **...** menu, outside the **+ / New Chat** dropdown. Adding entries to that dropdown requires the proposed Chat Session Provider API.

If the error persists, run **ACP: Show Diagnostics** and copy the report from **Output > ACP**. It includes model availability and extension/runtime versions, but no prompts, launch arguments, or environment variables.

## Development

```sh
npm ci
npm run compile
npm test
npm run package
```

Use `npm.cmd` in Windows PowerShell if script execution is restricted. Press **F5** in VS Code to launch the Extension Development Host. Packaging creates `acp-chat-bridge-0.1.10.vsix`.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.txt` for project and bundled dependency licenses.
