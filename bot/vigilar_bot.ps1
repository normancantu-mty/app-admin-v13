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
#   - si el bot ESTA y contesta pero algun `bot/*.py` es MAS NUEVO que el
#     proceso, esta sirviendo codigo viejo (D21) y se reinicia, escribiendo las
#     dos fechas. Salvo que haya una conversacion a medias: entonces espera y
#     lo anota (D23).
#
# QUIEN DECIDE: `decidir_reinicio.py`, no este archivo. Aqui estan las MANOS
# --matar, arrancar, mirar la lista de procesos--; el JUICIO esta alla, como
# funcion pura, y `probar_vigilante.py` lo corre con sus controles negativos.
# El tope de 20 minutos vive alla tambien: una sola verdad, no dos.
#
# INSTALARLO (una vez, en una terminal de Norman - pide elevacion):
#   schtasks /create /tn "VigilarBotERP" /sc minute /mo 5 /ru "$env:USERNAME" ^
#     /tr "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Users\norma\Documents\cursor\app-admin\bot\vigilar_bot.ps1"
#
# QUITARLO:   schtasks /delete /tn "VigilarBotERP" /f
# ============================================================================

$ErrorActionPreference = 'Continue'
$raiz    = Split-Path -Parent $PSScriptRoot
$logVig  = Join-Path $PSScriptRoot 'vigilante.log'

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

# --- 3. El bot: vive el proceso, y CON QUE CODIGO?
#
#        El juicio NO vive aqui. Vive en `decidir_reinicio.py`, como funcion
#        pura, y lo corre `probar_vigilante.py` con sus controles negativos. La
#        razon es D24: mientras la decision estuvo escrita en PowerShell dentro
#        de este `if`, **nadie podia probarla**, y por eso el 2026-09-19 el
#        vigilante dejo al bot servir codigo de 24 horas sin decir una palabra.
#
#        Aqui se queda solo lo que unicamente Windows sabe: si el proceso existe
#        y a que hora arranco. Todo lo demas -- el `.py` mas nuevo, la edad del
#        log, los borradores del ultimo latido -- lo lee Python, que si se prueba.
$proc = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -like '*bot_gastos.py*' }

$existe = '0'
$arranque = '-'
if ($proc) {
  $existe = '1'
  $utc1970 = [datetime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
  $primero = $proc | Sort-Object CreationDate | Select-Object -First 1
  $arranque = [string][int64](($primero.CreationDate.ToUniversalTime() - $utc1970).TotalSeconds)
}

# El reloj de la espera de D23 tiene que sobrevivir entre corridas: el vigilante
# nace y muere cada 5 minutos, asi que "llevo 20 minutos esperando" no cabe en
# una variable. Cabe en este archivo de una linea.
$archivoEspera = Join-Path $PSScriptRoot 'vigilante_espera.txt'
$espera = '-'
if (Test-Path $archivoEspera) {
  $leido = (Get-Content $archivoEspera -Raw -ErrorAction SilentlyContinue)
  if ($leido) { $espera = $leido.Trim() }
  if (-not $espera) { $espera = '-' }
}

$veredicto = @(& python (Join-Path $PSScriptRoot 'decidir_reinicio.py') $existe $arranque $espera)
$accion = if ($veredicto.Count -gt 0) { [string]$veredicto[0] } else { '' }
$razon  = if ($veredicto.Count -gt 1) { ([string]$veredicto[1]).Trim() } else { '' }
$nuevaEspera = if ($veredicto.Count -gt 2) { ([string]$veredicto[2]).Trim() } else { '' }
$accion = $accion.Trim()

# Si el juez no contesta, NO se mata nada. Un vigilante que reinicia cuando no
# entiende la respuesta es un vigilante que reinicia cada 5 minutos.
if ($accion -ne 'nada' -and $accion -ne 'esperar' -and $accion -ne 'reiniciar') {
  Apuntar "No pude decidir (decidir_reinicio.py dijo '$accion'). No toco el bot."
  exit 1
}

if ($accion -eq 'esperar') {
  # D23: hay una conversacion a medias. No se tira por un cambio de codigo.
  Apuntar $razon
  if ($nuevaEspera) { Set-Content -Path $archivoEspera -Value $nuevaEspera -Encoding ASCII }
  exit 0
}

Remove-Item $archivoEspera -ErrorAction SilentlyContinue

if ($accion -eq 'nada') { exit 0 }   # El silencio del vigilante es correcto.

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
