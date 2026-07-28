# figmingo-mcp one-command installer (Windows).
#   iwr -useb https://raw.githubusercontent.com/<owner>/figmingo-mcp/main/scripts/install.ps1 | iex
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

# --- 3. Figma token ----------------------------------------------------------
if (-not $Token -and $env:FIGMA_API_KEY) { $Token = $env:FIGMA_API_KEY }
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
  $cfg.mcpServers | Add-Member -NotePropertyName "figmingo" -NotePropertyValue $entry -Force
  $cfg | ConvertTo-Json -Depth 20 | Set-Content $path -Encoding UTF8
  Info "wrote $name config -> $path"
}

# Codex CLI config (~/.codex/config.toml, TOML). Only ever touches the
# [mcp_servers.figmingo] section (incl. its .env subtable); the rest of the
# file is preserved. Backs up the original to config.toml.figmingo-bak on
# first write. Idempotent: re-running replaces the section in place.
function Write-CodexConfig($path) {
  $dir = Split-Path $path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tomlCmd = $Cmd
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
  Set-Content -Path $path -Value $out -Encoding UTF8
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
  Copy-Item (Join-Path $src "manifest.json"), (Join-Path $src "code.js"), (Join-Path $src "README.md") $pluginDir -ErrorAction SilentlyContinue
  Info "companion plugin copied to $pluginDir"
} else {
  Warn "could not locate bundled plugin; copy plugin\ from the npm package manually"
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
       -> select $pluginDir\manifest.json
       -> run "figmingo" from Plugins -> Development while using write tools.
  4. Verify: ask your AI client to call the "whoami" tool.
"@
