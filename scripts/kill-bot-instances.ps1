# Завершает все node-процессы с src/index.js (бот PAWPAW), не трогая Cursor/IDE.
# Родительские `npm start` без пути в командной строке сюда не попадают — закрой лишние окна терминала вручную при необходимости.
$ErrorActionPreference = 'SilentlyContinue'
$botRoot = Split-Path -Parent $PSScriptRoot
$lock = Join-Path $botRoot '.bot-single.lock'

$n = 0
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object {
  $c = $_.CommandLine
  if (-not $c) { return }
  if ($c -match 'cursor[\\/]resources[\\/]app') { return }
  if ($c -match 'typingsInstaller|eslint|typescript') { return }
  if ($c -match 'src[/\\]index\.js') {
    Write-Host "Kill node PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force
    $n++
  }
}
if (Test-Path $lock) {
  Remove-Item $lock -Force
  Write-Host "Removed $lock"
}
Write-Host "Stopped $n bot worker(s). Run: npm start (once)"
