import { test, expect } from '@playwright/test'
import {
  calcularFechasPorRango,
  hoyEnMX,
  limitesRangoMX,
  medianocheMXaISO
} from '../lib/date-format'

/**
 * ERP-23 — EL RANGO DE FECHAS, Y POR QUE NO TENIA NI UNA PRUEBA.
 *
 * El defecto que describia el ticket: el rango se armaba en UTC y cortaba a
 * medianoche, asi que **despues de las 18:00 de Zacatecas "HOY" ya era manana**
 * y los movimientos del dia desaparecian de "ESTE_MES". Al medir el 2026-09-14
 * la aritmetica de `lib/date-format.ts` ya estaba corregida —intervalo
 * semiabierto anclado a `America/Mexico_City`— pero **no habia una sola prueba
 * sobre ella**: ni en `tests/`, ni indirecta. Una correccion sin centinela es
 * una correccion con fecha de caducidad.
 *
 * Y habia una razon estructural para que no la hubiera: las funciones leian el
 * reloj por dentro (`new Date()`), asi que el caso interesante —las 18:01 de
 * Zacatecas— solo se podia observar corriendo la suite a esa hora. Este bloque
 * entra junto con el cambio que las vuelve medibles: `hoyEnMX(ahora)` y
 * `calcularFechasPorRango(rango, ahora)` reciben el instante.
 *
 * **El problema, con su nombre: timezone-dependent date bucketing** — el dia al
 * que pertenece un instante depende de la zona en que se le pregunte, y el
 * sistema tenia tres respuestas distintas (UTC, el navegador, Mexico).
 *
 * Pruebas puras: sin navegador, sin base, sin sesion. Corren en `puras`.
 */

/** Zacatecas es UTC-6 todo el anio: no hay horario de verano desde 2022. */
const UTC = (iso: string) => new Date(iso)

test.describe('ERP-23 · el dia se decide en hora de Mexico, no en UTC', () => {
  test('a las 17:30 de Zacatecas, HOY es hoy', () => {
    // 2026-09-14 23:30 UTC = 2026-09-14 17:30 en Mexico.
    expect(hoyEnMX(UTC('2026-09-14T23:30:00Z'))).toBe('2026-09-14')
  })

  test('CONTROL NEGATIVO: a las 19:30 de Zacatecas, HOY SIGUE siendo hoy', () => {
    // 2026-09-15 01:30 UTC = 2026-09-14 19:30 en Mexico. **Este es el caso que
    // el ticket describe.** En UTC el dia ya cambio; en Mexico no. Si alguien
    // vuelve a poner `toISOString()` aqui, esta linea se pone roja con
    // '2026-09-15' y nombra el defecto sola.
    expect(hoyEnMX(UTC('2026-09-15T01:30:00Z'))).toBe('2026-09-14')
  })

  test('a las 00:30 de Zacatecas el dia SI cambio', () => {
    // 2026-09-15 06:30 UTC = 2026-09-15 00:30 en Mexico.
    expect(hoyEnMX(UTC('2026-09-15T06:30:00Z'))).toBe('2026-09-15')
  })

  test('la medianoche de Mexico son las 06:00 UTC', () => {
    expect(medianocheMXaISO('2026-09-14')).toBe('2026-09-14T06:00:00.000Z')
    expect(medianocheMXaISO('2026-09-14', 1)).toBe('2026-09-15T06:00:00.000Z')
  })

  test('el rango es semiabierto: el ultimo dia entra COMPLETO', () => {
    const { desde, hastaExclusivo } = limitesRangoMX('2026-09-01', '2026-09-14')

    expect(desde).toBe('2026-09-01T06:00:00.000Z')
    // El corte es la medianoche del 15, NO la del 14: un movimiento de las
    // 19:30 del 14 (01:30 UTC del 15) queda DENTRO. Ese era el defecto.
    expect(hastaExclusivo).toBe('2026-09-15T06:00:00.000Z')

    const movimientoDeEsaNoche = UTC('2026-09-15T01:30:00Z').toISOString()
    expect(movimientoDeEsaNoche >= desde!).toBe(true)
    expect(movimientoDeEsaNoche < hastaExclusivo!).toBe(true)
  })

  test('CONTROL NEGATIVO: con el criterio viejo, ese mismo movimiento se perdia', () => {
    // Lo que hacia `.lte(col, 'YYYY-MM-DD')`: cortar en la medianoche UTC del
    // ultimo dia. Se deja escrito para que se vea QUE cambio, no solo que hoy
    // pasa. Sin esta linea, la prueba de arriba no demuestra que haya un antes.
    const corteViejoUTC = '2026-09-14T23:59:59.999Z'
    const movimientoDeEsaNoche = '2026-09-15T01:30:00.000Z'

    expect(movimientoDeEsaNoche <= corteViejoUTC).toBe(false)
  })

  test('sin alguna de las dos fechas no hay filtro: el rango TODO no inventa un corte', () => {
    expect(limitesRangoMX(undefined, '2026-09-14')).toEqual({})
    expect(limitesRangoMX('2026-09-01', undefined)).toEqual({})
    expect(limitesRangoMX(undefined, undefined)).toEqual({})
  })
})

test.describe('ERP-23 · el selector de la TopBar', () => {
  // Las 19:30 de Zacatecas: la hora a la que el criterio viejo se equivocaba.
  const esaNoche = UTC('2026-09-15T01:30:00Z')

  test('ESTE_MES llega hasta HOY, no hasta ayer', () => {
    expect(calcularFechasPorRango('ESTE_MES', esaNoche)).toEqual({
      fechaInicio: '2026-09-01',
      fechaFin: '2026-09-14'
    })
  })

  test('HOY son las dos orillas del mismo dia local', () => {
    expect(calcularFechasPorRango('HOY', esaNoche)).toEqual({
      fechaInicio: '2026-09-14',
      fechaFin: '2026-09-14'
    })
  })

  test('HOY, pasado por el rango, cubre el dia entero en hora de Mexico', () => {
    // El encadenado completo, que es lo que de verdad ve la pantalla:
    // selector -> dias locales -> instantes. Un movimiento capturado a las
    // 19:30 tiene que caer dentro de su propio "HOY".
    const { fechaInicio, fechaFin } = calcularFechasPorRango('HOY', esaNoche)
    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    expect(desde).toBe('2026-09-14T06:00:00.000Z')
    expect(hastaExclusivo).toBe('2026-09-15T06:00:00.000Z')
    expect(esaNoche.toISOString() >= desde!).toBe(true)
    expect(esaNoche.toISOString() < hastaExclusivo!).toBe(true)
  })

  test('TRIMESTRE arranca el dia 1, tres meses atras', () => {
    expect(calcularFechasPorRango('TRIMESTRE', esaNoche)).toEqual({
      fechaInicio: '2026-07-01',
      fechaFin: '2026-09-14'
    })
  })

  test('TRIMESTRE cruza el cambio de anio sin romperse', () => {
    // 2026-02-10 12:00 MX. Tres meses atras es diciembre del 2025.
    expect(calcularFechasPorRango('TRIMESTRE', UTC('2026-02-10T18:00:00Z'))).toEqual({
      fechaInicio: '2025-12-01',
      fechaFin: '2026-02-10'
    })
  })

  test('TODO no pone fechas, y un rango desconocido cae en ESTE_MES', () => {
    expect(calcularFechasPorRango('TODO', esaNoche)).toEqual({
      fechaInicio: undefined,
      fechaFin: undefined
    })
    expect(calcularFechasPorRango('LO_QUE_SEA', esaNoche)).toEqual(
      calcularFechasPorRango('ESTE_MES', esaNoche)
    )
  })

  test('el selector lee el reloj UNA sola vez', () => {
    // Antes eran dos `new Date()` en la misma funcion —uno para el dia y otro
    // para el mes—, y entre los dos cabe un cambio de medianoche: el 30 de
    // septiembre a las 23:59:59.999 podia devolver `2026-10-01 .. 2026-09-30`,
    // un rango vacio. Con el instante inyectado, el mes y el dia salen del
    // MISMO instante y eso ya no puede pasar.
    const finDeMes = UTC('2026-10-01T05:59:59.999Z') // 2026-09-30 23:59:59.999 MX
    const { fechaInicio, fechaFin } = calcularFechasPorRango('ESTE_MES', finDeMes)

    expect(fechaInicio).toBe('2026-09-01')
    expect(fechaFin).toBe('2026-09-30')
    expect(fechaInicio! <= fechaFin!).toBe(true)
  })
})
