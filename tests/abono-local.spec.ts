import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CASOS, cableado } from './abono-local.casos'

test.describe('abono del DST que surte a su local (REGLAS_COMERCIALES, opcion i)', () => {
  for (const c of CASOS) test(c.nombre, () => expect(c.obtenido).toEqual(c.esperado))
})

const RUTAS = {
  venta: 'lib/venta-servidor.ts',
  auditoria: 'app/actions/auditoria.ts',
  devoluciones: 'app/actions/devoluciones.ts',
  inventario: 'app/actions/inventario.ts',
  abono: 'lib/abono-local.ts',
  documento: 'lib/documento.ts',
  bot: 'lib/bot-pregunta-erp.ts',
  feedV1: 'app/dashboard/feed/page.tsx',
  feedV2: 'components/v2/actividad/Feed.tsx',
  feedUtils: 'lib/feed-utils.ts',
  perfilV1: 'app/dashboard/distribuidores/[id]/page.tsx',
  perfilV2: 'lib/v2/nodo.ts',
  directorioV1: 'app/dashboard/distribuidores/page.tsx',
  directorioV2: 'lib/v2/red.ts',
  historialV1: 'app/dashboard/distribuidores/[id]/HistorialActividadTableClient.tsx',
  historialV2: 'components/v2/nodo/Historial.tsx'
}

test.describe('cableado del abono, leido del codigo', () => {
  const fuentes: Record<string, string> = {}
  for (const [k, ruta] of Object.entries(RUTAS)) fuentes[k] = readFileSync(join(process.cwd(), ruta), 'utf-8')
  for (const [nombre, ok] of cableado(fuentes)) test(nombre, () => expect(ok).toBe(true))
})
