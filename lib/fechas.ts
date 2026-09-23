/**
 * Las dos operaciones de fecha que el bot necesita, en un solo lugar.
 *
 * Nacieron dentro de `lib/bot-lotes.ts` y salieron de ahi cuando la cotizacion
 * pidio exactamente lo mismo (la vigencia es `fecha + dias`). No se copiaron:
 * dos implementaciones de "sumar dias" divergen el dia que una corrige un caso
 * de borde y la otra no, y las dos escriben fechas en la base.
 */

import { hoyEnMX } from '@/lib/date-format'

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
