<#
corte_aplicar.ps1 - APLICA el SQL del corte ERP v2 a PRODUCCION. Lo corre Norman, en su terminal.

Escrito el 2026-10-30 por el Socio (ejecutor A2), rama v2-arranque-limpio. Plan aprobado:
~/.claude/plans/lazy-growing-grove.md.

Que hace, en orden:
  1. Calcula el SHA-256 de -Archivo y lo compara con el de <Archivo>.sha256 (lo escribio el
     generador). Si no coinciden, o si el hash no empieza con -Confirmar, NO corre nada.
  2. Corre psql -X -v ON_ERROR_STOP=1 -f <Archivo> contra el pooler de Supabase (sesion, 5432,
     sslmode=require) con PGCLIENTENCODING=UTF8. psql PIDE LA CONTRASENA (Password:); este script
     no la lee, no la guarda y no la busca en ningun lado.
  3. Guarda todo lo que psql imprime en supabase/_corte/<prefijo>_<AAAAMMDD_HHMMSS>.log (UTF-8) y
     al final imprime el codigo de salida de psql: 0 = COMMIT; distinto de 0 = ROLLBACK, nada escrito.

Uso (PowerShell 5.1):
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\norma\Documents\Cursor\app-admin-v2\scripts\corte_aplicar.ps1 `
      -Archivo C:\Users\norma\Documents\Cursor\app-admin-v2\supabase\_corte\corte_2026-10-30.sql -Confirmar <8 hex>

-Servidor/-Puerto/-Usuario/-BaseDatos existen solo para ensayarlo contra una copia desechable; por
defecto apuntan a produccion. -Patron y -Prefijo los usa corte_rollback_aplicar.ps1.
#>
param(
    [Parameter(Mandatory = $true)][string]$Archivo,
    [Parameter(Mandatory = $true)][string]$Confirmar,
    [string]$Servidor = 'aws-1-us-west-1.pooler.supabase.com',
    [int]$Puerto = 5432,
    [string]$Usuario = 'postgres.gnnqxtsdrbvmlkhfemjw',
    [string]$BaseDatos = 'postgres',
    [string]$Patron = '^corte_\d{4}-\d{2}-\d{2}\.sql$',
    [string]$Prefijo = 'aplicado'
)

$ErrorActionPreference = 'Stop'

function Alto([string]$motivo) {
    Write-Host ''
    Write-Host ('NO CORRI NADA: ' + $motivo) -ForegroundColor Red
    exit 2
}

# ---------------------------------------------------------------- 1. el archivo es el revisado
if (-not (Test-Path -LiteralPath $Archivo -PathType Leaf)) { Alto ('no existe el archivo ' + $Archivo) }
$ruta = (Resolve-Path -LiteralPath $Archivo).Path
$nombre = Split-Path -Leaf $ruta
if ($nombre -notmatch $Patron) { Alto ('el archivo ' + $nombre + ' no tiene el nombre esperado (' + $Patron + ')') }
$lateral = $ruta + '.sha256'
if (-not (Test-Path -LiteralPath $lateral -PathType Leaf)) { Alto ('falta ' + $lateral) }

$lineaLateral = (Get-Content -LiteralPath $lateral -TotalCount 1)
if (-not $lineaLateral) { Alto ($lateral + ' esta vacio') }
$partes = $lineaLateral.Trim() -split '\s+'
$esperado = $partes[0].ToLower()
if ($esperado -notmatch '^[0-9a-f]{64}$') { Alto ($lateral + ' no trae un SHA-256') }
if ($partes.Count -ge 2) {
    $nombreLateral = $partes[1].TrimStart('*')
    if ((Split-Path -Leaf $nombreLateral) -ne $nombre) { Alto ($lateral + ' es de otro archivo: ' + $nombreLateral) }
}
$real = (Get-FileHash -LiteralPath $ruta -Algorithm SHA256).Hash.ToLower()
$conf = $Confirmar.Trim().ToLower()
if ($conf -notmatch '^[0-9a-f]{8}$') { Alto ('-Confirmar debe ser los primeros 8 caracteres del SHA-256 (hex)') }
if ($real -ne $esperado) {
    Alto ('el SHA-256 del archivo (' + $real + ') no es el del .sha256 (' + $esperado + '): el archivo cambio despues de generarse')
}
if (-not $real.StartsWith($conf)) {
    Alto ('-Confirmar ' + $conf + ' no coincide con el SHA-256 del archivo (' + $real.Substring(0, 8) + '...)')
}

# ---------------------------------------------------------------- 2. psql
$psql = 'C:\Program Files\PostgreSQL\16\bin\psql.exe'
if (-not (Test-Path -LiteralPath $psql)) {
    $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { Alto 'no encuentro psql.exe' }
    $psql = $cmd.Source
}
$raiz = Split-Path -Parent $PSScriptRoot
$dirLog = Join-Path $raiz 'supabase\_corte'
if (-not (Test-Path -LiteralPath $dirLog)) { New-Item -ItemType Directory -Path $dirLog | Out-Null }
$log = Join-Path $dirLog ($Prefijo + '_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.log')
$conexion = 'host=' + $Servidor + ' port=' + $Puerto + ' user=' + $Usuario + ' dbname=' + $BaseDatos + ' sslmode=require'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Anotar([string]$linea) {
    Write-Host $linea
    [System.IO.File]::AppendAllText($log, $linea + "`r`n", $utf8)
}

Anotar ('# ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') + '  ' + $Prefijo)
Anotar ('# archivo  ' + $ruta)
Anotar ('# sha256   ' + $real + '  (igual al .sha256, confirmado ' + $conf + ')')
Anotar ('# destino  ' + $conexion)
Anotar ('# psql     ' + $psql)
Write-Host ''
Write-Host 'psql te va a pedir la contrasena de la base (Password:). Escribela y Enter; no se ve al teclear.' -ForegroundColor Yellow
Write-Host ''

$encAntes = $env:PGCLIENTENCODING
$salidaAntes = [Console]::OutputEncoding
$env:PGCLIENTENCODING = 'UTF8'
$codigo = 99
try {
    [Console]::OutputEncoding = $utf8
    $ErrorActionPreference = 'Continue'
    & $psql -X -v ON_ERROR_STOP=1 -d $conexion -f $ruta 2>&1 | ForEach-Object { Anotar ([string]$_) }
    $codigo = $LASTEXITCODE
} finally {
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = $salidaAntes
    $env:PGCLIENTENCODING = $encAntes
}

# ---------------------------------------------------------------- 3. resultado
Anotar ('# codigo de salida de psql: ' + $codigo)
Write-Host ''
if ($codigo -eq 0) {
    Write-Host ('LISTO: psql salio con 0 (COMMIT). Log: ' + $log) -ForegroundColor Green
} else {
    Write-Host ('psql salio con ' + $codigo + ': NO hubo COMMIT, nada escrito (2 = no conecto / contrasena; 3 = error o RAISE y ROLLBACK). Log: ' + $log) -ForegroundColor Red
}
exit $codigo
