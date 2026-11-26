# Tally on the home laptop (T4.4, D62). Run by the three files next to it:
#   Install Tally.bat  -> install   (once: settings, build, database, first login, desktop shortcut)
#   Open Tally.bat     -> open      (every day: start if needed, open the browser)
#   Update Tally.bat   -> update    (newest version from GitHub, keeps all data)
# Windows PowerShell 5.1. Docker Desktop and Git must be installed (home/README.md).
param([Parameter(Mandatory)][ValidateSet('install', 'open', 'update')][string]$Action)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $PSScriptRoot 'tally.env'
$site = 'http://localhost:8080'
# A copy of the data taken before an update changes the database, deleted once the update works.
$backup = Join-Path $PSScriptRoot 'backup-before-update.dump'

function Say($text) { Write-Host $text -ForegroundColor Cyan }

# Native programs do not stop the script on failure: check each one's exit code.
function Run([string]$what, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$what did not work (exit code $LASTEXITCODE)." }
}

function Compose {
  docker compose -p tally-home -f "$root\docker\compose.prod.yml" -f "$root\docker\compose.home.yml" --env-file $envFile @args
}

function Wait-Docker {
  # 5.1 turns a redirected native error line into a stopping error: "not running" must not stop us.
  $ErrorActionPreference = 'Continue'
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { return }
  $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (-not (Test-Path $desktop)) { throw 'Docker Desktop is not installed (see home/README.md).' }
  Say 'Starting Docker Desktop...'
  Start-Process $desktop
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }
  }
  throw 'Docker Desktop did not start within 3 minutes. Open it from the Start menu and try again.'
}

function Wait-Tally {
  for ($i = 0; $i -lt 60; $i++) {
    try {
      if ((Invoke-WebRequest "$site/api/health" -UseBasicParsing -TimeoutSec 5).Content -eq 'ok') { return }
    } catch {}
    Start-Sleep -Seconds 2
  }
  throw 'Tally did not start within 2 minutes.'
}

function New-Password {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

# Settings for this laptop, written once. Running Install again keeps them (and so the data).
function New-Settings {
  Say 'Paste the reading key (it starts with sk-ant-; it is not shown) and press Enter:'
  $secure = Read-Host -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
  if ($key -notmatch '^sk-ant-[A-Za-z0-9_-]+$') { throw 'That does not look like a reading key. Nothing was saved.' }
  $db = New-Password
  $storage = New-Password
  $lines = @(
    '# Tally on this laptop. Written by Install Tally. Holds passwords and the reading key:',
    '# never share this file, never put it on GitHub.',
    'TALLY_VERSION=home',
    "APP_URL=$site",
    "DB_PASSWORD=$db",
    "DATABASE_URL=postgresql://tally:$db@postgres:5432/tally",
    "STORAGE_PASSWORD=$storage",
    'S3_ENDPOINT=http://localhost:19100',
    'S3_REGION=us-east-1',
    'S3_BUCKET=tally',
    'S3_ACCESS_KEY_ID=tally',
    "S3_SECRET_ACCESS_KEY=$storage",
    'EXTRACTOR=anthropic',
    "ANTHROPIC_API_KEY=$key",
    'REVIEW_EVERYTHING=true',
    'SESSION_IDLE_DAYS=30'
  )
  # ASCII: no byte-order mark, which Docker would read as part of the first setting.
  Set-Content -Path $envFile -Value $lines -Encoding ASCII
}

function Build-And-Start {
  Say 'Preparing Tally (the first time takes about 10 minutes)...'
  Run 'Preparing the app' { docker build -f "$root\docker\app.Dockerfile" -t tally-app:home $root }
  Run 'Preparing the website' { docker build -f "$root\docker\web.Dockerfile" -t tally-web:home $root }
  Say 'Updating the database...'
  Run 'Updating the database' { Compose run --rm -w /app/apps/api api ./node_modules/.bin/prisma migrate deploy }
  Run 'Starting Tally' { Compose up -d }
  Wait-Tally
}

function Install {
  Wait-Docker
  if (Test-Path $envFile) {
    Say 'Settings already exist on this laptop: keeping them.'
  } else {
    # New passwords would lock out an existing database: never write them over old data.
    $ErrorActionPreference = 'Continue'
    docker volume inspect tally-home_postgres *> $null
    $hasData = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($hasData) { throw "Tally's data is on this laptop but home\tally.env is missing. Put the file back (it was in the Tally\home folder)." }
    New-Settings
  }
  Build-And-Start
  # Also the way back in after a forgotten password: run Install again with another email.
  Say "Create the login (an email address and a password of at least 12 characters):"
  Compose run --rm api node --experimental-strip-types --disable-warning=ExperimentalWarning apps/api/src/seed-admin.ts
  if ($LASTEXITCODE -ne 0) { Say 'No new login was created (the reason is above). Existing logins still work.' }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Tally.lnk'))
  $link.TargetPath = Join-Path $PSScriptRoot 'Open Tally.bat'
  $link.WorkingDirectory = $PSScriptRoot
  $link.Save()
  Say 'Done. A "Tally" shortcut is on the desktop.'
  Start-Process $site
}

function Open {
  if (-not (Test-Path $envFile)) { throw 'Tally is not installed yet: run Install Tally first.' }
  Wait-Docker
  Run 'Starting Tally' { Compose up -d --no-build }
  try { Wait-Tally } catch {
    # The app shares storage's network; if storage restarted alone, starting them afresh fixes it.
    Run 'Restarting Tally' { Compose up -d --no-build --force-recreate }
    Wait-Tally
  }
  Start-Process $site
}

$script:backupFresh = $false

function Save-Backup {
  Say 'Saving a copy of the data first...'
  Run 'Starting the database' { Compose up -d --wait postgres }
  Run 'Saving a copy of the data' { Compose exec -T postgres pg_dump -U tally -Fc -f /tmp/backup.dump tally }
  # Next to an older copy a failed update left, which is replaced only once this one is complete.
  Run 'Saving a copy of the data' { Compose cp postgres:/tmp/backup.dump "$backup.new" }
  Compose exec -T postgres rm -f /tmp/backup.dump
  Move-Item -Force "$backup.new" $backup
  $script:backupFresh = $true
}

function Update {
  if (-not (Test-Path $envFile)) { throw 'Tally is not installed yet: run Install Tally first.' }
  Say 'Getting the newest version...'
  Run 'Getting the newest version (check the internet connection)' { git -C $root pull --ff-only }
  Wait-Docker
  Save-Backup
  Build-And-Start
  # Kept only while needed: nothing of a closed month may outlive its closing (6.4).
  Remove-Item $backup -ErrorAction SilentlyContinue
  Say 'Tally is up to date.'
}

try {
  switch ($Action) { 'install' { Install } 'open' { Open } 'update' { Update } }
  if ($Action -ne 'open') { Read-Host 'Press Enter to close' }
} catch {
  Write-Host ''
  Write-Host "Something went wrong: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Nothing is lost. Send a photo of this window to Liam.'
  if ($script:backupFresh) { Write-Host "A copy of the data from before this update is in $backup." }
  elseif (Test-Path $backup) { Write-Host "An older copy of the data, from an update that failed before, is in $backup." }
  Read-Host 'Press Enter to close'
  exit 1
}
