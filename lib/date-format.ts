/** Zona horaria fija: mismo resultado en SSR y cliente (evita hydration mismatch). */
const MX_TIME_ZONE = 'America/Mexico_City'

const fechaHoraFormatter = new Intl.DateTimeFormat('es-MX', {
  timeZone: MX_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

/**
 * Fecha y hora legibles para movimientos del ledger (ej. "14 may 2026, 14:30").
 */
export function formatFechaHoraMX(value: string | Date | null | undefined): string {
  if (value == null || value === '') return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  const ms = date.getTime()
  if (!Number.isFinite(ms)) return '—'
  return fechaHoraFormatter.format(date)
}
