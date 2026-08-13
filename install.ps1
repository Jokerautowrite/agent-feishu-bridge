[CmdletBinding()]
param(
  [switch]$NoStartup,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$RepoUrl = if ($env:AGENT_BRIDGE_REPO_URL) { $env:AGENT_BRIDGE_REPO_URL } else { 'https://github.com/Jokerautowrite/agent-feishu-bridge.git' }
$BaseDir = if ($env:AGENT_BRIDGE_INSTALL_DIR) { $env:AGENT_BRIDGE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'agent-feishu-bridge' }
$InstallDir = Join-Path $BaseDir 'app'
$EnvFile = if ($env:AGENT_BRIDGE_ENV_FILE) { $env:AGENT_BRIDGE_ENV_FILE } else { Join-Path $BaseDir '.env' }
$DataDir = Join-Path $BaseDir 'data'
$LogDir = Join-Path $BaseDir 'logs'
$Launcher = Join-Path $BaseDir 'run-agent-feishu-bridge.ps1'

function Require-Command([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "Missing required command: $Name" }
  return $command.Source
}

function Read-ExistingEnv([string]$Key) {
  if (-not (Test-Path -LiteralPath $EnvFile)) { return '' }
  $line = Get-Content -LiteralPath $EnvFile -Encoding utf8 | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -Last 1
  if (-not $line) { return '' }
  return ([string]$line).Substring(([string]$line).IndexOf('=') + 1).Trim().Trim('"')
}

function Read-Value([string]$Prompt, [string]$Default = '') {
  $suffix = if ($Default) { " [$Default]" } else { '' }
  $value = Read-Host "$Prompt$suffix"
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value.Trim()
}

function Read-SecretValue([string]$Existing) {
  if ($env:FEISHU_APP_SECRET) { return $env:FEISHU_APP_SECRET }
  if ($Existing) { return $Existing }
  $secure = Read-Host 'Feishu App Secret' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Quote-Env([string]$Value) {
  return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

$Git = Require-Command 'git.exe'
$Node = Require-Command 'node.exe'
$Npm = Require-Command 'npm.cmd'
$NodeMajor = [int](& $Node -p "Number(process.versions.node.split('.')[0])")
if ($NodeMajor -lt 18) { throw "Node.js 18 or newer is required: $(& $Node --version)" }

New-Item -ItemType Directory -Force -Path $BaseDir, $DataDir, $LogDir | Out-Null
if (Test-Path -LiteralPath (Join-Path $InstallDir '.git')) {
  Write-Host 'Updating existing checkout...'
  & $Git -C $InstallDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'Git update failed. Local modifications were preserved; resolve them and rerun.' }
} elseif (Test-Path -LiteralPath $InstallDir) {
  throw "$InstallDir exists but is not an agent-feishu-bridge Git checkout."
} else {
  & $Git clone --depth 1 $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { throw 'Git clone failed.' }
}

Write-Host 'Installing Node.js dependencies...'
& $Npm --prefix $InstallDir ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw 'npm dependency installation failed.' }

$AppId = if ($env:FEISHU_APP_ID) { $env:FEISHU_APP_ID } else { Read-Value 'Feishu App ID' (Read-ExistingEnv 'FEISHU_APP_ID') }
$AppSecret = Read-SecretValue (Read-ExistingEnv 'FEISHU_APP_SECRET')
$Backend = if ($env:AGENT_BRIDGE_BACKEND) { $env:AGENT_BRIDGE_BACKEND } else { Read-Value 'Agent backend (codex/opencode/claude/chuang/openclaw/hermes/grok)' ((Read-ExistingEnv 'AGENT_BRIDGE_BACKEND') -replace '^$','codex') }
$ProjectsRoot = if ($env:AGENT_BRIDGE_PROJECTS_ROOT) { $env:AGENT_BRIDGE_PROJECTS_ROOT } else { Read-Value 'Projects root' ((Read-ExistingEnv 'AGENT_BRIDGE_PROJECTS_ROOT') -replace '^$',(Join-Path $HOME 'projects')) }

if (-not $AppId -or -not $AppSecret) { throw 'Feishu App ID and App Secret are required.' }
if ($Backend -notin @('codex','opencode','claude','chuang','openclaw','hermes','grok')) { throw "Unsupported backend: $Backend" }
$BackendCommand = switch ($Backend) {
  'codex' { 'codex.exe' }
  'opencode' { 'opencode.exe' }
  'claude' { 'claude.exe' }
  'openclaw' { 'openclaw' }
  'hermes' { 'hermes' }
  'grok' { 'grok.exe' }
  default { $null }
}
$ResolvedBackendCommand = if ($env:AGENT_BRIDGE_CODEX_COMMAND) { $env:AGENT_BRIDGE_CODEX_COMMAND } else { Read-ExistingEnv 'AGENT_BRIDGE_CODEX_COMMAND' }
if ($Backend -eq 'codex' -and -not $ResolvedBackendCommand) {
  $foundCodex = Get-Command $BackendCommand -ErrorAction SilentlyContinue
  if ($foundCodex) { $ResolvedBackendCommand = $foundCodex.Source }
}
if ($BackendCommand -and $Backend -ne 'codex' -and -not (Get-Command $BackendCommand -ErrorAction SilentlyContinue)) {
  throw "$Backend backend command was not found. Install/login the selected Agent, then rerun this installer."
}
if ($Backend -eq 'codex' -and -not $ResolvedBackendCommand) {
  throw 'Codex CLI was not found. Install/login Codex, or set AGENT_BRIDGE_CODEX_COMMAND, then rerun.'
}

$SessionsFile = Join-Path $DataDir 'sessions.json'
$AttachmentsDir = Join-Path $DataDir 'attachments'
New-Item -ItemType Directory -Force -Path $AttachmentsDir | Out-Null
$managedKeys = @(
  'FEISHU_APP_ID','FEISHU_APP_SECRET','AGENT_BRIDGE_BACKEND','AGENT_BRIDGE_PROJECTS_ROOT',
  'AGENT_BRIDGE_SESSIONS_FILE','AGENT_BRIDGE_ATTACHMENTS_DIR','AGENT_BRIDGE_CODEX_COMMAND',
  'AGENT_BRIDGE_FEISHU_STREAMING_OUTPUT','AGENT_BRIDGE_FEISHU_CARDKIT_STREAMING',
  'AGENT_BRIDGE_OUTPUT_VISIBLE_TAIL_PERCENT'
)
$preservedLines = if (Test-Path -LiteralPath $EnvFile) {
  Get-Content -LiteralPath $EnvFile -Encoding utf8 | Where-Object {
    $line = $_
    -not ($managedKeys | Where-Object { $line -match "^$([regex]::Escape($_))=" })
  }
} else { @() }
$envLines = @($preservedLines) + @(
  "FEISHU_APP_ID=$(Quote-Env $AppId)"
  "FEISHU_APP_SECRET=$(Quote-Env $AppSecret)"
  "AGENT_BRIDGE_BACKEND=$(Quote-Env $Backend)"
  "AGENT_BRIDGE_PROJECTS_ROOT=$(Quote-Env $ProjectsRoot)"
  "AGENT_BRIDGE_SESSIONS_FILE=$(Quote-Env $SessionsFile)"
  "AGENT_BRIDGE_ATTACHMENTS_DIR=$(Quote-Env $AttachmentsDir)"
  $(if ($ResolvedBackendCommand) { "AGENT_BRIDGE_CODEX_COMMAND=$(Quote-Env $ResolvedBackendCommand)" })
  'AGENT_BRIDGE_FEISHU_STREAMING_OUTPUT=true'
  'AGENT_BRIDGE_FEISHU_CARDKIT_STREAMING=true'
  'AGENT_BRIDGE_OUTPUT_VISIBLE_TAIL_PERCENT=10'
)
[IO.File]::WriteAllText($EnvFile, ($envLines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
& icacls.exe $EnvFile /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null

$Entry = Join-Path $InstallDir 'bin\codex-im.js'
$stdout = Join-Path $LogDir 'bridge.log'
$stderr = Join-Path $LogDir 'bridge-error.log'
$launcherContent = @"
`$env:AGENT_BRIDGE_ENV_FILE = '$($EnvFile.Replace("'", "''"))'
Set-Location -LiteralPath '$($InstallDir.Replace("'", "''"))'
& '$($Node.Replace("'", "''"))' '$($Entry.Replace("'", "''"))' feishu-bot 1>> '$($stdout.Replace("'", "''"))' 2>> '$($stderr.Replace("'", "''"))'
"@
[IO.File]::WriteAllText($Launcher, $launcherContent, [Text.UTF8Encoding]::new($false))

if (-not $NoStartup) {
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  New-Item -Path $runKey -Force | Out-Null
  $runCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""
  Set-ItemProperty -Path $runKey -Name 'AgentFeishuBridge' -Value $runCommand
}

if (-not $NoStart) {
  $escapedEntry = [regex]::Escape($Entry)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { [string]$_.CommandLine -match $escapedEntry } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$Launcher) -WindowStyle Hidden

  Start-Sleep -Seconds 2
  $verified = $false
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { [string]$_.CommandLine -match $escapedEntry }
    $logText = if (Test-Path -LiteralPath $stdout) { (Get-Content -LiteralPath $stdout -Tail 30) -join "`n" } else { '' }
    if ($running -and $logText -match 'Feishu long connection started') { $verified = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $verified) {
    $errorTail = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Tail 15) -join "`n" } else { 'No error log.' }
    throw "Bridge started but the Feishu long connection was not verified. Check credentials and README setup steps.`n$errorTail"
  }
}

Write-Host ''
Write-Host 'agent-feishu-bridge installed successfully.' -ForegroundColor Green
Write-Host "App:    $InstallDir"
Write-Host "Config: $EnvFile"
Write-Host 'Before testing, finish the Feishu application checklist at the top of README.md.'
