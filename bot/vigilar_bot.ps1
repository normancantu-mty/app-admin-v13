# ============================================================================
# vigilar_bot.ps1 - el que hace que el latido sirva de algo.
#
# POR QUE EXISTE (2026-09-14, medido, no supuesto)
# ------------------------------------------------
# El bot YA tenia latido: escribe "latido: vivo" en su log cada 15 minutos, y
# su propio comentario dice *"su valor es el silencio"*. El problema es que
# **nadie auscultaba ese silencio.**
#
# El 2026-09-12 a las 19:40:22 el proceso murio sin dejar traceback (el ultimo
# latido fue a las 19:33:47 y el siguiente tocaba a las 19:48). El 13 de
# septiembre Norman le escribio *"Gasto de 1000 salida 'salida socios'"* y no
# hubo nadie del otro lado. Se entero **dos dias despues**, preguntando.
#
# Este script es idempotente y seguro de correr cada 5 minutos:
#   - si el servidor de Next no responde, lo levanta;
#   - si el bot no esta en la lista de procesos, lo arranca;
#   - si el bot ESTA pero su log lleva mas de 20 min sin una linea, esta
#     colgado (E-25) y se reinicia. 20 > 15 a proposito: un latido perdido por
#     carga no es un cuelgue.
#
# INSTALARLO (una vez, en una terminal de Norman - pide elevacion):
#   schtasks /create /tn "VigilarBotERP" /sc minute /mo 5 /ru "$env:USERNAME" ^
#     /tr "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Users\norma\Documents\cursor\app-admin\bot\vigilar_bot.ps1"
#
# QUITARLO:   schtasks /delete /tn "VigilarBotERP" /f
# ============================================================================

$ErrorActionPreference = 'Continue'
$raiz    = Split-Path -Parent $PSScriptRoot
$logBot  = Join-Path $PSScriptRoot 'bot_gastos.log'
$logVig  = Join-Path $PSScriptRoot 'vigilante.log'
$MAX_MIN = 20

function Apuntar($texto) {
  $linea = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $texto
  Add-Content -Path $logVig -Value $linea -Encoding UTF8
  Write-Host $linea
}

# --- 1. Los tokens. Sin ellos no hay nada que vigilar.
foreach ($n in 'BOT_GASTOS_TELEGRAM_TOKEN', 'BOT_API_TOKEN') {
  $v = [Environment]::GetEnvironmentVariable($n, 'User')
  if (-not $v) { Apuntar "FALTA $n en el entorno de usuario. No hago nada."; exit 1 }
  Set-Item -Path "env:$n" -Value $v
}

# --- 2. El servidor de Next. El bot sin el CONTESTA PERO NO GUARDA, que es
#        peor que no contestar: el usuario cree que quedo registrado.
$servidorVivo = $false
try {
  $null = Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/' -TimeoutSec 8
  $servidorVivo = $true
} catch { }

if (-not $servidorVivo) {
  Apuntar 'El servidor 3000 no responde. Lo levanto.'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' `
    -WorkingDirectory $raiz -WindowStyle Hidden
  # Next tarda en compilar la primera vez. Se espera hasta 90s antes de
  # decidir que fallo: arrancar el bot contra un servidor a medio compilar
  # reproduce exactamente el fallo que este script existe para evitar.
  for ($i = 0; $i -lt 18; $i++) {
    Start-Sleep -Seconds 5
    try {
      $null = Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/' -TimeoutSec 5
      $servidorVivo = $true; break
    } catch { }
  }
  if ($servidorVivo) { Apuntar 'Servidor 3000 arriba.' }
  else { Apuntar 'El servidor NO levanto en 90s. No arranco el bot a ciegas.'; exit 1 }
}

# --- 3. El bot: vive el proceso?
$proc = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -like '*bot_gastos.py*' }

$razon = $null
if (-not $proc) {
  $razon = 'el proceso no existe'
} elseif (Test-Path $logBot) {
  # --- 4. Vive el proceso PERO esta colgado? El latido es lo unico que lo
  #        distingue: un proceso en la lista de tareas no es un bot que
  #        contesta. Es E-25, y ya paso una vez.
  $edad = (New-TimeSpan -Start (Get-Item $logBot).LastWriteTime -End (Get-Date)).TotalMinutes
  if ($edad -gt $MAX_MIN) {
    $razon = ('el log lleva {0:N0} min sin una linea (tope {1}); esta colgado' -f $edad, $MAX_MIN)
  }
}

if (-not $razon) { exit 0 }   # Todo bien. El silencio del vigilante es correcto.

Apuntar "REINICIO el bot: $razon"
if ($proc) {
  $proc | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

$salida = Join-Path $env:TEMP 'bot_gastos.out'
$p = Start-Process -FilePath 'python' -ArgumentList 'bot/bot_gastos.py' `
       -WorkingDirectory $raiz -WindowStyle Hidden -PassThru `
       -RedirectStandardOutput $salida -RedirectStandardError "$salida.err"

Start-Sleep -Seconds 6
if ($p.HasExited) {
  Apuntar "El bot murio al arrancar. Ultimas lineas de $salida.err :"
  Get-Content "$salida.err" -Tail 10 | ForEach-Object { Apuntar "    $_" }
  exit 1
}
Apuntar "Bot arriba de nuevo. PID $($p.Id)."
