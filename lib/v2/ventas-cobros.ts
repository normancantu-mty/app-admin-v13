/**
 * Front v2 — "Vendido y cobrado por mes": aritmetica PURA de la tarjeta del panel.
 * Escrito el 2026-10-30 por un ejecutor del Socio (encargo de Norman: la tarjeta
 * con botones de periodo y de agrupado, dinamica).
 *
 * Sin red ni base: el servidor arma los HECHOS agregados (mes x producto x cliente
 * x canal) una vez y el navegador los filtra y agrupa en cada clic. Se prueba en
 * `tests/v2-ventas-cobros.spec.ts` con datos falsos.
 *
 * Reglas:
 *  - Vendido = `total_cobrado_real` de los tickets ACTIVO (lo mismo que suma
 *    `v_ventas_por_mes`), por mes en hora de Mexico. Por producto se reparte el
 *    total del ticket en proporcion a `subtotal_linea`, para que la suma por
 *    producto de EXACTAMENTE lo mismo que la suma general (un descuento de ticket
 *    no desaparece al agrupar).
 *  - Cobrado = lo que ENTRO a las cuentas de la matriz por INGRESO_VENTA o
 *    ABONO_DEUDA, con el WHERE de `saldo_cuenta` (ACTIVO/APPROVED, nunca
 *    ABONO_PENDIENTE). Account_Firewall: un abono de un local a su distribuidor no
 *    es cobro de la matriz. Por producto NO existe (un abono no dice que producto paga).
 */

import { mesMx, rangoMeses } from './formato'
import { CATEGORIA_QUE_NO_CUENTA, STATUS_QUE_CUENTAN } from './dinero'

export type Canal = 'CONTADO' | 'CONCESION'
export type Periodo = '3m' | '6m' | '12m' | 'anio' | 'todo'
export type Grupo = 'general' | 'producto' | 'cliente' | 'canal'
export type Metrica = 'pesos' | 'piezas'
export type Alcance = 'matriz' | 'red'

export const SIN_CLIENTE = '_sin'
export const SIN_PRODUCTO = '_sin'
export const OTROS = '_otros'

export const NOMBRE_CANAL: Record<Canal, string> = { CONTADO: 'Contado', CONCESION: 'Concesión' }

/** Un renglon agregado de venta: mes x producto x cliente x canal x quien vendio. */
export interface HechoVenta {
  mes: string
  prod: string
  cli: string
  canal: Canal
  /** el vendedor es una entidad ADMIN (la matriz) */
  matriz: boolean
  pesos: number
  piezas: number
}

/** Un renglon agregado de cobro de la matriz: mes x cliente x canal. */
export interface HechoCobro {
  mes: string
  cli: string
  canal: Canal
  pesos: number
}

export interface DatosVentasCobros {
  ventas: HechoVenta[]
  cobros: HechoCobro[]
  productos: Record<string, string>
  clientes: Record<string, { nombre: string; rol: string }>
}

// ── Filas crudas (lo que devuelve la base) ──

export interface TicketCrudo {
  id: string
  fecha_transaccion: string | null
  condicion_pago: string
  id_comprador: string | null
  id_vendedor: string | null
  total_cobrado_real: number | string
  ticket_detalles: {
    id_producto: string | null
    cantidad: number | string
    subtotal_linea: number | string
    /** muchos-a-uno: PostgREST manda un objeto; el tipo inferido sin esquema dice arreglo. Se aceptan los dos. */
    catalogo_productos: { nombre: string } | { nombre: string }[] | null
  }[]
}

export interface CobroCrudo {
  monto: number | string
  fecha_movimiento: string | null
  tipo_movimiento: string
  status: string | null
  categoria: string | null
  id_ticket: string | null
  id_entidad_relacionada: string | null
  id_cuenta_destino: string | null
}

const n = (v: unknown) => Number(v) || 0
const r2 = (v: number) => Math.round(v * 100) / 100
const canalDe = (c: string | null | undefined): Canal => (c === 'CONCESION' ? 'CONCESION' : 'CONTADO')
const STATUS_OK = new Set<string>(STATUS_QUE_CUENTAN)
const nombreProducto = (c: TicketCrudo['ticket_detalles'][number]['catalogo_productos']): string =>
  (Array.isArray(c) ? c[0]?.nombre : c?.nombre) ?? 'Producto sin nombre'

/** Arma los hechos agregados a partir de los tickets y los cobros crudos. */
export function armarVentasCobros(
  tickets: TicketCrudo[],
  cobros: CobroCrudo[],
  idsCuentasMatriz: ReadonlySet<string>,
  entidades: ReadonlyMap<string, { nombre: string; rol: string }>
): DatosVentasCobros {
  const productos: Record<string, string> = {}
  const clientes: Record<string, { nombre: string; rol: string }> = {}
  const ventas = new Map<string, HechoVenta>()
  const porTicket = new Map<string, { cli: string; canal: Canal }>()

  const cliente = (id: string | null): string => {
    if (!id) return SIN_CLIENTE
    if (!clientes[id]) clientes[id] = entidades.get(id) ?? { nombre: 'Entidad sin nombre', rol: '' }
    return id
  }

  for (const t of tickets) {
    const cli = cliente(t.id_comprador)
    const canal = canalDe(t.condicion_pago)
    porTicket.set(t.id, { cli, canal })
    if (!t.fecha_transaccion) continue
    const mes = mesMx(t.fecha_transaccion)
    const matriz = entidades.get(t.id_vendedor ?? '')?.rol === 'ADMIN'
    const total = n(t.total_cobrado_real)
    const lineas = t.ticket_detalles ?? []
    const suma = lineas.reduce((a, l) => a + n(l.subtotal_linea), 0)
    const partes =
      lineas.length && suma > 0
        ? lineas.map((l) => ({
            prod: l.id_producto ?? SIN_PRODUCTO,
            nombre: nombreProducto(l.catalogo_productos),
            pesos: (total * n(l.subtotal_linea)) / suma,
            piezas: n(l.cantidad)
          }))
        : [
            {
              prod: SIN_PRODUCTO,
              nombre: 'Sin detalle',
              pesos: total,
              piezas: lineas.reduce((a, l) => a + n(l.cantidad), 0)
            }
          ]
    for (const p of partes) {
      if (!productos[p.prod]) productos[p.prod] = p.nombre
      const k = `${mes}|${p.prod}|${cli}|${canal}|${matriz ? 1 : 0}`
      const h = ventas.get(k) ?? { mes, prod: p.prod, cli, canal, matriz, pesos: 0, piezas: 0 }
      h.pesos += p.pesos
      h.piezas += p.piezas
      ventas.set(k, h)
    }
  }

  const cobrosAg = new Map<string, HechoCobro>()
  for (const c of cobros) {
    if (c.tipo_movimiento !== 'INGRESO_VENTA' && c.tipo_movimiento !== 'ABONO_DEUDA') continue
    if (!STATUS_OK.has(c.status ?? '') || c.categoria === CATEGORIA_QUE_NO_CUENTA) continue
    if (!c.id_cuenta_destino || !idsCuentasMatriz.has(c.id_cuenta_destino)) continue
    if (!c.fecha_movimiento) continue
    const t = c.id_ticket ? porTicket.get(c.id_ticket) : undefined
    // Sin ticket: un abono paga deuda de concesion; un ingreso suelto es contado.
    const canal: Canal = t?.canal ?? (c.tipo_movimiento === 'ABONO_DEUDA' ? 'CONCESION' : 'CONTADO')
    const cli = t?.cli ?? (c.tipo_movimiento === 'ABONO_DEUDA' ? cliente(c.id_entidad_relacionada) : SIN_CLIENTE)
    const mes = mesMx(c.fecha_movimiento)
    const k = `${mes}|${cli}|${canal}`
    const h = cobrosAg.get(k) ?? { mes, cli, canal, pesos: 0 }
    h.pesos += n(c.monto)
    cobrosAg.set(k, h)
  }

  return {
    ventas: [...ventas.values()].map((h) => ({ ...h, pesos: r2(h.pesos) })),
    cobros: [...cobrosAg.values()].map((h) => ({ ...h, pesos: r2(h.pesos) })),
    productos,
    clientes
  }
}

// ── Lo que hace el navegador en cada clic ──

function mesMenos(mes: string, k: number): string {
  const [y, m] = mes.split('-').map(Number)
  const t = y * 12 + (m - 1) - k
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}

/** Meses 'YYYY-MM' del periodo, terminando en el mes en curso. «Todo» arranca en el primer dato o en el corte. */
export function mesesDelPeriodo(periodo: Periodo, mesHoy: string, datos: DatosVentasCobros, mesCorte: string | null): string[] {
  if (periodo === 'anio') return rangoMeses(`${mesHoy.slice(0, 4)}-01`, mesHoy)
  if (periodo === 'todo') {
    const todos = [...datos.ventas.map((v) => v.mes), ...datos.cobros.map((c) => c.mes), mesCorte ?? mesHoy].filter((m) => m <= mesHoy)
    const primero = todos.reduce((a, b) => (b < a ? b : a), mesHoy)
    return rangoMeses(primero, mesHoy)
  }
  const k = periodo === '3m' ? 3 : periodo === '6m' ? 6 : 12
  return rangoMeses(mesMenos(mesHoy, k - 1), mesHoy)
}

export interface Filtrado {
  ventas: HechoVenta[]
  cobros: HechoCobro[]
}

/** Recorta al periodo y al alcance (la matriz o toda la red). Los cobros siempre son de la matriz. */
export function filtrar(datos: DatosVentasCobros, meses: string[], alcance: Alcance): Filtrado {
  const dentro = new Set(meses)
  return {
    ventas: datos.ventas.filter((v) => dentro.has(v.mes) && (alcance === 'red' || v.matriz)),
    cobros: datos.cobros.filter((c) => dentro.has(c.mes))
  }
}

export interface Totales {
  vendido: number
  cobrado: number | null
  /** cobrado / vendido en %, null si no aplica (piezas, toda la red o sin venta) */
  pct: number | null
}

export function totales(f: Filtrado, metrica: Metrica, alcance: Alcance): Totales {
  const vendido = r2(f.ventas.reduce((a, v) => a + (metrica === 'pesos' ? v.pesos : v.piezas), 0))
  if (metrica === 'piezas') return { vendido, cobrado: null, pct: null }
  const cobrado = r2(f.cobros.reduce((a, c) => a + c.pesos, 0))
  const pct = alcance === 'matriz' && vendido > 0 ? Math.round((cobrado / vendido) * 1000) / 10 : null
  return { vendido, cobrado, pct }
}

const valor = (v: HechoVenta, metrica: Metrica) => (metrica === 'pesos' ? v.pesos : v.piezas)

/** Vista General: vendido por mes partido en contado/concesion, y la linea de lo cobrado. */
export function serieGeneral(meses: string[], f: Filtrado, metrica: Metrica) {
  const idx = new Map(meses.map((m, i) => [m, i]))
  const contado = meses.map(() => 0)
  const concesion = meses.map(() => 0)
  const cobrado = meses.map(() => 0)
  for (const v of f.ventas) {
    const i = idx.get(v.mes)
    if (i === undefined) continue
    if (v.canal === 'CONCESION') concesion[i] += valor(v, metrica)
    else contado[i] += valor(v, metrica)
  }
  for (const c of f.cobros) {
    const i = idx.get(c.mes)
    if (i !== undefined) cobrado[i] += c.pesos
  }
  return { contado: contado.map(r2), concesion: concesion.map(r2), cobrado: cobrado.map(r2) }
}

export interface FilaRanking {
  clave: string
  nombre: string
  vendido: number
  /** null cuando el agrupado no admite cobro (producto) o la metrica es piezas */
  cobrado: number | null
}

function claveDe(grupo: Exclude<Grupo, 'general'>, h: { prod?: string; cli: string; canal: Canal }): string {
  return grupo === 'producto' ? h.prod ?? SIN_PRODUCTO : grupo === 'cliente' ? h.cli : h.canal
}

export function nombreDe(grupo: Exclude<Grupo, 'general'>, clave: string, datos: DatosVentasCobros): string {
  if (clave === OTROS) return 'Otros'
  if (grupo === 'canal') return NOMBRE_CANAL[clave as Canal] ?? clave
  if (grupo === 'producto') return clave === SIN_PRODUCTO ? 'Sin producto' : datos.productos[clave] ?? 'Producto sin nombre'
  if (clave === SIN_CLIENTE) return 'Sin cliente'
  const c = datos.clientes[clave]
  return c ? (c.rol ? `${c.nombre} · ${c.rol}` : c.nombre) : 'Entidad sin nombre'
}

/** Ranking del periodo: los `top` mayores por vendido (o cobrado si no hubo venta) + «Otros». */
export function ranking(grupo: Exclude<Grupo, 'general'>, f: Filtrado, metrica: Metrica, datos: DatosVentasCobros, top = 7): FilaRanking[] {
  const conCobro = grupo !== 'producto' && metrica === 'pesos'
  const acc = new Map<string, { vendido: number; cobrado: number }>()
  for (const v of f.ventas) {
    const k = claveDe(grupo, v)
    const a = acc.get(k) ?? { vendido: 0, cobrado: 0 }
    a.vendido += valor(v, metrica)
    acc.set(k, a)
  }
  if (conCobro)
    for (const c of f.cobros) {
      const k = claveDe(grupo, c)
      const a = acc.get(k) ?? { vendido: 0, cobrado: 0 }
      a.cobrado += c.pesos
      acc.set(k, a)
    }
  const filas = [...acc.entries()]
    .filter(([, a]) => a.vendido !== 0 || a.cobrado !== 0)
    .sort((x, y) => y[1].vendido - x[1].vendido || y[1].cobrado - x[1].cobrado || x[0].localeCompare(y[0]))
  const cabeza = filas.length > top + 1 ? filas.slice(0, top) : filas
  const cola = filas.length > top + 1 ? filas.slice(top) : []
  const out: FilaRanking[] = cabeza.map(([k, a]) => ({
    clave: k,
    nombre: nombreDe(grupo, k, datos),
    vendido: r2(a.vendido),
    cobrado: conCobro ? r2(a.cobrado) : null
  }))
  if (cola.length)
    out.push({
      clave: OTROS,
      nombre: `Otros (${cola.length})`,
      vendido: r2(cola.reduce((s, [, a]) => s + a.vendido, 0)),
      cobrado: conCobro ? r2(cola.reduce((s, [, a]) => s + a.cobrado, 0)) : null
    })
  return out
}

/** Por mes, apilado: los `top` mayores del periodo + «Otros». Solo lo vendido. */
export function apiladoPorMes(grupo: Exclude<Grupo, 'general'>, meses: string[], f: Filtrado, metrica: Metrica, datos: DatosVentasCobros, top = 4) {
  const tot = new Map<string, number>()
  for (const v of f.ventas) tot.set(claveDe(grupo, v), (tot.get(claveDe(grupo, v)) ?? 0) + valor(v, metrica))
  const orden = [...tot.entries()].filter(([, x]) => x !== 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const elegidos = (orden.length > top + 1 ? orden.slice(0, top) : orden).map(([k]) => k)
  const hayOtros = orden.length > elegidos.length
  const idx = new Map(meses.map((m, i) => [m, i]))
  const claves = hayOtros ? [...elegidos, OTROS] : elegidos
  const valores = new Map(claves.map((k) => [k, meses.map(() => 0)]))
  for (const v of f.ventas) {
    const i = idx.get(v.mes)
    if (i === undefined) continue
    const k0 = claveDe(grupo, v)
    const k = elegidos.includes(k0) ? k0 : OTROS
    valores.get(k)![i] += valor(v, metrica)
  }
  return claves.map((k) => ({ clave: k, nombre: nombreDe(grupo, k, datos), valores: valores.get(k)!.map(r2) }))
}
