# ============================================================================
# instalar_arranque.ps1 - D86 (Fase 8): el bot arranca solo al iniciar sesion.
#
# POR QUE: el vigilante (`VigilarBotERP`, cada 5 min) ya levanta Next y el bot,
# pero solo si alguien lo instalo, y su primera vuelta llega hasta 5 minutos
# despues de prender la maquina. Esta tarea corre `vigilar_bot.ps1` UNA vez al
# iniciar sesion: el mismo camino, sin logica nueva, sin servicios de pago.
#
# PROBARLO SIN INSTALAR NADA (no toca el Programador de tareas):
#   powershell -NoProfile -ExecutionPolicy Bypass -File bot\instalar_arranque.ps1 -WhatIf
#
# INSTALARLO (si dice "Acceso denegado", en una PowerShell como administrador):
#   powershell -NoProfile -ExecutionPolicy Bypass -File bot\instalar_arranque.ps1
#
# QUITARLO:  bot\desinstalar_arranque.ps1   (tambien acepta -WhatIf)
# ============================================================================
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$NombreTarea = 'ArrancarBotERP'
)

$ErrorActionPreference = 'Stop'
$vigilante = Join-Path $PSScriptRoot 'vigilar_bot.ps1'
if (-not (Test-Path $vigilante)) { Write-Host "No encuentro $vigilante" -ForegroundColor Red; exit 1 }

$argumentos = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$vigilante`""
$usuario = "$env:USERDOMAIN\$env:USERNAME"

Write-Host "Tarea:     $NombreTarea"
Write-Host "Cuando:    al iniciar sesion $usuario (30 s despues, para que haya red)"
Write-Host "Que corre: powershell.exe $argumentos"

$yaEsta = Get-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
if ($yaEsta) { Write-Host "Ya existe una tarea '$NombreTarea': se reemplaza." -ForegroundColor Yellow }

if ($PSCmdlet.ShouldProcess($NombreTarea, 'Registrar tarea al iniciar sesion')) {
  $accion   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argumentos -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
  $disparo  = New-ScheduledTaskTrigger -AtLogOn -User $usuario
  $disparo.Delay = 'PT30S'
  $ajustes  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  $quien    = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $NombreTarea -Action $accion -Trigger $disparo -Settings $ajustes `
    -Principal $quien -Description 'Fase 8 D86: corre vigilar_bot.ps1 al iniciar sesion (levanta Next y el bot).' -Force | Out-Null
  Write-Host "Instalada. Compruebala con:  schtasks /query /tn $NombreTarea /v /fo LIST" -ForegroundColor Green
}
