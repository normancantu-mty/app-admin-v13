/**
 * Casos de `lib/abono-local.ts`, sin framework. Los corre
 * `tests/abono-local.spec.ts`. Cada caso devuelve lo obtenido y lo esperado.
 */
import {
  TIPO_FILA_ABONO_LOCAL,
  avisoCorteLocalPropio,
  conceptoAbonoLocal,
  construirAbonoLocal,
  correspondeAbonoLocal,
  esAbonoPorSurtirLocal,
  preciosPublicos,
  resolverAbonoLocal,
  saldoPorPagarSinAbonoLocal
} from '../lib/abono-local'
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
  { nombre: 'P1 si no se pudo leer la deuda, avisa y lo dice', obtenido: /no se pudo leer/.test(corte({ deudaConsignacion: null })?.mensaje ?? ''), esperado: true }
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
