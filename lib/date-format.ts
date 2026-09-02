/** Zona horaria fija: mismo resultado en SSR y cliente (evita hydration mismatch). */
export const MX_TIME_ZONE = 'America/Mexico_City'

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

// ============================================================================
// RANGO DE FECHAS — fuente única para TODAS las pantallas
// ----------------------------------------------------------------------------
// Regla, y no hay otra: un rango es el intervalo semiabierto
//     [inicio 00:00 MX , fin+1día 00:00 MX)
// anclado a America/Mexico_City. Nunca `.lte(fecha, 'YYYY-MM-DD')` contra un
// timestamptz: eso corta a la medianoche UTC del último día y borra de la vista
// los movimientos de hoy. Nunca `toISOString()` para saber qué día es hoy: en
// UTC−6, después de las 18:00 locales "hoy" ya sería mañana.
// ============================================================================

const partesFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MX_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

type PartesFecha = { year: number; month: number; day: number; hour: number; minute: number; second: number }

function partesEnMX(instante: Date): PartesFecha {
  const partes = partesFormatter.formatToParts(instante)
  const leer = (tipo: Intl.DateTimeFormatPartTypes): number => {
    const parte = partes.find((p) => p.type === tipo)
    return parte ? Number(parte.value) : 0
  }
  // Intl rinde la hora 24 como "24" a la medianoche en algunos runtimes.
  const hour = leer('hour') % 24
  return {
    year: leer('year'),
    month: leer('month'),
    day: leer('day'),
    hour,
    minute: leer('minute'),
    second: leer('second')
  }
}

/** Minutos que la hora local de México va adelante de UTC en ese instante (negativo). */
function offsetMinutosMX(instante: Date): number {
  const p = partesEnMX(instante)
  const comoUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return (comoUTC - instante.getTime()) / 60000
}

/** 'YYYY-MM-DD' del día de hoy **en México**, no en UTC. */
export function hoyEnMX(): string {
  const p = partesEnMX(new Date())
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

function parsearFechaLocal(fecha: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha)
  if (!match) {
    const parsed = new Date(fecha)
    if (Number.isNaN(parsed.getTime())) return null
    const p = partesEnMX(parsed)
    return { year: p.year, month: p.month, day: p.day }
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/**
 * Instante ISO (UTC) que corresponde a la medianoche local de México del día
 * `fecha` + `diasExtra`. Se resuelve el offset dos veces para caer del lado
 * correcto si algún día vuelve el horario de verano.
 */
export function medianocheMXaISO(fecha: string, diasExtra = 0): string | null {
  const partes = parsearFechaLocal(fecha)
  if (!partes) return null

  const paredUTC = Date.UTC(partes.year, partes.month - 1, partes.day + diasExtra, 0, 0, 0, 0)
  let instante = new Date(paredUTC - offsetMinutosMX(new Date(paredUTC)) * 60000)
  instante = new Date(paredUTC - offsetMinutosMX(instante) * 60000)
  return instante.toISOString()
}

export interface RangoFechas {
  fechaInicio?: string
  fechaFin?: string
}

export interface LimitesRango {
  /** Inclusivo: primer instante del rango. */
  desde?: string
  /** **Exclusivo**: primer instante fuera del rango (fin + 1 día). */
  hastaExclusivo?: string
}

/**
 * Convierte un rango de días locales MX en el par de instantes que se le pasa
 * a Supabase: `.gte(col, desde).lt(col, hastaExclusivo)`.
 * Si falta cualquiera de las dos fechas, no hay filtro (rango "TODO").
 */
export function limitesRangoMX(fechaInicio?: string, fechaFin?: string): LimitesRango {
  if (!fechaInicio || !fechaFin) return {}
  const desde = medianocheMXaISO(fechaInicio, 0)
  const hastaExclusivo = medianocheMXaISO(fechaFin, 1)
  if (!desde || !hastaExclusivo) return {}
  return { desde, hastaExclusivo }
}

/**
 * Traduce el selector global de la TopBar a días locales de México.
 * Devuelve 'YYYY-MM-DD' (no instantes): quien consulta usa `limitesRangoMX`.
 */
export function calcularFechasPorRango(rango: string): RangoFechas {
  const hoy = hoyEnMX()
  const p = partesEnMX(new Date())
  const primerDiaDelMes = `${p.year}-${String(p.month).padStart(2, '0')}-01`

  switch (rango) {
    case 'TODO':
      return { fechaInicio: undefined, fechaFin: undefined }
    case 'HOY':
      return { fechaInicio: hoy, fechaFin: hoy }
    case 'TRIMESTRE': {
      const inicio = new Date(Date.UTC(p.year, p.month - 1 - 2, 1))
      const y = inicio.getUTCFullYear()
      const m = String(inicio.getUTCMonth() + 1).padStart(2, '0')
      return { fechaInicio: `${y}-${m}-01`, fechaFin: hoy }
    }
    case 'ESTE_MES':
    default:
      return { fechaInicio: primerDiaDelMes, fechaFin: hoy }
  }
}
