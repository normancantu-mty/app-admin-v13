import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { concesionPorProducto, leerFaltante, restarFaltante, type MovimientoConcesion } from '@/lib/en-concesion'

/** Lo que esta en concesion, con el faltante restado. Nada sale a la red. */

const ROL: Record<string, string> = { adm: 'ADMIN', dst: 'DST', loc: 'LOC' }

function m(
  tipo: string, cubeta: string | null, piezas: number, origen: string | null, destino: string | null,
  extra: Partial<MovimientoConcesion> = {}
): MovimientoConcesion {
  return {
    id_producto: 'p750', tipo_movimiento: tipo, cubeta, cantidad: piezas, status: 'ACTIVO',
    id_entidad_origen: origen, id_entidad_destino: destino,
    entidad_origen: origen ? { rol: ROL[origen] } : null,
    entidad_destino: destino ? [{ rol: ROL[destino] }] : null,
    ...extra
  }
}

/** Lo que hacian las dos pantallas antes de la v2: solo CONSIGNADO. Copiado de ahi. */
function antes(movs: MovimientoConcesion[]): number {
  return movs
    .filter((x) => x.cubeta === 'CONSIGNADO' && x.status === 'ACTIVO')
    .reduce((acc, x) => {
      const tipo = String(x.tipo_movimiento)
      if (tipo.startsWith('ENTRADA') || tipo === 'AJUSTE_INVENTARIO') return acc + Number(x.cantidad)
      if (tipo.startsWith('SALIDA') || tipo === 'MERMA') return acc - Number(x.cantidad)
      return acc
    }, 0)
}
const hoy = (movs: MovimientoConcesion[]) => concesionPorProducto(movs).get('p750') ?? 0

/** La Matriz entrega 8; el distribuidor surte 10 a su local: 8 consignadas y 2 que no tenia. */
const DIEZ_CON_OCHO = [
  m('PRODUCCION', 'PAGADO', 50, null, 'adm'),
  m('SALIDA_CONCESION', 'PAGADO', 8, 'adm', null),
  m('ENTRADA_CONCESION', 'CONSIGNADO', 8, null, 'dst'),
  m('SALIDA_CONCESION', 'CONSIGNADO', 8, 'dst', null),
  m('SALIDA_CONCESION', 'PAGADO', 2, 'dst', null),
  m('ENTRADA_CONCESION', 'CONSIGNADO', 10, null, 'loc')
]

test('salieron 8 de la Matriz y el distribuidor entrego 10: en concesion hay 8, no 10', () => {
  expect(antes(DIEZ_CON_OCHO)).toBe(10)
  expect(hoy(DIEZ_CON_OCHO)).toBe(8)
})

test('es regresion SOLO con negativo: sin el, las dos cuentas dan lo mismo', () => {
  const sinFaltante = DIEZ_CON_OCHO
    .filter((x) => !(x.cubeta === 'PAGADO' && x.id_entidad_origen === 'dst'))
    .map((x) => (x.cantidad === 10 ? { ...x, cantidad: 8 } : x))
  const conPagadoPositivo = [...sinFaltante, m('ENTRADA_COMPRA', 'PAGADO', 4, null, 'dst'), m('SALIDA_VENTA', 'PAGADO', 3, 'dst', null)]
  const conTraslado = [
    ...sinFaltante,
    m('DEVOLUCION_FISICA', 'CONSIGNADO', 2, 'loc', 'dst'),
    m('AJUSTE_INVENTARIO', 'CONSIGNADO', -1, null, 'loc'),
    m('MERMA', 'CONSIGNADO', 1, 'loc', null)
  ]
  for (const movs of [sinFaltante, conPagadoPositivo, conTraslado]) expect(hoy(movs)).toBe(antes(movs))
  expect(hoy(sinFaltante)).toBe(8)
  expect(hoy(conTraslado)).toBe(6)
})

test('el negativo de la Matriz no es concesion, y una entidad cuyo rol no se ve no cuenta', () => {
  const tres = m('ENTRADA_CONCESION', 'CONSIGNADO', 3, null, 'loc')
  expect(hoy([m('SALIDA_VENTA', 'PAGADO', 5, 'adm', null), tres])).toBe(3)
  expect(hoy([m('SALIDA_VENTA', 'PAGADO', 5, 'dst', null, { entidad_origen: null }), tres])).toBe(3)
})

test('el sobrante pagado de uno no tapa el faltante de otro, y lo anulado no cuenta', () => {
  const movs = [
    m('ENTRADA_COMPRA', 'PAGADO', 9, null, 'loc'),
    m('SALIDA_VENTA', 'PAGADO', 2, 'dst', null),
    m('ENTRADA_CONCESION', 'CONSIGNADO', 4, null, 'dst')
  ]
  expect(hoy(movs)).toBe(2)
  expect(hoy([...movs, m('SALIDA_VENTA', 'PAGADO', 50, 'dst', null, { status: 'ANULADO' })])).toBe(2)
  // Sin cubeta es PAGADO, como en `getStockPorCubetaPorEntidad`.
  expect(hoy([...movs, m('SALIDA_VENTA', null, 1, 'dst', null)])).toBe(1)
  // La entrada que llega despues lo cubre.
  expect(hoy([...movs, m('ENTRADA_COMPRA', 'PAGADO', 2, null, 'dst')])).toBe(4)
})

test('la ficha: resta el faltante, agrega lo que no estaba y quita lo que queda en cero', () => {
  const f = (idProducto: string, stockEsperado: number) => ({ idProducto, producto: idProducto, stockEsperado })
  expect(restarFaltante([f('a', 5), f('b', 2)], [f('a', -2), f('b', -2), f('c', -1)])).toEqual([f('a', 3), f('c', -1)])
  expect(restarFaltante([f('a', 5)], [])).toEqual([f('a', 5)])
})

/** Un cliente de mentiras: contesta por tabla, o con error. Anota lo que se le pide. */
function cliente(tablas: Record<string, unknown[]>, error?: string) {
  const pedidos: string[] = []
  const from = (tabla: string) => {
    const q: Record<string, unknown> = {}
    for (const x of ['select', 'in', 'or', 'order', 'eq']) {
      q[x] = (...a: unknown[]) => {
        pedidos.push(`${tabla}.${x}(${JSON.stringify(a)})`)
        return q
      }
    }
    const r = () => Promise.resolve(error ? { data: null, error: { message: error } } : { data: tablas[tabla] ?? [], error: null })
    q.range = r
    q.then = (a: never, b: never) => r().then(a, b)
    return q
  }
  return { c: { from } as never, pedidos }
}
const fila = (tipo: string, cubeta: string, piezas: number, origen: string | null, destino: string | null) => ({
  id_producto: 'p750', tipo_movimiento: tipo, cantidad: piezas, cubeta, id_entidad_origen: origen, id_entidad_destino: destino
})

test('la ficha lee el faltante de ESA entidad, solo producto terminado, y no se cae si falla', async () => {
  const { c, pedidos } = cliente({
    inventario_ledger: [
      fila('SALIDA_CONCESION', 'PAGADO', 2, 'dst', 'loc'),
      fila('ENTRADA_CONCESION', 'CONSIGNADO', 9, null, 'dst'),
      fila('SALIDA_VENTA', 'PAGADO', 7, 'loc', null)
    ],
    catalogo_productos: [{ id: 'p750', nombre: 'Destilado 750ml' }]
  })
  expect(await leerFaltante(c, 'dst')).toEqual([{ idProducto: 'p750', producto: 'Destilado 750ml', stockEsperado: -2 }])
  expect(pedidos.join('\n')).toContain('catalogo_productos.eq(["tipo","TERMINADO"])')
  expect(pedidos.join('\n')).toContain('inventario_ledger.in(["status",["ACTIVO","APPROVED"]])')
  const sano = cliente({ inventario_ledger: [fila('ENTRADA_COMPRA', 'PAGADO', 2, null, 'dst')] })
  expect(await leerFaltante(sano.c, 'dst')).toEqual([])
  expect(sano.pedidos.join()).not.toContain('catalogo_productos')
  expect(await leerFaltante(cliente({}, 'truena').c, 'dst')).toEqual([])
})

test('las dos pantallas y las dos fichas lo usan; los botones de merma siguen con el libro', () => {
  const leer = (r: string) => readFileSync(join(process.cwd(), r), 'utf-8')
  const [v1, v2] = ['app/dashboard/distribuidores/[id]/page.tsx', 'lib/v2/nodo.ts']
  for (const r of ['app/dashboard/inventario/page.tsx', 'components/v2/inventario/InventarioVista.tsx']) {
    expect(leer(r), r).toContain('const concesion = concesionPorProducto(movimientos)')
    expect(leer(r), r).toContain('const stockFisicoConsignado = concesion.get(producto.id) ?? 0')
  }
  expect(leer(v1)).toContain('restarFaltante(consignadoDelLibro, await leerFaltante(supabaseClient, resolvedParams.id))')
  expect(leer(v2)).toContain('restarFaltante(consignadoDelLibro, faltante)')
  expect(leer(v2)).toMatch(/leerStockPorCubeta\(supabaseClient, id\)\.catch\(\(\) => \[\]\),\n\s+leerFaltante\(supabaseClient, id\),/)
  for (const r of [v1, v2]) expect(leer(r), r).toContain('[...inventarioPagado, ...consignadoDelLibro]')
})
