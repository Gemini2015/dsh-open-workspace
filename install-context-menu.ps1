param([switch]$Remove)
# Add or remove the Windows Explorer "open with DSH" entry for directories.
# HKEY_CURRENT_USER only: no administrator rights, no machine-wide change.
$ErrorActionPreference = 'Stop'
$command = Join-Path $PSScriptRoot 'dsh-open.cmd'
if (-not (Test-Path $command)) { throw "dsh-open.cmd not found beside this script: $command" }

$scopes = @(
  @{ Key = 'HKCU:\Software\Classes\Directory\shell\DSHOpen'; Label = '通过 DSH 打开' },
  @{ Key = 'HKCU:\Software\Classes\Directory\Background\shell\DSHOpen'; Label = '通过 DSH 打开此目录' }
)

foreach ($scope in $scopes) {
  if ($Remove) {
    if (Test-Path $scope.Key) { Remove-Item $scope.Key -Recurse -Force }
    continue
  }
  New-Item -Path $scope.Key -Force | Out-Null
  New-ItemProperty -Path $scope.Key -Name '(default)' -Value $scope.Label -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $scope.Key -Name 'Icon' -Value 'node.exe' -PropertyType String -Force | Out-Null
  New-Item -Path (Join-Path $scope.Key 'command') -Force | Out-Null
  New-ItemProperty -Path (Join-Path $scope.Key 'command') -Name '(default)' `
    -Value "`"$command`" `"%V`"" -PropertyType String -Force | Out-Null
}

if ($Remove) { Write-Host 'Explorer entry removed.' }
else { Write-Host "Explorer entry installed: $command" }
