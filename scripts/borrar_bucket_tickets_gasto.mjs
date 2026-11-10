// ROLLBACK de la migracion comprobantes_gasto, paso 1: vaciar y borrar el bucket.
// Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos de tickets).
//
// Postgres no deja borrar filas de storage.objects a mano: va por la API.
// Solo toca `tickets_gasto`. El bucket `comprobantes` es de LucIA.
//
//   node scripts/borrar_bucket_tickets_gasto.mjs        # cuenta y no borra nada
//   node scripts/borrar_bucket_tickets_gasto.mjs --si   # vacia y borra el bucket
//
// Lee NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY del entorno o del .env
// de la carpeta donde se corre. Las fotos siguen en bot/comprobantes/.
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'tickets_gasto'

function delEntorno(nombre) {
  if (process.env[nombre]) return process.env[nombre]
  if (!existsSync('.env')) return undefined
  const linea = readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith(nombre + '='))
  return linea?.slice(nombre.length + 1).trim().replace(/^["']|["']$/g, '')
}

const url = delEntorno('NEXT_PUBLIC_SUPABASE_URL')
const llave = delEntorno('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !llave) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(2)
}
const supabase = createClient(url, llave, { auth: { persistSession: false } })

async function rutas() {
  const salida = []
  const carpetas = await supabase.storage.from(BUCKET).list('', { limit: 1000 })
  if (carpetas.error) throw carpetas.error
  for (const c of carpetas.data) {
    const dentro = await supabase.storage.from(BUCKET).list(c.name, { limit: 1000 })
    if (dentro.error) throw dentro.error
    for (const f of dentro.data) salida.push(c.name + '/' + f.name)
  }
  return salida
}

async function borrar(todas) {
  for (let i = 0; i < todas.length; i += 100) {
    const r = await supabase.storage.from(BUCKET).remove(todas.slice(i, i + 100))
    if (r.error) throw r.error
  }
  const quedan = await rutas()
  if (quedan.length) {
    console.error('Quedan ' + quedan.length + ' objetos: vuelve a correrlo.')
    process.exitCode = 1
    return
  }
  const borrado = await supabase.storage.deleteBucket(BUCKET)
  if (borrado.error) throw borrado.error
  console.log('Bucket borrado. Sigue: drop table if exists public.comprobantes_gasto;')
}

const todas = await rutas()
console.log(BUCKET + ': ' + todas.length + ' objetos')
if (process.argv.includes('--si')) await borrar(todas)
else console.log('No se borro nada. Con --si vacia y borra el bucket.')
