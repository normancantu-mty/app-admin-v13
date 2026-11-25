/**
 * Casos de `lib/abono-local.ts`, sin framework. Los corre
 * `tests/abono-local.spec.ts`. Cada caso devuelve lo obtenido y lo esperado.
 */
import {
  TIPO_FILA_ABONO_LOCAL,
  arranqueCubierto,
  avisoAbonoDeMas,
  avisoArranqueSinCosto,
  avisoCorteLocalPropio,
  conceptoAbonoLocal,
  construirAbonoLocal,
  correspondeAbonoLocal,
  derechoAbono,
  esAbonoPorSurtirLocal,
  MOTIVO_ABONO_SIN_ANULAR,
  piezasDelAsiento,
  piezasSinCargo,
  preciosPublicos,
  renglonAbonoLocal,
  resolverAbonoLocal,
  saldoPorPagarSinAbonoLocal
} from '../lib/abono-local'
import type { CargoAbono, LibroAbono, MovimientoAbono } from '../lib/abono-local'
import { CATALOGO_AVISOS } from '../lib/avisos'
import { abonoPorBotellaLocal, ajusteTraspasoDstALocal } from '../lib/reglas-comerciales'

const P = { p750: 'id-750', p250: 'id-250', p50: 'id-50' }
const PP = new Map([[P.p750, 599], [P.p250, 179], [P.p50, 69]])
const piezas = [
  { idProducto: P.p750, etiqueta: 'Plata 750ml', cantidad: 12 },
  { idProducto: P.p250, etiqueta: 'Plata 250ml', cantidad: 12 },
  { idProducto: P.p50, etiqueta: 'Plata 50ml', cantidad: 24 }
]
const entrada = (cambios: Record<string, unknown> = {}) => ({
  idTicket: 'b71a462a-134a-4b3a-b4c6-fa3044237b86',
  idDistribuidor: 'DST-1',
  nombreLocal: 'Local de prueba',
  porcentajes: { local: 0.15, red: 0.15, base: 0.2 } as { local: unknown; red: unknown; base: unknown },
  esCuentaFiscal: false,
  piezas,
  precioPublico: PP,
  fecha: '2026-11-24T19:15:45.121Z',
  usuario: 'prueba@prueba',
  ...cambios
})
const abono = (cambios: Record<string, unknown> = {}) => construirAbonoLocal(entrada(cambios))
const resuelve = (cambios: Record<string, unknown> = {}, ctx: { zona?: string; error?: string | null } = {}) =>
  resolverAbonoLocal(entrada(cambios), { zona: ctx.zona ?? 'Zacatecas', error: ctx.error ?? null })
const botella = (pp: number, local: number, esCuentaFiscal = false) =>
  abonoPorBotellaLocal({ pp, comisionLocal: local, comisionRed: 0.15, comisionBase: 0.2, esCuentaFiscal })
const aplica = (cambios: Record<string, unknown> = {}) =>
  correspondeAbonoLocal({
    esConcesion: true,
    rolVendedor: 'DST',
    vendedorId: 'DST-1',
    origenInventarioId: 'DST-1',
    comprador: { rol: 'LOC', id_padre: 'DST-1', id_nodo_padre: 'DST-1' },
    ...cambios
  })
const filaAbono = (cambios: Record<string, unknown> = {}) => ({
  id_entidad_relacionada: 'DST-1',
  tipo_movimiento: 'CARGO_DEUDA',
  categoria: 'COMISION_LOCAL',
  monto: -1044,
  status: 'ACTIVO',
  ...cambios
})
const corte = (cambios: Record<string, unknown> = {}) =>
  avisoCorteLocalPropio({
    esLocalPropio: true,
    montoComision: 1405,
    montoDeudaAMatriz: 7967,
    deudaConsignacion: 8720,
    ...cambios
  })

const fila = abono()
const SOLO_750 = { precioPublico: new Map([[P.p750, 599]]) }
const TRUENA = { precioPublico: { get: () => { throw new Error('roto') } } }
const SIN_PRECIO = { precioPublico: new Map<string, number>() }

// -- v3: solo se abona lo que trae cargo --
const T = {
  carga: '3e6fb32c-0000-4000-8000-000000000000',
  recarga: '4e6fb32c-0000-4000-8000-000000000000',
  contado: '5e6fb32c-0000-4000-8000-000000000000',
  b71a: 'b71a462a-134a-4b3a-b4c6-fa3044237b86',
  v1: '1a1a1a1a-0000-4000-8000-000000000000',
  v2: '2a2a2a2a-0000-4000-8000-000000000000'
}
const [D20, D23, D24, D25] = [20, 23, 24, 25].map((d) => `2026-11-${d}T18:00:00Z`)
const mov = (cambios: Record<string, unknown>): MovimientoAbono => ({
  id_producto: P.p750,
  tipo_movimiento: 'ENTRADA_CONCESION',
  cantidad: 0,
  id_entidad_origen: null,
  id_entidad_destino: 'DST-1',
  fecha_movimiento: D23,
  costo_unitario_movimiento: 0,
  notas: `ticket:${T.carga}`,
  status: 'ACTIVO',
  ...cambios
})
const entra = (id_producto: string, cantidad: number, cambios: Record<string, unknown> = {}) => mov({ id_producto, cantidad, ...cambios })
// `precio_neto` de conciliacion_locales_2026-10-29.json, lo que cargar_arranque.py escribe en el renglon.
const COSTO = new Map([[P.p750, 480], [P.p250, 144], [P.p50, 56]])
const arranque = (id_producto: string, cantidad: number, cambios: Record<string, unknown> = {}) =>
  mov({ id_producto, cantidad, fecha_movimiento: '2026-10-28T05:59:00Z', costo_unitario_movimiento: COSTO.get(id_producto) ?? null, notas: 'ARRANQUE 2026-10-27: consignacion inicial (conciliado)', ...cambios })
const surte = (id_producto: string, cantidad: number, ticket: string, cambios: Record<string, unknown> = {}) =>
  mov({ id_producto, cantidad, tipo_movimiento: 'SALIDA_CONCESION', id_entidad_origen: 'DST-1', id_entidad_destino: null, fecha_movimiento: D24, notas: `ticket:${ticket}`, ...cambios })
const sale = (cantidad: number, cambios: Record<string, unknown>) => surte(P.p750, cantidad, T.v1, { notas: null, ...cambios })
const regresaDelLocal = (cantidad: number) =>
  mov({ cantidad, tipo_movimiento: 'DEVOLUCION_FISICA', id_entidad_origen: 'LOC-1', fecha_movimiento: D25, notas: 'Devolucion' })
const ajuste = (cantidad: number) => mov({ cantidad, tipo_movimiento: 'AJUSTE_INVENTARIO', fecha_movimiento: D24, notas: 'AJUSTE ADMIN' })
const asiento = (id_ticket: string | null, dice: Record<string, number> | null, cambios: Partial<CargoAbono> = {}): CargoAbono => ({
  id_ticket,
  tipo_movimiento: 'CARGO_DEUDA',
  categoria: 'COMISION_LOCAL',
  monto: -100,
  subcategoria: dice ? JSON.stringify(dice) : null,
  ...cambios
})
const cargoArranque = (monto: number, cambios: Partial<CargoAbono> = {}) => asiento(null, null, { categoria: 'ARRANQUE', monto, ...cambios })
const libro = (movimientos: MovimientoAbono[], cargos: CargoAbono[] = [], cambios: Partial<LibroAbono> = {}): LibroAbono => ({
  idDistribuidor: 'DST-1',
  movimientos,
  cargos,
  ticketsVivos: new Set([T.carga, T.recarga, T.contado]),
  ticketsContado: new Set([T.contado]),
  ...cambios
})
/** Cuantas de esas piezas se abonan. */
const abona = (l: LibroAbono, idProducto: string, cantidad: number) => cantidad - (piezasSinCargo(l, [{ idProducto, cantidad }]).get(idProducto) ?? 0)
const derechos = (l: LibroAbono) => [P.p750, P.p250, P.p50].map((p) => derechoAbono(l, p))
const lanza = (f: () => unknown) => {
  try {
    f()
    return ''
  } catch (e) {
    return String(e)
  }
}
const ANTES_DE_B71A = [arranque(P.p750, 10), arranque(P.p50, 12), entra(P.p750, 12), entra(P.p250, 12), entra(P.p50, 22)]
const DAVID = [...ANTES_DE_B71A, surte(P.p750, 12, T.b71a), surte(P.p250, 12, T.b71a), surte(P.p50, 24, T.b71a)]
// Como lo deja el SQL (jsonb -> texto, con espacios y otro orden).
const SUBCATEGORIA_SQL = '{"id-50": 22, "id-250": 12, "id-750": 12}'
const B71A = asiento(T.b71a, null, { monto: -1044, subcategoria: SUBCATEGORIA_SQL })
const DOCE = [arranque(P.p750, 20), entra(P.p750, 12)]
const contado = (cantidad: number, cambios: Record<string, unknown> = {}) =>
  entra(P.p750, cantidad, { tipo_movimiento: 'ENTRADA_COMPRA', notas: `ticket:${T.contado}`, ...cambios })
const VENDIO_12 = [surte(P.p750, 12, T.v1)]
const A12 = asiento(T.v1, { [P.p750]: 12 })
const consignado = (a: number, b: number, c: number) => [arranque(P.p750, a), arranque(P.p250, b), arranque(P.p50, c)]
const ALE = libro(consignado(3, 3, 3), [cargoArranque(2040)])
const GILBERTO = libro(consignado(12, 12, 12), [cargoArranque(8496)])
const MARTIN = libro(consignado(14, 3, 6), [cargoArranque(11327)])
const TRES = [ALE, GILBERTO, MARTIN]
const ETIQUETAS = { idTicket: T.v2, nombreLocal: 'Local de prueba', etiquetas: new Map([[P.p750, 'Plata 750ml']]) }
const SIN_COSTO = libro([arranque(P.p750, 3, { costo_unitario_movimiento: 0 }), arranque(P.p50, 3)], [cargoArranque(2040)])
const avisaSinCosto = (l: LibroAbono, sinCargo = new Map([[P.p750, 3]])) => avisoArranqueSinCosto(l, sinCargo, ETIQUETAS)
const DE_MAS = { idTicket: T.v2, nombreLocal: 'Local de prueba', subcategoria: JSON.stringify({ [P.p750]: 12 }), etiquetas: new Map([[P.p750, 'Plata 750ml']]) }
const DIEZ_Y_DIEZ = {
  piezas: [{ ...piezas[0], cantidad: 10 }, { ...piezas[2], cantidad: 10 }],
  piezasSinCargo: new Map([[P.p750, 10], [P.p50, 10]])
}
const DOS_DE_50 = { piezasSinCargo: new Map([[P.p50, 2]]) }
// Lo que deja escrito el SQL de la regularizacion (12 + 12 + 22 piezas).
const TEXTO_SQL =
  'Abono por surtir a Local de prueba - Ticket #B71A462A\n12x Destilado Plata 750ml ($59 c/u) = $708\n' +
  '12x Destilado Plata 250ml ($17 c/u) = $204\n22x Destilado Plata 50ml ($6 c/u) = $132\n' +
  'Sin abono: 2x Destilado Plata 50ml (sin cargo por abonar)'
const COMO_EL_SQL = { ...DOS_DE_50, piezas: piezas.map((p) => ({ ...p, etiqueta: `Destilado ${p.etiqueta}` })) }
const sumaRenglones = (texto: string) => Array.from(texto.matchAll(/ = \$(\d+)$/gm)).reduce((a, m) => a + Number(m[1]), 0)
const peso = (n: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n)
export const CASOS: Array<{ nombre: string; obtenido: unknown; esperado: unknown }> = [
  // ── La cuenta ──
  { nombre: 'por botella 59/17/6', obtenido: [botella(599, 0.15), botella(179, 0.15), botella(69, 0.15)], esperado: [59, 17, 6] },
  { nombre: 'local al 20%: 89/26/10', obtenido: [botella(599, 0.2), botella(179, 0.2), botella(69, 0.2)], esperado: [89, 26, 10] },
  { nombre: 'el float no se come un peso: 10% de 100 = 10', obtenido: botella(100, 0.15), esperado: 10 },
  { nombre: 'cuenta fiscal: sobre Base 337.50, 33', obtenido: botella(599, 0.15, true), esperado: 33 },
  { nombre: 'negativo no abona ni cobra', obtenido: botella(599, 0), esperado: 0 },
  { nombre: 'la funcion sin truncar no cambio: 59.9', obtenido: ajusteTraspasoDstALocal({ pp: 599, comisionLocal: 0.15, comisionRed: 0.15, comisionBase: 0.2, esCuentaFiscal: false }), esperado: 59.9 },
  { nombre: '12 + 12 + 24 piezas: -1056', obtenido: fila?.monto, esperado: -1056 },
  { nombre: '12 + 12 + 22 piezas: -1044 y 8720 -> 7676', obtenido: 8720 + (abono({ piezas: [piezas[0], piezas[1], { ...piezas[2], cantidad: 22 }] })?.monto ?? 0), esperado: 7676 },
  // ── El asiento ──
  { nombre: 'tipo y categoria: no es ABONO_DEUDA', obtenido: [fila?.tipo_movimiento, fila?.categoria], esperado: ['CARGO_DEUDA', 'COMISION_LOCAL'] },
  { nombre: 'no toca efectivo', obtenido: [fila?.id_cuenta_origen, fila?.id_cuenta_destino], esperado: [null, null] },
  { nombre: 'ligado al ticket y al DST', obtenido: [fila?.id_ticket, fila?.id_entidad_relacionada, fila?.status], esperado: ['b71a462a-134a-4b3a-b4c6-fa3044237b86', 'DST-1', 'ACTIVO'] },
  {
    nombre: 'detalle por botella legible',
    obtenido: fila?.categoria_gasto,
    esperado: 'Abono por surtir a Local de prueba - Ticket #B71A462A\n12x Plata 750ml ($59 c/u) = $708\n12x Plata 250ml ($17 c/u) = $204\n24x Plata 50ml ($6 c/u) = $144'
  },
  { nombre: 'cero -> sin asiento', obtenido: abono({ porcentajes: { local: 0.05, red: 0.15, base: 0.2 } }), esperado: null },
  { nombre: 'LOC sin porcentaje (null) -> sin asiento', obtenido: abono({ porcentajes: { local: null, red: 0.15, base: 0.2 } }), esperado: null },
  { nombre: 'porcentaje guardado como 15 = 0.15', obtenido: abono({ porcentajes: { local: 15, red: 15, base: 20 } })?.monto, esperado: -1056 },
  { nombre: 'porcentaje fuera de rango no lanza', obtenido: abono({ porcentajes: { local: -1, red: 0.15, base: 0.2 } }), esperado: null },
  // ── Cuando aplica ──
  { nombre: 'aplica: concesion, DST, su LOC', obtenido: aplica(), esperado: true },
  { nombre: 'CONTADO no (ya se parte solo)', obtenido: aplica({ esConcesion: false }), esperado: false },
  { nombre: 'ADMIN no (bloque 1)', obtenido: aplica({ rolVendedor: 'ADMIN' }), esperado: false },
  { nombre: 'triangulacion no (bloque 2)', obtenido: aplica({ origenInventarioId: 'DST-2' }), esperado: false },
  { nombre: 'LOC de otro DST no', obtenido: aplica({ comprador: { rol: 'LOC', id_padre: 'DST-2', id_nodo_padre: 'DST-2' } }), esperado: false },
  { nombre: 'LOC sin padre (centinela) no', obtenido: aplica({ comprador: { rol: 'LOC', id_padre: null, id_nodo_padre: null } }), esperado: false },
  { nombre: 'comprador DST no', obtenido: aplica({ comprador: { rol: 'DST', id_padre: 'DST-1', id_nodo_padre: 'DST-1' } }), esperado: false },
  { nombre: 'sin comprador no', obtenido: aplica({ comprador: null }), esperado: false },
  { nombre: 'solo id_padre tambien vale', obtenido: aplica({ comprador: { rol: 'LOC', id_padre: 'DST-1', id_nodo_padre: null } }), esperado: true },
  // ── Punto 2: sin precio no hay silencio ──
  { nombre: 'P2 todo con precio: abona y NO avisa', obtenido: [resuelve().fila?.monto, resuelve().aviso], esperado: [-1056, null] },
  { nombre: 'P2 una linea sin precio: abona el resto', obtenido: resuelve(SOLO_750).fila?.monto, esperado: -708 },
  { nombre: 'P2 una linea sin precio: avisa CUALES y no nombra la que si', obtenido: [/12x Plata 250ml \(sin precio de lista\); 24x Plata 50ml/, /Plata 750ml/].map((r) => r.test(resuelve(SOLO_750).aviso?.mensaje ?? '')), esperado: [true, false] },
  { nombre: 'P2 y el aviso dice que venta y que zona', obtenido: [/#B71A462A/, /Zona del local: Zacatecas/].map((r) => r.test(resuelve(SOLO_750).aviso?.mensaje ?? '')), esperado: [true, true] },
  { nombre: 'P2 y lo deja escrito en el asiento', obtenido: /No abonado: Plata 250ml \(sin precio de lista\), Plata 50ml/.test(resuelve(SOLO_750).fila?.descripcion ?? ''), esperado: true },
  { nombre: 'P2 una sola linea y sin precio: sin asiento, con aviso', obtenido: [resuelve({ piezas: [piezas[2]], ...SIN_PRECIO }).fila, /24x Plata 50ml/.test(resuelve({ piezas: [piezas[2]], ...SIN_PRECIO }).aviso?.mensaje ?? '')], esperado: [null, true] },
  { nombre: 'P2 error al leer precios: sin asiento, avisa las tres con el motivo', obtenido: [resuelve({}, { error: 'timeout' }).fila, /timeout/.test(resuelve({}, { error: 'timeout' }).aviso?.mensaje ?? ''), (resuelve({}, { error: 'timeout' }).aviso?.datos.lineas as unknown[] | undefined)?.length], esperado: [null, true, 3] },
  { nombre: 'P2 porcentaje fuera de rango: avisa', obtenido: /fuera de rango/.test(resuelve({ porcentajes: { local: -1, red: 0.15, base: 0.2 } }).aviso?.mensaje ?? ''), esperado: true },
  { nombre: 'P2 cantidad no entera: avisa', obtenido: /cantidad no entera/.test(resuelve({ piezas: [{ ...piezas[0], cantidad: 1.5 }] }).aviso?.mensaje ?? ''), esperado: true },
  { nombre: 'P2 neto 0 y sin precio: ni abona ni avisa (no hay hueco)', obtenido: resuelve({ ...SIN_PRECIO, porcentajes: { local: 0.05, red: 0.15, base: 0.2 } }), esperado: { fila: null, aviso: null } },
  { nombre: 'P2 si el calculo truena, no lanza: avisa', obtenido: [resuelve(TRUENA).fila, /fallo al calcular el abono: roto/.test(resuelve(TRUENA).aviso?.mensaje ?? '')], esperado: [null, true] },
  // ── La zona ──
  { nombre: 'zona: se queda con el precio mayor y brinca los nulos', obtenido: Array.from(preciosPublicos([{ id_producto: 'a', precio_final: 599 }, { id_producto: 'a', precio_final: 500 }, { id_producto: null, precio_final: 9 }, { id_producto: 'b', precio_final: null }])), esperado: [['a', 599]] },
  { nombre: 'zona vacia: no se cae a Zacatecas, avisa', obtenido: /Zona del local: \(vacia\)/.test(resuelve(SIN_PRECIO, { zona: '' }).aviso?.mensaje ?? ''), esperado: true },
  { nombre: 'zona Foraneo: se nombra la zona real', obtenido: /Zona del local: Foraneo/.test(resuelve(SIN_PRECIO, { zona: 'Foraneo' }).aviso?.mensaje ?? ''), esperado: true },
  // ── Punto 3: el saldo por pagar es efectivo ──
  { nombre: 'P3 David: la vista da -1044, se pinta 0', obtenido: saldoPorPagarSinAbonoLocal(-1044, 'DST-1', [filaAbono()]), esperado: 0 },
  { nombre: 'P3 con caja pendiente: 2956 de la vista son 4000', obtenido: saldoPorPagarSinAbonoLocal(2956, 'DST-1', [filaAbono()]), esperado: 4000 },
  { nombre: 'P3 un anulado no se suma', obtenido: saldoPorPagarSinAbonoLocal(0, 'DST-1', [filaAbono({ status: 'ANULADO' })]), esperado: 0 },
  { nombre: 'P3 un status nulo no se suma (la vista tampoco)', obtenido: saldoPorPagarSinAbonoLocal(0, 'DST-1', [filaAbono({ status: null })]), esperado: 0 },
  { nombre: 'P3 el abono de otra entidad no se suma', obtenido: saldoPorPagarSinAbonoLocal(0, 'DST-1', [filaAbono({ id_entidad_relacionada: 'DST-2' })]), esperado: 0 },
  { nombre: 'P3 un saldo a favor de verdad se sigue viendo', obtenido: saldoPorPagarSinAbonoLocal(-300, 'DST-1', [filaAbono({ categoria: 'ARRANQUE', monto: -300 })]), esperado: -300 },
  // ── Punto 4: como se lee ──
  { nombre: 'P4 el asiento negativo se reconoce', obtenido: esAbonoPorSurtirLocal(filaAbono()), esperado: true },
  { nombre: 'P4 un CARGO_DEUDA negativo de otra categoria NO es abono', obtenido: esAbonoPorSurtirLocal(filaAbono({ categoria: 'ARRANQUE' })), esperado: false },
  { nombre: 'P4 un COMISION_LOCAL positivo NO es abono', obtenido: esAbonoPorSurtirLocal(filaAbono({ monto: 1044 })), esperado: false },
  { nombre: 'P4 un ABONO_DEUDA no se confunde', obtenido: esAbonoPorSurtirLocal(filaAbono({ tipo_movimiento: 'ABONO_DEUDA' })), esperado: false },
  { nombre: 'P4 concepto con detalle por botella', obtenido: conceptoAbonoLocal(fila?.categoria_gasto), esperado: 'Abono por surtir a sus locales\n12x Plata 750ml ($59 c/u) = $708\n12x Plata 250ml ($17 c/u) = $204\n24x Plata 50ml ($6 c/u) = $144' },
  { nombre: 'P4 sin detalle: solo la etiqueta', obtenido: conceptoAbonoLocal(null), esperado: 'Abono por surtir a sus locales' },
  { nombre: 'P4 la fila del historial, normalizada como la normaliza la tabla', obtenido: TIPO_FILA_ABONO_LOCAL.replaceAll(' ', '_').toUpperCase(), esperado: 'ABONO_POR_SURTIR_A_SUS_LOCALES' },
  { nombre: 'W18 y W19 estan en el catalogo y son REVISAR', obtenido: [CATALOGO_AVISOS.W18?.severidad, CATALOGO_AVISOS.W19?.severidad], esperado: ['REVISAR', 'REVISAR'] },
  // ── Punto 1: el corte de un local propio avisa ──
  { nombre: 'P1 local propio con deuda: avisa con las tres cifras', obtenido: [/\$1405\.00/, /\$7967\.00/, /\$8720\.00/].map((r) => r.test(corte()?.mensaje ?? '')), esperado: [true, true, true] },
  { nombre: 'P1 sin deuda de consignacion no avisa', obtenido: corte({ deudaConsignacion: 0 }), esperado: null },
  { nombre: 'P1 local de otro no avisa', obtenido: corte({ esLocalPropio: false }), esperado: null },
  { nombre: 'P1 si no se pudo leer la deuda, avisa y lo dice', obtenido: /no se pudo leer/.test(corte({ deudaConsignacion: null })?.mensaje ?? ''), esperado: true },
  // -- v3: solo se abona lo que trae cargo --
  { nombre: 'v3 b71a462a: 24 de 50 ml con 22 cargadas, 2 sin abono', obtenido: Array.from(piezasSinCargo(libro(ANTES_DE_B71A), [[P.p750, 12], [P.p250, 12], [P.p50, 24]].map(([idProducto, cantidad]) => ({ idProducto: String(idProducto), cantidad: Number(cantidad) })))), esperado: [[P.p50, 2]] },
  { nombre: 'v3 b71a462a: y eso da -1044', obtenido: abono(DOS_DE_50)?.monto, esperado: -1044 },
  { nombre: 'v3 el asiento guarda las piezas que gasto: 12/12/22', obtenido: piezasDelAsiento(abono(DOS_DE_50)?.subcategoria), esperado: new Map([[P.p750, 12], [P.p250, 12], [P.p50, 22]]) },
  { nombre: 'v3 el formato del SQL se lee igual', obtenido: Object.fromEntries(piezasDelAsiento(SUBCATEGORIA_SQL) ?? []), esperado: { [P.p750]: 12, [P.p250]: 12, [P.p50]: 22 } },
  { nombre: 'v3 la pieza con cargo y sin precio tambien queda gastada', obtenido: piezasDelAsiento(abono(SOLO_750)?.subcategoria)?.get(P.p50), esperado: 24 },
  { nombre: 'v3 formatos que no se leen', obtenido: ['', null, undefined, 'hola', '[1]', '5', 'null', '{"a":"x"}', '{"a":-1}', '{"a":0}'].map((x) => piezasDelAsiento(x)), esperado: Array(10).fill(null) },
  { nombre: 'v3 asiento vacio legible', obtenido: piezasDelAsiento('{}'), esperado: new Map() },
  { nombre: 'v3 b71a con su SQL: cuenta 12/12/22, no 24', obtenido: derechos(libro(DAVID, [B71A])), esperado: [0, 0, 0] },
  { nombre: 'v3 b71a sin SQL: su salida se gasta completa', obtenido: derechos(libro(DAVID)), esperado: [0, 0, -2] },
  { nombre: 'v3 asiento de la v2 (sin piezas): cuenta todo su ticket', obtenido: derechos(libro(DAVID, [asiento(T.b71a, null)])), esperado: [0, 0, -2] },
  { nombre: 'v3 asiento de la v2: el folio en mayusculas es el mismo', obtenido: derechos(libro(DAVID, [asiento(T.b71a.toUpperCase(), null)])), esperado: [0, 0, -2] },
  { nombre: 'v3 negativo y vacio no se cree: cuenta todo su ticket', obtenido: derechos(libro(DAVID, [asiento(T.b71a, {})])), esperado: [0, 0, -2] },
  { nombre: 'v3 tras b71a, 10 mas = 0', obtenido: [abona(libro(DAVID, [B71A]), P.p50, 10), abona(libro(DAVID, [B71A]), P.p750, 10)], esperado: [0, 0] },
  { nombre: 'v3 tras b71a entran 12: 12 nuevas + 10 del arranque abona 12', obtenido: abona(libro([...DAVID, entra(P.p750, 12)], [B71A]), P.p750, 22), esperado: 12 },
  { nombre: 'v3 tras b71a entran 5 de 50: abona 5', obtenido: abona(libro([...DAVID, entra(P.p50, 5)], [B71A]), P.p50, 10), esperado: 5 },
  { nombre: 'v3 y en pesos son 12 x 59', obtenido: abono({ piezas: [{ ...piezas[0], cantidad: 22 }], piezasSinCargo: new Map([[P.p750, 10]]) })?.monto, esperado: -708 },
  { nombre: 'v3 auditor: E12 surte 12, el local devuelve 12, resurte = 0', obtenido: abona(libro([entra(P.p750, 12), ...VENDIO_12, regresaDelLocal(12)], [A12]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 auditor: lo mismo con arranque = 0', obtenido: abona(libro([...DOCE, ...VENDIO_12, regresaDelLocal(12)], [A12]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 auditor: ajuste +10 = 0', obtenido: abona(libro([ajuste(10)]), P.p750, 10), esperado: 0 },
  { nombre: 'v3 ajuste a la alza encima de 12 cargadas: 12', obtenido: abona(libro([...DOCE, ajuste(5)]), P.p750, 17), esperado: 12 },
  { nombre: 'v3 auditor: arranque 20 con cargo de $1 = 0', obtenido: abona(libro([arranque(P.p750, 20)], [cargoArranque(1)]), P.p750, 20), esperado: 0 },
  { nombre: 'v3 auditor: anula E1 ya surtida, recaptura E2, resurte = 0', obtenido: abona(libro([arranque(P.p750, 20), entra(P.p750, 12, { status: 'ANULADO' }), ...VENDIO_12, entra(P.p750, 12, { notas: `ticket:${T.recarga}`, fecha_movimiento: D25 })], [A12]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 anula E1 ya vendida al publico y recaptura: tampoco', obtenido: abona(libro([arranque(P.p750, 20), entra(P.p750, 12, { status: 'ANULADO' }), sale(12, { tipo_movimiento: 'SALIDA_VENTA' }), entra(P.p750, 12, { notas: `ticket:${T.recarga}`, fecha_movimiento: D25 })]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 auditor: dos ventas iguales en serie, la segunda 0', obtenido: [abona(libro(DOCE), P.p750, 12), abona(libro([...DOCE, ...VENDIO_12], [A12]), P.p750, 12)], esperado: [12, 0] },
  { nombre: 'v3 en serie: lo que queda', obtenido: abona(libro([...DOCE, surte(P.p750, 8, T.v1)], [asiento(T.v1, { [P.p750]: 8 })]), P.p750, 8), esperado: 4 },
  { nombre: 'v3 salida anulada sola, con su abono vivo: 0', obtenido: abona(libro([...DOCE, surte(P.p750, 12, T.v1, { status: 'ANULADO' })], [A12]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 surtido sin asiento: gasta cargadas', obtenido: abona(libro([...DOCE, ...VENDIO_12]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 surtido puro arranque (asiento en 0): no gasta', obtenido: abona(libro([...DOCE, ...VENDIO_12], [asiento(T.v1, {}, { monto: 0 })]), P.p750, 12), esperado: 12 },
  { nombre: 'v3 asiento sin ticket y sin piezas: lanza, no adivina', obtenido: /no dice que piezas/.test(lanza(() => derechoAbono(libro(DOCE, [asiento(null, null)]), P.p750))), esperado: true },
  { nombre: 'v3 asiento sin salidas vivas y sin piezas: lanza', obtenido: /no dice que piezas/.test(lanza(() => derechoAbono(libro([...DOCE, surte(P.p750, 12, T.v1, { status: 'ANULADO' })], [asiento(T.v1, null)]), P.p750))), esperado: true },
  { nombre: 'v3 un COMISION_LOCAL positivo no es abono', obtenido: abona(libro(DOCE, [asiento(T.v1, { [P.p750]: 12 }, { monto: 100 })]), P.p750, 12), esperado: 12 },
  { nombre: 'v3 la entrada cuyo ticket se anulo no da derecho', obtenido: abona(libro(DOCE, [], { ticketsVivos: new Set([T.recarga]) }), P.p750, 12), esperado: 0 },
  { nombre: 'v3 la entrada anulada no da derecho', obtenido: abona(libro([entra(P.p750, 12, { status: 'ANULADO' })]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 contado: 12 compradas y 12 surtidas = 12, como en la v2', obtenido: abona(libro([contado(12)]), P.p750, 12), esperado: 12 },
  { nombre: 'v3 contado: con arranque sin cubrir, solo las compradas', obtenido: abona(libro([arranque(P.p750, 20), contado(12)]), P.p750, 20), esperado: 12 },
  { nombre: 'v3 contado y carga: se suman', obtenido: abona(libro([contado(5), entra(P.p750, 12)]), P.p750, 20), esperado: 17 },
  { nombre: 'v3 contado: ya abonadas, 0', obtenido: abona(libro([contado(12), ...VENDIO_12], [A12]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 contado: vendidas al publico, 0', obtenido: abona(libro([contado(12), sale(12, { tipo_movimiento: 'SALIDA_VENTA' })]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 contado viejo: no se come una carga nueva', obtenido: abona(libro([arranque(P.p750, 30), contado(5, { fecha_movimiento: D20 }), sale(30, { tipo_movimiento: 'SALIDA_VENTA', fecha_movimiento: D23 }), entra(P.p750, 12, { fecha_movimiento: D25 })]), P.p750, 12), esperado: 12 },
  { nombre: 'v3 contado: anulada, vendida y recapturada, 0', obtenido: abona(libro([arranque(P.p750, 20), contado(12, { status: 'ANULADO' }), sale(12, { tipo_movimiento: 'SALIDA_VENTA' }), contado(12, { fecha_movimiento: D25 })]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 contado: ajuste a la alza encima, solo las compradas', obtenido: abona(libro([contado(12), ajuste(10)]), P.p750, 22), esperado: 12 },
  { nombre: 'v3 contado: el local devuelve 12 y resurte, 0', obtenido: abona(libro([contado(12), ...VENDIO_12, regresaDelLocal(12)], [A12]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 contado: compra sin ticket, de ticket que no es de contado, anulada, de ticket anulado, interna o ajena = 0', obtenido: [abona(libro([contado(6, { notas: null })]), P.p750, 6), abona(libro([contado(6, { notas: `ticket:${T.carga}` })]), P.p750, 6), abona(libro([contado(6, { status: 'ANULADO' })]), P.p750, 6), abona(libro([contado(6)], [], { ticketsContado: new Set() }), P.p750, 6), abona(libro([contado(6, { id_entidad_origen: 'DST-1' })]), P.p750, 6), abona(libro([contado(6, { id_entidad_destino: 'LOC-9' })]), P.p750, 6)], esperado: [0, 0, 0, 0, 0, 0] },
  { nombre: 'v3 contado sin ticket: tampoco con el arranque cubierto', obtenido: derechos(libro([...consignado(3, 3, 3), contado(6, { notas: null })], [cargoArranque(2040)])), esperado: [3, 3, 3] },
  { nombre: 'v3 devolucion del local con ticket vivo en la nota: no da', obtenido: abona(libro([entra(P.p750, 6, { tipo_movimiento: 'DEVOLUCION_FISICA', id_entidad_origen: 'LOC-1' })]), P.p750, 6), esperado: 0 },
  { nombre: 'v3 devolucion a la matriz: gasta cargadas', obtenido: abona(libro([...DOCE, sale(4, { tipo_movimiento: 'DEVOLUCION_FISICA', id_entidad_destino: 'ADMIN' })]), P.p750, 12), esperado: 8 },
  { nombre: 'v3 devolucion a la matriz que cita un ticket abonado: gasta', obtenido: abona(libro([entra(P.p750, 24), ...VENDIO_12, sale(4, { tipo_movimiento: 'DEVOLUCION_FISICA', notas: `ticket:${T.v1}` })], [A12]), P.p750, 12), esperado: 8 },
  { nombre: 'v3 venta al publico, corte y merma: gastan cargadas', obtenido: ['SALIDA_VENTA', 'LIQUIDACION_INTERNA', 'MERMA'].map((t) => abona(libro([...DOCE, sale(5, { tipo_movimiento: t })]), P.p750, 12)), esperado: [7, 7, 7] },
  { nombre: 'v3 venta al publico anulada: no gasta', obtenido: abona(libro([...DOCE, sale(5, { tipo_movimiento: 'SALIDA_VENTA', status: 'ANULADO' })]), P.p750, 12), esperado: 12 },
  { nombre: 'v3 ajuste a la baja: gasta cargadas', obtenido: abona(libro([...DOCE, ajuste(-3)]), P.p750, 12), esperado: 9 },
  { nombre: 'v3 lo que salio antes de la primera carga no se la come', obtenido: abona(libro([...DOCE, sale(8, { tipo_movimiento: 'SALIDA_VENTA', fecha_movimiento: D20 })]), P.p750, 12), esperado: 12 },
  { nombre: 'v3 mismo instante que la carga: la gasta', obtenido: abona(libro([...DOCE, sale(8, { tipo_movimiento: 'SALIDA_VENTA', fecha_movimiento: D23 })]), P.p750, 12), esperado: 4 },
  { nombre: 'v3 salida sin fecha: gasta', obtenido: abona(libro([...DOCE, sale(8, { tipo_movimiento: 'SALIDA_VENTA', fecha_movimiento: null })]), P.p750, 12), esperado: 4 },
  { nombre: 'v3 carga sin fecha: cualquier salida la gasta', obtenido: abona(libro([entra(P.p750, 12, { fecha_movimiento: null }), sale(8, { tipo_movimiento: 'SALIDA_VENTA', fecha_movimiento: D20 })]), P.p750, 12), esperado: 4 },
  { nombre: 'v3 media pieza no se abona', obtenido: derechoAbono(libro([entra(P.p750, 2.5)]), P.p750), esperado: 2 },
  { nombre: 'v3 DST nuevo, sin arranque: abona lo cargado', obtenido: abona(libro([...DAVID, entra(P.p750, 12, { id_entidad_destino: 'DST-NUEVO' })], [], { idDistribuidor: 'DST-NUEVO' }), P.p750, 15), esperado: 12 },
  { nombre: 'v3 movimiento interno del DST: no es carga, ni arranque que valuar', obtenido: [abona(libro([entra(P.p750, 12, { id_entidad_origen: 'DST-1' })]), P.p750, 12), abona(libro([entra(P.p750, 12), entra(P.p750, 4, { id_entidad_origen: 'DST-1' })]), P.p750, 12), arranqueCubierto(libro([...consignado(3, 3, 3), arranque(P.p750, 5, { id_entidad_origen: 'DST-1' })], [cargoArranque(2040)]))], esperado: [0, 8, true] },
  { nombre: 'v3 carga negativa: gasta una vez, no dos', obtenido: abona(libro([...DOCE, entra(P.p750, -3)]), P.p750, 12), esperado: 9 },
  { nombre: 'v3 arranque negativo: no abarata lo que hay que cubrir', obtenido: arranqueCubierto(libro([...consignado(3, 3, 3), arranque(P.p750, -1)], [cargoArranque(1560)])), esperado: false },
  { nombre: 'v3 salida guardada en negativo: cuenta igual en un asiento de la v2', obtenido: derechoAbono(libro([...DOCE, surte(P.p750, -12, T.v1)], [asiento(T.v1, null)]), P.p750), esperado: 0 },
  { nombre: 'v3 un cargo de arranque negativo no es un abono', obtenido: abona(libro(DOCE, [cargoArranque(-1)]), P.p750, 12), esperado: 12 },
  { nombre: 'v3 sin movimientos: 0', obtenido: abona(libro([]), P.p750, 5), esperado: 0 },
  { nombre: 'v3 la carga de otra entidad no da derecho', obtenido: abona(libro([entra(P.p750, 12, { id_entidad_destino: 'LOC-9' })]), P.p750, 12), esperado: 0 },
  { nombre: 'v3 la salida de otra entidad no gasta', obtenido: abona(libro([...DOCE, sale(5, { tipo_movimiento: 'SALIDA_VENTA', id_entidad_origen: 'LOC-9' })]), P.p750, 12), esperado: 12 },
  { nombre: 'v3 un producto no gasta el de otro', obtenido: abona(libro([...DOCE, surte(P.p50, 5, T.v2)], [asiento(T.v1, { [P.p50]: 5 }), asiento(T.v2, null)]), P.p750, 12), esperado: 12 },
  { nombre: 'v3 arranque: los cargos de Ale, Gilberto y Martin cubren', obtenido: TRES.map(arranqueCubierto), esperado: [true, true, true] },
  { nombre: 'v3 arranque: y sus piezas se abonan todas, ni una mas', obtenido: TRES.flatMap(derechos), esperado: [3, 3, 3, 12, 12, 12, 14, 3, 6] },
  { nombre: 'v3 arranque: Ale con un centavo menos no cubre', obtenido: derechos(libro(consignado(3, 3, 3), [cargoArranque(2039.99)])), esperado: [0, 0, 0] },
  { nombre: 'v3 arranque: manda el costo de su renglon, un peso mas ya no cubre', obtenido: arranqueCubierto(libro([arranque(P.p750, 3, { costo_unitario_movimiento: 481 }), arranque(P.p250, 3), arranque(P.p50, 3)], [cargoArranque(2040)])), esperado: false },
  { nombre: 'v3 arranque: el costo llega como texto (numeric)', obtenido: arranqueCubierto(libro([arranque(P.p750, 3, { costo_unitario_movimiento: '480.0000' })], [cargoArranque(1440)])), esperado: true },
  { nombre: 'v3 arranque: los decimales del costo no se redondean por pieza', obtenido: [100.49, 100.5].map((c) => arranqueCubierto(libro([arranque(P.p750, 100, { costo_unitario_movimiento: 1.005 })], [cargoArranque(c)]))), esperado: [false, true] },
  { nombre: 'v3 arranque: si cubre menos no cuenta ninguna, ni la del producto que si alcanza', obtenido: derechos(libro(consignado(14, 3, 6), [cargoArranque(7487)])), esperado: [0, 0, 0] },
  { nombre: 'v3 arranque: un renglon en 0 o nulo, no cuenta ninguno', obtenido: [0, null].flatMap((c) => derechos(libro([arranque(P.p750, 3, { costo_unitario_movimiento: c }), arranque(P.p50, 3)], [cargoArranque(9999)]))), esperado: [0, 0, 0, 0, 0, 0] },
  { nombre: 'v3 arranque sin costo: avisa que ticket, que piezas y por que', obtenido: avisaSinCosto(SIN_COSTO), esperado: { mensaje: 'Ticket #2A2A2A2A a Local de prueba: revisa el abono. No se abonaron 3x Plata 750ml: el arranque del distribuidor tiene cargo, pero le falta el costo unitario a un renglon y no se sabe si lo cubre.', datos: { id_ticket: T.v2, id_distribuidor: 'DST-1', motivo: 'arranque sin costo unitario', lineas: [{ etiqueta: 'Plata 750ml', piezas: 3 }] } } },
  { nombre: 'v3 arranque sin costo: no avisa con costos, sin cargo vivo, si nada quedo sin abono, o si el producto no es de arranque', obtenido: [avisaSinCosto(ALE), avisaSinCosto({ ...SIN_COSTO, cargos: [] }), avisaSinCosto(SIN_COSTO, new Map()), avisaSinCosto(SIN_COSTO, new Map([[P.p250, 2]]))], esperado: [null, null, null, null] },
  { nombre: 'v3 arranque sin costo: un renglon anulado no avisa', obtenido: avisaSinCosto(libro([arranque(P.p750, 3), arranque(P.p750, 9, { costo_unitario_movimiento: 0, status: 'ANULADO' })], [cargoArranque(2040)])), esperado: null },
  { nombre: 'v3 arranque: dos cargos vivos se suman', obtenido: arranqueCubierto(libro(consignado(3, 3, 3), [cargoArranque(2000), cargoArranque(40)])), esperado: true },
  { nombre: 'v3 arranque: un cargo negativo, de otra categoria o de otro tipo no cubre', obtenido: [cargoArranque(-2040), cargoArranque(2040, { categoria: 'OTRA' }), cargoArranque(2040, { tipo_movimiento: 'ABONO_DEUDA' })].map((c) => arranqueCubierto(libro(consignado(3, 3, 3), [c]))), esperado: [false, false, false] },
  { nombre: 'v3 arranque: un cargo negativo no resta ni suma', obtenido: arranqueCubierto(libro(consignado(3, 3, 3), [cargoArranque(2040), cargoArranque(-1)])), esperado: true },
  { nombre: 'v3 arranque: la pieza anulada no se valua', obtenido: arranqueCubierto(libro([...consignado(3, 3, 3), arranque(P.p750, 50, { status: 'ANULADO' })], [cargoArranque(2040)])), esperado: true },
  { nombre: 'v3 arranque: lo cargado con ticket no se valua como arranque', obtenido: derechos(libro([...consignado(3, 3, 3), entra(P.p750, 50)], [cargoArranque(2040)])), esperado: [53, 3, 3] },
  { nombre: 'v3 arranque: sin piezas no hay nada cubierto', obtenido: arranqueCubierto(libro([], [cargoArranque(2040)])), esperado: false },
  { nombre: 'v3 arranque cubierto y ya surtido: 0', obtenido: abona(libro([...consignado(3, 3, 3), surte(P.p750, 3, T.v1)], [cargoArranque(2040), asiento(T.v1, { [P.p750]: 3 })]), P.p750, 3), esperado: 0 },
  { nombre: 'v3 arranque con su cargo anulado (David): 0', obtenido: abona(libro([arranque(P.p750, 10)]), P.p750, 10), esperado: 0 },
  { nombre: 'v3 a la vez: las dos abonaron 12 de 12, avisa', obtenido: /revisa el abono.*12x Plata 750ml/.test(avisoAbonoDeMas(libro([...DOCE, ...VENDIO_12, surte(P.p750, 12, T.v2)], [A12, asiento(T.v2, { [P.p750]: 12 })]), DE_MAS)?.mensaje ?? ''), esperado: true },
  { nombre: 'v3 a la vez: el aviso dice de que ticket y cuantas', obtenido: avisoAbonoDeMas(libro([...DOCE, ...VENDIO_12, surte(P.p750, 12, T.v2)], [A12, asiento(T.v2, { [P.p750]: 12 })]), DE_MAS)?.datos, esperado: { id_ticket: T.v2, id_distribuidor: 'DST-1', motivo: 'movimientos a la vez', lineas: [{ etiqueta: 'Plata 750ml', deMas: 12 }] } },
  { nombre: 'v3 a la vez: una sola venta no avisa', obtenido: avisoAbonoDeMas(libro([...DOCE, surte(P.p750, 12, T.v2)], [asiento(T.v2, { [P.p750]: 12 })]), DE_MAS), esperado: null },
  { nombre: 'v3 a la vez: un producto que esta venta no abono no avisa', obtenido: avisoAbonoDeMas(libro(DAVID), { ...DE_MAS, subcategoria: JSON.stringify({ [P.p250]: 1 }) }), esperado: null },
  {
    nombre: 'v3 el historial dice cuantas no llevaron abono y por que',
    obtenido: abono(DOS_DE_50)?.categoria_gasto,
    esperado: 'Abono por surtir a Local de prueba - Ticket #B71A462A\n12x Plata 750ml ($59 c/u) = $708\n12x Plata 250ml ($17 c/u) = $204\n22x Plata 50ml ($6 c/u) = $132\nSin abono: 2x Plata 50ml (sin cargo por abonar)'
  },
  {
    nombre: 'v3 ninguna con cargo: asiento en 0 que lo dice, sin aviso',
    obtenido: [resuelve(DIEZ_Y_DIEZ).fila?.monto, resuelve(DIEZ_Y_DIEZ).fila?.categoria_gasto, resuelve(DIEZ_Y_DIEZ).fila?.subcategoria, resuelve(DIEZ_Y_DIEZ).aviso],
    esperado: [0, 'Abono por surtir a Local de prueba - Ticket #B71A462A\nSin abono: 10x Plata 750ml (sin cargo por abonar)\nSin abono: 10x Plata 50ml (sin cargo por abonar)', '{}', null]
  },
  { nombre: 'v3 el asiento en 0 dice que no mueve la deuda', obtenido: [abono(DIEZ_Y_DIEZ), abono()].map((x) => x?.descripcion.split(':')[0]), esperado: ['No mueve la deuda del distribuidor', 'Baja la deuda del distribuidor'] },
  { nombre: 'v3 el asiento en 0 se lee como abono y no mueve el saldo', obtenido: [esAbonoPorSurtirLocal(filaAbono({ monto: 0 })), saldoPorPagarSinAbonoLocal(500, 'DST-1', [filaAbono({ monto: 0 })])], esperado: [true, 500] },
  { nombre: 'v3 neto 0: ni asiento en 0', obtenido: abono({ ...DIEZ_Y_DIEZ, porcentajes: { local: 0.05, red: 0.15, base: 0.2 } }), esperado: null },
  { nombre: 'v3 red al 10%: el abono sale de sus propias tasas (5%)', obtenido: abono({ piezas: [piezas[0]], porcentajes: { local: 0.15, red: 0.1, base: 0.2 } })?.monto, esperado: -348 },
  { nombre: 'v3 sin cargo y sin precio: no avisa, no habia que abonar', obtenido: resuelve({ ...DIEZ_Y_DIEZ, ...SIN_PRECIO }).aviso, esperado: null },
  { nombre: 'v3 mitad sin cargo y sin precio: avisa solo las que si', obtenido: /: 22x Plata 50ml \(sin precio de lista\)/.test(resuelve({ piezas: [piezas[2]], ...DOS_DE_50, ...SIN_PRECIO }).aviso?.mensaje ?? ''), esperado: true },
  { nombre: 'v3 la lectura falla: no abona y avisa con el motivo', obtenido: [resuelve({}, { error: 'no se pudo saber que piezas traen cargo: timeout' }).fila, /SIN el abono.*piezas traen cargo: timeout/.test(resuelve({}, { error: 'no se pudo saber que piezas traen cargo: timeout' }).aviso?.mensaje ?? '')], esperado: [null, true] },
  // -- v3: como se ve en el historial --
  { nombre: 'v3 historial: el asiento del SQL y el del codigo dicen lo mismo', obtenido: abono(COMO_EL_SQL)?.categoria_gasto, esperado: TEXTO_SQL },
  { nombre: 'v3 historial: los renglones suman lo que dice el monto', obtenido: [sumaRenglones(TEXTO_SQL), sumaRenglones(abono(COMO_EL_SQL)?.categoria_gasto ?? ''), abono(COMO_EL_SQL)?.monto], esperado: [1044, 1044, -1044] },
  { nombre: 'v3 historial: el monto se lee -$1,044.00 y el de ninguna con cargo $0.00', obtenido: [peso(-1044), peso(Number(abono(DIEZ_Y_DIEZ)?.monto))], esperado: ['-$1,044.00', '$0.00'] },
  { nombre: 'v3 historial: la etiqueta', obtenido: TIPO_FILA_ABONO_LOCAL, esperado: 'ABONO POR SURTIR A SUS LOCALES' },
  { nombre: 'v3 historial: sin cuenta y sin Anular, con su motivo', obtenido: JSON.stringify({ cuentaContexto: 'Cuenta Matriz -> Cuenta Matriz', ...renglonAbonoLocal(filaAbono()) }), esperado: JSON.stringify({ annulDisabled: true, annulDisabledReason: MOTIVO_ABONO_SIN_ANULAR }) },
  { nombre: 'v3 historial: el motivo dice que arrastraria la venta', obtenido: /venta completa/.test(MOTIVO_ABONO_SIN_ANULAR), esperado: true },
  { nombre: 'v3 historial: un cargo cualquiera conserva cuenta y Anular', obtenido: renglonAbonoLocal(filaAbono({ categoria: 'ARRANQUE', monto: 500 })), esperado: {} },
  { nombre: 'v3 historial: el asiento es del DST, no del local', obtenido: abono()?.id_entidad_relacionada, esperado: 'DST-1' }
]

/** Quita comentarios de linea y de bloque: se juzga el codigo, no la prosa. */
const codigo = (f: string) => f.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

/** El cableado, leido del codigo fuente: [nombre, se cumple]. `f` = fuente por ruta. */
export function cableado(f: Record<string, string>): Array<[string, boolean]> {
  const venta = codigo(f.venta)
  const iBloque = venta.indexOf('correspondeAbonoLocal({')
  const iPush = venta.indexOf('if (abonoLocal.fila) movimientosComisionTriangulacionYAdmin.push(abonoLocal.fila)')
  const iRpc = venta.indexOf("supabase.rpc('registrar_venta_atomica'")
  const iFallo = venta.indexOf('if (ventaError)')
  const iAviso = venta.indexOf("tipo: 'W19'")
  const iRelee = venta.indexOf('if (abonoEscrito)')
  const iLector = venta.indexOf('async function leerLibroAbono(')
  const lector = iLector > 0 ? venta.slice(iLector, venta.indexOf('export async function registrarVenta(')) : ''
  const bloque = iBloque > 0 && iPush > iBloque ? venta.slice(iBloque, iPush) : ''
  const corteF = codigo(f.auditoria)
  const iDetalles = corteF.indexOf('if (detallesError)')
  const iW18 = corteF.indexOf("tipo: 'W18'")
  const feeds: Array<[string, boolean]> = (['feedV1', 'feedV2', 'feedUtils'] as const).map((k): [string, boolean] => [
    `P4 ${k}: pide la categoria y decide con esAbonoPorSurtirLocal, no con monto < 0`,
    /\bcategoria,\s*(entidad:|id_ticket)/.test(codigo(f[k])) &&
      codigo(f[k]).includes('esAbonoPorSurtirLocal(finanza)') &&
      !/CARGO_DEUDA'\s*&&\s*finanza\.monto\s*<\s*0/.test(codigo(f[k]))
  ])
  const saldos: Array<[string, boolean]> = (['perfilV1', 'perfilV2', 'directorioV1', 'directorioV2'] as const).map((k): [string, boolean] => [
    `P3 ${k}: el saldo por pagar pasa por saldoPorPagarSinAbonoLocal`,
    /saldoPorPagarSinAbonoLocal\(\s*Number\(\w+\?\.saldo_por_pagar_efectivo \?\? 0\)/.test(codigo(f[k])) &&
      (codigo(f[k]).match(/saldo_por_pagar_efectivo/g) ?? []).length === 1
  ])
  return [
    ['la venta llama al abono antes de la RPC', iBloque > 0 && iPush > iBloque && iRpc > iPush],
    ['usa la lista `p_finanzas` de la RPC atomica', /p_finanzas: \[\s*\.\.\.movimientosFinancieros,\s*\.\.\.movimientosComisionTriangulacionYAdmin/.test(venta)],
    ['zona: el precio sale de listas_precios por la zona del LOCAL', bloque.includes("from('listas_precios')") && bloque.includes(".eq('zona', zonaLocal)") && bloque.includes("const zonaLocal = (compradorEntidad.zona ?? '').trim()")],
    ['zona: sin caida silenciosa a Zacatecas', bloque !== '' && !bloque.includes("'Zacatecas'")],
    ['no usa el precio del payload', bloque !== '' && !/payload\.|precio_unitario/.test(bloque)],
    ['el origen es el que resolvio el servidor', /^\s*origenInventarioId,$/m.test(bloque)],
    ['comision local del LOC, red y base del DST', /local: compradorEntidad\.comision_base_local,\s*red: vendedor\.comision_hijo_local,\s*base: vendedor\.comision_base\s/.test(bloque)],
    ['la fiscalidad sale de la cuenta', bloque.includes('esCuentaFiscal: esCuentaFiscal(cuentaData.tipo_fiscalidad)')],
    ['P2 el error de precios llega al aviso', bloque.includes('errorPrecios = preciosError.message') && bloque.includes('error: errorPrecios')],
    ['P2 una excepcion al leer precios no tumba la venta', /catch \(e\) \{\s*errorPrecios =/.test(bloque)],
    ['P2 el aviso va DESPUES de la venta y apunta al ticket', iFallo > iRpc && iAviso > iFallo && /tipo: 'W19',[\s\S]{0,200}tabla: 'transacciones_tickets',\s*idRegistro: idTicket/.test(venta)],
    ['v3 lee el libro del DST: todos sus productos, por sus dos lados, con el status', /fetchTodasLasFilas<MovimientoAbono>\([\s\S]{0,80}from\('inventario_ledger'\)\s*\.select\('id_producto, tipo_movimiento, cantidad, id_entidad_origen, id_entidad_destino, fecha_movimiento, costo_unitario_movimiento, notas, status'\)\s*\.or\(`id_entidad_destino\.eq\.\$\{idDst\},id_entidad_origen\.eq\.\$\{idDst\}`\)\s*\.order\('id'\)/.test(lector)],
    ['v3 los cargos: solo vivos, de ese DST, del abono y del arranque, con sus piezas', /\.select\('id_ticket, tipo_movimiento, categoria, monto, subcategoria'\)\s*\.eq\('id_entidad_relacionada', idDst\)\s*\.eq\('tipo_movimiento', TIPO_ABONO_LOCAL\)\s*\.in\('categoria', \[CATEGORIA_ABONO_LOCAL, 'ARRANQUE'\]\)\s*\.in\('status', \['ACTIVO', 'APPROVED'\]\)/.test(lector)],
    ['v3 los tickets: activos y con el DST de comprador', lector.includes("from('transacciones_tickets').select('id, condicion_pago').eq('id_comprador', idDst).eq('status', 'ACTIVO').order('id')") && lector.includes('ticketsVivos: new Set(tickets.map((t) => t.id.toLowerCase()))') && lector.includes("ticketsContado: new Set(tickets.filter((t) => t.condicion_pago === 'CONTADO').map((t) => t.id.toLowerCase()))")],
    ['v3 las lecturas del libro van a la vez', /const \[movimientos, cargos, tickets\] = await Promise\.all\(\[\s*fetchTodasLasFilas</.test(lector) && (lector.match(/await /g) ?? []).length === 1 && !lector.includes('listas_precios')],
    ['v3 el arranque sin costo avisa W19 despues de escribir', /if \(libro && !errorCargo\) \{\s*avisoArranque = avisoArranqueSinCosto\(libro, sinCargo, /.test(venta) && iFallo > 0 && venta.indexOf('if (avisoArranque) await avisaAbono(avisoArranque)') > iFallo],
    ['v3 una lectura rota no tumba la venta y llega al aviso', /try \{\s*libro = await leerLibroAbono\(supabase, vendedor\.id\)\s*sinCargo = piezasSinCargo\(libro, piezasVendidas\)\s*\} catch \(e\) \{\s*errorCargo =/.test(bloque) && bloque.includes('error: errorPrecios ?? errorCargo')],
    ['v3 lo que no trae cargo llega al calculo', /const piezasVendidas = Array\.from\(cantidadPorProducto,/.test(bloque) && /^\s*piezasSinCargo: sinCargo,$/m.test(bloque)],
    ['v3 a la vez: se relee DESPUES de escribir, con tope, y nunca lanza', iFallo > 0 && iRelee > iFallo && /if \(abonoEscrito\) \{\s*let deMas: AvisoAbonoLocal \| null = null\s*try \{\s*deMas = avisoAbonoDeMas\(await conTope\(leerLibroAbono\(supabase, vendedor\.id\)\), abonoEscrito\)\s*\} catch \(e\) \{\s*console\.error\('abono local[^\n]*\n\s*deMas = \{[\s\S]{0,400}motivo: 'sin comprobar' \}\s*\}\s*\}\s*if \(deMas\) await avisaAbono\(deMas\)/.test(venta.slice(iRelee))],
    ['v3 el aviso tambien va con tope y sin lanzar', /const avisaAbono = \(aviso: AvisoAbonoLocal\) =>\s*conTope\(\s*registrarAviso\(supabase, \{\s*tipo: 'W19',[\s\S]{0,260}\)\s*\)\.catch\(\(e\) => console\.error\('abono local: no se pudo avisar'/.test(venta)],
    ['v3 el tope es corto y suelta el reloj', /const TOPE_REVISION_MS = 1000\n/.test(venta) && /setTimeout\(\(\) => falla\(new Error\([^\n]*\)\), TOPE_REVISION_MS\)/.test(venta) && venta.includes('Promise.race([tarea, tope]).finally(() => clearTimeout(reloj))')],
    ['v3 a la vez: compara las piezas del asiento que escribio', /if \(abonoLocal\.fila\) \{\s*abonoEscrito = \{[\s\S]{0,160}subcategoria: abonoLocal\.fila\.subcategoria,/.test(venta)],
    ['v3 la ficha pega el renglon del abono al final de la fila', [f.perfilV1, f.perfilV2].every((x) => /\{ annulTarget: \{ kind: 'LEDGER' as const, id: finanza\.id \} \}\),\s*\.\.\.renglonAbonoLocal\(finanza\)\s*\}\)/.test(codigo(x)))],
    ['v3 el permiso no vuelve a prender Anular en el abono', [f.perfilV1, f.perfilV2].every((x) => codigo(x).includes('if (!row.annulTarget || row.annulDisabled) return row'))],
    ['v3 el renglon solo sale en la ficha de su dueno (el DST, no el local)', [f.perfilV1, f.perfilV2].every((x) => codigo(x).includes('const finanzasEntidad = finanzas.filter((finanza) => finanza.id_entidad_relacionada === idEntidad)') && /finanzasEntidad\s*\.filter\(f => !!f\.fecha_movimiento\)\s*\.forEach\(finanza/.test(codigo(x)))],
    ['v3 la referencia del abono es su categoria_gasto, renglon por renglon', [f.perfilV1, f.perfilV2].every((x) => codigo(x).includes("return finanza.categoria_gasto || 'Movimiento financiero'")) && [f.historialV1, f.historialV2].every((x) => (codigo(x).match(/whitespace-pre-line[^>]*>\{actividad\.referencia\}/g) ?? []).length === 2)],
    ['v3 el monto del abono se pinta tal cual, con su signo', [f.historialV1, f.historialV2].every((x) => /\+\$\{formatCurrency\(actividad\.monto\)\}`\s*: formatCurrency\(actividad\.monto\)/.test(codigo(x)) && (codigo(x).match(/FILA_ABONO_LOCAL/g) ?? []).length === 5)],
    ['v3 Anular apagado no hace nada, en tabla y en tarjeta', [f.historialV1, f.historialV2].every((x) => codigo(x).includes('if (!row.annulTarget || row.annulDisabled || isPending) return') && (codigo(x).match(/disabled=\{Boolean\(actividad\.annulDisabled\)/g) ?? []).length === 2)],
    ['v3 en computadora solo la tabla: la regla de las tarjetas de celular', /@media \(min-width: 48rem\) \{\s*\.v2 \.grid\.md\\:hidden \{ display: none; \}\s*\}/.test(codigo(f.estilosV2))],
    ...(['historialV2', 'directorioTabla', 'cobranzaTabla', 'aprobacionesTabla'] as const).map((k): [string, boolean] => [
      `v3 ${k}: una tabla de computadora y unas tarjetas de celular`,
      (codigo(f[k]).match(/hidden w-full overflow-x-auto md:block/g) ?? []).length === 1 && (codigo(f[k]).match(/className="grid [^"]*md:hidden"/g) ?? []).length === 1
    ]),
    ['P1 el corte avisa despues de escribir, y no lanza', iDetalles > 0 && iW18 > iDetalles && /if \(avisoCorte\) \{\s*await registrarAviso\(supabase, \{\s*tipo: 'W18',/.test(corteF) && !/throw/.test(corteF.slice(corteF.indexOf('const avisoCorte'), iW18 + 200))],
    ['P1 el calculo del corte sigue igual', corteF.includes('montoAdmin = Math.ceil(totalCobranza * (1 - comisionDecimal))') && corteF.includes('montoDST = totalCobranza - montoAdmin')],
    ...saldos,
    ...feeds,
    ['P4 historial v1 en verde (etiqueta y monto)', (codigo(f.historialV1).match(/FILA_ABONO_LOCAL/g) ?? []).length >= 5],
    ['P4 historial v2 en verde (etiqueta y monto)', (codigo(f.historialV2).match(/FILA_ABONO_LOCAL/g) ?? []).length >= 5],
    ['P4 perfil v1 y v2 ponen la etiqueta', [f.perfilV1, f.perfilV2].every((x) => codigo(x).includes('tipo: esAbonoPorSurtirLocal(finanza) ? TIPO_FILA_ABONO_LOCAL : getTipoFinanza('))],
    ['P4 documento: pide el asiento y usa el concepto', codigo(f.documento).includes('categoria.eq.${CATEGORIA_ABONO_LOCAL}') && codigo(f.documento).includes('esAbonoPorSurtirLocal(row) ? conceptoAbonoLocal(row.categoria_gasto)')],
    ['P4 bot: decide con la regla compartida', codigo(f.bot).includes('esAbonoPorSurtirLocal(d)')],
    ['P5 el comentario ya no dice «la deuda baja y nada mas»', !/baja y nada mas/.test(f.abono) && /saldo_por_pagar_efectivo/.test(f.abono)],
    // Solo DOCUMENTA el hueco: la devolucion LOC -> DST hoy no revierte el abono. Es
    // decision de Norman. Si un dia se implementa, esta linea se pone roja y hay que
    // sustituirla por la prueba de verdad.
    ['P5 (documento) la devolucion hoy NO revierte el abono', f.devoluciones.length > 0 && !/COMISION_LOCAL|abono-local/.test(f.devoluciones + f.inventario)]
  ]
}
