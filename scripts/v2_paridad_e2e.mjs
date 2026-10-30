// Paridad v2 — E2E de las funciones de /panel (panel unico con modales) como ADMIN, DST, LOC
// y SOCIO, comprobando el EFECTO EN LA BASE. Escrito el 2026-10-29 por el ejecutor del Socio.
//
//   E2E_BASE_URL=http://localhost:3122 SUPABASE_URL=http://127.0.0.1:56321 \
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/v2_paridad_e2e.mjs <carpeta_capturas>
//
// ESCRIBE en la base: corre SOLO contra una copia desechable. Se niega si la app no es
// localhost o si la base es la local de Norman (puerto 55321). Necesita en esa copia los
// usuarios de prueba ADMIN, DST, LOC y SOCIO (ver docs/V2_LOCAL.md, «Paridad v2»).
// Cada paso imprime "PASO <n> OK|FALLA <nombre>" y, si verifica la base, que encontro.
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const RUTA_BASE = '/panel'
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3122'
const SB = process.env.SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) { console.error('E2E_BASE_URL no es local: no corro.'); process.exit(2) }
if (!SB || !KEY || /:55321\b/.test(SB) || !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(SB)) {
  console.error('SUPABASE_URL debe ser una COPIA local (no 55321) con su service role: no corro.'); process.exit(2)
}
const OUT = process.argv[2] || 'paridad_e2e'
fs.mkdirSync(OUT, { recursive: true })

const U = {
  ADMIN: { email: 'normancantu@gmail.com', clave: 'v2-local-admin' },
  DST: { email: 'dst.prueba@v2.local', clave: 'v2-local-dst' },
  LOC: { email: 'loc.prueba@v2.local', clave: 'v2-local-loc' },
  SOCIO: { email: 'socio.prueba@v2.local', clave: 'v2-local-socio' }
}
const CEO = 'e0000000-0000-0000-0000-000000000001'
const DST_ID = 'd5000000-0000-4000-a000-000000000001'
const AEROPUERTO = '4cbad6ad-41f6-4397-86d3-0f5ec5be21dd'
const P750 = 'c1000000-0000-0000-0000-000000000001'
const P50 = 'c1000000-0000-0000-0000-000000000004'
const P250 = 'c1000000-0000-0000-0000-000000000003'
const RUN = String(Date.now()).slice(-6)
const T0 = new Date(Date.now() - 5000).toISOString()

// ── Base (service role, solo lectura de verificacion) ───────────────────────
async function q(tabla, filtro) {
  const r = await fetch(`${SB}/rest/v1/${tabla}?${filtro}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  if (!r.ok) throw new Error(`${tabla}: HTTP ${r.status} ${await r.text()}`)
  return r.json()
}
const desde = `fecha_movimiento=gte.${encodeURIComponent(T0)}`
function exigir(cond, msg) { if (!cond) throw new Error(msg) }

// ── Navegador ───────────────────────────────────────────────────────────────
const browser = await chromium.launch()
let ctx, page, rol
const dialogos = []
const errores = []
let fallas = 0
let n = 0
const resultados = []

async function entrar(quien) {
  if (ctx) await ctx.close()
  rol = quien
  ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  page = await ctx.newPage()
  page.on('dialog', async (d) => { dialogos.push(`${d.type()}: ${d.message()}`); await d.accept() })
  page.on('pageerror', (e) => errores.push(`[${rol}] pageerror ${e}`))
  page.on('console', (m) => { if (m.type() === 'error') errores.push(`[${rol}] console ${m.text().slice(0, 240)}`) })
  page.on('response', (r) => { if (r.status() >= 500) errores.push(`[${rol}] HTTP ${r.status()} ${r.url()}`) })
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', U[quien].email)
  await page.fill('input[type=password]', U[quien].clave)
  await page.click('button[type=submit]')
  await page.waitForURL((u) => u.pathname === RUTA_BASE, { timeout: 60000 })
  await page.waitForSelector('.panel', { timeout: 60000 })
}

async function paso(nombre, fn) {
  n += 1
  const antes = dialogos.length
  const t = Date.now()
  try {
    const nota = await fn()
    await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, '0')}_${rol}_${nombre}.png`) })
    const d = dialogos.length > antes ? ` | dialogo: ${dialogos.slice(antes).join(' / ')}` : ''
    console.log(`PASO ${n} OK [${rol}] ${nombre} (${Date.now() - t} ms)${nota ? ' | ' + nota : ''}${d}`)
    resultados.push({ n, rol, nombre, ok: true, nota: nota || '' })
  } catch (e) {
    fallas += 1
    await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, '0')}_${rol}_${nombre}_FALLA.png`) }).catch(() => {})
    const d = dialogos.length > antes ? ` | dialogo: ${dialogos.slice(antes).join(' / ')}` : ''
    console.log(`PASO ${n} FALLA [${rol}] ${nombre}: ${String(e?.message || e).split('\n')[0]}${d}`)
    resultados.push({ n, rol, nombre, ok: false, nota: String(e?.message || e).split('\n')[0] })
    // Vuelve a un estado limpio para el siguiente paso.
    await page.goto(`${BASE}${RUTA_BASE}`).catch(() => {})
    await page.waitForSelector('.panel', { timeout: 60000 }).catch(() => {})
  }
}

const modal = () => page.locator('[data-modal-v2]').last()
async function abrir(href) {
  await page.locator(`a[href="${href}"]`).first().click()
  await page.waitForURL((u) => u.pathname + u.search === href || u.pathname === href.split('?')[0], { timeout: 60000 })
  await modal().waitFor({ timeout: 60000 })
}
async function cerrarTodo() {
  for (let i = 0; i < 5 && (await page.locator('[data-modal-v2]').count()) > 0; i++) {
    await modal().locator('.m-cerrar').click()
    await page.waitForTimeout(400)
  }
  await page.waitForURL((u) => u.pathname === RUTA_BASE, { timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('[data-modal-v2]'), null, { timeout: 30000 })
}
async function elegirPorTexto(sel, texto) {
  const loc = page.locator(sel).first()
  await page.waitForFunction(({ s, t }) => [...(document.querySelector(s)?.options ?? [])].some((o) => o.textContent.includes(t)), { s: sel, t: texto }, { timeout: 30000 })
  const valor = await loc.evaluate((el, t) => [...el.options].find((o) => o.textContent.trim() === t || o.textContent.includes(t))?.value ?? null, texto)
  if (valor === null) throw new Error(`${sel}: no hay opcion "${texto}"`)
  await loc.selectOption(valor)
}
async function venta({ vendedor, comprador = '', condicion = 'CONTADO', cuenta, producto, cantidad }) {
  await abrir(rol === 'ADMIN' ? `${RUTA_BASE}/m/venta` : `${RUTA_BASE}/m/venta?vendedor=${vendedor}`)
  if (rol === 'ADMIN') {
    await page.waitForFunction(() => document.querySelectorAll('#vendedor option').length > 1, null, { timeout: 30000 })
    await page.selectOption('#vendedor', vendedor)
  }
  await page.waitForFunction(() => document.querySelectorAll('#producto option').length > 1, null, { timeout: 30000 })
  if (comprador) {
    await page.waitForFunction((c) => [...document.querySelectorAll('#comprador option')].some((o) => o.value === c), comprador, { timeout: 30000 })
    await page.selectOption('#comprador', comprador)
  }
  await page.selectOption('#condicion_pago', condicion)
  if (cuenta) await elegirPorTexto('#cuenta_destino', cuenta)
  await page.selectOption('#producto', producto)
  await page.fill('#cantidad', String(cantidad))
  await page.click('text=+ Añadir al Carrito')
  await page.click('text=Generar Ticket')
  await page.waitForURL(new RegExp(`${RUTA_BASE}/m/ticket/`), { timeout: 60000 })
  await modal().locator('text=Imprimir').waitFor({ timeout: 60000 })
  const id = new URL(page.url()).pathname.split('/').pop()
  const [t] = await q('transacciones_tickets', `id=eq.${id}&select=id,id_vendedor,id_comprador,condicion_pago,status,total_cobrado_real`)
  exigir(t && t.status === 'ACTIVO' && t.id_vendedor === vendedor, `ticket ${id} no quedo ACTIVO del vendedor: ${JSON.stringify(t)}`)
  if (comprador) exigir(t.id_comprador === comprador, `comprador distinto: ${t.id_comprador}`)
  exigir(t.condicion_pago === condicion, `condicion distinta: ${t.condicion_pago}`)
  return { id, nota: `ticket ${id.slice(0, 8)} ${condicion} total ${t.total_cobrado_real}` }
}
async function fichaDesdeCartera(id) {
  await abrir(`${RUTA_BASE}/m/cartera`)
  await modal().locator(`a[href="${RUTA_BASE}/m/nodo/${id}"]`).first().click()
  await page.waitForURL((u) => u.pathname === `${RUTA_BASE}/m/nodo/${id}`, { timeout: 60000 })
  await page.locator('[data-testid=ficha-nodo]').waitFor({ timeout: 60000 })
}

// ════════════════════════════════════════════════════════════════════════════
await entrar('ADMIN')

await paso('gasto', async () => {
  await abrir(`${RUTA_BASE}/m/gasto`)
  exigir((await page.inputValue('#tipo_movimiento')) === 'GASTO_OPERATIVO', 'el gasto no abre en Egreso')
  await page.waitForFunction(() => document.querySelectorAll('#subcategoria option').length > 1)
  const sub = await page.locator('#subcategoria option').nth(1).getAttribute('value')
  await page.selectOption('#subcategoria', sub)
  await elegirPorTexto('#cuenta_destino', 'Efectivo')
  await page.fill('#monto', '123.45')
  await page.fill('#descripcion', `E2E gasto ${RUN}`)
  await page.click('text=Guardar Movimiento')
  await page.waitForURL((u) => u.pathname === RUTA_BASE, { timeout: 60000 })
  const f = await q('finanzas_ledger', `categoria_gasto=eq.${encodeURIComponent(`E2E gasto ${RUN}`)}&select=id,monto,status,tipo_movimiento,subcategoria`)
  exigir(f.length === 1 && Number(f[0].monto) === 123.45 && f[0].status === 'ACTIVO', `base: ${JSON.stringify(f)}`)
  return `finanzas_ledger 1 fila ${f[0].tipo_movimiento} ${f[0].monto} ${f[0].subcategoria}`
})

await paso('compra_insumos', async () => {
  await abrir(`${RUTA_BASE}/m/compra`)
  await page.waitForFunction(() => document.querySelectorAll('#insumo option').length > 1)
  const insumo = await page.locator('#insumo option').nth(1).getAttribute('value')
  await page.selectOption('#insumo', insumo)
  await page.fill('#cantidad', '3')
  await page.fill('#costo', '271.5')
  await page.waitForFunction(() => document.querySelectorAll('#cuenta option').length > 1)
  await elegirPorTexto('#cuenta', 'Efectivo')
  await page.click('button:has-text("Registrar Compra")')
  await page.waitForURL((u) => u.pathname === `${RUTA_BASE}/m/inventario`, { timeout: 60000 })
  await modal().waitFor()
  const inv = await q('inventario_ledger', `${desde}&id_producto=eq.${insumo}&cantidad=eq.3&select=id,tipo_movimiento,status`)
  const fin = await q('finanzas_ledger', `${desde}&monto=eq.271.5&select=id,status`)
  exigir(inv.length >= 1 && fin.length >= 1, `base: inv ${inv.length} fin ${fin.length}`)
  await cerrarTodo()
  return `inventario ${inv[0].tipo_movimiento} + finanzas 271.5; tras guardar abre Inventario`
})

let idEnvasado = null
await paso('envasado', async () => {
  await abrir(`${RUTA_BASE}/m/envasado`)
  await page.waitForFunction(() => document.querySelectorAll('#producto option').length > 1)
  await page.selectOption('#producto', P750)
  await page.fill('#cantidad', '11')
  await page.click('button:has-text("Registrar Producción")')
  await page.waitForFunction(() => (document.querySelector('#cantidad')?.value ?? 'x') === '', null, { timeout: 60000 })
  const inv = await q('inventario_ledger', `${desde}&id_producto=eq.${P750}&cantidad=eq.11&tipo_movimiento=eq.PRODUCCION&select=id,status`)
  exigir(inv.length === 1 && inv[0].status === 'ACTIVO', `base: ${JSON.stringify(inv)}`)
  idEnvasado = inv[0].id
  await cerrarTodo()
  return `inventario_ledger PRODUCCION 11 x 750 (${idEnvasado.slice(0, 8)})`
})

await paso('anular_inventario', async () => {
  exigir(idEnvasado, 'sin envasado previo')
  await abrir(`${RUTA_BASE}/m/inventario`)
  const fila = modal().locator('table tbody tr').filter({ hasText: 'Destilado Plata 750ml' }).filter({ hasText: 'PRODUCCION' }).first()
  await fila.locator('button:has-text("Anular")').click()
  await page.waitForFunction(async () => true)
  for (let i = 0; i < 30; i++) {
    const [r] = await q('inventario_ledger', `id=eq.${idEnvasado}&select=status`)
    if (r.status === 'ANULADO') { await cerrarTodo(); return 'PRODUCCION -> ANULADO (no se borro)' }
    await page.waitForTimeout(500)
  }
  throw new Error('el movimiento no quedo ANULADO')
})

await paso('venta_concesion_a_dst', async () => {
  const r = await venta({ vendedor: CEO, comprador: DST_ID, condicion: 'CONCESION', cuenta: 'Efectivo', producto: P750, cantidad: 5 })
  await cerrarTodo()
  return r.nota + '; ticket en modal con Imprimir'
})

await paso('abono_sin_solo_egresos', async () => {
  await fichaDesdeCartera(AEROPUERTO)
  await page.click('[data-testid=ficha-abono]')
  await page.waitForURL((u) => u.pathname.endsWith('/abono'), { timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('#destino option').length > 1, null, { timeout: 60000 })
  const destinos = await page.locator('#destino option').allTextContents()
  exigir(!destinos.some((t) => /Gilberto/i.test(t)), `el destino ofrece una cuenta solo_egresos: ${destinos.join(' | ')}`)
  await page.waitForFunction(() => document.querySelectorAll('#origen option').length > 1)
  await elegirPorTexto('#origen', 'Aeropuerto')
  await elegirPorTexto('#destino', 'Efectivo')
  await page.fill('#monto', '217')
  await page.selectOption('#metodoPago', 'EFECTIVO')
  await page.click('text=Guardar Transferencia')
  await page.waitForURL((u) => u.pathname === `${RUTA_BASE}/m/nodo/${AEROPUERTO}`, { timeout: 60000 })
  const f = await q('finanzas_ledger', `${desde}&monto=eq.217&select=id,status,categoria`)
  exigir(f.length === 1 && f[0].status === 'ACTIVO', `base: ${JSON.stringify(f)}`)
  await cerrarTodo()
  return `destinos: ${destinos.filter(Boolean).join(' / ')}; finanzas 217 ${f[0].categoria}; vuelve a la ficha`
})

await paso('cobranza_corte_concesion', async () => {
  await fichaDesdeCartera(AEROPUERTO)
  await page.click('[data-testid=ficha-cobranza]')
  await page.waitForURL((u) => u.pathname.endsWith('/cobranza'), { timeout: 60000 })
  const filas = modal().locator('.hidden.md\\:block table tbody tr, table tbody tr').filter({ has: page.locator('input[type=number]') })
  const k = await filas.count()
  exigir(k > 0, 'sin renglones de stock')
  for (let i = 0; i < k; i++) {
    const tr = filas.nth(i)
    if (!(await tr.isVisible())) continue
    const txt = await tr.innerText()
    const esperado = Number((await tr.locator('td').nth(1).innerText()).trim())
    await tr.locator('input[type=number]').fill(String(/750ml/.test(txt) ? esperado - 1 : esperado))
  }
  await page.click('button:has-text("Procesar Cobranza")')
  await page.waitForURL(new RegExp(`${RUTA_BASE}/m/ticket/`), { timeout: 60000 })
  const id = new URL(page.url()).pathname.split('/').pop()
  const [t] = await q('transacciones_tickets', `id=eq.${id}&select=id,status,id_comprador,id_vendedor,total_cobrado_real`)
  exigir(t && t.status === 'ACTIVO', `ticket de cobranza: ${JSON.stringify(t)}`)
  await cerrarTodo()
  return `ticket de corte ${id.slice(0, 8)} total ${t.total_cobrado_real} (1 x 750 vendida)`
})

await paso('conteo_en_ficha', async () => {
  const antes = await q('conteos_fisicos', `id_entidad=eq.${AEROPUERTO}&select=id`)
  await fichaDesdeCartera(AEROPUERTO)
  await modal().locator('[data-testid=ficha-conteo]').click()
  await page.waitForURL((u) => u.pathname.endsWith('/conteo'), { timeout: 60000 })
  const inp = modal().locator('table input[type=number]').first()
  await inp.waitFor({ timeout: 60000 })
  await inp.fill('8')
  await page.click('button:has-text("Guardar conteo")')
  for (let i = 0; i < 30; i++) {
    const ahora = await q('conteos_fisicos', `id_entidad=eq.${AEROPUERTO}&select=id`)
    if (ahora.length === antes.length + 1) { await cerrarTodo(); return `conteos_fisicos ${antes.length} -> ${ahora.length}` }
    await page.waitForTimeout(500)
  }
  throw new Error('no aparecio el conteo en la base')
})

await paso('devolucion', async () => {
  await fichaDesdeCartera(AEROPUERTO)
  await page.click('[data-testid=ficha-devolucion]')
  await page.waitForURL((u) => u.pathname.endsWith('/devolucion'), { timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('#producto option').length > 1, null, { timeout: 60000 })
  await page.selectOption('#producto', P50)
  await page.fill('#cantidad', '1')
  await page.click('button:has-text("Procesar Devolución")')
  await page.waitForURL((u) => u.pathname === `${RUTA_BASE}/m/nodo/${AEROPUERTO}`, { timeout: 60000 })
  const inv = await q('inventario_ledger', `${desde}&id_producto=eq.${P50}&select=id,tipo_movimiento,status`)
  exigir(inv.some((r) => /DEVOLUCION/.test(r.tipo_movimiento)), `base: ${JSON.stringify(inv)}`)
  await cerrarTodo()
  return `inventario ${inv.map((r) => r.tipo_movimiento).join(',')}`
})

await paso('merma', async () => {
  await fichaDesdeCartera(AEROPUERTO)
  await page.click('text=Reportar Merma (Cascada)')
  await page.selectOption('select[name=id_producto]', P250)
  await page.fill('input[name=cantidad]', '1')
  await page.click('text=Confirmar merma')
  await page.waitForFunction(() => !document.querySelector('select[name=id_producto]'), null, { timeout: 60000 })
  const inv = await q('inventario_ledger', `${desde}&id_producto=eq.${P250}&tipo_movimiento=eq.MERMA&select=id`)
  exigir(inv.length >= 1, 'sin MERMA en la base')
  await cerrarTodo()
  return `inventario MERMA ${inv.length}`
})

await paso('anular_finanzas_desde_cuenta', async () => {
  const [g] = await q('finanzas_ledger', `categoria_gasto=eq.${encodeURIComponent(`E2E gasto ${RUN}`)}&select=id`)
  exigir(g, 'no hay gasto previo')
  await abrir(`${RUTA_BASE}/m/cuenta/efectivo`)
  const fila = modal().locator('tr').filter({ hasText: '123.45' }).first()
  await fila.locator('button:has-text("Anular")').click()
  for (let i = 0; i < 30; i++) {
    const [r] = await q('finanzas_ledger', `id=eq.${g.id}&select=status`)
    if (r.status === 'ANULADO') { await cerrarTodo(); return 'gasto -> ANULADO desde la tabla de movimientos' }
    await page.waitForTimeout(500)
  }
  throw new Error('el gasto no quedo ANULADO')
})

await paso('precios_selector_dst_local', async () => {
  await abrir(`${RUTA_BASE}/m/precios`)
  exigir(!(await modal().innerText()).includes('Foráneo'), 'aparece Foráneo')
  await page.click('[data-testid=precios-tipo-DST]')
  await elegirPorTexto('[data-testid=precios-entidad]', 'David Flores')
  await page.click('[data-testid=precios-aplicar]')
  await page.waitForURL((u) => u.searchParams.get('tipo') === 'DST' && !!u.searchParams.get('localId'), { timeout: 60000 })
  await modal().locator('th', { hasText: 'Precio para David Flores' }).waitFor({ timeout: 60000 })
  await page.click('[data-testid=precios-tipo-LOC]')
  const locs = await page.locator('[data-testid=precios-entidad] option').allTextContents()
  exigir(!locs.includes('David Flores'), 'el selector Local muestra distribuidores')
  await cerrarTodo()
  return `Distribuidor -> «Precio para David Flores»; Local lista ${locs.length - 1} locales; sin Foráneo`
})

await paso('red_seguimiento_y_editar', async () => {
  await abrir(`${RUTA_BASE}/m/red`)
  const id = 'be763698-bfa4-4a57-994a-7280199caca9' // Luis Rodriguez (DST)
  await modal().locator(`[data-testid=seguimiento-${id}]`).first().click()
  let ok = false
  for (let i = 0; i < 30 && !ok; i++) {
    const [e] = await q('entidades', `id=eq.${id}&select=fecha_ultimo_seguimiento,ultimo_seguimiento`)
    ok = (e.fecha_ultimo_seguimiento && e.fecha_ultimo_seguimiento >= T0) || (e.ultimo_seguimiento && e.ultimo_seguimiento >= T0)
    if (!ok) await page.waitForTimeout(500)
  }
  exigir(ok, 'el seguimiento no se registro')
  const tel = `49200${RUN}`
  const fila = modal().locator('tr').filter({ hasText: 'Luis Rodriguez' }).first()
  await fila.locator('button', { hasText: /Editar/ }).first().click()
  const campoTel = page.locator('label:text-is("Teléfono") + input').last()
  await campoTel.fill(tel)
  await page.click('button:has-text("Guardar cambios")')
  for (let i = 0; i < 30; i++) {
    const [e] = await q('entidades', `id=eq.${id}&select=telefono`)
    if (e.telefono === tel) { await cerrarTodo(); return `seguimiento registrado; telefono -> ${tel}` }
    await page.waitForTimeout(500)
  }
  throw new Error('editar no guardo el telefono')
})

await paso('alta_dst', async () => {
  await abrir(`${RUTA_BASE}/m/red`)
  await page.click('[data-testid=red-alta]')
  await page.waitForURL((u) => u.pathname === `${RUTA_BASE}/m/red/nuevo`, { timeout: 60000 })
  await page.fill('#nombre', `E2E DST ${RUN}`)
  await page.fill('#email', `e2e.dst.${RUN}@v2.local`)
  await page.fill('#password', `clave-${RUN}-x`)
  await page.click('button:has-text("Registrar Miembro")')
  await page.waitForURL((u) => u.pathname === `${RUTA_BASE}/m/red`, { timeout: 60000 })
  const e = await q('entidades', `nombre=eq.${encodeURIComponent(`E2E DST ${RUN}`)}&select=id,rol,auth_id`)
  exigir(e.length === 1 && e[0].rol === 'DST' && e[0].auth_id, `base: ${JSON.stringify(e)}`)
  await cerrarTodo()
  return `entidad DST con auth_id; vuelve a Red`
})

// ════════════════════════════════════════════════════════════════════════════
await entrar('DST')

await paso('panel_dst', async () => {
  await page.locator('[data-testid=ficha-nodo]').waitFor()
  exigir(await page.locator('text=Lo que he ganado').count(), 'no esta «Lo que he ganado»')
  exigir(await page.locator('[data-testid=mis-locales]').count(), 'no esta «Mis locales»')
  exigir((await page.locator('[data-testid=mis-locales]').innerText()).includes('LOC Prueba'), 'no lista a su local')
  return 'ficha propia + «Lo que he ganado» + «Mis locales»'
})

await paso('dst_sin_alta', async () => {
  // lib/entidad-servidor.ts (assertPuedeDarDeAlta) + RLS entidades_ins_admin: solo ADMIN da de alta.
  exigir(!(await page.locator(`a[href="${RUTA_BASE}/m/red/nuevo"]`).count()), 'el DST ve el alta')
  await page.goto(`${BASE}${RUTA_BASE}/m/red`)
  await modal().waitFor({ timeout: 60000 })
  exigir(!(await modal().locator('[data-testid=red-alta]').count()), 'el DST ve «+ Nuevo miembro» en el modal Red')
  await page.goto(`${BASE}${RUTA_BASE}/red`)
  await page.waitForLoadState('networkidle')
  exigir(!(await page.locator('[data-testid=red-pagina-alta]').count()), `el DST ve «+ Nuevo miembro» en ${RUTA_BASE}/red`)
  const r = await page.goto(`${BASE}${RUTA_BASE}/m/red/nuevo`)
  exigir(r.status() === 404, `DST abre el alta: HTTP ${r.status()}`)
  await page.goto(`${BASE}${RUTA_BASE}`)
  return `sin boton de alta (panel, modal Red, ${RUTA_BASE}/red); ${RUTA_BASE}/m/red/nuevo -> 404`
})

let ticketLoc = null
const LOC_ID = (await q('entidades', `email=eq.${encodeURIComponent(U.LOC.email)}&select=id`))[0]?.id
await paso('venta_dst_a_su_local', async () => {
  const r = await venta({ vendedor: DST_ID, comprador: LOC_ID, condicion: 'CONCESION', producto: P750, cantidad: 2 })
  ticketLoc = r.id
  await cerrarTodo()
  return r.nota
})

await paso('abono_dst_pendiente', async () => {
  await page.click('[data-testid=ficha-abono]')
  await page.waitForURL((u) => u.pathname.endsWith('/abono'), { timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('#destino option').length > 1, null, { timeout: 60000 })
  const destinos = await page.locator('#destino option').allTextContents()
  exigir(!destinos.some((t) => /Gilberto/i.test(t)), `ofrece solo_egresos: ${destinos.join(' | ')}`)
  if (!(await page.inputValue('#origen'))) await page.selectOption('#origen', { index: 1 })
  if (!(await page.inputValue('#destino'))) await page.selectOption('#destino', { index: 1 })
  await page.fill('#monto', '131')
  await page.selectOption('#metodoPago', 'EFECTIVO').catch(() => {})
  await page.click('text=Guardar Transferencia')
  await page.waitForURL((u) => u.pathname === RUTA_BASE, { timeout: 60000 })
  const f = await q('finanzas_ledger', `${desde}&monto=eq.131&select=id,status,categoria`)
  exigir(f.length === 1, `base: ${JSON.stringify(f)}`)
  return `finanzas 131 categoria ${f[0].categoria}`
})

await paso('conteo_local_dst', async () => {
  const antes = await q('conteos_fisicos', `id_entidad=eq.${LOC_ID}&select=id`)
  await page.locator('[data-testid=mis-locales]').locator(`a[href="${RUTA_BASE}/m/nodo/${LOC_ID}"]`).click()
  await page.waitForURL((u) => u.pathname === `${RUTA_BASE}/m/nodo/${LOC_ID}`, { timeout: 60000 })
  await modal().locator('[data-testid=ficha-conteo]').click()
  await page.waitForURL((u) => u.pathname.endsWith('/conteo'), { timeout: 60000 })
  const inp = modal().locator('table input[type=number]').first()
  await inp.waitFor({ timeout: 60000 })
  await inp.fill('2')
  await page.click('button:has-text("Guardar conteo")')
  for (let i = 0; i < 30; i++) {
    const ahora = await q('conteos_fisicos', `id_entidad=eq.${LOC_ID}&select=id`)
    if (ahora.length === antes.length + 1) { await cerrarTodo(); return `conteos_fisicos del local ${antes.length} -> ${ahora.length}` }
    await page.waitForTimeout(500)
  }
  throw new Error('no aparecio el conteo')
})

// ════════════════════════════════════════════════════════════════════════════
await entrar('LOC')

await paso('panel_loc', async () => {
  await page.locator('[data-testid=ficha-nodo]').waitFor()
  exigir((await page.locator('[data-testid=kpi-ganado]').count()) === 0, 'un LOC ve Total ganado')
  exigir(await page.locator('[data-testid=kpi-saldo]').count(), 'no esta el saldo')
  return 'su ficha, sin Total ganado'
})

await paso('loc_sin_venta', async () => {
  // RLS: transacciones_tickets no tiene INSERT para LOC (la v1 le ofrecia el POS y fallaba).
  exigir(!(await page.locator(`a[href="${RUTA_BASE}/m/venta"], a[href^="${RUTA_BASE}/m/venta?"]`).count()), 'el LOC ve Nueva venta')
  const r = await page.goto(`${BASE}${RUTA_BASE}/m/venta`)
  exigir(r.status() === 404, `LOC abre la venta: HTTP ${r.status()}`)
  await page.goto(`${BASE}${RUTA_BASE}`)
  return `sin Nueva venta; ${RUTA_BASE}/m/venta -> 404`
})

await paso('loc_sin_modales_de_operacion', async () => {
  // El RLS de estas escrituras solo deja a ADMIN y DST: la puerta de la pagina da 404.
  const codigos = []
  for (const k of ['abono', 'cobranza', 'conteo', 'devolucion']) {
    const r = await page.goto(`${BASE}${RUTA_BASE}/m/nodo/${LOC_ID}/${k}`)
    codigos.push(`${k}=${r.status()}`)
  }
  await page.goto(`${BASE}${RUTA_BASE}`)
  exigir(codigos.every((c) => c.endsWith('=404')), codigos.join(' '))
  return codigos.join(' ')
})

// ════════════════════════════════════════════════════════════════════════════
await entrar('ADMIN')

await paso('aprobar_abono_dst', async () => {
  const [p] = await q('finanzas_ledger', `${desde}&monto=eq.131&select=id,categoria`)
  exigir(p, 'no hay abono del DST')
  await abrir(`${RUTA_BASE}/m/aprobaciones`)
  await modal().locator('button:has-text("Aprobar")').first().waitFor({ timeout: 60000 })
  await modal().locator('tr').filter({ hasText: '131' }).locator('button:has-text("Aprobar")').first().click()
  for (let i = 0; i < 40; i++) {
    const [r] = await q('finanzas_ledger', `id=eq.${p.id}&select=categoria,status`)
    if (r.categoria !== 'ABONO_PENDIENTE') { await cerrarTodo(); return `categoria ${p.categoria} -> ${r.categoria}` }
    await page.waitForTimeout(500)
  }
  throw new Error('el abono sigue pendiente')
})

await paso('anular_ticket_desde_ficha', async () => {
  exigir(ticketLoc, 'sin ticket DST -> LOC')
  await abrir(`${RUTA_BASE}/m/red`)
  await modal().locator(`a[href="${RUTA_BASE}/m/nodo/${LOC_ID}"]`).first().click()
  await page.waitForURL((u) => u.pathname === `${RUTA_BASE}/m/nodo/${LOC_ID}`, { timeout: 60000 })
  await page.locator('[data-testid=ficha-nodo]').waitFor()
  const botones = modal().locator('button[aria-label="Anular movimiento"]:visible')
  await botones.first().waitFor({ timeout: 60000 })
  await botones.first().click()
  for (let i = 0; i < 40; i++) {
    const t = await q('transacciones_tickets', `id=eq.${ticketLoc}&select=id,status`)
    const f = await q('finanzas_ledger', `${desde}&status=eq.ANULADO&select=id`)
    if (t.some((x) => x.status === 'ANULADO') || f.length > 1) { await cerrarTodo(); return `ficha -> Anular: ${t.map((x) => x.status).join(',')}` }
    await page.waitForTimeout(500)
  }
  throw new Error('nada quedo ANULADO')
})

await paso('lotes_y_actividad', async () => {
  await abrir(`${RUTA_BASE}/m/lotes`)
  exigir((await modal().locator('[data-testid=lotes-vacio], [data-testid=tabla-lotes]').count()) > 0, 'el modal de lotes no pinta')
  await cerrarTodo()
  await abrir(`${RUTA_BASE}/m/actividad`)
  await cerrarTodo()
  await abrir(`${RUTA_BASE}/m/avisos`)
  await cerrarTodo()
  return 'lotes, actividad y avisos abren'
})

// ════════════════════════════════════════════════════════════════════════════
await entrar('DST')

await paso('abono_de_su_local_a_su_cuenta', async () => {
  // D8: «los locales de David le pagan a David». Destino = cuenta propia del DST; la matriz no aparece.
  const [cuentaDst] = await q('cuentas_financieras', `id_entidad=eq.${DST_ID}&select=id,nombre`)
  exigir(cuentaDst, 'el DST no tiene cuenta propia en la copia')
  await page.goto(`${BASE}${RUTA_BASE}/m/nodo/${LOC_ID}/abono`)
  await modal().waitFor({ timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('#destino option').length > 1, null, { timeout: 60000 })
  const ids = await page.locator('#destino option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean))
  exigir(ids.length > 0 && ids.every((v) => v === cuentaDst.id), `destinos ofrecidos: ${ids.join(' | ')}`)
  if (!(await page.inputValue('#origen'))) await page.selectOption('#origen', { index: 1 })
  if (!(await page.inputValue('#destino'))) await page.selectOption('#destino', cuentaDst.id)
  await page.fill('#monto', '137')
  await page.click('text=Guardar Transferencia')
  await page.waitForURL((u) => !u.pathname.endsWith('/abono'), { timeout: 60000 })
  let f = []
  for (let i = 0; i < 30 && !f.length; i++) {
    f = await q('finanzas_ledger', `${desde}&id_entidad_relacionada=eq.${LOC_ID}&tipo_movimiento=eq.ABONO_DEUDA&usuario_creador=eq.${encodeURIComponent(U.DST.email)}&select=id,monto,categoria,id_cuenta_destino`)
    if (!f.length) await page.waitForTimeout(500)
  }
  const suma = f.reduce((a, x) => a + Number(x.monto), 0)
  exigir(Math.abs(suma - 137) < 0.005, `base: ${JSON.stringify(f)}`)
  exigir(f.every((x) => x.id_cuenta_destino === cuentaDst.id), `destino en la base: ${JSON.stringify(f)}`)
  exigir(f.every((x) => x.categoria === 'ABONO_REAL'), `categoria: ${JSON.stringify(f)}`)
  await page.goto(`${BASE}${RUTA_BASE}`)
  return `${f.length} fila(s), 137 a ${cuentaDst.nombre}, ABONO_REAL`
})

// ════════════════════════════════════════════════════════════════════════════
await entrar('SOCIO')

await paso('socio_solo_lectura', async () => {
  exigir((await page.locator('text=CAPTURAR').count()) === 0, 'SOCIO ve Capturar')
  await abrir(`${RUTA_BASE}/m/cuenta/efectivo`)
  exigir((await modal().locator('button:has-text("Anular")').count()) === 0, 'SOCIO ve Anular')
  await cerrarTodo()
  const r = await page.goto(`${BASE}${RUTA_BASE}/m/gasto`)
  exigir(r.status() === 404, `SOCIO abre gasto: HTTP ${r.status()}`)
  await page.goto(`${BASE}${RUTA_BASE}`)
  return `sin Capturar ni Anular; ${RUTA_BASE}/m/gasto -> 404`
})

await ctx.close()
await browser.close()
const reales = errores.filter((e) => !/404/.test(e))
console.log(`errores de consola/500: ${reales.length}`)
for (const e of reales.slice(0, 20)) console.log('  ' + e)
fs.writeFileSync(path.join(OUT, 'resultados.json'), JSON.stringify({ RUN, T0, resultados, errores }, null, 2))
console.log(fallas ? `FALLAS: ${fallas} de ${n}` : `TODO OK (${n} pasos)`)
process.exit(fallas ? 1 : 0)
