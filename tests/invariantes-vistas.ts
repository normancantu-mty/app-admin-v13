/**
 * ════════════════════════════════════════════════════════════════════════════
 * INVARIANTES DE LAS VISTAS — reglas que se cumplen con CUALQUIER dato
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Fase 7, D58-D59 (2026-09-22). No es un `.spec`: Playwright no lo recoge.
 *
 * El defecto que cierra: las pruebas del proyecto `equivalencia` leen la base
 * de PRODUCCION y afirmaban *hechos* de esa base como si fueran *reglas* ("el
 * Eden nunca abono", "no hay pasivos fiscales vivos"). Cada vez que el negocio
 * funcionaba —una venta, un abono— una prueba se ponia roja y bloqueaba el
 * push. Tres veces: 2026-09-07, 2026-09-17, 2026-09-22.
 *
 * Aqui viven las reglas como FUNCIONES PURAS que devuelven la lista de
 * violaciones (vacia = se cumple). Las llaman dos lados:
 *
 * - las pruebas de produccion (`vistas-equivalencia`, `cableado-pantallas`),
 *   sobre las filas vivas;
 * - `tests/invariantes-eventos.spec.ts` (proyecto `puras`), sobre fixtures que
 *   simulan el evento que antes tumbaba la suite: primer abono, venta en
 *   concesion, primer PASIVO_IVA, primer ABONO_PENDIENTE, un CARGO_DEUDA. Esa
 *   es la prueba de que una venta y un abono NO pueden poner roja la suite.
 *
 * Y los AVISOS: dos pruebas eran alarmas puestas a proposito (querian enterarse
 * del primer IVA vivo y del primer abono pendiente). El evento se sigue
 * detectando, pero se DICE, no bloquea: `avisar()` lo escribe en la salida de
 * la suite y en las anotaciones de Playwright.
 */

/** Dinero al centavo, sin que un 0.1 + 0.2 de coma flotante lo tumbe. */
export const centavos = (n: number): number => Math.round(n * 100)

const FECHA_MX = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

/** La fecha de un instante en hora de Mexico, que es como Norman cuenta los dias. */
export const fechaMx = (iso: string): string => FECHA_MX.format(new Date(iso))

/** Dias de calendario (hora de Mexico) entre dos instantes. */
export function diasCalendarioMx(desde: string, hasta: string): number {
  return Math.round(
    (Date.parse(`${fechaMx(hasta)}T00:00:00Z`) - Date.parse(`${fechaMx(desde)}T00:00:00Z`)) /
      86_400_000
  )
}

// ════════════════════════════════════════════════════════════════════════════
// v_saldo_entidad
// ════════════════════════════════════════════════════════════════════════════

/** Las columnas de `v_saldo_entidad` que miran las invariantes. */
export interface FilaSaldoInvariante {
  nombre: string
  saldo_pendiente_consignacion: number
  deuda_generada_tickets: number
  cargos_deuda: number
  abonos_aprobados: number
  ultimo_abono: string | null
  dias_sin_abonar: number | null
}

/**
 * Para TODA fila:
 * 1. `saldo = generada + cargos - abonos` (la resta completa; sin `cargos` un
 *    CARGO_DEUDA —evento normal, `app/actions/abonos.ts:569`— la tumba).
 * 2. `abonos = 0` ⇔ `ultimo_abono` y `dias_sin_abonar` nulos.
 * 3. Pago de mas: si `abonos > generada + cargos`, el saldo es negativo (no se
 *    redondea a cero un pago excedente — el caso de Aeropuerto, generalizado).
 */
export function violacionesSaldo(filas: FilaSaldoInvariante[]): string[] {
  const v: string[] = []
  for (const f of filas) {
    const g = Number(f.deuda_generada_tickets)
    const c = Number(f.cargos_deuda)
    const a = Number(f.abonos_aprobados)
    const s = Number(f.saldo_pendiente_consignacion)
    if (centavos(s) !== centavos(g + c - a)) {
      v.push(`${f.nombre} · saldo ${s.toFixed(2)} != generada ${g} + cargos ${c} - abonos ${a}`)
    }
    if (centavos(a) === 0) {
      if (f.ultimo_abono !== null) v.push(`${f.nombre} · sin abonos pero con fecha de abono`)
      if (f.dias_sin_abonar !== null) v.push(`${f.nombre} · sin abonos pero con dias sin abonar`)
    } else if (!f.ultimo_abono) {
      v.push(`${f.nombre} · con abonos ${a} y sin fecha de abono`)
    }
    if (centavos(a) > centavos(g + c) && !(s < 0)) {
      v.push(`${f.nombre} · pago de mas y el saldo no es negativo (${s})`)
    }
  }
  return v
}

/**
 * Los dias sin abonar salen del abono contado en hora de Mexico, contra el
 * "hoy" DE LA BASE (`calculado_en` de la misma fila), no el de Node: con el
 * reloj de Node una corrida a las 23:59:59 de Mexico puede salir roja sin
 * defecto.
 */
export function violacionesDiasSinAbonar(
  filas: (FilaSaldoInvariante & { calculado_en: string })[]
): string[] {
  const v: string[] = []
  for (const f of filas) {
    if (!f.ultimo_abono) continue
    const esperados = diasCalendarioMx(f.ultimo_abono, f.calculado_en)
    if (Number(f.dias_sin_abonar) !== esperados) {
      v.push(`${f.nombre} · dias sin abonar ${f.dias_sin_abonar}, esperados ${esperados}`)
    }
  }
  return v
}

// ════════════════════════════════════════════════════════════════════════════
// v_cartera
// ════════════════════════════════════════════════════════════════════════════

export interface FilaCarteraInvariante {
  nombre: string
  generado: number
  abonado: number
  deuda: number
  porcentaje_pagado: number | null
}

/**
 * Invariante CONDICIONAL: quien no ha abonado y genero deuda, debe todo lo
 * generado y va en 0% (no en null: `Number(null)` da 0 y taparia justo el null).
 * Devuelve tambien CUANTAS filas cubrio: si son cero, el llamador lo dice.
 */
export function violacionesCarteraSinAbonos(filas: FilaCarteraInvariante[]): {
  violaciones: string[]
  cubiertas: number
} {
  const v: string[] = []
  const sinAbonos = filas.filter(
    (f) => centavos(Number(f.abonado)) === 0 && centavos(Number(f.generado)) > 0
  )
  for (const f of sinAbonos) {
    if (centavos(Number(f.deuda)) !== centavos(Number(f.generado))) {
      v.push(`${f.nombre} · sin abonos, deuda ${f.deuda} != generado ${f.generado}`)
    }
    if (f.porcentaje_pagado === null) {
      v.push(`${f.nombre} · sin abonos y % pagado null ("no aplica")`)
    } else if (Math.abs(Number(f.porcentaje_pagado)) > 1e-10) {
      v.push(`${f.nombre} · sin abonos y % pagado ${f.porcentaje_pagado}`)
    }
  }
  return { violaciones: v, cubiertas: sinAbonos.length }
}

// ════════════════════════════════════════════════════════════════════════════
// Las dos alarmas a proposito, convertidas en AVISOS
// ════════════════════════════════════════════════════════════════════════════

export interface MovimientoAviso {
  tipo_movimiento: string | null
  status: string
  categoria: string | null
  id_entidad_relacionada: string | null
  fecha_movimiento: string | null
}

/**
 * Antes: `expect(pasivosVivos + pagosVivos).toBe(0)` — se ponia roja con la
 * primera venta FULL_TAX (`lib/venta-servidor.ts:758-759`). Ahora devuelve el
 * texto del aviso, en los dos sentidos: mientras sea 0 contra 0 la
 * equivalencia de `v_pasivo_fiscal` no ejercita la acumulacion (hueco de
 * cobertura); cuando ya hay vivos, la equivalencia de arriba YA los compara y
 * hay que mirarla con cuidado la primera vez.
 */
export function avisoPasivoFiscal(pasivosVivos: number, pagosVivos: number): string {
  return pasivosVivos + pagosVivos === 0
    ? 'v_pasivo_fiscal: hoy la comparacion es 0 contra 0 (ningun PASIVO_IVA/IEPS ni pago de ' +
        'impuesto ACTIVO). La equivalencia pasa sin ejercitar la acumulacion.'
    : `v_pasivo_fiscal: ya hay ${pasivosVivos} pasivo(s) y ${pagosVivos} pago(s) de impuesto ` +
        'vivos. La equivalencia de arriba ya los compara al centavo; revisala a mano la primera vez.'
}

/**
 * La unica diferencia semantica del cableado: `getLiderazgoRed` tomaba el
 * ultimo ABONO_DEUDA **con** los ABONO_PENDIENTE; `v_saldo_entidad` los
 * excluye.
 *
 * Invariante (bloquea): la fecha de la vista es la del ultimo abono NO
 * pendiente, para toda entidad.
 * Aviso (no bloquea): las entidades donde la logica vieja da otra fecha — un
 * abono de un no-ADMIN esperando aprobacion (`app/actions/abonos.ts:572-579`).
 */
export function ultimoAbonoVistaVsViejo(
  entidades: { id: string; nombre: string }[],
  contables: MovimientoAviso[],
  ultimoAbonoVista: (idEntidad: string) => string | null
): { violaciones: string[]; avisos: string[] } {
  const violaciones: string[] = []
  const avisos: string[] = []
  const maxFecha = (filas: MovimientoAviso[]): string | null =>
    filas.length
      ? new Date(Math.max(...filas.map((f) => new Date(f.fecha_movimiento ?? 0).getTime()))).toISOString()
      : null

  for (const e of entidades) {
    const abonos = contables.filter(
      (f) => f.tipo_movimiento === 'ABONO_DEUDA' && f.id_entidad_relacionada === e.id
    )
    const viejo = maxFecha(abonos)
    const aprobados = maxFecha(abonos.filter((f) => f.categoria !== 'ABONO_PENDIENTE'))
    const crudo = ultimoAbonoVista(e.id)
    const vista = crudo ? new Date(crudo).toISOString() : null

    if (vista !== aprobados) {
      violaciones.push(`${e.nombre} · ultimo abono de la vista ${vista}, aprobado ${aprobados}`)
    }
    if (vista !== viejo) {
      avisos.push(
        `${e.nombre}: el semaforo viejo usaba ${viejo} (incluye abono pendiente) y la vista ${vista}`
      )
    }
  }
  return { violaciones, avisos }
}

/**
 * Un aviso visible que NO bloquea el push: sale en la consola de la suite y en
 * las anotaciones del reporte de Playwright. Recibe `info` para no importar
 * `@playwright/test` aqui y dejar este modulo puro.
 */
export function avisar(
  info: { annotations: { type: string; description?: string }[] } | null,
  texto: string
): void {
  info?.annotations.push({ type: 'aviso', description: texto })
  console.warn(`[aviso] ${texto}`)
}
