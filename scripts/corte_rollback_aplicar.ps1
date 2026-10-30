<#
corte_rollback_aplicar.ps1 - APLICA el ROLLBACK del corte ERP v2 a PRODUCCION. Lo corre Norman.

Escrito el 2026-10-30 por el Socio (ejecutor A2), rama v2-arranque-limpio.

Mismo candado que corte_aplicar.ps1 (es el mismo script): SHA-256 del archivo = el de su .sha256 y
empieza con -Confirmar; psql PIDE la contrasena; log en supabase/_corte/rollback_aplicado_<fecha>.log.
Solo acepta archivos rollback_AAAA-MM-DD.sql (los genera scripts/corte_rollback.py --solo-generar,
con el respaldo de ANTES del corte).

Uso:
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\norma\Documents\Cursor\app-admin-v2\scripts\corte_rollback_aplicar.ps1 `
      -Archivo C:\Users\norma\Documents\Cursor\app-admin-v2\supabase\_corte\rollback_2026-10-30.sql -Confirmar <8 hex>
#>
param(
    [Parameter(Mandatory = $true)][string]$Archivo,
    [Parameter(Mandatory = $true)][string]$Confirmar,
    [string]$Servidor = 'aws-1-us-west-1.pooler.supabase.com',
    [int]$Puerto = 5432,
    [string]$Usuario = 'postgres.gnnqxtsdrbvmlkhfemjw',
    [string]$BaseDatos = 'postgres'
)
$aplicar = Join-Path $PSScriptRoot 'corte_aplicar.ps1'
& $aplicar -Archivo $Archivo -Confirmar $Confirmar -Servidor $Servidor -Puerto $Puerto -Usuario $Usuario `
    -BaseDatos $BaseDatos -Patron '^rollback_\d{4}-\d{2}-\d{2}\.sql$' -Prefijo 'rollback_aplicado'
exit $LASTEXITCODE
