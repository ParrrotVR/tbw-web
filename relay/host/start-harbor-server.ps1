# Harbor Server: runs the Harbor relay on this PC and makes it reachable from anywhere
# through Tailscale Funnel (a free, fixed https://<pc>.<tailnet>.ts.net address).
# Start it with "Start Harbor Server.bat". Close the window (or press Ctrl+C) to stop.
# Works in Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$data = Join-Path $env:LOCALAPPDATA 'Harbor Server'
$port = 8787
$harborLink = 'https://cdn.jsdelivr.net/gh/ParrrotVR/tbw-web@launch/index.svg'
New-Item -ItemType Directory -Force $data | Out-Null
# The relay runs from its own copy, so its downloaded parts never land in the project folder.
$relay = Join-Path $data 'relay'
$host.UI.RawUI.WindowTitle = 'Harbor Server'

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ''; Write-Host $text -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

Step 'Checking Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Start-Process 'https://nodejs.org/en/download'
  Fail 'Node.js is not installed. Install the LTS version from the page that just opened, then run this again.'
}
$major = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "Node.js $major is too old. Install version 22 or newer from https://nodejs.org, then run this again." }
Write-Host "Node.js $(& node --version)"

Step 'Preparing the relay (the first run downloads its parts)'
& robocopy $source $relay /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copying the relay to $relay failed." }
$lock = Join-Path $relay 'package-lock.json'
$stamp = Join-Path $relay 'node_modules\.harbor-installed'
$lockHash = (Get-FileHash $lock).Hash
if (-not (Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $lockHash) {
  Push-Location $relay
  try { & npm.cmd ci --omit=dev; if ($LASTEXITCODE) { Fail 'Installing the relay failed (npm ci). Check your internet connection and try again.' } }
  finally { Pop-Location }
  [IO.File]::WriteAllText($stamp, $lockHash)
}
Write-Host 'Relay ready.'

# A private access key, made once and kept outside the project folder.
$keyFile = Join-Path $data 'access-key.txt'
if (-not (Test-Path $keyFile)) {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [IO.File]::WriteAllText($keyFile, [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
}
$key = (Get-Content $keyFile -Raw).Trim()

Step 'Checking Tailscale'
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' }
if (-not (Test-Path $ts)) {
  Start-Process 'https://tailscale.com/download/windows'
  Fail 'Tailscale is not installed. Install it from the page that just opened, sign in, then run this again.'
}
function TailscaleStatus { try { return (& $ts status --json | Out-String | ConvertFrom-Json) } catch { return $null } }
$status = TailscaleStatus
for ($i = 0; $i -lt 20 -and $status -and $status.BackendState -eq 'Starting'; $i++) { Start-Sleep -Seconds 1; $status = TailscaleStatus }
if (-not $status -or $status.BackendState -ne 'Running') {
  Write-Host 'Tailscale is not signed in. A sign-in page will open; sign in, then come back here.' -ForegroundColor Yellow
  & $ts up
  $status = TailscaleStatus
  if (-not $status -or $status.BackendState -ne 'Running') { Fail 'Tailscale is still not connected. Open Tailscale from the taskbar, sign in, then run this again.' }
}
$dns = ([string]$status.Self.DNSName).TrimEnd('.')
if (-not $dns) { Fail 'Tailscale did not report this PC''s name. Open the Tailscale admin page and turn on MagicDNS, then run this again.' }
$address = "https://$dns"
Write-Host "This PC is $dns"

Step 'Publishing the relay with Tailscale Funnel'
Write-Host 'If Tailscale prints a link to enable HTTPS or Funnel, open it, click Enable, and this continues by itself.' -ForegroundColor Yellow
& $ts funnel --bg $port
if ($LASTEXITCODE) { Fail 'Tailscale Funnel could not start. Open https://login.tailscale.com/admin/settings/features, turn on HTTPS certificates and Funnel, then run this again.' }

Step 'Starting the relay'
$env:HOST = '127.0.0.1'
$env:PORT = "$port"
$env:FIXTURE_PORT = "$($port + 1)"
$env:HARBOR_ACCESS_KEY = $key
$env:HARBOR_CLIENT_ORIGINS = 'https://cdn.jsdelivr.net'
$env:HARBOR_PUBLIC_ORIGIN = $address
$env:NODE_ENV = 'production'
$server = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.mjs' -WorkingDirectory $relay -NoNewWindow -PassThru

# Keep the PC awake while the relay runs (the screen may still turn off).
Add-Type -Namespace Harbor -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
[void][Harbor.Power]::SetThreadExecutionState([uint32]'0x80000001')

$headers = @{ 'X-Harbor-Key' = $key }
$local = $false
for ($i = 0; $i -lt 30 -and -not $local -and -not $server.HasExited; $i++) {
  Start-Sleep -Seconds 1
  try { $local = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$port/api/health").StatusCode -eq 200 } catch {}
}
if (-not $local) { Fail 'The relay did not start. Read the messages above for the reason.' }
$public = $false
for ($i = 0; $i -lt 6 -and -not $public; $i++) {
  try { $public = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Headers $headers "$address/api/health").StatusCode -eq 200 } catch { Start-Sleep -Seconds 3 }
}

# One-tap setup link: the address and key travel after "#", which browsers never send to a server.
$payload = [Text.Encoding]::UTF8.GetBytes((@{ a = $address; k = $key } | ConvertTo-Json -Compress))
$setup = $harborLink + '#harbor-server=' + [Convert]::ToBase64String($payload).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$connect = Join-Path $data 'connect.html'
$template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'connect.html'))
[IO.File]::WriteAllText($connect, $template.Replace('__SETUP_LINK__', $setup).Replace('__ADDRESS__', $address).Replace('__KEY__', $key), (New-Object Text.UTF8Encoding $false))
try { Set-Clipboard -Value $setup } catch {}
Start-Process $connect

Write-Host ''
Write-Host '======================================================' -ForegroundColor Green
Write-Host ' Harbor Server is running on this PC' -ForegroundColor Green
Write-Host "   Address: $address"
Write-Host "   Key:     $key"
if ($public) { Write-Host '   Reachable from the internet: yes' -ForegroundColor Green }
else { Write-Host '   Reachable from the internet: not confirmed yet (Funnel can take a minute the first time)' -ForegroundColor Yellow }
Write-Host ' On the iPad: scan the QR code in the page that just opened,'
Write-Host ' or paste the setup link (already copied) into Safari.'
Write-Host ' Keep this window open. Close it to stop the server.'
Write-Host '======================================================' -ForegroundColor Green
try { $server.WaitForExit() }
finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  & $ts funnel --https=443 off 2>$null | Out-Null
}
