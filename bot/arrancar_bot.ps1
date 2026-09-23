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

# --- D86 (Fase 8): CONTRA QUE ERP. `ERP_API_URL` del entorno de usuario (la
#     misma variable que lee `bot_gastos.py`); sin ella, localhost:3000 como
#     siempre. Si la URL NO es local (Vercel), no hay `npm run dev` que levantar:
#     solo se comprueba que conteste.
$api = [Environment]::GetEnvironmentVariable('ERP_API_URL', 'User')
if (-not $api) { $api = 'http://localhost:3000' }
$api = $api.TrimEnd('/')
$esLocal = @('localhost', '127.0.0.1') -contains ([uri]$api).Host
$env:ERP_API_URL = $api

# D86: tampoco se arranca un bot que no compila.
$compila = @(& python (Join-Path $PSScriptRoot 'compila_bot.py'))
if ($LASTEXITCODE -ne 0) {
  Write-Host ("El bot no compila: " + ($compila -join ' ')) -ForegroundColor Red
  exit 1
}

# El bot escribe contra la API de Next. Si el servidor no esta, el bot contesta
# pero NO guarda nada — que es peor que no contestar. Se comprueba antes.
try {
  $null = Invoke-WebRequest -UseBasicParsing "$api/" -TimeoutSec 8
} catch {
  if ($esLocal) {
    Write-Host "El servidor no responde en $api. Levantalo primero:  npm run dev" -ForegroundColor Red
  } else {
    Write-Host "El ERP no responde en $api (ERP_API_URL)." -ForegroundColor Red
  }
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
Write-Host "Bot arriba contra $api. PID $($p.Id). Log: $log" -ForegroundColor Green
