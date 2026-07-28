#!/usr/bin/env bash
# figmingo-mcp one-command installer (macOS / Linux).
#   curl -fsSL https://raw.githubusercontent.com/<owner>/figmingo-mcp/main/scripts/install.sh | bash
# or locally:
#   bash scripts/install.sh [--yes] [--clients cursor,claude-code,claude-desktop,vscode] [--token <FIGMA_PAT>] [--no-install]
set -euo pipefail

PKG="figmingo-mcp"
YES=0
NO_INSTALL=0
CLIENTS=""
TOKEN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --clients) CLIENTS="${2:-}"; shift ;;
    --token) TOKEN="${2:-}"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; }

# --- 1. Node >= 18 -----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed. Install Node 18+ from https://nodejs.org and re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js $(node -v) is too old; figmingo-mcp requires Node >= 18."
  exit 1
fi
info "Node $(node -v) detected"

# --- 2. Install the package --------------------------------------------------
if [ "$NO_INSTALL" -eq 0 ]; then
  if npm ls -g "$PKG" >/dev/null 2>&1; then
    info "$PKG already installed globally; upgrading"
    npm install -g "$PKG@latest"
  else
    info "Installing $PKG globally"
    npm install -g "$PKG"
  fi
else
  info "Skipping package install (--no-install)"
fi
CMD="$(command -v figmingo-mcp || echo "npx figmingo-mcp")"

# --- 3. Figma token ----------------------------------------------------------
if [ -z "$TOKEN" ] && [ -n "${FIGMA_API_KEY:-}" ]; then TOKEN="$FIGMA_API_KEY"; fi
if [ -z "$TOKEN" ] && [ "$YES" -eq 0 ] && [ -t 0 ]; then
  printf 'Figma Personal Access Token (leave empty to configure later): '
  read -r TOKEN || true
fi

token_json() {
  if [ -n "$TOKEN" ]; then printf ',\n      "env": { "FIGMA_API_KEY": "%s" }' "$TOKEN"; fi
}

# --- 4. Write MCP client configs --------------------------------------------
write_config() {
  local name="$1" path="$2"
  mkdir -p "$(dirname "$path")"
  local entry
  if [ "$CMD" = "npx figmingo-mcp" ]; then
    entry=$(printf '{ "command": "npx", "args": ["-y", "figmingo-mcp"]%s }' "$(token_json)")
  else
    entry=$(printf '{ "command": "%s"%s }' "$CMD" "$(token_json)")
  fi
  local tmp
  tmp="$(mktemp)"
  if [ -f "$path" ]; then cp "$path" "$tmp"; else printf '{}' > "$tmp"; fi
  ENTRY="$entry" node -e '
    const fs = require("fs");
    const [p, entryRaw] = [process.argv[1], process.env.ENTRY];
    const cfg = JSON.parse(fs.readFileSync(p, "utf8") || "{}");
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers["figmingo"] = JSON.parse(entryRaw);
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' "$tmp"
  mv "$tmp" "$path"
  info "wrote $name config → $path"
}

pick_clients() {
  if [ -n "$CLIENTS" ]; then echo "$CLIENTS"; return; fi
  if [ "$YES" -eq 1 ] || [ ! -t 0 ]; then echo "cursor,claude-code,claude-desktop,vscode"; return; fi
  printf 'Configure which clients? [cursor,claude-code,claude-desktop,vscode] (comma list, empty = all): '
  local ans; read -r ans || true
  echo "${ans:-cursor,claude-code,claude-desktop,vscode}"
}

IFS=',' read -ra WANT <<< "$(pick_clients)"
for c in "${WANT[@]}"; do
  case "$(echo "$c" | tr -d '[:space:]')" in
    cursor)         write_config "Cursor" "$HOME/.cursor/mcp.json" ;;
    claude-code)    write_config "Claude Code" "$HOME/.claude.json" ;;
    claude-desktop)
      case "$(uname -s)" in
        Darwin) write_config "Claude Desktop" "$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
        *)      write_config "Claude Desktop" "$HOME/.config/Claude/claude_desktop_config.json" ;;
      esac ;;
    vscode)
      case "$(uname -s)" in
        Darwin) write_config "VS Code" "$HOME/Library/Application Support/Code/User/mcp.json" ;;
        *)      write_config "VS Code" "$HOME/.config/Code/User/mcp.json" ;;
      esac ;;
    *) warn "unknown client '$c' — skipped" ;;
  esac
done

# --- 5. Drop the companion plugin -------------------------------------------
PLUGIN_DIR="$HOME/.figmingo/plugin"
mkdir -p "$PLUGIN_DIR"
SRC=""
for cand in \
  "$(npm root -g 2>/dev/null)/$PKG/plugin" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/plugin"; do
  if [ -n "$cand" ] && [ -f "$cand/manifest.json" ]; then SRC="$cand"; break; fi
done
if [ -n "$SRC" ]; then
  cp "$SRC/manifest.json" "$SRC/code.js" "$SRC/README.md" "$PLUGIN_DIR/" 2>/dev/null || true
  info "companion plugin copied to $PLUGIN_DIR"
else
  warn "could not locate bundled plugin; copy plugin/ from the npm package manually"
fi

# --- 6. Next steps ------------------------------------------------------------
cat <<EOF

$(info "figmingo-mcp installed") 

Next steps:
  1. Get a Figma Personal Access Token:
       Figma → Settings → Security → Personal access tokens → Generate new token
     (scopes: file content read, file metadata read — dev resources optional)
  2. Restart your AI client (Cursor / Claude Code / Claude Desktop / VS Code).
     The MCP server starts automatically via: $CMD
  3. (Write tools) In Figma desktop:
       Plugins → Development → Import plugin from manifest…
       → select $PLUGIN_DIR/manifest.json
       → run "figmingo" from Plugins → Development while using write tools.
  4. Verify: ask your AI client to call the "whoami" tool.

Docs: https://github.com/<owner>/figmingo-mcp#readme
EOF
