// v2 LOCAL: T5, flujos que la simulacion del 2026-10-28 no ejercio, por la INTERFAZ real
// (Chromium headless + la app en local). Escrito el 2026-10-29 por el Socio (ejecutor).
//
//   E2E_BASE_URL=http://localhost:3002 node scripts/v2_simular_t5.mjs <carpeta_capturas>
//
// Corre sobre la base recien cargada en modo conciliado, DESPUES del fixture
// scripts/v2_t5_fixture.sql (DST Prueba con comision_base 0.20). Cada paso escribe
// "PASO <n> OK|FALLA". Las cifras las comprueba scripts/v2_verificar_t5.sql, no este script.
//  1  ADMIN vende de contado a Al son del Mezcal (LOC de David): COMISION_PASIVA para David
//  2  ADMIN consigna 3x750 a DST Prueba (montaje para 3, 4 y 5)
//  3  ADMIN registra la devolucion fisica de 1x750 de DST Prueba: DEVOLUCION_FISICA + ABONO_DEUDA
//  4  DST Prueba (su propia sesion) vende de contado 1x750: INGRESO_COMISION + DEUDA_A_MATRIZ
//  5  ADMIN ANULA desde la ficha del distribuidor (boton Anular movimiento) la venta del paso 4: ticket y filas
//     en ANULADO, la pieza vuelve al CONSIGNADO de DST Prueba
//  6  ADMIN vende de contado al publico desde Cuenta Fresnillo (FULL_TAX): INGRESO_VENTA +
//     PASIVO_IVA + PASIVO_IEPS. Va al final para que quede en la lista de anulables del bot
//     (las 8 mas recientes), que la anula en scripts/v2_pruebas_t5_bot.py.
// Lee la service key de .env.local SOLO para encontrar el id de la fila que se anula en 5, y
// solo si SUPABASE_URL es local.
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3002'
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) {
  console.error('E2E_BASE_URL no es local: no corro.'); process.exit(2)
}
const OUT = process.argv[2] || 'simulacion_t5'
fs.mkdirSync(OUT, { recursive: true })

const ADMIN = { email: 'normancantu@gmail.com', clave: 'v2-local-admin' }
const DSTP_USR = { email: 'dst.prueba@v2.local', clave: 'v2-local-dst' }
const CEO = 'e0000000-0000-0000-0000-000000000001'
const AL_SON = '0aaf30d4-cd0c-4f24-907e-e1678e29587e'
const DSTP = 'd5000000-0000-4000-a000-000000000001'
const P750 = 'c1000000-0000-0000-0000-000000000001'
const P250 = 'c1000000-0000-0000-0000-000000000003'

const browser = await chromium.launch()
let ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
let page = await ctx.newPage()
const dialogos = []
const engancharDialogos = (p) => p.on('dialog', async (d) => { dialogos.push(d.message()); await d.accept() })
engancharDialogos(page)

// v2 (2026-10-29, Socio ejecutor): el servidor de DESARROLLO compila cada ruta la primera vez que
// se pide. Si esa primera compilacion cae en medio de un router.push, el HMR puede recargar la
// pagina de ORIGEN y el push se pierde. Medido en la ronda 3: tras "Transferencia registrada"
// el log trae GET /<id> (compile 1969ms) y enseguida GET /<id>/abono = recarga del formulario.
// En produccion no hay compilacion bajo demanda; por eso se precalientan las rutas destino.
async function precalentar(rutas) {
  for (const r of rutas) {
    await page.goto(BASE + r).catch(() => {})
    await page.waitForLoadState('networkidle').catch(() => {})
  }
}
const recargasHMR = []
let fallas = 0
let n = 0
const tickets = {}

async function paso(nombre, fn) {
  n += 1
  const antes = dialogos.length
  try {
    await fn()
    await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, '0')}_${nombre}.png`), fullPage: true })
    console.log(`PASO ${n} OK ${nombre}` + (dialogos.length > antes ? ` | dialogo: ${dialogos.slice(antes).join(' / ')}` : ''))
  } catch (e) {
    fallas += 1
    await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, '0')}_${nombre}_FALLA.png`), fullPage: true }).catch(() => {})
    console.log(`PASO ${n} FALLA ${nombre}: ${String(e?.message || e).split('\n')[0]}` +
      (dialogos.length > antes ? ` | dialogo: ${dialogos.slice(antes).join(' / ')}` : ''))
  }
}

async function login(u) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', u.email)
  await page.fill('input[type=password]', u.clave)
  await page.click('button[type=submit]')
  await page.waitForURL((x) => !x.pathname.startsWith('/login'), { timeout: 30000 })
}

async function elegirPorTexto(selector, texto) {
  const valor = await page.$eval(selector, (el, t) => {
    const o = [...el.options].find((op) => op.textContent.trim() === t || op.textContent.includes(t))
    return o ? o.value : null
  }, texto)
  if (!valor) throw new Error(`${selector}: no hay opcion "${texto}"`)
  await page.selectOption(selector, valor)
}

async function venta({ vendedor = CEO, comprador = '', condicion = 'CONTADO', cuenta, producto, cantidad }) {
  await page.goto(`${BASE}/pos`)
  await page.waitForFunction(() => document.querySelectorAll('#vendedor option').length >= 1)
  if (await page.$eval('#vendedor', (el) => !el.disabled)) await page.selectOption('#vendedor', vendedor)
  await page.waitForFunction(() => document.querySelectorAll('#producto option').length > 1)
  if (comprador) {
    await page.waitForFunction((c) => [...document.querySelectorAll('#comprador option')].some((o) => o.value === c), comprador)
    await page.selectOption('#comprador', comprador)
  }
  await page.selectOption('#condicion_pago', condicion)
  await page.waitForFunction((t) => [...document.querySelectorAll('#cuenta_destino option')].some((o) => o.textContent.trim().includes(t)), cuenta)
  await elegirPorTexto('#cuenta_destino', cuenta)
  await page.selectOption('#producto', producto)
  await page.fill('#cantidad', String(cantidad))
  await page.click('text=+ Añadir al Carrito')
  await page.click('text=Generar Ticket')
  await page.waitForURL(/\/ticket\//, { timeout: 30000 })
  return page.url().split('/ticket/')[1].split(/[?#/]/)[0]
}

const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const SB = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(SB || '')) { console.error('Supabase no local: no corro.'); process.exit(2) }
async function rest(q) {
  const r = await fetch(`${SB}/rest/v1/${q}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } })
  return r.json()
}

await paso('login_admin', async () => {
  await login(ADMIN)
  await precalentar(['/pos', '/ticket/00000000-0000-0000-0000-000000000000', `/dashboard/distribuidores/${DSTP}`, `/dashboard/distribuidores/${DSTP}/devolucion`])
})
await paso('venta_contado_al_son_2x250', async () => {
  tickets.al_son = await venta({ comprador: AL_SON, cuenta: 'Efectivo', producto: P250, cantidad: 2 })
})
await paso('consignacion_dst_prueba_3x750', async () => {
  tickets.consigna_dstp = await venta({ comprador: DSTP, condicion: 'CONCESION', cuenta: 'Efectivo', producto: P750, cantidad: 3 })
})
await paso('devolucion_fisica_dst_prueba_1x750', async () => {
  await page.goto(`${BASE}/dashboard/distribuidores/${DSTP}/devolucion`)
  await page.waitForFunction((p) => [...document.querySelectorAll('#producto option')].some((o) => o.value === p), P750)
  await page.selectOption('#producto', P750)
  await page.fill('#cantidad', '1')
  await page.click('button:has-text("Procesar Devolución")')
  await page.waitForURL((u) => !u.pathname.endsWith('/devolucion'), { timeout: 30000 })
  if (!dialogos.some((d) => d.includes('Devolución procesada'))) throw new Error('sin aviso de exito: ' + dialogos.join(' / '))
})

// Sesion del distribuidor, en un contexto nuevo (sin las cookies del ADMIN).
await ctx.close()
ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
page = await ctx.newPage()
engancharDialogos(page)
await paso('login_dst_prueba', () => login(DSTP_USR))
await paso('venta_dst_prueba_contado_1x750', async () => {
  tickets.dstp_contado = await venta({ vendedor: DSTP, cuenta: 'Efectivo (DST Prueba', producto: P750, cantidad: 1 })
})


await ctx.close()
ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
page = await ctx.newPage()
engancharDialogos(page)
await paso('login_admin_2', () => login(ADMIN))
await paso('anular_por_pantalla_venta_dst_prueba', async () => {
  // /dashboard/finanzas solo lista lo que toca cuentas del ADMIN: la venta del DST se anula
  // desde su ficha (HistorialActividadTableClient -> anularMovimientoFinanzas).
  await page.goto(`${BASE}/dashboard/distribuidores/${DSTP}`)
  const fila = page.locator('tr', { hasText: 'Ticket #' + tickets.dstp_contado.slice(0, 8).toUpperCase() }).first()
  await fila.waitFor({ timeout: 30000 })
  await fila.locator('button[aria-label="Anular movimiento"]').click()
  for (let i = 0; i < 40; i += 1) {
    const t = await rest(`transacciones_tickets?select=status&id=eq.${tickets.dstp_contado}`)
    if (t?.[0]?.status === 'ANULADO') return
    await page.waitForTimeout(500)
  }
  throw new Error('el ticket no quedo ANULADO')
})
await paso('venta_fresnillo_publico_2x750', async () => {
  tickets.fresnillo = await venta({ cuenta: 'Cuenta Fresnillo', producto: P750, cantidad: 2 })
})

await browser.close()
fs.writeFileSync(path.join(OUT, 'tickets.json'), JSON.stringify(tickets, null, 1))
console.log('tickets', JSON.stringify(tickets))
console.log(fallas ? `FALLAS: ${fallas}` : 'TODO OK')
process.exit(fallas ? 1 : 0)
