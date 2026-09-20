# Install this plugin into a dsh profile without a package manager: make this
# directory resolvable under its package name, and add the loader row to the
# profile's user patch layer.
#
# This is the offline route — a directory someone unzipped. Installing with
# `dsh plugin --profile web add <spec>` needs none of it: that records the
# package as a profile bundle and the row comes from the package's own
# cordis.patch.yml. Use one route or the other, never both, or the row is
# inserted twice.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ContextMenu
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Remove
#
# Exit codes: 0 installed, already installed, or removed; 1 a step failed.

param(
  # Profile to install into; the same one `dsh web` runs.
  [string]$Profile = 'web',
  # Also add (or, with -Remove, take away) the Explorer context-menu entry.
  [switch]$ContextMenu,
  # Undo the link and the loader row instead of installing them.
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 predates $IsWindows; this installer is Windows-first
# and falls back to a symbolic link elsewhere.
$onWindows = $true
if (Test-Path variable:IsWindows) { $onWindows = [bool]$IsWindows }

# The plugin's package name, which is also the loader row's id and name.
$packageName = 'dsh-open-workspace'

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  # Set-Content -Encoding utf8 writes a BOM on Windows PowerShell 5.1, and a
  # YAML reader would see those three bytes as content.
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Test-IsLink([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  # LinkType/Target only exist from PowerShell 6 on, so links are recognised by
  # the reparse-point attribute instead.
  $attributes = (Get-Item -LiteralPath $Path -Force).Attributes
  return [bool]($attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function Test-IsThisPlugin([string]$Path) {
  # Reads through the link, which works the same on every PowerShell version.
  $manifest = Join-Path $Path 'package.json'
  if (-not (Test-Path -LiteralPath $manifest)) { return $false }
  try { return ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name -eq $packageName) }
  catch { return $false }
}

function Remove-Link([string]$Path) {
  # Delete the link, never what it points at: a Remove-Item -Recurse on a
  # junction deletes the target's contents on Windows PowerShell 5.1.
  try { [System.IO.Directory]::Delete($Path, $false) }
  catch { Remove-Item -LiteralPath $Path -Force }
}

# This directory is the plugin; the script refuses to guess otherwise.
$pluginDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($pluginDir)) {
  Write-Host 'install.ps1: 请作为文件运行（powershell -File install.ps1），不要用 -Command' -ForegroundColor Red
  exit 1
}
$pluginDir = (Resolve-Path -LiteralPath $pluginDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'package.json'))) {
  Write-Host "install.ps1: $pluginDir 里没有 package.json —— 这不是插件目录" -ForegroundColor Red
  exit 1
}

# The harness home resolves the way the plugin resolves it: $DSH_HOME, else ~/.dsh.
if (-not [string]::IsNullOrEmpty($env:DSH_HOME)) { $dshHome = $env:DSH_HOME }
elseif ($onWindows) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
else { $dshHome = Join-Path $HOME '.dsh' }

$profilesDir = Join-Path $dshHome 'profiles'
$linkPath = Join-Path (Join-Path $profilesDir 'node_modules') $packageName
$profileDir = Join-Path $profilesDir $Profile
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

# The profile's own patch-layer header, so a file this script creates looks like
# the one `dsh` initializes.
$patchHeader = @(
  '# Your patch layer for this dsh profile, applied after every bundle layer:'
  '# a top-level YAML array of loader patch entries (id-targeted config'
  '# overrides, disables, and insert lists; `!!js` expressions allowed).'
)
$patchRow = @(
  '- insert:'
  "    - id: $packageName"
  "      name: '$packageName'"
)

function Test-BundleInstall {
  # `dsh plugin ... add` records the package as a profile bundle instead, and
  # then this script's row would be a second copy of the same plugin.
  $manifestPath = Join-Path $profileDir 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { return $false }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $bundles = @($manifest.dsh.profile.bundles)
    return $bundles -contains $packageName
  } catch { return $false }
}

function Install-Link {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $linkPath) | Out-Null
  if (Test-IsLink $linkPath) {
    if (Test-IsThisPlugin $linkPath) { Write-Host "链接已存在: $linkPath"; return }
    Write-Host "同名链接指向的不是这个插件，替换它: $linkPath"
  } elseif (Test-Path -LiteralPath $linkPath) {
    Write-Host "$linkPath 是一个真实目录，不是链接 —— 请先自行处理（脚本不删目录）" -ForegroundColor Red
    exit 1
  }
  if ($onWindows) { New-Item -ItemType Junction -Force -Path $linkPath -Target $pluginDir | Out-Null }
  else { New-Item -ItemType SymbolicLink -Force -Path $linkPath -Target $pluginDir | Out-Null }
  Write-Host "已创建链接: $linkPath -> $pluginDir"
}

function Install-Row {
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  if (-not (Test-Path -LiteralPath $patchPath)) {
    Write-Utf8NoBom $patchPath (($patchHeader + $patchRow -join "`n") + "`n")
    Write-Host "已创建补丁层: $patchPath"
    return
  }
  $text = [System.IO.File]::ReadAllText($patchPath)
  if ($text -match [regex]::Escape($packageName)) { Write-Host "补丁行已存在: $patchPath"; return }
  # A layer that is still the empty-array template takes the row in place of the
  # `[]` and has nothing to lose; a layer holding the user's own entries takes it
  # appended, because a top-level YAML array ends wherever the file ends, and is
  # backed up first.
  if (-not ($text -match '(?m)^\[\]\s*$')) {
    Copy-Item -LiteralPath $patchPath -Destination "$patchPath.bak" -Force
    Write-Host "已备份原文件: $patchPath.bak"
  }
  if ($text -match '(?m)^\[\]\s*$') {
    $updated = [regex]::Replace($text, '(?m)^\[\]\s*$', ($patchRow -join "`n"))
  } else {
    $updated = $text.TrimEnd("`r", "`n") + "`n" + ($patchRow -join "`n")
  }
  Write-Utf8NoBom $patchPath ($updated.TrimEnd("`r", "`n") + "`n")
  Write-Host "已追加补丁行: $patchPath"
}

function Remove-Row {
  if (-not (Test-Path -LiteralPath $patchPath)) { return }
  $text = [System.IO.File]::ReadAllText($patchPath)
  if ($text -notmatch [regex]::Escape($packageName)) { Write-Host '补丁行不在文件里，跳过'; return }
  # Drop exactly the three lines this script writes, and nothing else.
  $kept = New-Object System.Collections.Generic.List[string]
  $lines = $text -split "`r?`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -eq '- insert:' -and $i + 2 -lt $lines.Count `
      -and $lines[$i + 1].Trim() -eq "- id: $packageName" `
      -and $lines[$i + 2].Trim() -eq "name: '$packageName'") {
      $i += 2
      continue
    }
    $kept.Add($lines[$i])
  }
  $body = ($kept -join "`n").TrimEnd("`r", "`n")
  $entries = @($body -split "`n" | Where-Object { $_ -match '^- ' })
  if ($entries.Count -eq 0) { $body = $body + "`n[]" }
  Write-Utf8NoBom $patchPath ($body.TrimEnd("`r", "`n") + "`n")
  Write-Host "已移除补丁行: $patchPath"
}

function Test-Resolution {
  # The loader resolves a bare row name through the profile directory, so that
  # is where a successful import has to come from.
  $probe = "const m = await import('$packageName'); if (typeof m.apply !== 'function') { console.error('no apply export'); process.exit(1) }"
  Push-Location -LiteralPath $profileDir
  try { node --input-type=module -e $probe } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "包名 $packageName 无法解析 —— 链接或 node 有问题，插件不会加载" -ForegroundColor Red
    exit 1
  }
  Write-Host "已验证: 从 $profileDir 能以包名 $packageName 解析并导入"
}

function Invoke-ContextMenu([bool]$Uninstall) {
  $menu = Join-Path $pluginDir 'install-context-menu.ps1'
  if (-not (Test-Path -LiteralPath $menu)) { Write-Host '找不到 install-context-menu.ps1，跳过'; return }
  if ($Uninstall) { & $menu -Remove } else { & $menu }
}

if ($Remove) {
  if (Test-IsLink $linkPath) {
    if (Test-IsThisPlugin $linkPath) { Remove-Link $linkPath; Write-Host "已删除链接: $linkPath" }
    else { Write-Host "$linkPath 指向的不是这个插件，未删除" -ForegroundColor Yellow }
  } elseif (Test-Path -LiteralPath $linkPath) { Write-Host "$linkPath 是真实目录，未删除" -ForegroundColor Yellow }
  else { Write-Host "没有链接可删: $linkPath" }
  Remove-Row
  if ($ContextMenu) { Invoke-ContextMenu $true }
  Write-Host ''
  Write-Host '已卸载。重启 `dsh web` 之后插件才会从进程里消失。'
  exit 0
}

if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'install.ps1: 找不到 node —— dsh-open CLI 需要一个在 PATH 上的 node' -ForegroundColor Red
  exit 1
}
if (Test-BundleInstall) {
  Write-Host "注意: $profileDir 的 package.json 已经把 $packageName 列为 profile bundle —— " -ForegroundColor Yellow
  Write-Host '      说明它是用 `dsh plugin ... add` 装的。两种方式的加载行会重复，本次不再写补丁行。' -ForegroundColor Yellow
  Install-Link
  exit 0
}

Install-Link
Install-Row
Test-Resolution
if ($ContextMenu) { Invoke-ContextMenu $false }

Write-Host ''
Write-Host '装好了。接下来:'
Write-Host '  1. 已经在跑 dsh web 的话: 补丁层会实时重载，但宿主半侧要重启一次才换；刷新 GUI 页面让浏览器半侧生效。'
Write-Host '  2. 验证: dsh-open --status（或 .\dsh-open.cmd --status）'
Write-Host "  3. 可选: 把 $pluginDir 加进 PATH，就能在任意 shell 里直接用 dsh-open；"
Write-Host '     或在资源管理器里右键目录 → 通过 DSH 打开。'
exit 0
