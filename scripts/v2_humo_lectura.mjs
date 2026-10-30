// v2 LOCAL: humo de SOLO LECTURA por la interfaz (no crea movimientos). Escrito el 2026-10-29
// por el Socio (ejecutor). Entra como admin y abre tablero, distribuidores y la ficha de Aeropuerto.
//
//   E2E_BASE_URL=http://localhost:3002 node scripts/v2_humo_lectura.mjs <carpeta_capturas>
import { chromium } from '@playwright/test'
import fs from 'node:fs'

const B = process.env.E2E_BASE_URL || 'http://localhost:3002'
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(B)) { console.error('URL no local'); process.exit(2) }
const OUT = process.argv[2] || 'humo_lectura'
fs.mkdirSync(OUT, { recursive: true })
const RUTAS = [
  ['/dashboard/general', 'general'],
  ['/dashboard/distribuidores', 'distribuidores'],
  ['/dashboard/distribuidores/4cbad6ad-41f6-4397-86d3-0f5ec5be21dd', 'aeropuerto']
]

// La clave del ADMIN local no vive en el repo (2026-10-30): se lee del entorno.
const CLAVE_ADMIN = process.env.E2E_ADMIN_PASSWORD
if (!CLAVE_ADMIN) {
  console.error('Falta E2E_ADMIN_PASSWORD (clave del usuario ADMIN local; ver docs/V2_LOCAL.md). No corro.')
  process.exit(2)
}

const br = await chromium.launch()
const pg = await br.newPage({ viewport: { width: 1400, height: 1000 } })
await pg.goto(B + '/login')
await pg.fill('input[type=email]', 'normancantu@gmail.com')
await pg.fill('input[type=password]', CLAVE_ADMIN)
await pg.click('button[type=submit]')
await pg.waitForURL((u) => !u.pathname.startsWith('/login'))
let fallas = 0
for (const [ruta, nombre] of RUTAS) {
  const r = await pg.goto(B + ruta)
  await pg.waitForLoadState('networkidle')
  const t = await pg.innerText('body')
  const err = /Application error|Unhandled Runtime Error/i.test(t) || r.status() >= 400
  if (err) fallas += 1
  const transf = (t.match(/Liquidez Transferencias[\s\S]{0,40}/) || [''])[0].replace(/\s+/g, ' ')
  console.log(`${nombre} HTTP ${r.status()} ${err ? 'CON ERROR' : 'sin error'} ${transf}`)
  await pg.screenshot({ path: `${OUT}/humo_${nombre}.png`, fullPage: true })
}
await br.close()
console.log(fallas ? `FALLAS: ${fallas}` : 'TODO OK')
process.exit(fallas ? 1 : 0)
