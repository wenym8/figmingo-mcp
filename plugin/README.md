# figmingo companion plugin

This plugin runs inside **Figma desktop** and gives figmingo-mcp write access to
the canvas over a local WebSocket (`ws://127.0.0.1:39220`). It works on free
plans — no REST quota involved.

## Import (one time)

1. In Figma desktop: **Plugins → Development → Import plugin from manifest…**
2. Select this folder's `manifest.json`.
3. Start the MCP server (`figmingo-mcp` via your AI client, or
   `npx figmingo-mcp` manually) — the plugin auto-connects on launch.
4. Run it from **Plugins → Development → figmingo**. Keep it running while you
   use the write tools (`execute_plugin_command`, `import_html_replica`).

## How it works

- On open it sends a `hello` envelope (session id, plugin version, file name).
- The MCP server sends `command` envelopes (`create_frame`, `create_text`,
  `create_rectangle`, `set_fills`, `set_auto_layout`, `insert_image`,
  `move_node`, `resize_node`, `delete_node`, `get_selection`, `export_node`,
  `batch`); the plugin executes them against the Plugin API and replies with
  `result` envelopes.
- Reconnects automatically (backoff up to 15 s). The server times out any
  command that takes > 30 s.
- `batch` supports variable capture: a command with `"as": "main"` stores its
  `nodeId`; later commands may reference it as `"parentId": "$main"`.
- Network access is restricted to `ws://127.0.0.1:39220` (see
  `manifest.json → networkAccess`). Image bytes are pushed from the local
  server as base64; nothing leaves your machine.

## Rebuild

```bash
npm run build:plugin   # tsc -p plugin/tsconfig.json → plugin/code.js
```
