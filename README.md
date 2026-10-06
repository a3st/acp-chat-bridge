# ACP Chat Bridge

Connect [Agent Client Protocol](https://agentclientprotocol.com/) agents to the native VS Code chat using `@acp-agent`. No custom chat panels or webviews.

## Features

- Select agents from the model picker below the chat input.
- Add and remove connections with native VS Code commands.
- Stream responses, preserve conversation sessions, and cancel requests.
- Handle permissions, text attachments, and workspace file operations.
- English and Russian UI, selected automatically from the VS Code display language.

## Quick start

Requires **VS Code 1.140+**, a trusted workspace, and a separately installed **ACP v1 agent with stdio support**.

1. Install the VSIX via **Extensions → Install from VSIX…**.
2. Run **ACP: Add Connection** and enter the agent executable and arguments as a JSON array of strings.
3. Run **ACP: Open Chat**, use **Ask** mode, and select **ACP · your agent** in the model picker.
4. Send `@acp-agent` followed by your request.

Use `@acp-agent /connections` to manage connections and `@acp-agent /new` to reset the current agent session. Agent installation and authentication are separate from the extension.

On Windows, use an `.exe` or `node.exe` with the CLI entry file in its arguments; `.cmd` and `.bat` launchers are not supported. HTTP/WebSocket connections and image inputs are not supported.

## Development

```sh
npm ci
npm run compile
npm test
npm run package
```

Use `npm.cmd` in Windows PowerShell if script execution is restricted. Press **F5** in VS Code to launch the Extension Development Host. Packaging creates `acp-chat-bridge-0.1.2.vsix`.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.txt` for project and bundled dependency licenses.
