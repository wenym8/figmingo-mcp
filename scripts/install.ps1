# figmingo-mcp one-command installer (Windows).
#   iwr -useb https://raw.githubusercontent.com/wenym8/figmingo-mcp/main/scripts/install.ps1 | iex
# or locally:
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [-Yes] [-Clients cursor,claude-code,kimi,codex] [-Token <FIGMA_PAT>] [-NoInstall]
param(
  [switch]$Yes,
  [string]$Clients = "",
  [string]$Token = "",
  [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
$Pkg = "figmingo-mcp"

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "[x] $msg" -ForegroundColor Red }

# --- 1. Node >= 18 -----------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Err "Node.js is not installed. Install Node 18+ from https://nodejs.org and re-run."
  exit 1
}
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 18) {
  Err "Node.js $(node -v) is too old; figmingo-mcp requires Node >= 18."
  exit 1
}
Info "Node $(node -v) detected"

# --- 2. Install the package --------------------------------------------------
if (-not $NoInstall) {
  $installed = npm ls -g $Pkg 2>$null | Select-String $Pkg
  if ($installed) {
    Info "$Pkg already installed globally; upgrading"
    npm install -g "$Pkg@latest"
  } else {
    Info "Installing $Pkg globally"
    npm install -g $Pkg
  }
} else {
  Info "Skipping package install (-NoInstall)"
}
$CmdObj = Get-Command figmingo-mcp -ErrorAction SilentlyContinue
if ($CmdObj) { $Cmd = $CmdObj.Source } else { $Cmd = "npx figmingo-mcp" }

# fnm users: Get-Command resolves into fnm's per-session multishell directory
# (...\fnm_multishells\<pid>\...), which fnm deletes when that shell exits —
# an MCP config pointing there breaks permanently. Rewrite to the stable
# node-versions install of the same Node version.
if ($Cmd -match 'fnm_multishells') {
  $nodeVer = (node -p 'process.version')
  $stableCandidates = @(
    (Join-Path $env:APPDATA "fnm\node-versions\$nodeVer\installation\figmingo-mcp.cmd"),
    (Join-Path $env:LOCALAPPDATA "fnm\node-versions\$nodeVer\installation\figmingo-mcp.cmd"),
    (Join-Path $HOME ".fnm\node-versions\$nodeVer\installation\figmingo-mcp.cmd")
  )
  $stable = $stableCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($stable) {
    $Cmd = $stable
    Info "fnm multishell path detected; using stable path: $Cmd"
  } else {
    Warn "fnm multishell path detected but no stable install found; re-run from a login shell or use npx"
  }
}

# JSON/TOML files must be UTF-8 WITHOUT BOM (Windows PowerShell 5.1's
# Set-Content -Encoding UTF8 writes a BOM that strict JSON parsers reject).
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# --- 3. Figma token ----------------------------------------------------------
if (-not $Token -and $env:FIGMA_API_KEY) { $Token = $env:FIGMA_API_KEY }
# Reuse a token already written by a previous install (re-runs must not wipe it).
if (-not $Token) {
  $inheritPaths = @(
    (Join-Path $HOME ".cursor\mcp.json"),
    (Join-Path $HOME ".claude.json"),
    (Join-Path $env:APPDATA "Claude\claude_desktop_config.json"),
    (Join-Path $env:APPDATA "Code\User\mcp.json"),
    (Join-Path $HOME ".kimi\mcp.json")
  )
  foreach ($p in $inheritPaths) {
    if (Test-Path $p) {
      try {
        $j = Get-Content $p -Raw | ConvertFrom-Json
        $t = $j.mcpServers.figmingo.env.FIGMA_API_KEY
        if ($t) { $Token = $t; Info "reused Figma token from $p"; break }
      } catch { }
    }
  }
}
if (-not $Token -and -not $Yes -and [Environment]::UserInteractive) {
  $Token = Read-Host "Figma Personal Access Token (leave empty to configure later)"
}

# --- 4. Write MCP client configs --------------------------------------------
function Write-Config($name, $path) {
  $dir = Split-Path $path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if ($Cmd -eq "npx figmingo-mcp") {
    $entry = @{ command = "npx"; args = @("-y", "figmingo-mcp") }
  } else {
    $entry = @{ command = $Cmd }
  }
  if ($Token) { $entry.env = @{ FIGMA_API_KEY = $Token } }
  $raw = ""
  if (Test-Path $path) { $raw = Get-Content $path -Raw }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $cfg = [pscustomobject]@{}
  } else {
    $cfg = $raw | ConvertFrom-Json
  }
  if (-not $cfg.mcpServers) { $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
  # Non-destructive re-runs: keep a previously written env (token) when this
  # run has none to write.
  if (-not $Token -and $cfg.mcpServers.figmingo -and $cfg.mcpServers.figmingo.env) {
    $entry.env = $cfg.mcpServers.figmingo.env
  }
  $cfg.mcpServers | Add-Member -NotePropertyName "figmingo" -NotePropertyValue $entry -Force
  [System.IO.File]::WriteAllText($path, ($cfg | ConvertTo-Json -Depth 20) + "`n", $script:Utf8NoBom)
  Info "wrote $name config -> $path"
}

# Codex CLI config (~/.codex/config.toml, TOML). Only ever touches the
# [mcp_servers.figmingo] section (incl. its .env subtable); the rest of the
# file is preserved. Backs up the original to config.toml.figmingo-bak on
# first write. Idempotent: re-running replaces the section in place.
function Write-CodexConfig($path) {
  $dir = Split-Path $path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Non-destructive re-runs: inherit a previously written token.
  if (-not $script:Token -and (Test-Path $path)) {
    $m = Select-String -Path $path -Pattern '^FIGMA_API_KEY = "(.*)"\s*$' | Select-Object -First 1
    if ($m) { $script:Token = $m.Matches[0].Groups[1].Value }
  }
  $tomlCmd = $Cmd -replace '\\', '/'   # backslashes are escape chars in TOML basic strings
  $tomlArgs = @()
  if ($Cmd -eq "npx figmingo-mcp") { $tomlCmd = "npx"; $tomlArgs = @("-y", "figmingo-mcp") }
  $lines = @()
  if (Test-Path $path) {
    if (-not (Test-Path "$path.figmingo-bak")) {
      Copy-Item $path "$path.figmingo-bak"
      Info "backed up existing config -> $path.figmingo-bak"
    }
    $lines = @(Get-Content $path)
  }
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($line in $lines) {
    if ($line -match '^\[mcp_servers\.figmingo(\.[^\]]*)?\]\s*$') { $skip = $true; continue }
    if ($line -match '^\[') { $skip = $false }
    if (-not $skip) { $out.Add($line) }
  }
  while ($out.Count -gt 0 -and $out[$out.Count - 1] -match '^\s*$') { $out.RemoveAt($out.Count - 1) }
  if ($out.Count -gt 0) { $out.Add("") }
  $out.Add("[mcp_servers.figmingo]")
  $out.Add("command = `"$tomlCmd`"")
  $argsToml = ($tomlArgs | ForEach-Object { "`"$_`"" }) -join ", "
  $out.Add("args = [$argsToml]")
  if ($Token) {
    $out.Add("")
    $out.Add("[mcp_servers.figmingo.env]")
    $out.Add("FIGMA_API_KEY = `"$Token`"")
  }
  [System.IO.File]::WriteAllText($path, ($out -join "`n") + "`n", $script:Utf8NoBom)
  Info "wrote Codex config -> $path"
}

if (-not $Clients) {
  if ($Yes) { $Clients = "cursor,claude-code,claude-desktop,vscode,kimi,codex" }
  else {
    $ans = Read-Host "Configure which clients? [cursor,claude-code,claude-desktop,vscode,kimi,codex] (comma list, empty = all)"
    if ([string]::IsNullOrWhiteSpace($ans)) { $Clients = "cursor,claude-code,claude-desktop,vscode,kimi,codex" } else { $Clients = $ans }
  }
}

foreach ($c in $Clients.Split(",")) {
  switch ($c.Trim()) {
    "cursor"         { Write-Config "Cursor" (Join-Path $HOME ".cursor\mcp.json") }
    "claude-code"    { Write-Config "Claude Code" (Join-Path $HOME ".claude.json") }
    "claude-desktop" { Write-Config "Claude Desktop" (Join-Path $env:APPDATA "Claude\claude_desktop_config.json") }
    "vscode"         { Write-Config "VS Code" (Join-Path $env:APPDATA "Code\User\mcp.json") }
    "kimi"           { Write-Config "Kimi CLI" (Join-Path $HOME ".kimi\mcp.json") }
    "codex"          { Write-CodexConfig (Join-Path $HOME ".codex\config.toml") }
    default          { Warn "unknown client '$c' - skipped" }
  }
}

# --- 5. Drop the companion plugin -------------------------------------------
$pluginDir = Join-Path $HOME ".figmingo\plugin"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
$npmRoot = (npm root -g 2>$null)
$candidates = @(
  (Join-Path $npmRoot "$Pkg\plugin"),
  (Join-Path $PSScriptRoot "..\plugin")
)
$src = $candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ "manifest.json")) } | Select-Object -First 1
if ($src) {
  Copy-Item (Join-Path $src "manifest.json"), (Join-Path $src "code.js"), (Join-Path $src "ui.html"), (Join-Path $src "README.md") $pluginDir -ErrorAction SilentlyContinue
  Info "companion plugin copied to $pluginDir"
} else {
  Warn "could not locate bundled plugin; copy plugin\ from the npm package manually"
}

# --- 5a. Easy-to-find shortcut for the Figma import dialog --------------------
# ~/.figmingo is hidden and painful to navigate to in Figma's "Import plugin
# from manifest..." file picker. Put a shortcut on the Desktop (fallback: $HOME)
# pointing at the real folder. Symlink needs admin/Developer Mode on Windows,
# so fall back to a plain copy when linking fails.
# Desktop may be OneDrive-redirected on Windows — ask the shell for the real
# location instead of assuming $HOME\Desktop.
$desktopPath = [Environment]::GetFolderPath('Desktop')
$pluginLink = $null
foreach ($base in @($desktopPath, $HOME)) {
  if ($base -and (Test-Path $base)) { $pluginLink = Join-Path $base "figmingo-plugin"; break }
}
if ($pluginLink -and (Test-Path (Join-Path $pluginDir "manifest.json"))) {
  $linked = $false
  try {
    if (Test-Path $pluginLink) { Remove-Item $pluginLink -Recurse -Force -ErrorAction Stop }
    New-Item -ItemType SymbolicLink -Path $pluginLink -Target $pluginDir -ErrorAction Stop | Out-Null
    $linked = $true
  } catch {
    Copy-Item $pluginDir $pluginLink -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($linked) { Info "plugin shortcut -> $pluginLink" } else { Info "plugin copied to -> $pluginLink (symlink unavailable)" }
}

# --- 5b. Playwright Chromium (HTML render/extract/compare) -------------------
# `npm install -g` fetches the playwright package but NOT its ~170MB browser.
# Locate the playwright CLI inside the installed package (global first, then
# the repo checkout for -NoInstall runs) and install chromium. Idempotent:
# playwright skips the download when the browser is already present.
$pwCandidates = @(
  (Join-Path $npmRoot "$Pkg\node_modules\.bin\playwright.cmd"),
  (Join-Path $PSScriptRoot "..\node_modules\.bin\playwright.cmd")
)
$pwCli = $pwCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($pwCli) {
  Info "ensuring Playwright Chromium (one-time ~170MB download)"
  & $pwCli install chromium
  if ($LASTEXITCODE -eq 0) {
    Info "Playwright Chromium ready"
  } else {
    Warn "Chromium download FAILED - HTML render/extract/compare tools will not work."
    Warn "Fix manually: npx playwright install chromium   (then: $Cmd doctor)"
  }
} else {
  Warn "playwright CLI not found - run: npx playwright install chromium (then: $Cmd doctor)"
}

# --- 6. Next steps ------------------------------------------------------------
Write-Host ""
Info "figmingo-mcp installed"
Write-Host @"

Next steps:
  1. Get a Figma Personal Access Token:
       Figma -> Settings -> Security -> Personal access tokens -> Generate new token
  2. Restart your AI client (Cursor / Claude Code / Claude Desktop / VS Code / Kimi CLI / Codex).
     The MCP server starts automatically via: $Cmd
  3. (Write tools) In Figma desktop:
       Plugins -> Development -> Import plugin from manifest...
       -> pick figmingo-plugin\manifest.json on your Desktop
          (it links to $pluginDir)
       -> run "figmingo" from Plugins -> Development while using write tools.
  4. Verify the environment:  $Cmd doctor
  5. Verify end-to-end: ask your AI client to call the "whoami" tool.
"@
