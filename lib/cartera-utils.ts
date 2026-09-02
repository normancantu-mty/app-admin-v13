/**
 * Cartera: a quien visitar, cuanto tiene y cuanto debe.
 *
 * Funciones **puras**: no hablan con Supabase. La pantalla
 * (`app/dashboard/cartera/page.tsx`) trae las filas y las pasa aqui. Asi el
 * calculo se prueba sin red ni base (`tests/cartera.spec.ts`).
 *
 * **La deuda no se calcula aqui.** Se delega en
 * `calcularSaldoPendienteInventarioConsignacion` de `lib/distribuidores-saldos.ts`,
 * que es la fuente de verdad compartida con el perfil del distribuidor. Si esa
 * formula cambia, esta pantalla cambia con ella y no se abre drift.
 */

import {
  calcularSaldoPendienteInventarioConsignacion,
  type EntidadRolSaldo,
  type FinanzaSaldoInput,
  type TicketSaldoInput
} from './distribuidores-saldos'
import { esAbonoPendienteAprobacion } from './finance-utils'

/** Roles que pueden tener mercancia en piso y deuda de consignacion. */
export type RolNodoCartera = Extract<EntidadRolSaldo, 'DST' | 'LOC'>

export interface EntidadCartera {
  id: string
  nombre: string
  rol: string | null
}

export interface MovimientoInventarioCartera {
  tipo_movimiento: string | null
  cantidad: number | null
  status: string | null
  id_entidad_origen: string | null
  id_entidad_destino: string | null
  fecha_movimiento: string | null
}

export type TicketCartera = TicketSaldoInput & { status?: string | null }

export type FinanzaCartera = FinanzaSaldoInput & {
  status?: string | null
  fecha_movimiento?: string | null
}

export interface FilaCartera {
  id: string
  nombre: string
  rol: RolNodoCartera
  /** Piezas que recibio en consignacion (ENTRADA_CONCESION vivas). */
  recibidas: number
  /** Piezas que salieron de ese nodo con movimiento registrado (venta, merma, traspaso...). */
  salidas: number
  /** recibidas − salidas: lo que el inventario afirma que sigue en su piso. */
  libroDice: number
  /** Deuda generada por sus tickets de consignacion vivos, mas cargos. */
  generado: number
  /** Abonos aprobados (excluye ANULADO y ABONO_PENDIENTE). */
  abonado: number
  /** abonado / generado. `null` cuando no genero deuda: no es 0%, es "no aplica". */
  porcentajePagado: number | null
  /** recibidas × (1 − % pagado), nunca negativo. La lectura por dinero. */
  estimadoEnPiso: number
  /** Lo que falta cobrar. Viene de `lib/distribuidores-saldos.ts`, sin reimplementar. */
  deuda: number
  /** Fecha del ultimo abono aprobado. `null` si nunca abono. */
  ultimoAbono: string | null
  /**
   * Dias desde el ultimo abono. Si nunca abono, dias desde que recibio
   * mercancia — `referenciaDias` dice cual de las dos se esta midiendo.
   */
  diasSinAbono: number | null
  referenciaDias: 'ABONO' | 'ENTREGA' | 'NINGUNA'
  /** deuda × dias. El orden de visita. */
  prioridad: number
}

const MS_POR_DIA = 24 * 60 * 60 * 1000

/** Zona en la que Norman cuenta los dias. Un abono es del dia en que lo cobro. */
const ZONA = 'America/Mexico_City'

const FECHA_LOCAL = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

/** Movimiento de inventario que cuenta: ANULADO fuera, legacy APPROVED dentro. */
function inventarioVivo(status: string | null): boolean {
  return status !== 'ANULADO'
}

/**
 * Dias de calendario entre dos instantes, contados en hora de Mexico.
 *
 * A proposito **no** son milisegundos entre fechas: un abono cobrado el lunes a
 * las 8 de la noche y otro el martes a las 9 de la manana estan a un dia, no a
 * "0 dias". Contar por reloj hacia que la columna cambiara segun la hora en que
 * se capturo el movimiento.
 */
function diasEntre(desde: string, hasta: string): number | null {
  const inicio = new Date(desde)
  const fin = new Date(hasta)
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime())) return null

  const medianoche = (fecha: Date) => Date.parse(`${FECHA_LOCAL.format(fecha)}T00:00:00Z`)

  return Math.max(0, Math.round((medianoche(fin) - medianoche(inicio)) / MS_POR_DIA))
}

function esRolNodo(rol: string | null): rol is RolNodoCartera {
  return rol === 'DST' || rol === 'LOC'
}

export interface EntradaCartera {
  entidades: EntidadCartera[]
  inventario: MovimientoInventarioCartera[]
  tickets: TicketCartera[]
  finanzas: FinanzaCartera[]
  /** Fecha de corte (ISO). Se inyecta para que el calculo sea determinista. */
  hoy: string
}

/**
 * Una fila por nodo DST/LOC que **haya recibido mercancia**. Ordenadas por
 * prioridad de visita: deuda × dias desde el ultimo abono.
 */
export function construirCartera({
  entidades,
  inventario,
  tickets,
  finanzas,
  hoy
}: EntradaCartera): FilaCartera[] {
  // El perfil del distribuidor calcula el saldo sobre los movimientos no
  // anulados; aqui se usa el mismo conjunto para que ambas pantallas digan lo
  // mismo del mismo nodo.
  const finanzasContables = finanzas.filter((f) => (f.status ?? 'ACTIVO') !== 'ANULADO')
  const movimientosVivos = inventario.filter((m) => inventarioVivo(m.status))

  const filas: FilaCartera[] = []

  for (const entidad of entidades) {
    if (!esRolNodo(entidad.rol)) continue

    let recibidas = 0
    let salidas = 0
    let ultimaEntrega: string | null = null

    for (const mov of movimientosVivos) {
      const cantidad = Math.abs(Number(mov.cantidad) || 0)

      if (mov.id_entidad_destino === entidad.id && mov.tipo_movimiento === 'ENTRADA_CONCESION') {
        recibidas += cantidad
        if (mov.fecha_movimiento && (!ultimaEntrega || mov.fecha_movimiento > ultimaEntrega)) {
          ultimaEntrega = mov.fecha_movimiento
        }
      }

      // Cualquier movimiento que sale del nodo descarga su piso: venta, merma,
      // traspaso o consignacion hacia abajo. Filtrar por tipo dejaria piezas
      // colgadas en el libro que ya no estan ahi.
      if (mov.id_entidad_origen === entidad.id) {
        salidas += cantidad
      }
    }

    if (recibidas <= 0) continue

    const nodo = { id: entidad.id, rol: entidad.rol }

    const deuda = calcularSaldoPendienteInventarioConsignacion(
      nodo,
      tickets,
      [entidad.id],
      finanzasContables
    )

    const abonos = finanzasContables.filter(
      (f) =>
        f.tipo_movimiento === 'ABONO_DEUDA' &&
        f.id_entidad_relacionada === entidad.id &&
        !esAbonoPendienteAprobacion(f.categoria)
    )
    const abonado = abonos.reduce((sum, f) => sum + (Number(f.monto) || 0), 0)

    // `generado` se deriva del saldo compartido en vez de recalcularse: asi el
    // porcentaje y la deuda no pueden contradecirse entre si.
    const generado = deuda + abonado
    const porcentajePagado = generado > 0 ? abonado / generado : null

    const estimadoEnPiso =
      porcentajePagado === null
        ? recibidas
        : Math.max(0, Math.round(recibidas * (1 - porcentajePagado)))

    const ultimoAbono = abonos.reduce<string | null>((max, f) => {
      const fecha = f.fecha_movimiento ?? null
      if (!fecha) return max
      return !max || fecha > max ? fecha : max
    }, null)

    const referenciaFecha = ultimoAbono ?? ultimaEntrega
    const referenciaDias: FilaCartera['referenciaDias'] = ultimoAbono
      ? 'ABONO'
      : ultimaEntrega
        ? 'ENTREGA'
        : 'NINGUNA'
    const diasSinAbono = referenciaFecha ? diasEntre(referenciaFecha, hoy) : null

    filas.push({
      id: entidad.id,
      nombre: entidad.nombre,
      rol: entidad.rol,
      recibidas,
      salidas,
      libroDice: recibidas - salidas,
      generado,
      abonado,
      porcentajePagado,
      estimadoEnPiso,
      deuda,
      ultimoAbono,
      diasSinAbono,
      referenciaDias,
      prioridad: deuda > 0 ? deuda * (diasSinAbono ?? 0) : 0
    })
  }

  return filas.sort((a, b) => {
    if (b.prioridad !== a.prioridad) return b.prioridad - a.prioridad
    if (b.deuda !== a.deuda) return b.deuda - a.deuda
    return a.nombre.localeCompare(b.nombre, 'es')
  })
}

/** Totales del pie de tabla. */
export function totalesCartera(filas: FilaCartera[]) {
  return filas.reduce(
    (acc, fila) => ({
      recibidas: acc.recibidas + fila.recibidas,
      libroDice: acc.libroDice + fila.libroDice,
      estimadoEnPiso: acc.estimadoEnPiso + fila.estimadoEnPiso,
      deuda: acc.deuda + fila.deuda
    }),
    { recibidas: 0, libroDice: 0, estimadoEnPiso: 0, deuda: 0 }
  )
}
