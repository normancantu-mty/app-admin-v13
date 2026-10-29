// v2 LOCAL: prueba por la INTERFAZ de la base recien cargada (modo conciliado), SOLO LECTURA.
// Escrito el 2026-10-29 por el Socio (ejecutor).
//
//   E2E_BASE_URL=http://localhost:3002 node scripts/v2_prueba_arranque_ui.mjs <conciliacion.json> [captura.json]
//
// Corre justo despues de cargar_arranque.py --consig conciliado, antes de cualquier movimiento.
// Los esperados salen de la captura (fecha de corte) y del JSON de la conciliacion, no de la base.
//  T4  tablero general: ningun "Sin actividad"/"999 dias", dias = dias de CALENDARIO en hora de
//      Mexico entre el corte y hoy (regla unica de lib/actividad.ts, ronda 2), ningun semaforo rojo.
//      Directorio: ningun "Sin contacto" y, nodo por nodo, los MISMOS dias que el tablero.
//  Renombre: la tarjeta de liquidez dice "Cuenta Gilberto" y en ningun lado "CUENTA_PERSONAL".
//  T6  /dashboard/cartera: "Total por cobrar" = suma de la deuda con acreedor Matriz; la deuda de
//      locales con su distribuidor sale aparte y no se suma.
import { chromium } from '@playwright/test'
import fs from 'node:fs'

const B = process.env.E2E_BASE_URL || 'http://localhost:3002'
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(B)) { console.error('URL no local'); process.exit(2) }
if (!process.argv[2]) { console.error('falta la ruta del JSON de conciliacion'); process.exit(2) }
const conc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const ents = conc.entidades || conc
const cap = JSON.parse(fs.readFileSync(process.argv[3] || 'scripts/arranque_datos/captura_norman.json', 'utf8'))
const corte = (cap.data || cap).corte
const diaMX = (d) => {
  const [y, m, dd] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d).split('-').map(Number)
  return Date.UTC(y, m - 1, dd) / 86400000
}
const esperadoDias = diaMX(new Date()) - diaMX(new Date(`${corte}T23:59:00-06:00`))
const mxn = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n)
let matriz = 0, conDst = 0, nDst = 0
for (const [k, d] of Object.entries(ents)) {
  if (k.startsWith('_')) continue
  const deuda = Number(d.deuda || 0)
  if ((d.acreedor || 'Matriz') === 'Matriz') matriz += deuda
  else if (deuda > 0.005) { conDst += deuda; nDst += 1 }
}

const br = await chromium.launch()
const pg = await br.newPage({ viewport: { width: 1400, height: 1000 } })
await pg.goto(B + '/login')
await pg.fill('input[type=email]', 'normancantu@gmail.com')
await pg.fill('input[type=password]', 'v2-local-admin')
await pg.click('button[type=submit]')
await pg.waitForURL((u) => !u.pathname.startsWith('/login'))

await pg.goto(B + '/dashboard/general')
await pg.waitForLoadState('networkidle')
const celdas = await pg.$$eval('table td', (tds) => tds.map((t) => t.innerText.trim()))
const hace = celdas.filter((c) => /^Hace \d+ días$/.test(c)).map((c) => Number(c.match(/\d+/)[0]))
const sin = celdas.filter((c) => c === 'Sin actividad').length
const general = await pg.innerText('body')
const filasDe = () => pg.$$eval('table tbody tr', (trs) => trs.map((tr) => {
  const n = tr.querySelector('.font-medium.text-gray-900')
  const t = tr.innerText
  const m = /Hace (\d+) días/.exec(t) || /(\d+) días/.exec(t)
  return { nombre: n ? n.textContent.trim() : '', dias: m ? Number(m[1]) : (/Sin contacto|Sin actividad/.test(t) ? 'sin' : null) }
}).filter((f) => f.nombre && f.dias !== null))
const diasTablero = new Map((await filasDe()).map((f) => [f.nombre, f.dias]))

await pg.goto(B + '/dashboard/distribuidores')
await pg.waitForLoadState('networkidle')
const filasDir = await filasDe()
const sinContacto = filasDir.filter((f) => f.dias === 'sin').map((f) => f.nombre)
const comunes = filasDir.filter((f) => diasTablero.has(f.nombre))
const distintos = comunes.filter((f) => diasTablero.get(f.nombre) !== f.dias).map((f) => `${f.nombre}: tablero ${diasTablero.get(f.nombre)} / directorio ${f.dias}`)

await pg.goto(B + '/dashboard/cartera')
await pg.waitForLoadState('networkidle')
const cartera = await pg.innerText('body')
const total = await pg.locator('p', { hasText: /^Total por cobrar$/i }).locator('xpath=following-sibling::p[1]')
  .innerText().then((t) => t.trim()).catch(() => '')
const aparte = await pg.locator('[data-prueba="deuda-con-distribuidor"]').innerText().catch(() => '')
await br.close()

let fallas = 0
const fila = (p, e, o) => {
  const ok = String(e) === String(o); if (!ok) fallas += 1
  console.log(`${p} | esperado ${e} | obtenido ${o} | ${ok ? 'OK' : 'FALLA'}`)
}
console.log(`corte ${corte} 23:59 -06; ahora ${new Date().toISOString()}`)
fila('T4 renglones con "Sin actividad"', 0, sin)
fila('T4 renglones con "Hace N dias" (>0)', true, hace.length > 0)
// Solo los nodos de la conciliacion: su unica actividad es el corte. Los usuarios de prueba
// (seed 60, p. ej. DST Prueba) nacen con seguimiento = ahora y dan 0, que es correcto.
const normN = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const deConc = new Set(Object.keys(ents).filter((k) => !k.startsWith('_')).map(normN))
const diasConc = [...diasTablero].filter(([n]) => deConc.has(normN(n)))
fila('T4 nodos de la conciliacion en el tablero (>5)', true, diasConc.length > 5)
fila('T4 dias de los nodos de la conciliacion = dias desde el corte', esperadoDias,
  [...new Set(diasConc.map(([, d]) => d))].join(',') + (diasConc.some(([, d]) => d !== esperadoDias) ? ' (' + diasConc.filter(([, d]) => d !== esperadoDias).map(([n, d]) => n + '=' + d).join(', ') + ')' : ''))
fila('T4 bloque "Semaforos Rojos"', 0, (general.match(/Semáforos Rojos/g) || []).length)
fila('T4 textos "999 dias sin actividad"', 0, (general.match(/999 días sin actividad/g) || []).length)
fila('T4 directorio: renglones "Sin contacto"', 0, sinContacto.length + (sinContacto.length ? ' (' + sinContacto.join(', ') + ')' : ''))
fila('T4 nodos comparados tablero vs directorio (>5)', true, comunes.length > 5)
fila('T4 tablero y directorio: mismos dias, nodo por nodo', 0, distintos.length + (distintos.length ? ' (' + distintos.join('; ') + ')' : ''))
fila('Renombre: tarjeta "Cuenta: Cuenta Gilberto"', true, general.includes('Cuenta: Cuenta Gilberto'))
fila('Renombre: textos "CUENTA_PERSONAL" o "Cuenta personal" en el tablero', 0, (general.match(/CUENTA_PERSONAL|Cuenta personal/gi) || []).length)
fila('T6 Cartera "Total por cobrar" = deuda con acreedor Matriz', mxn(matriz), total)
fila('T6 aparte: deuda de locales con su distribuidor', true,
  aparte.includes(mxn(conDst)) && aparte.includes(`${nDst} locales`))
console.log(`T6 linea aparte: ${aparte.replace(/\s+/g, ' ')}`)
console.log(fallas ? `FALLAS: ${fallas}` : 'TODO OK')
process.exit(fallas ? 1 : 0)
