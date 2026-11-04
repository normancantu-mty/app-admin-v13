/**
 * Las dos operaciones de fecha que el bot necesita, en un solo lugar.
 *
 * Nacieron dentro de `lib/bot-lotes.ts` y salieron de ahi cuando la cotizacion
 * pidio exactamente lo mismo (la vigencia es `fecha + dias`). No se copiaron:
 * dos implementaciones de "sumar dias" divergen el dia que una corrige un caso
 * de borde y la otra no, y las dos escriben fechas en la base.
 */

import { hoyEnMX, medianocheMXaISO } from '@/lib/date-format'

/**
 * `AAAA-MM-DD` en hora de MEXICO, que es la que la persona tiene en la cabeza.
 *
 * `toISOString()` daria la UTC: a las 22:00 en Mexico eso ya es el dia
 * siguiente, y un lote capturado de noche quedaria fechado manana.
 *
 * **D69 (Fase 8): antes leia la zona del PROCESO** (`getFullYear`,
 * `getDate`). En la PC de Norman eso es Mexico y salia bien; en Vercel el
 * proceso corre en UTC y habria dado exactamente el defecto que este comentario
 * dice evitar. Ahora delega en `hoyEnMX`, que fija la zona con `Intl`.
 */
export function fechaLocal(ahora: Date): string {
  return hoyEnMX(ahora)
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

/**
 * El instante que se guarda para una fecha dictada, con su regla en un solo lugar.
 *
 * `new Date('2026-11-03')` es medianoche UTC: en Mexico todavia es el dia 2, asi
 * que "ayer" caia un dia antes y "el primero" caia en el mes anterior (auditoria
 * del 2026-11-04). `finanzas_ledger.fecha_movimiento` es `timestamptz`.
 *
 * - Un dia pasado se ancla al MEDIODIA de Mexico, igual que la web
 *   (`resolverFechaMovimiento` en `app/actions/abonos.ts`): se lee el mismo dia en
 *   UTC y en Mexico, que importa porque `lib/bot-consultas.ts` hace `.slice(0, 10)`.
 * - Hoy es el instante real.
 * - Un dia futuro se ancla a `ahora` y lo dice (`futura`): una fila con fecha
 *   futura desaparece de todo filtro "hasta hoy" (aviso W11).
 * - Vacio, ilegible o un dia que no existe: `null`, y quien llama usa `ahora`.
 */
export function instanteDeFechaDictada(
  valor: unknown,
  ahora: Date
): { instante: Date; futura: boolean } | null {
  const texto = String(valor ?? '').trim()
  if (texto === '') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    const hoy = hoyEnMX(ahora)
    if (texto > hoy) return { instante: ahora, futura: true }
    if (texto === hoy) return { instante: ahora, futura: false }
    const medianoche = medianocheMXaISO(texto)
    if (!medianoche) return null
    const mediodia = new Date(new Date(medianoche).getTime() + 12 * 60 * 60 * 1000)
    // `Date.UTC` da la vuelta sola (31 de febrero es 3 de marzo): no es ese dia.
    return hoyEnMX(mediodia) === texto ? { instante: mediodia, futura: false } : null
  }
  const parseada = new Date(texto)
  if (Number.isNaN(parseada.getTime())) return null
  return parseada > ahora
    ? { instante: ahora, futura: true }
    : { instante: parseada, futura: false }
}

/**
 * D70 (Fase 8): **la UNICA forma en que una fecha se le ensena a una persona**:
 * `DD/MM/AAAA` (ej. `07/10/2026`). Norman: *"el formato debe ser dia mes y
 * ano"*. Lo que viaja entre sistemas (JSON, SQL) se queda ISO; esto es solo
 * para pantalla, imagen y mensajes del bot.
 *
 * Acepta `AAAA-MM-DD` (se lee tal cual, sin pasar por `Date`, porque
 * `new Date('2026-10-07')` es medianoche UTC y en Mexico seria el dia 6) o un
 * instante completo (se lleva a la fecha de Mexico). Lo que no se entiende
 * sale como `—`, nunca como `NaN/NaN/NaN`.
 */
export function fechaParaPersona(valor: string | Date | null | undefined): string {
  if (valor == null || valor === '') return '—'
  let iso: string
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) {
    iso = valor.trim()
  } else {
    const d = typeof valor === 'string' ? new Date(valor) : valor
    if (!Number.isFinite(d.getTime())) return '—'
    iso = hoyEnMX(d)
  }
  const [y, m, dia] = iso.split('-')
  return `${dia}/${m}/${y}`
}

const HORA_MX = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Mexico_City',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

/**
 * Lo mismo que `fechaParaPersona`, con la hora de Mexico cuando el dato la
 * trae: `22/09/2026 22:08`. Un `AAAA-MM-DD` a secas sale SIN hora: un documento
 * que no tiene hora no debe inventarse una.
 */
export function fechaHoraParaPersona(valor: string | Date | null | undefined): string {
  if (valor == null || valor === '') return '—'
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) {
    return fechaParaPersona(valor)
  }
  const d = typeof valor === 'string' ? new Date(valor) : valor
  if (!Number.isFinite(d.getTime())) return '—'
  return `${fechaParaPersona(d)} ${HORA_MX.format(d)}`
}
