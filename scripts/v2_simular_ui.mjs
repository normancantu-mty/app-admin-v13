// v2 LOCAL: simula por la INTERFAZ (Chromium headless + la app corriendo en local) las
// operaciones del dia a dia contra la base LOCAL. Escrito el 2026-10-28 por el Socio (ejecutor).
//
//   E2E_BASE_URL=http://localhost:3002 node scripts/v2_simular_ui.mjs <carpeta_capturas>
//
// Se niega a correr si la URL no es localhost/127.0.0.1. Cada paso guarda una captura y
// escribe una linea "PASO <n> OK|FALLA ...". La verificacion de cifras la hace
// scripts/v2_verificar_simulacion.sql contra la base, no este script.
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3002'
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) {
  console.error('E2E_BASE_URL no es local: no corro.'); process.exit(2)
}
const OUT = process.argv[2] || 'simulacion_ui'
fs.mkdirSync(OUT, { recursive: true })

const ADMIN = { email: 'normancantu@gmail.com', clave: 'v2-local-admin' }
const CEO = 'e0000000-0000-0000-0000-000000000001'
const AEROPUERTO = '4cbad6ad-41f6-4397-86d3-0f5ec5be21dd'
const P750 = 'c1000000-0000-0000-0000-000000000001'
const P250 = 'c1000000-0000-0000-0000-000000000003'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const dialogos = []
page.on('dialog', async (d) => { dialogos.push(d.message()); await d.accept() })

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
page.on('console', (m) => { if (/full reload/i.test(m.text())) recargasHMR.push(m.text()) })
let fallas = 0
let n = 0

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

async function elegirPorTexto(selector, texto) {
  const valor = await page.$eval(selector, (el, t) => {
    const o = [...el.options].find((op) => op.textContent.trim() === t || op.textContent.includes(t))
    return o ? o.value : null
  }, texto)
  if (!valor) throw new Error(`${selector}: no hay opcion "${texto}"`)
  await page.selectOption(selector, valor)
}

async function venta({ comprador = '', condicion = 'CONTADO', cuenta, producto, cantidad }) {
  await page.goto(`${BASE}/pos`)
  await page.waitForFunction(() => document.querySelectorAll('#vendedor option').length > 1)
  await page.selectOption('#vendedor', CEO)
  await page.waitForFunction(() => document.querySelectorAll('#producto option').length > 1)
  if (comprador) {
    await page.waitForFunction((c) => [...document.querySelectorAll('#comprador option')].some((o) => o.value === c), comprador)
    await page.selectOption('#comprador', comprador)
  }
  await page.selectOption('#condicion_pago', condicion)
  await page.waitForFunction((t) => [...document.querySelectorAll('#cuenta_destino option')].some((o) => o.textContent.trim() === t), cuenta)
  await elegirPorTexto('#cuenta_destino', cuenta)
  await page.selectOption('#producto', producto)
  await page.fill('#cantidad', String(cantidad))
  await page.click('text=+ Añadir al Carrito')
  await page.click('text=Generar Ticket')
  await page.waitForURL(/\/ticket\//, { timeout: 30000 })
}

await paso('login', async () => {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', ADMIN.email)
  await page.fill('input[type=password]', ADMIN.clave)
  await page.click('button[type=submit]')
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 })
  await precalentar(['/pos', '/ticket/00000000-0000-0000-0000-000000000000', `/dashboard/distribuidores/${AEROPUERTO}`, `/dashboard/distribuidores/${AEROPUERTO}/abono`,
    '/dashboard/finanzas', '/dashboard/finanzas/nuevo', '/dashboard/inventario', '/dashboard/inventario/compra', '/dashboard/general'])
})

await paso('venta_efectivo_2x750', () => venta({ cuenta: 'Efectivo', producto: P750, cantidad: 2 }))
await paso('venta_transferencia_3x250', () => venta({ cuenta: 'Transferencias', producto: P250, cantidad: 3 }))
await paso('venta_consignacion_aeropuerto_4x750', () =>
  venta({ comprador: AEROPUERTO, condicion: 'CONCESION', cuenta: 'Efectivo', producto: P750, cantidad: 4 }))

await paso('abono_aeropuerto_1000', async () => {
  await page.goto(`${BASE}/dashboard/distribuidores/${AEROPUERTO}/abono`)
  await page.waitForFunction(() => document.querySelectorAll('#origen option').length > 2)
  await elegirPorTexto('#origen', 'Efectivo (Aeropuerto)')
  await elegirPorTexto('#destino', 'Efectivo')
  await page.fill('#monto', '1000')
  await page.selectOption('#metodoPago', 'EFECTIVO')
  await page.click('text=Guardar Transferencia')
  await page.waitForURL((u) => !u.pathname.endsWith('/abono'), { timeout: 30000 })
})

await paso('gasto_logistica_gasolina_350.75', async () => {
  await page.goto(`${BASE}/dashboard/finanzas/nuevo`)
  await page.selectOption('#tipo_movimiento', 'GASTO_OPERATIVO')
  await page.selectOption('#categoria', 'Logística y envíos')
  await page.selectOption('#subcategoria', 'Gasolina')
  await elegirPorTexto('#cuenta_destino', 'Efectivo')
  await page.fill('#monto', '350.75')
  await page.fill('#descripcion', 'SIMULACION v2: gasolina ruta Fresnillo')
  await page.click('text=Guardar Movimiento')
  await page.waitForURL((u) => u.pathname === '/dashboard/finanzas', { timeout: 30000 })
})

await paso('compra_insumo_sorbato_2kg_300', async () => {
  await page.goto(`${BASE}/dashboard/inventario/compra`)
  await page.waitForFunction(() => document.querySelectorAll('#insumo option').length > 1)
  await elegirPorTexto('#insumo', 'Sorbato de potasio')
  await page.fill('#cantidad', '2')
  await page.fill('#costo', '300')
  await page.waitForFunction(() => document.querySelectorAll('#cuenta option').length > 0)
  await elegirPorTexto('#cuenta', 'Efectivo')
  await page.click('button:has-text("Registrar")')
  await page.waitForURL((u) => u.pathname === '/dashboard/inventario', { timeout: 30000 })
})

await paso('merma_aeropuerto_1x750', async () => {
  await page.goto(`${BASE}/dashboard/distribuidores/${AEROPUERTO}`)
  await page.click('text=Reportar Merma (Cascada)')
  await page.selectOption('select[name=id_producto]', P750)
  await page.fill('input[name=cantidad]', '1')
  await page.click('text=Confirmar merma')
  await page.waitForFunction(() => !document.querySelector('select[name=id_producto]'), null, { timeout: 30000 })
})

await paso('conversion_500', async () => {
  await page.goto(`${BASE}/dashboard/general`)
  await page.waitForSelector('[data-testid=tarjeta-transferencias]')
  await page.fill('[data-testid=transf-monto]', '500')
  await page.click('[data-testid=transf-convertir]')
  await page.waitForSelector('[data-testid=transf-mensaje]', { timeout: 30000 })
  const msg = await page.textContent('[data-testid=transf-mensaje]')
  console.log('   mensaje:', msg)
  if (!/Convertido/.test(msg)) throw new Error(msg)
  await page.waitForTimeout(1500)
})

await paso('dashboard_final', async () => {
  await page.goto(`${BASE}/dashboard/general`)
  await page.waitForSelector('[data-testid=tarjeta-transferencias]')
  for (const id of ['transf-recibido', 'transf-convertido', 'transf-pendiente']) {
    console.log(`   ${id}:`, (await page.textContent(`[data-testid=${id}]`)).trim())
  }
})

await browser.close()
console.log(`recargas completas del HMR durante la corrida: ${recargasHMR.length}`)
console.log(fallas ? `FALLAS: ${fallas}` : 'TODO OK')
process.exit(fallas ? 1 : 0)
