// Front v2 LOCAL: capturas y comprobacion de cifras por pantalla (SOLO LECTURA).
// Escrito el 2026-10-29 por el ejecutor del Front v2 (lanzado por el Socio).
//
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... E2E_BASE_URL=http://localhost:3002 \
//     node scripts/v2_front_capturas.mjs <carpeta> [ruta ...]
//
// Entra como admin, abre cada ruta /v2, falla si hay error de Next o HTTP >= 400,
// imprime las cifras que encuentra y guarda captura a 1440 y a 390 px.
// Las cifras ESPERADAS se pasan por V2_ESPERADAS="12,059.33;4,690.00;..." y cada
// una tiene que aparecer en el texto de la pagina (control contra la base).
import { chromium } from '@playwright/test'
import fs from 'node:fs'

const B = process.env.E2E_BASE_URL || 'http://localhost:3002'
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(B)) { console.error('URL no local'); process.exit(2) }
const OUT = process.argv[2] || 'capturas_front_v2'
const RUTAS = process.argv.slice(3).length ? process.argv.slice(3) : ['/v2']
const ESPERADAS = (process.env.V2_ESPERADAS || '').split(';').map((s) => s.trim()).filter(Boolean)

// Credenciales: E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD (los nombres de la bateria,
// ver tests/auth.setup.ts). Si no vienen en el entorno, se leen del .env.local del
// repo SI existe. Sin ellas, falla con un mensaje claro: ninguna clave va en el
// codigo (correccion de la auditoria, 2026-10-29).
function leerEnvLocal() {
  const p = new URL('../.env.local', import.meta.url)
  if (!fs.existsSync(p)) return {}
  const out = {}
  for (const l of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}
const envLocal = leerEnvLocal()
const EMAIL = process.env.E2E_ADMIN_EMAIL || envLocal.E2E_ADMIN_EMAIL
const CLAVE = process.env.E2E_ADMIN_PASSWORD || envLocal.E2E_ADMIN_PASSWORD
if (!EMAIL || !CLAVE) {
  console.error(
    'Faltan E2E_ADMIN_EMAIL y E2E_ADMIN_PASSWORD. Ponlas en el entorno o en .env.local ' +
      '(los usuarios de prueba locales estan en docs/V2_LOCAL.md).'
  )
  process.exit(2)
}
fs.mkdirSync(OUT, { recursive: true })

const br = await chromium.launch()
const ctx = await br.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
const pg = await ctx.newPage()
const errores = []
pg.on('pageerror', (e) => errores.push(String(e)))
await pg.goto(B + '/login')
await pg.fill('input[type=email]', EMAIL)
await pg.fill('input[type=password]', CLAVE)
await pg.click('button[type=submit]')
await pg.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 })

let fallas = 0
for (const ruta of RUTAS) {
  const nombre = ruta.replace(/^\/+/, '').replace(/[^a-z0-9]+/gi, '_') || 'raiz'
  // El servidor de desarrollo compila la ruta la primera vez y el HMR puede
  // abortar esa navegacion (ver V2_LOCAL.md, precalentar): un reintento.
  let r
  try {
    r = await pg.goto(B + ruta, { timeout: 120000 })
  } catch (e) {
    console.log(`  reintento tras: ${String(e).slice(0, 120)}`)
    await pg.waitForTimeout(3000)
    r = await pg.goto(B + ruta, { timeout: 120000 })
  }
  await pg.waitForLoadState('networkidle')
  await pg.evaluate(() => document.fonts.ready)
  const t = await pg.innerText('body')
  const err = /Application error|Unhandled Runtime Error|Error: /i.test(t) || r.status() >= 400 || pg.url().includes('/login')
  const faltan = ESPERADAS.filter((e) => !t.includes(e))
  if (err || faltan.length) fallas += 1
  console.log(`${ruta} HTTP ${r.status()} ${err ? 'CON ERROR' : 'sin error'} faltan=[${faltan.join(' | ')}]`)
  const cifras = [...new Set(t.match(/\$[\d,]+(\.\d{2})?/g) || [])].slice(0, 40)
  console.log(`  cifras: ${cifras.join(' ')}`)
  await pg.screenshot({ path: `${OUT}/${nombre}_1440.png`, fullPage: true })
  await pg.setViewportSize({ width: 390, height: 844 })
  await pg.waitForTimeout(300)
  const sw = await pg.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
  console.log(`  390px: scrollWidth=${sw[0]} clientWidth=${sw[1]}`)
  await pg.screenshot({ path: `${OUT}/${nombre}_390.png`, fullPage: true })
  await pg.setViewportSize({ width: 1440, height: 1000 })
}
if (errores.length) { console.log('ERRORES JS:', errores.join(' || ')); fallas += 1 }
await br.close()
console.log(fallas ? `FALLAS: ${fallas}` : 'TODO OK')
process.exit(fallas ? 1 : 0)
