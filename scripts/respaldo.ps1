#Requires -Version 5.1
# ---------------------------------------------------------------------------
# respaldo.ps1 - volcado completo de la base de Supabase del ERP.
#
# Deja dos archivos con fecha en supabase/_respaldos/ :
#   AAAA-MM-DD_schema.sql  esquema + RLS + politicas + funciones + vistas
#   AAAA-MM-DD_datos.sql   datos de toda la base (se comprueban las 9 tablas de
#                          negocio + la bitacora del bot) + el esquema auth
#
# NO lleva contrasenas. El CLI de Supabase se autentica con la sesion que dejo
# "supabase login" (token en %USERPROFILE%\.supabase). Si algun dia pide la
# contrasena de la base, la toma de la variable de entorno SUPABASE_DB_PASSWORD
# - nunca de un archivo del repo.
#
# Necesita Docker corriendo: el CLI hace el volcado con una imagen de Postgres
# que coincide con la version del servidor (17.x). El pg_dump 16 de la maquina
# NO sirve: pg_dump se niega a volcar un servidor mas nuevo que el.
#
# Uso:  npm run respaldo
#       powershell -NoProfile -ExecutionPolicy Bypass -File scripts\respaldo.ps1
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [string]$Destino,
    [int]$Conservar = 12
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
if (-not $Destino) { $Destino = Join-Path $raiz 'supabase\_respaldos' }
if (-not (Test-Path $Destino)) { New-Item -ItemType Directory -Path $Destino -Force | Out-Null }

$fecha    = Get-Date -Format 'yyyy-MM-dd'
$fSchema  = Join-Path $Destino ($fecha + '_schema.sql')
$fDatos   = Join-Path $Destino ($fecha + '_datos.sql')
$bitacora = Join-Path $Destino 'respaldo.log'

function Escribir([string]$texto, [string]$color = 'Gray') {
    $sello = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-Host $texto -ForegroundColor $color
    Add-Content -Path $bitacora -Value "$sello  $texto" -Encoding UTF8
}

# Las 9 tablas de negocio. Si el volcado no las trae todas, no es un respaldo.
$tablas = @(
    'entidades', 'cuentas_financieras', 'finanzas_ledger', 'inventario_ledger',
    'transacciones_tickets', 'ticket_detalles', 'catalogo_productos',
    'listas_precios', 'recetas_produccion'
)
# Cazador F0 (2026-10-17): la bitacora del bot (todo lo dicho, solo-agregar).
# Se exige que el esquema la defina; sus FILAS no, porque recien desplegada
# puede estar vacia y eso no es un respaldo malo.
$tablasSinFilasObligatorias = @('bitacora')
# 2026-10-17: el volcado real del 2026-10-11 trae 93 (el 49 de antes llevaba
# semanas dando FALLA en respaldo.log) + 1 de la bitacora (bitacora_sel_admin).
$politicasEsperadas = 94

# --- como se invoca el CLI --------------------------------------------------
# Ojo: desde PowerShell, "npx" resuelve al shim npx.ps1 y falla con
# "could not determine executable to run". Hay que llamar a npx.cmd.
$cli = $null
if (Get-Command supabase -ErrorAction SilentlyContinue) {
    $cli = @('supabase')
} elseif (Get-Command npx.cmd -ErrorAction SilentlyContinue) {
    $cli = @('npx.cmd', '--yes', 'supabase')
} else {
    Escribir 'FALLA  no encuentro ni "supabase" ni "npx.cmd" en el PATH' 'Red'
    exit 1
}

function Volcar([string[]]$argumentos) {
    $exe = $cli[0]
    $todos = @()
    if ($cli.Count -gt 1) { $todos += $cli[1..($cli.Count - 1)] }
    $todos += $argumentos
    & $exe @todos
    return $LASTEXITCODE
}

$fallas = @()

try {
    Escribir "=== respaldo $fecha : inicio ===" 'Cyan'

    Push-Location $raiz
    try {
        Escribir 'Volcando esquema (tablas, RLS, politicas, funciones, vistas)...'
        $codigo = Volcar @('db', 'dump', '--linked', '--file', $fSchema)
        if ($codigo -ne 0) { throw "el volcado de esquema fallo (codigo $codigo)" }

        Escribir 'Volcando datos...'
        $codigo = Volcar @('db', 'dump', '--linked', '--data-only', '--file', $fDatos)
        if ($codigo -ne 0) { throw "el volcado de datos fallo (codigo $codigo)" }
    }
    finally { Pop-Location }

    # ---- comprobacion: un respaldo que nadie revisa no es un respaldo ------
    foreach ($f in @($fSchema, $fDatos)) {
        if (-not (Test-Path $f)) { $fallas += "falta el archivo $f"; continue }
        if ((Get-Item $f).Length -lt 1024) { $fallas += "$(Split-Path -Leaf $f) quedo vacio o truncado" }
    }

    if ($fallas.Count -eq 0) {
        $schema = Get-Content $fSchema -Raw
        $datos  = Get-Content $fDatos  -Raw

        $nPol = ([regex]::Matches($schema, 'CREATE POLICY')).Count
        if ($nPol -ne $politicasEsperadas) {
            $fallas += "el esquema trae $nPol politicas RLS y se esperaban $politicasEsperadas"
        } else {
            Escribir "OK  $nPol politicas RLS en el esquema" 'Green'
        }

        foreach ($t in $tablas) {
            if ($schema -notmatch [regex]::Escape('"public"."' + $t + '"')) {
                $fallas += "el esquema no define la tabla $t"
            }
            if ($datos -notmatch [regex]::Escape('INSERT INTO "public"."' + $t + '"')) {
                $fallas += "los datos no traen filas de la tabla $t"
            }
        }
        foreach ($t in $tablasSinFilasObligatorias) {
            if ($schema -notmatch [regex]::Escape('"public"."' + $t + '"')) {
                $fallas += "el esquema no define la tabla $t"
            } elseif ($datos -notmatch [regex]::Escape('INSERT INTO "public"."' + $t + '"')) {
                Escribir "AVISO  la tabla $t esta en el esquema pero sin filas en los datos" 'Yellow'
            }
        }
        if ($fallas.Count -eq 0) {
            Escribir "OK  las $($tablas.Count) tablas de negocio y la bitacora estan en el respaldo" 'Green'
        }

        $kbS = [math]::Round((Get-Item $fSchema).Length / 1KB, 1)
        $kbD = [math]::Round((Get-Item $fDatos).Length / 1KB, 1)
        Escribir "esquema: $kbS KB   datos: $kbD KB" 'Green'
    }

    # ---- retencion: se conservan los ultimos $Conservar pares --------------
    $pares = @(Get-ChildItem $Destino -Filter '*_schema.sql' | Sort-Object Name -Descending)
    if ($pares.Count -gt $Conservar) {
        foreach ($viejo in ($pares | Select-Object -Skip $Conservar)) {
            $base = $viejo.Name -replace '_schema\.sql$', ''
            Remove-Item (Join-Path $Destino ($base + '_schema.sql')) -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $Destino ($base + '_datos.sql'))  -ErrorAction SilentlyContinue
            Escribir "purgado el respaldo viejo de $base"
        }
    }
}
catch {
    # Sin este catch, un "throw" bajo -File sale con codigo 0 y la tarea
    # programada reporta exito con la base sin respaldar.
    Escribir "FALLA  $($_.Exception.Message)" 'Red'
    Escribir '=== respaldo FALLIDO ===' 'Red'
    exit 1
}

if ($fallas.Count -gt 0) {
    foreach ($x in $fallas) { Escribir "FALLA  $x" 'Red' }
    Escribir '=== respaldo INCOMPLETO: revisalo antes de confiar en el ===' 'Red'
    exit 1
}

Escribir "=== respaldo $fecha : listo en $Destino ===" 'Green'
exit 0
