# paste-use installer for Windows - downloads the prebuilt binary from the
# GitHub Release (no npm, no admin, no auth for you or your users).
#
#   irm https://raw.githubusercontent.com/leeguooooo/paste-use/main/install.ps1 | iex
#
# Env overrides (set before running, e.g. $env:PASTE_USE_VERSION = 'v0.1.0'):
#   PASTE_USE_VERSION         pin a specific release tag
#   PASTE_USE_INSTALL_DIR     install location (default: %LOCALAPPDATA%\Programs\paste-use)
#   PASTE_USE_INSTALL_SKILLS  set to 0 to skip installing the AI agent skill
#   PASTE_USE_NO_PATH         do not add the install directory to your user PATH
#
# Windows PowerShell 5.1 and PowerShell 7 are both supported. Everything runs
# inside one function: under `irm | iex` this script executes in the caller's
# session, where `exit` would close the user's window, so failures throw.

function Install-PasteUse {
  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest's progress bar makes downloads many times slower on 5.1.
  $ProgressPreference = 'SilentlyContinue'
  # GitHub requires TLS 1.2; Windows PowerShell 5.1 may not offer it by default.
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'leeguooooo/paste-use'
  $exeName = 'paste-use.exe'
  $asset = 'paste-use-windows-x64.zip'

  function Say($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
  function Fail($msg) { throw "paste-use installation failed: $msg" }

  # x64 runs natively on AMD64 and under emulation on ARM64; 32-bit Windows is not supported.
  if (-not [Environment]::Is64BitOperatingSystem) { Fail '64-bit Windows is required' }

  $base = if ($env:PASTE_USE_VERSION) {
    "https://github.com/$repo/releases/download/$($env:PASTE_USE_VERSION)"
  } else {
    "https://github.com/$repo/releases/latest/download"
  }
  $binDir = if ($env:PASTE_USE_INSTALL_DIR) { $env:PASTE_USE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\paste-use' }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("paste-use-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  try {
    $zip = Join-Path $tmp $asset
    Say "downloading $base/$asset"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $zip
    # Fail closed: every release ships a .sha256.
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset.sha256" -OutFile "$zip.sha256"
    $expected = ((Get-Content "$zip.sha256" -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
    if (-not $expected -or $expected -ne $actual) { Fail "sha256 mismatch: expected $expected got $actual" }

    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $staged = Join-Path $tmp $exeName
    if (-not (Test-Path $staged)) { Fail "the archive has no $exeName" }
    & $staged version | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'downloaded binary failed smoke test' }

    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $target = Join-Path $binDir $exeName
    if (Test-Path $target) {
      # A running .exe cannot be overwritten but can be renamed (`paste-use upgrade` runs this
      # script from the binary it replaces).
      $old = "$target.old"
      Remove-Item $old -Force -ErrorAction SilentlyContinue
      Move-Item $target $old -Force
    }
    Move-Item $staged $target -Force
    Remove-Item "$target.old" -Force -ErrorAction SilentlyContinue
    Say "installed: $target"

    if (-not $env:PASTE_USE_NO_PATH) {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if (-not $userPath) { $userPath = '' }
      if (-not (($userPath -split ';') -contains $binDir)) {
        [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $binDir).TrimStart(';')), 'User')
        $env:Path = "$env:Path;$binDir"
        Say "added $binDir to your user PATH (new terminals pick it up)"
      }
    }

    if ($env:PASTE_USE_INSTALL_SKILLS -ne '0') {
      & $target skill install
      if ($LASTEXITCODE -ne 0) { Write-Warning 'skill install failed; rerun: paste-use skill install' }
    }
    Say 'ok: run `paste-use status` (it reads the Pastyx app''s history: https://paste.leeguoo.com/download)'
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-PasteUse
