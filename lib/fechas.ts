/**
 * Las dos operaciones de fecha que el bot necesita, en un solo lugar.
 *
 * Nacieron dentro de `lib/bot-lotes.ts` y salieron de ahi cuando la cotizacion
 * pidio exactamente lo mismo (la vigencia es `fecha + dias`). No se copiaron:
 * dos implementaciones de "sumar dias" divergen el dia que una corrige un caso
 * de borde y la otra no, y las dos escriben fechas en la base.
 */

/**
 * `AAAA-MM-DD` en hora LOCAL, que es la que la persona tiene en la cabeza.
 *
 * `toISOString()` daria la UTC: a las 22:00 en Mexico eso ya es el dia
 * siguiente, y un lote capturado de noche quedaria fechado manana.
 */
export function fechaLocal(ahora: Date): string {
  const y = ahora.getFullYear()
  const m = String(ahora.getMonth() + 1).padStart(2, '0')
  const d = String(ahora.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Suma dias a una fecha `AAAA-MM-DD` y devuelve otra `AAAA-MM-DD`.
 *
 * La cuenta se hace en UTC a proposito: aqui ya no hay hora que respetar, solo
 * dias de calendario, y en UTC no existen los saltos de horario de verano que
 * harian que sumar un dia diera 23 o 25 horas.
 */
export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d))
  base.setUTCDate(base.getUTCDate() + dias)
  return base.toISOString().slice(0, 10)
}
