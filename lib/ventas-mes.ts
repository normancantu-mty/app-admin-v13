/**
 * La aritmetica de la pantalla de ventas por mes. **Todo puro**: sin base, sin
 * red, sin `Date.now()`. Es lo unico que las pruebas de `[puras]` pueden
 * vigilar de verdad, y corre tambien en CI.
 *
 * LA REGLA QUE ORDENA EL ARCHIVO: **este modulo no agrupa por mes.** La
 * agrupacion la hace `v_ventas_por_mes` dentro de Postgres, en hora de Mexico.
 * Si alguna vez alguien tiene la tentacion de meter aqui un `new Date(...)
 * .getMonth()`, el resultado va a estar en el huso del servidor —UTC en
 * Vercel— y las ventas de la tarde se van a ir al mes siguiente. Ya paso una
 * vez, midiendo a mano el 2026-09-12.
 */

export interface VentasDeUnMes {
  /** Primer dia del mes, `YYYY-MM-DD`, ya en hora de Mexico. */
  mes: string
  tickets: number
  vendido: number
  vendido_contado: number | null
  vendido_concesion: number | null
  tickets_concesion: number
  compradores: number
}

export interface RenglonDeTendencia extends VentasDeUnMes {
  /** Pesos de diferencia contra el mes anterior. `null` en el mes mas viejo. */
  cambio: number | null
  /** Fraccion: `0.12` es +12%. `null` si no hay mes anterior o si ese mes fue 0. */
  cambioRelativo: number | null
  /** Ticket promedio del mes. `0` si no hubo tickets. */
  ticketPromedio: number
}

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
]

/**
 * `2026-08-01` → `agosto 2026`.
 *
 * Se parte la cadena a mano en vez de usar `new Date(mes)`: `new Date` de una
 * cadena `YYYY-MM-DD` la interpreta como **medianoche UTC**, y en Mexico eso
 * es la tarde del dia anterior — o sea el mes anterior cuando es dia 1. Un
 * `agosto` que se pinta como `julio` es exactamente el defecto que esta
 * pantalla vino a matar.
 */
export function nombreDelMes(mes: string): string {
  const [anio, mesNumero] = mes.split('-')
  const indice = Number(mesNumero) - 1
  if (!anio || Number.isNaN(indice) || indice < 0 || indice > 11) return mes
  return `${MESES_ES[indice]} ${anio}`
}

/**
 * Ordena del mas viejo al mas nuevo y calcula el cambio contra el mes
 * anterior.
 *
 * **El mes mas viejo lleva `cambio: null`, no `0`.** No es lo mismo "no cambio"
 * que "no hay con que comparar", y pintar un 0% en el primer mes es inventar
 * una medicion.
 */
export function conTendencia(filas: VentasDeUnMes[]): RenglonDeTendencia[] {
  const orden = [...filas].sort((a, b) => a.mes.localeCompare(b.mes))

  return orden.map((fila, i) => {
    const previo = i > 0 ? orden[i - 1] : null
    const cambio = previo ? fila.vendido - previo.vendido : null

    // Division por cero: si el mes anterior vendio 0, el porcentaje es infinito
    // y no significa nada. Se devuelve null y la pantalla enseña el absoluto.
    const cambioRelativo =
      previo && previo.vendido !== 0 ? (fila.vendido - previo.vendido) / previo.vendido : null

    return {
      ...fila,
      cambio,
      cambioRelativo,
      ticketPromedio: fila.tickets > 0 ? fila.vendido / fila.tickets : 0
    }
  })
}

/**
 * Cuantos meses seguidos, contando hacia atras desde el ultimo, viene bajando
 * la venta. `0` si el ultimo mes subio o empato.
 *
 * ⚠️ **Lo que mide y lo que quiere medir no son lo mismo**, y hay que decirlo:
 * mide **venta capturada**, no botellas vendidas. Un mes con la misma venta
 * real y menos captura baja igual. Es un **proxy**, y la pantalla lo dice.
 */
export function mesesEnCaida(filas: VentasDeUnMes[]): number {
  const orden = [...filas].sort((a, b) => a.mes.localeCompare(b.mes))
  let racha = 0

  for (let i = orden.length - 1; i > 0; i--) {
    if (orden[i].vendido < orden[i - 1].vendido) racha++
    else break
  }

  return racha
}

/**
 * El mes en curso esta incompleto casi siempre. Devolver la comparacion contra
 * un mes cerrado sin decirlo es la forma mas facil de asustar a alguien con una
 * caida que solo es "todavia no acaba el mes".
 */
export function esMesEnCurso(mes: string, hoyMx: string): boolean {
  return mes.slice(0, 7) === hoyMx.slice(0, 7)
}

/** Suma de control: debe cuadrar con el total de tickets ACTIVOS de la base. */
export function totalVendido(filas: VentasDeUnMes[]): number {
  return filas.reduce((suma, fila) => suma + fila.vendido, 0)
}
