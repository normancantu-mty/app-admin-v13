// v2 LOCAL, ronda 2 (auditoria): el precio que se ABONA en una devolucion es el precio con
// que NACIO la deuda, incluida la del arranque. Escrito el 2026-10-29 por el Socio (ejecutor).
//
//   E2E_BASE_URL=http://localhost:3002 node scripts/v2_prueba_devolucion_precio.mjs <conciliacion.json>
//
// Corre sobre la carga conciliada. El ESPERADO sale de `precio_neto` de la conciliacion (el
// precio al que el analista valuo la deuda de arranque), no del codigo.
//  1  la vista previa de /dashboard/distribuidores/<id>/devolucion, por presentacion, para:
//     Al son del Mezcal (LOC de David, sin ticket), Nuevo Ideal (LOC de Gilberto, sin ticket)
//     y Aeropuerto (LOC de la matriz)
//  2  una devolucion REAL de 1x750 de Al son: el ABONO_DEUDA escrito = precio_neto 750 y su
//     deuda en v_cartera baja exactamente eso
// Lee la service key de .env.local solo para leer filas, y solo si SUPABASE_URL es local.
import { chromium } from '@playwright/test'
import fs from 'node:fs'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3002'
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) { console.error('E2E_BASE_URL no es local: no corro.'); process.exit(2) }
const CONC = process.argv[2]
if (!CONC || !fs.existsSync(CONC)) { console.error('Falta la ruta de la conciliacion.'); process.exit(2) }
const conc = JSON.parse(fs.readFileSync(CONC, 'utf8')).entidades

const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const SB = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(SB || '')) { console.error('Supabase no local: no corro.'); process.exit(2) }
async function rest(q) {
  const r = await fetch(`${SB}/rest/v1/${q}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } })
  return r.json()
}

const PRES = { '750': 'c1000000-0000-0000-0000-000000000001', '250': 'c1000000-0000-0000-0000-000000000003', '50': 'c1000000-0000-0000-0000-000000000004' }
const CASOS = ['Al son del Mezcal', 'Nuevo Ideal', 'Aeropuerto']
const pesos = (t) => Number(String(t).replace(/[^0-9.]/g, ''))

let fallas = 0
function check(nombre, esperado, obtenido) {
  const ok = Math.abs(Number(esperado) - Number(obtenido)) < 0.005
  if (!ok) fallas += 1
  console.log(`${ok ? 'OK   ' : 'FALLA'} | ${nombre} | esperado ${esperado} | obtenido ${obtenido}`)
}

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage()
const dialogos = []
page.on('dialog', async (d) => { dialogos.push(d.message()); await d.accept() })
await page.goto(`${BASE}/login`)
await page.fill('input[type=email]', 'normancantu@gmail.com')
await page.fill('input[type=password]', 'v2-local-admin')
await page.click('button[type=submit]')
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 })

const ids = {}
for (const nombre of CASOS) {
  const e = await rest(`entidades?select=id&nombre=eq.${encodeURIComponent(nombre)}`)
  ids[nombre] = e?.[0]?.id
  if (!ids[nombre]) { check(`${nombre}: existe`, 1, 0); continue }
  await page.goto(`${BASE}/dashboard/distribuidores/${ids[nombre]}/devolucion`)
  await page.waitForFunction((p) => [...document.querySelectorAll('#producto option')].some((o) => o.value === p), PRES['750'], { timeout: 30000 })
  for (const [k, idp] of Object.entries(PRES)) {
    const texto = await page.$eval(`#producto option[value="${idp}"]`, (o) => o.textContent).catch(() => '')
    const m = /\(([^()]*)\)\s*$/.exec(texto || '')
    check(`${nombre} ${k} ml: precio de abono (vista previa)`, conc[nombre].precio_neto[k], m ? pesos(m[1]) : NaN)
  }
}

// 2. Devolucion real 1x750 de Al son
const AL = ids['Al son del Mezcal']
const deudaAntes = Number((await rest(`v_cartera?select=deuda&id_entidad=eq.${AL}`))?.[0]?.deuda)
const desde = new Date().toISOString()
await page.goto(`${BASE}/dashboard/distribuidores/${AL}/devolucion`)
await page.waitForFunction((p) => [...document.querySelectorAll('#producto option')].some((o) => o.value === p), PRES['750'])
await page.selectOption('#producto', PRES['750'])
await page.fill('#cantidad', '1')
await page.click('button:has-text("Procesar Devolución")')
await page.waitForURL((u) => !u.pathname.endsWith('/devolucion'), { timeout: 30000 }).catch(() => {})
let abono = null
for (let i = 0; i < 40 && !abono; i += 1) {
  const f = await rest(`finanzas_ledger?select=monto&tipo_movimiento=eq.ABONO_DEUDA&id_entidad_relacionada=eq.${AL}&status=neq.ANULADO&fecha_movimiento=gte.${encodeURIComponent(desde)}`)
  if (Array.isArray(f) && f.length) abono = f
  else await page.waitForTimeout(500)
}
check('Al son: filas ABONO_DEUDA nuevas', 1, abono ? abono.length : 0)
check('Al son: ABONO_DEUDA de la devolucion 1x750', conc['Al son del Mezcal'].precio_neto['750'], abono ? Number(abono[0].monto) : NaN)
const deudaDespues = Number((await rest(`v_cartera?select=deuda&id_entidad=eq.${AL}`))?.[0]?.deuda)
check('Al son: v_cartera.deuda baja lo abonado', (deudaAntes - conc['Al son del Mezcal'].precio_neto['750']).toFixed(2), deudaDespues.toFixed(2))
console.log('dialogos:', dialogos.join(' / '))

await browser.close()
console.log(fallas ? `FALLAS: ${fallas}` : 'TODO OK')
process.exit(fallas ? 1 : 0)
