#!/usr/bin/env bash
# figmingo-mcp one-command installer (macOS / Linux).
#   curl -fsSL https://raw.githubusercontent.com/wenym8/figmingo-mcp/main/scripts/install.sh | bash
# or locally:
#   bash scripts/install.sh [--yes] [--clients cursor,claude-code,claude-desktop,vscode,kimi,codex] [--token <FIGMA_PAT>] [--no-install]
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

# fnm users: `command -v` resolves into fnm's per-shell-session directory
# (~/.local/state/fnm_multishells/<pid>/...), which fnm deletes when that
# shell exits — an MCP config pointing there breaks permanently. Rewrite to
# the stable node-versions installation of the same Node version.
case "$CMD" in
  *fnm_multishells*)
    NODE_VER="$(node -p 'process.version' 2>/dev/null || true)"
    STABLE="$HOME/.local/share/fnm/node-versions/$NODE_VER/installation/bin/$PKG"
    if [ -n "$NODE_VER" ] && [ -x "$STABLE" ]; then
      CMD="$STABLE"
      info "fnm multishell path detected; using stable path: $CMD"
    else
      warn "fnm multishell path detected but no stable install found; re-run from a login shell or use npx"
    fi
    ;;
esac

# GUI clients (Finder-launched macOS apps) get a bare PATH
# (/usr/bin:/bin:/usr/sbin:/sbin) — the npm shim's `#!/usr/bin/env node`
# shebang then can't find node installed via fnm/nvm/volta/Homebrew, and the
# client silently fails to spawn the server (plugin stuck on "connecting…").
# When node lives outside /usr/bin|/bin, write configs as
# { command: <node abs path>, args: [<resolved script>] } — PATH-immune.
ENTRY_ARGS_JSON='[]'
ENTRY_ARGS_TOML=''
if [ "$CMD" != "npx figmingo-mcp" ]; then
  NODE_BIN="$(command -v node || true)"
  case "$NODE_BIN" in
    *fnm_multishells*)
      NB_STABLE="$HOME/.local/share/fnm/node-versions/$(node -p 'process.version' 2>/dev/null || true)/installation/bin/node"
      [ -x "$NB_STABLE" ] && NODE_BIN="$NB_STABLE"
      ;;
  esac
  case "$NODE_BIN" in
    /usr/bin/node|/bin/node|'') : ;;  # system-wide node: the shim works everywhere
    *)
      SCRIPT_PATH="$(node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$CMD" 2>/dev/null || true)"
      if [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
        CMD="$NODE_BIN"
        ENTRY_ARGS_JSON="$(node -e 'process.stdout.write(JSON.stringify([process.argv[1]]))' "$SCRIPT_PATH")"
        ENTRY_ARGS_TOML="\"$SCRIPT_PATH\""
        info "user-local node detected; clients will spawn: $NODE_BIN $SCRIPT_PATH"
      fi
      ;;
  esac
fi

# --- 3. Figma token ----------------------------------------------------------
if [ -z "$TOKEN" ] && [ -n "${FIGMA_API_KEY:-}" ]; then TOKEN="$FIGMA_API_KEY"; fi
# Reuse a token already written by a previous install (re-runs must not wipe it).
if [ -z "$TOKEN" ]; then
  for cfg in \
    "$HOME/.cursor/mcp.json" \
    "$HOME/.claude.json" \
    "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
    "$HOME/.config/Claude/claude_desktop_config.json" \
    "$HOME/Library/Application Support/Code/User/mcp.json" \
    "$HOME/.config/Code/User/mcp.json" \
    "$HOME/.kimi/mcp.json" \
    "$HOME/.kimi-code/mcp.json"; do
    [ -f "$cfg" ] || continue
    TOKEN="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c?.mcpServers?.figmingo?.env?.FIGMA_API_KEY??"")}catch{}' "$cfg" 2>/dev/null || true)"
    if [ -n "$TOKEN" ]; then info "reused Figma token from $cfg"; break; fi
  done
fi
# read_answer <default>: prompts on stderr (never captured by $(...)), then
# reads the answer from the safest source available:
#   1. stdin is a keyboard (tty)          → read stdin
#   2. script runs from a file with piped → consume the pipe (e.g. echo "" | bash install.sh)
#      stdin (NOT curl|bash, where stdin
#      is the script itself)
#   3. curl|bash with a real /dev/tty     → read the keyboard via /dev/tty
#   4. nothing readable                   → the default, no blocking
read_answer() {
  local default="$1" ans=""
  if [ -t 0 ]; then
    read -r ans || ans=""
  elif [ -f "$0" ] && [ ! -t 0 ]; then
    read -r ans || ans=""
  elif [ -r /dev/tty ]; then
    read -r ans < /dev/tty || ans=""
  fi
  printf '%s' "${ans:-$default}"
}

if [ -z "$TOKEN" ] && [ "$YES" -eq 0 ]; then
  printf 'Figma Personal Access Token (leave empty to configure later): ' >&2
  TOKEN="$(read_answer "")"
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
    entry=$(printf '{ "command": "%s", "args": %s%s }' "$CMD" "$ENTRY_ARGS_JSON" "$(token_json)")
  fi
  local tmp
  tmp="$(mktemp)"
  if [ -f "$path" ]; then cp "$path" "$tmp"; else printf '{}' > "$tmp"; fi
  ENTRY="$entry" node -e '
    const fs = require("fs");
    const [p, entryRaw] = [process.argv[1], process.env.ENTRY];
    const cfg = JSON.parse(fs.readFileSync(p, "utf8") || "{}");
    cfg.mcpServers = cfg.mcpServers || {};
    const next = JSON.parse(entryRaw);
    // Non-destructive re-runs: keep a previously written env (token) when this
    // run has none to write.
    const prev = cfg.mcpServers["figmingo"];
    if (!next.env && prev && prev.env) next.env = prev.env;
    cfg.mcpServers["figmingo"] = next;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' "$tmp"
  mv "$tmp" "$path"
  info "wrote $name config → $path"
}

# --- 4b. Codex CLI config (~/.codex/config.toml, TOML) -----------------------
# Only ever touches the [mcp_servers.figmingo] section; the rest of the file is
# preserved byte-for-byte. Backs up the original to config.toml.figmingo-bak on
# first write. Idempotent: re-running replaces the section in place.
write_codex_config() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  if [ -f "$path" ] && [ ! -f "$path.figmingo-bak" ]; then
    cp "$path" "$path.figmingo-bak"
    info "backed up existing config → $path.figmingo-bak"
  fi
  # Non-destructive re-runs: inherit a previously written token.
  if [ -z "$TOKEN" ] && [ -f "$path" ]; then
    local existing
    existing="$(sed -n 's/^FIGMA_API_KEY = "\(.*\)"[[:space:]]*$/\1/p' "$path" | head -1)"
    if [ -n "$existing" ]; then TOKEN="$existing"; fi
  fi
  local cmd args_toml="$ENTRY_ARGS_TOML"
  if [ "$CMD" = "npx figmingo-mcp" ]; then
    cmd="npx"; args_toml='"-y", "figmingo-mcp"'
  else
    cmd="$CMD"
  fi
  local tmp
  tmp="$(mktemp)"
  if [ -f "$path" ]; then
    # Drop any existing [mcp_servers.figmingo] (+ .env subtable) section and
    # trim trailing blank lines; keep everything else untouched.
    awk '
      /^\[mcp_servers\.figmingo(\.[^]]*)?\][[:space:]]*$/ { skip=1; next }
      /^\[/ { skip=0 }
      !skip { lines[++n] = $0 }
      END {
        last = n
        while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
        for (i = 1; i <= last; i++) print lines[i]
      }
    ' "$path" > "$tmp"
  else
    : > "$tmp"
  fi
  if [ -s "$tmp" ]; then printf '\n' >> "$tmp"; fi
  {
    printf '[mcp_servers.figmingo]\n'
    printf 'command = "%s"\n' "$cmd"
    printf 'args = [%s]\n' "$args_toml"
    if [ -n "$TOKEN" ]; then
      printf '\n[mcp_servers.figmingo.env]\n'
      printf 'FIGMA_API_KEY = "%s"\n' "$TOKEN"
    fi
  } >> "$tmp"
  mv "$tmp" "$path"
  info "wrote Codex config → $path"
}

pick_clients() {
  if [ -n "$CLIENTS" ]; then echo "$CLIENTS"; return; fi
  # Prompt on stderr so $(...) only ever captures the answer itself.
  local default="cursor,claude-code,claude-desktop,vscode,kimi,codex"
  if [ "$YES" -eq 1 ]; then echo "$default"; return; fi
  printf 'Configure which clients? [cursor,claude-code,claude-desktop,vscode,kimi,codex] (comma list, empty = all): ' >&2
  read_answer "$default"; echo
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
    kimi)
      # Kimi Code CLI reads ~/.kimi-code/mcp.json; older builds used ~/.kimi/mcp.json — write both.
      write_config "Kimi CLI" "$HOME/.kimi-code/mcp.json"
      write_config "Kimi CLI (legacy)" "$HOME/.kimi/mcp.json" ;;
    codex)          write_codex_config "$HOME/.codex/config.toml" ;;
    *) warn "unknown client '$c' — skipped" ;;
  esac
done

# --- 5. Drop the companion plugin -------------------------------------------
PLUGIN_DIR="$HOME/.figmingo/plugin"
mkdir -p "$PLUGIN_DIR"
SRC=""
for cand in \
  "$(npm root -g 2>/dev/null)/$PKG/plugin" \
  "$(cd "$(dirname "${BASH_SOURCE[0]:-}")/.." 2>/dev/null && pwd)/plugin"; do
  if [ -n "$cand" ] && [ -f "$cand/manifest.json" ]; then SRC="$cand"; break; fi
done
if [ -n "$SRC" ]; then
  cp "$SRC/manifest.json" "$SRC/code.js" "$SRC/ui.html" "$SRC/README.md" "$PLUGIN_DIR/" 2>/dev/null || true
  info "companion plugin copied to $PLUGIN_DIR"
else
  warn "could not locate bundled plugin; copy plugin/ from the npm package manually"
fi

# --- 5a. Easy-to-find symlink for the Figma import dialog --------------------
# ~/.figmingo is hidden and painful to navigate to in Figma's "Import plugin
# from manifest…" file picker. Drop a symlink on the Desktop (fallback: $HOME)
# so the user can just click it. The canonical copy stays in $PLUGIN_DIR
# (doctor checks that path); the symlink is a pure convenience.
PLUGIN_LINK=""
for base in "$HOME/Desktop" "$HOME"; do
  if [ -d "$base" ]; then
    PLUGIN_LINK="$base/figmingo-plugin"
    break
  fi
done
if [ -n "$PLUGIN_LINK" ] && [ -f "$PLUGIN_DIR/manifest.json" ]; then
  ln -sfn "$PLUGIN_DIR" "$PLUGIN_LINK"
  info "plugin shortcut → $PLUGIN_LINK"
fi

# --- 5b. Playwright Chromium (HTML render/extract/compare) -------------------
# `npm install -g` fetches the playwright package but NOT its ~170MB browser.
# Locate the playwright CLI inside the installed package (global first, then
# the repo checkout for --no-install runs) and install chromium. Idempotent:
# playwright skips the download when the browser is already present.
PW_CLI=""
for cand in \
  "$(npm root -g 2>/dev/null)/$PKG/node_modules/.bin/playwright" \
  "$(cd "$(dirname "${BASH_SOURCE[0]:-}")/.." 2>/dev/null && pwd)/node_modules/.bin/playwright"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then PW_CLI="$cand"; break; fi
done
if [ -n "$PW_CLI" ]; then
  info "ensuring Playwright Chromium (one-time ~170MB download)"
  if "$PW_CLI" install chromium; then
    info "Playwright Chromium ready"
  else
    warn "Chromium download FAILED — HTML render/extract/compare tools will not work."
    warn "Fix manually: npx playwright install chromium   (then: $CMD doctor)"
  fi
else
  warn "playwright CLI not found — run: npx playwright install chromium (then: $CMD doctor)"
fi

# --- 6. Next steps ------------------------------------------------------------
cat <<EOF

$(info "figmingo-mcp installed") 

Next steps:
  1. Get a Figma Personal Access Token:
       Figma → Settings → Security → Personal access tokens → Generate new token
     (scopes: file content read, file metadata read — dev resources optional)
  2. Restart your AI client (Cursor / Claude Code / Claude Desktop / VS Code / Kimi CLI / Codex).
     The MCP server starts automatically via: $CMD
  3. (Write tools) In Figma desktop:
       Plugins → Development → Import plugin from manifest…
       → pick ${PLUGIN_LINK:-$PLUGIN_DIR}/manifest.json
         (the figmingo-plugin folder on your Desktop links there;
          in the file dialog you can also press ⌘⇧G and paste the path)
       → run "figmingo" from Plugins → Development while using write tools.
  4. Verify the environment:  $CMD doctor
  5. Verify end-to-end: ask your AI client to call the "whoami" tool.

Docs: https://github.com/wenym8/figmingo-mcp#readme
EOF
