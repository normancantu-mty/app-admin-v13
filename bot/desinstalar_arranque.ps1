# ============================================================================
# desinstalar_arranque.ps1 - D86 (Fase 8): quita la tarea de instalar_arranque.ps1.
# No toca `VigilarBotERP` (el vigilante de cada 5 min) ni el bot que este corriendo.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File bot\desinstalar_arranque.ps1 -WhatIf
#   powershell -NoProfile -ExecutionPolicy Bypass -File bot\desinstalar_arranque.ps1
# ============================================================================
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$NombreTarea = 'ArrancarBotERP'
)

$ErrorActionPreference = 'Stop'
$tarea = Get-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
if (-not $tarea) { Write-Host "No hay tarea '$NombreTarea'. Nada que quitar."; exit 0 }

if ($PSCmdlet.ShouldProcess($NombreTarea, 'Quitar tarea al iniciar sesion')) {
  Unregister-ScheduledTask -TaskName $NombreTarea -Confirm:$false
  Write-Host "Quitada: $NombreTarea" -ForegroundColor Green
}
