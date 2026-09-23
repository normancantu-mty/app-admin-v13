/**
 * D69 + D70 (Fase 8): "hoy" es hoy en Mexico, y una fecha se le ensena a una
 * persona de UNA sola forma: DD/MM/AAAA.
 *
 * El caso es el real: COT-0002 se hizo el 2026-09-22 a las ~22:08 de Mexico,
 * que en UTC ya era 2026-09-23T04:08Z. Nacio fechada el 23 y vigente hasta el
 * 08/10 en vez del 07/10.
 *
 * Puras: reloj inyectado, sin base. La mitad SQL (el `default` nuevo de
 * `cotizaciones.fecha` / `lote_envasado.fecha`) se comprobo con una consulta de
 * solo lectura contra `information_schema`; ver el informe de la Fase 8.
 */
import { test, expect } from '@playwright/test'
import { hoyEnMX } from '@/lib/date-format'
import { fechaHoraParaPersona, fechaLocal, fechaParaPersona, sumarDias } from '@/lib/fechas'

const NOCHE_DE_COT_0002 = new Date('2026-09-23T04:08:00Z')

/** La version vieja, la que tenia el `default CURRENT_DATE` de la base: UTC. */
const hoyEnUTC = (d: Date) => d.toISOString().slice(0, 10)

test.describe('D69 · hoy es hoy en Mexico', () => {
  test('a las 22:08 de Mexico, hoy es el 22 (no el 23)', () => {
    expect(hoyEnMX(NOCHE_DE_COT_0002)).toBe('2026-09-22')
    // `fechaLocal` es la que usan la ruta de la cotizacion y el lote: tiene
    // que dar lo mismo aunque el proceso corra en UTC (Vercel).
    expect(fechaLocal(NOCHE_DE_COT_0002)).toBe('2026-09-22')
  })

  test('y la vigencia de 15 dias vence el 07/10, como dijo Norman', () => {
    expect(sumarDias(fechaLocal(NOCHE_DE_COT_0002), 15)).toBe('2026-10-07')
  })

  test('CONTROL NEGATIVO: la version UTC da el 23 y la vigencia del 08/10', () => {
    expect(hoyEnUTC(NOCHE_DE_COT_0002)).toBe('2026-09-23')
    expect(sumarDias(hoyEnUTC(NOCHE_DE_COT_0002), 15)).toBe('2026-10-08')
    expect(hoyEnUTC(NOCHE_DE_COT_0002)).not.toBe(hoyEnMX(NOCHE_DE_COT_0002))
  })

  test('las dos orillas del corte: 17:59 y 18:00 de Mexico (23:59Z y 00:00Z)', () => {
    expect(hoyEnMX(new Date('2026-09-22T23:59:00Z'))).toBe('2026-09-22')
    expect(hoyEnMX(new Date('2026-09-23T00:00:00Z'))).toBe('2026-09-22')
    expect(hoyEnMX(new Date('2026-09-23T06:00:00Z'))).toBe('2026-09-23')
  })
})

test.describe('D70 · la fecha que ve una persona es DD/MM/AAAA', () => {
  test('un dia de calendario sale tal cual, sin correrse un dia', () => {
    expect(fechaParaPersona('2026-10-07')).toBe('07/10/2026')
  })

  test('un instante sale en fecha de Mexico', () => {
    expect(fechaParaPersona('2026-09-23T04:08:00Z')).toBe('22/09/2026')
    expect(fechaHoraParaPersona('2026-09-23T04:08:00Z')).toBe('22/09/2026 22:08')
  })

  test('un dia de calendario NO se inventa una hora', () => {
    expect(fechaHoraParaPersona('2026-10-07')).toBe('07/10/2026')
  })

  test('lo que no se entiende sale como guion, nunca NaN', () => {
    expect(fechaParaPersona(null)).toBe('—')
    expect(fechaParaPersona('')).toBe('—')
    expect(fechaParaPersona('no es fecha')).toBe('—')
  })

  test('CONTROL NEGATIVO: el formateador viejo (new Date de un AAAA-MM-DD) se corre al dia anterior en Mexico', () => {
    // `new Date('2026-10-07')` es medianoche UTC = 6 de la tarde del 6 en Mexico.
    const viejo = new Date('2026-10-07').toLocaleDateString('es-MX', {
      timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric'
    })
    expect(viejo).toBe('06/10/2026')
    expect(viejo).not.toBe(fechaParaPersona('2026-10-07'))
  })
})
