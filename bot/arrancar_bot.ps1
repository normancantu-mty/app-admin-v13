# ============================================================================
# Arranca el bot de gastos. Para despues de un reinicio: clic derecho ->
# "Ejecutar con PowerShell", o desde una terminal:
#     powershell -ExecutionPolicy Bypass -File bot\arrancar_bot.ps1
#
# Los dos tokens viven en el entorno de USUARIO (puestos con `setx`), no en
# ningun archivo versionado. Este script los lee de ahi; no los contiene.
# ============================================================================

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $env:TEMP 'bot_gastos.log'

foreach ($n in 'BOT_GASTOS_TELEGRAM_TOKEN', 'BOT_API_TOKEN') {
  if (-not [Environment]::GetEnvironmentVariable($n, 'User')) {
    Write-Host "FALTA la variable $n. Ponla con:  setx $n `"<valor>`"" -ForegroundColor Red
    exit 1
  }
  Set-Item -Path "env:$n" -Value ([Environment]::GetEnvironmentVariable($n, 'User'))
}

# El bot escribe contra la API de Next. Si el servidor no esta, el bot contesta
# pero NO guarda nada — que es peor que no contestar. Se comprueba antes.
try {
  $null = Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/' -TimeoutSec 8
} catch {
  Write-Host "El servidor no responde en localhost:3000. Levantalo primero:  npm run dev" -ForegroundColor Red
  exit 1
}

# Un solo bot a la vez: dos procesos con long polling se roban los mensajes.
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*bot_gastos.py*' } |
  ForEach-Object { Write-Host "Matando el bot anterior (PID $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force }

$p = Start-Process -FilePath 'python' -ArgumentList 'bot/bot_gastos.py' `
       -WorkingDirectory $raiz -WindowStyle Hidden -PassThru `
       -RedirectStandardOutput $log -RedirectStandardError "$log.err"

Start-Sleep -Seconds 4
if ($p.HasExited) {
  Write-Host "El bot murio al arrancar. Log: $log.err" -ForegroundColor Red
  Get-Content "$log.err" -Tail 15
  exit 1
}
Write-Host "Bot arriba. PID $($p.Id). Log: $log" -ForegroundColor Green
