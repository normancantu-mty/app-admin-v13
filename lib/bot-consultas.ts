/**
 * AG-04 Fase 3 — CONSULTAS. El bot lee, y **no calcula**.
 *
 * LA REGLA QUE ORDENA TODO ESTE ARCHIVO, y es la misma de la Fase 1 con el
 * papel invertido: **el LLM elige QUE se pregunta; el servidor produce el texto
 * entero, numeros incluidos.** El modelo nunca ve una cifra y por lo tanto no
 * puede inventarla. Es el patron *AI-Gateway*: la parte blanda decide el
 * destino, la parte dura escribe lo que sale.
 *
 * Por que importa aqui mas que en la Fase 1: una escritura mala se ANULA y se
 * ve en el ledger. **Una consulta que contesta un numero falso no deja rastro**
 * — se convierte en una decision tomada con un dato inventado, y nadie sabe
 * nunca que paso. Por eso la Fase 3 va DESPUES de las escrituras (PLAN_BOT
 * v001) y por eso el formateo vive aqui y no en el prompt.
 */

import type { FilaCarteraVista, FilaStockPorCubeta, FilaVentasPorMes } from '@/lib/vistas'
import { fechaHoraParaPersona } from '@/lib/fechas'

/** Lo que el modelo puede pedir. Lista cerrada, igual que las categorias. */
export const CONSULTAS = ['stock', 'cartera', 'ventas', 'produccion', 'precios'] as const
export type TipoConsulta = (typeof CONSULTAS)[number]

export function esConsultaValida(x: unknown): x is TipoConsulta {
  return typeof x === 'string' && (CONSULTAS as readonly string[]).includes(x)
}

/** Quien pregunta. ADMIN ve todo; cualquier otro rol ve SOLO lo suyo. */
export interface AlcanceConsulta {
  idEntidad: string
  rol: string
  nombreEntidad: string
}

export function esAdministrador(alcance: AlcanceConsulta): boolean {
  return alcance.rol === 'ADMIN'
}

/**
 * El filtro de alcance, en un solo lugar.
 *
 * Devuelve el `id_entidad` al que hay que acotar la consulta, o `null` si no
 * hay que acotarla. **Se calcula aqui y se aplica en el endpoint**: si algun
 * dia hay dos endpoints, los dos llaman a esta funcion.
 */
export function entidadALaQueSeAcota(alcance: AlcanceConsulta): string | null {
  return esAdministrador(alcance) ? null : alcance.idEntidad
}

// ─────────────────────────────────────────────────────────────────────────────
// Formato. Todo lo que la persona lee sale de aqui.
// ─────────────────────────────────────────────────────────────────────────────

export function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function piezas(n: number): string {
  const entero = Math.round(n)
  return `${entero.toLocaleString('es-MX')} ${entero === 1 ? 'pieza' : 'piezas'}`
}

/**
 * El pie de toda respuesta. **No es decoracion.**
 *
 * Dice de que vista salio el numero y cuando se calculo. Sin esto, quien lee no
 * puede distinguir un dato de hoy de uno de hace una semana, y un numero sin
 * procedencia es exactamente lo que esta fase existe para no producir.
 */
export function pieDeConsulta(vista: string, calculadoEn?: string | null): string {
  const cuando = calculadoEn ? new Date(calculadoEn) : null
  const sello =
    cuando && !Number.isNaN(cuando.getTime())
      ? fechaHoraParaPersona(cuando)
      : 'al momento'
  return `\n\n(de ${vista}, calculado ${sello})`
}

/**
 * CERO FILAS NO ES CERO PESOS.
 *
 * La confusion que esta funcion existe para impedir: si la vista no devuelve
 * filas, la respuesta honesta es *"no tengo ese dato"*, **nunca "$0.00"**. Un
 * cero inventado se parece demasiado a un cero real.
 */
export function sinDatos(que: string): string {
  return `No tengo datos de ${que}. No es que sea cero: es que no hay filas que leer.`
}

// ─────────────────────────────────────────────────────────────────────────────
// Las tres respuestas. Cada una recibe filas de SU vista y devuelve texto.
// Son funciones puras: se prueban sin base y sin red.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las filas NO se redefinen aqui: son las de `lib/vistas.ts`, que es donde ya
 * viven y donde las pruebas de equivalencia las comparan **fila por fila**
 * contra el TypeScript de la app. Definir una copia local seria un segundo
 * lugar donde el mismo dato puede caducar.
 */
const TOPE_RENGLONES = 25

/** AG-04 literal: stock por SKU y por punto de venta. */
export function textoStock(
  filas: readonly FilaStockPorCubeta[],
  filtro: string | null
): string {
  const conExistencia = filas.filter((f) => Number(f.stock) > 0)
  if (conExistencia.length === 0) {
    return sinDatos(filtro ? `stock de "${filtro}"` : 'stock')
  }

  // Se agrupa por punto de venta porque asi es como se pregunta: "que hay en
  // Delirio", no "cuantas piezas del SKU X hay en total".
  const porEntidad = new Map<string, FilaStockPorCubeta[]>()
  for (const f of conExistencia) {
    const k = f.entidad ?? '(sin nombre)'
    if (!porEntidad.has(k)) porEntidad.set(k, [])
    porEntidad.get(k)!.push(f)
  }

  const total = conExistencia.reduce((s, f) => s + Number(f.stock), 0)
  const lineas: string[] = [
    filtro ? `STOCK de "${filtro}" — ${piezas(total)} en total` : `STOCK — ${piezas(total)} en total`,
    ''
  ]

  let renglones = 0
  for (const [entidad, suyas] of [...porEntidad.entries()].sort()) {
    if (renglones >= TOPE_RENGLONES) {
      lineas.push(`... y ${porEntidad.size - renglones} punto(s) mas. Afina la pregunta.`)
      break
    }
    const suma = suyas.reduce((s, f) => s + Number(f.stock), 0)
    lineas.push(`${entidad}: ${piezas(suma)}`)
    renglones++
    for (const f of suyas.sort((a, b) => Number(b.stock) - Number(a.stock))) {
      lineas.push(`   ${f.producto} (${f.cubeta}): ${piezas(Number(f.stock))}`)
    }
  }
  return lineas.join('\n')
}

/**
 * La consulta que mas vale hoy: quien debe, cuanto, y desde hace cuanto.
 * Ordenada por deuda, que es como se decide a quien llamar primero.
 */
/** Sin acentos ni mayusculas, espacios colapsados: "Aeropuerto " == "aeropuerto". */
function llaveDeNombre(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fase 8 (D76): la cartera DE UN deudor. **Pura.**
 *
 * Norman, 2026-09-21, 07:58: *"cuanto me debe aeropuerto"* y cuatro veces *"y
 * la deuda?"*: el filtro se tiraba en el enrutador y el servidor contestaba la
 * cartera entera. Sin filtro (o vacio) devuelve todas las filas: *"quien me
 * debe"* sigue siendo la lista completa. El empate es por nombre, en los dos
 * sentidos ("aeropuerto" empata "Aeropuerto Zacatecas" y al reves).
 */
export function filtrarCartera<T extends { nombre: string }>(
  filas: readonly T[],
  filtro: string | null | undefined
): T[] {
  const q = llaveDeNombre(filtro ?? '')
  if (!q) return [...filas]
  return filas.filter((f) => {
    const n = llaveDeNombre(f.nombre)
    return n !== '' && (n.includes(q) || q.includes(n))
  })
}

export function textoCartera(filas: readonly FilaCarteraVista[], filtro?: string | null): string {
  const deben = filas.filter((f) => Number(f.deuda) > 0.005)
  if (filtro && filas.length === 0) {
    return `No encuentro a "${filtro}" en la cartera. Pregunta "quien me debe" para ver la lista.`
  }
  if (filtro && deben.length === 0) {
    return `${filas.map((f) => f.nombre).join(', ')}: no te debe nada hoy.`
  }
  if (deben.length === 0) return sinDatos('cartera con deuda')

  const total = deben.reduce((s, f) => s + Number(f.deuda), 0)
  const ordenadas = [...deben].sort((a, b) => Number(b.deuda) - Number(a.deuda))
  const lineas: string[] = [`CARTERA — ${pesos(total)} por cobrar, ${deben.length} deudor(es)`, '']

  for (const f of ordenadas.slice(0, TOPE_RENGLONES)) {
    const dias =
      f.dias_sin_abono === null || f.dias_sin_abono === undefined
        ? 'nunca ha abonado'
        : `${f.dias_sin_abono} d sin abonar`
    // DOS trampas en este campo, y las dos ya cobraron:
    //
    // 1. **Es una FRACCION 0-1, no un porcentaje**, pese a llamarse
    //    `porcentaje_pagado`. Sin el x100, Delirio 85 sale como "1% pagado"
    //    cuando ha pagado el 75.7% (medido contra produccion el 2026-09-12).
    //    Se usa el MISMO criterio que `formateaPorcentaje` de la pantalla de
    //    Cartera: x100 con un decimal. Un solo criterio, dos superficies.
    // 2. `null` NO es 0%: la vista lo usa para "no genero deuda, no aplica".
    const pagado =
      f.porcentaje_pagado === null || f.porcentaje_pagado === undefined
        ? 'sin % (no genero deuda)'
        : `${(Number(f.porcentaje_pagado) * 100).toFixed(1)}% pagado`
    lineas.push(`${pesos(Number(f.deuda))}  ${f.nombre} (${f.rol}) — ${pagado}, ${dias}`)
  }
  if (ordenadas.length > TOPE_RENGLONES) {
    lineas.push(`... y ${ordenadas.length - TOPE_RENGLONES} mas.`)
  }
  return lineas.join('\n')
}

export function textoVentas(filas: readonly FilaVentasPorMes[]): string {
  if (filas.length === 0) return sinDatos('ventas')

  const lineas: string[] = ['VENTAS por mes', '']
  for (const f of filas) {
    const mes = new Date(f.mes).toLocaleDateString('es-MX', { year: 'numeric', month: 'long' })
    lineas.push(
      `${mes}: ${pesos(Number(f.vendido))} · ${f.tickets} tickets · ${f.compradores} compradores`
    )
    // Contado y concesion se separan SIEMPRE: una venta en concesion no es
    // dinero cobrado, y juntarlas es el error que produjo ERP-77.
    lineas.push(
      `   contado ${pesos(Number(f.vendido_contado ?? 0))} · concesion ${pesos(Number(f.vendido_concesion ?? 0))}`
    )
  }
  return lineas.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 9 (D99) — "QUIEN DEBE" COMPLETO, Y LOS PRECIOS POR ENTIDAD.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FASE 10 (D104): la linea de "cobrado por entregar" se OCULTA. Medido el
 * 2026-09-23 con SQL: el cobro se registra (`DEUDA_A_MATRIZ`), pero la entrega
 * no tiene registro propio — resta como `ABONO_DEUDA/ABONO_REAL`, el mismo
 * renglon que el pago de concesion. `v_saldo_entidad.saldo_por_pagar_efectivo`
 * salia negativo en las 11 entidades y el bot mostraba $0 a todos, incluidos
 * los dos DST que si cobraron. Mientras no exista un movimiento de entrega, el
 * numero no se puede separar y no se inventa. Tabla:
 * `Fresnillo/ERP_Fresnillo/_avance_fase10_2026-09-23.md`, D104.
 */
export const NOTA_EFECTIVO_NO_SEPARABLE =
  'El efectivo que ya cobraron y no han entregado no se muestra: el ERP no separa su entrega del pago de concesion.'

/**
 * Norman, textual: *"debes de poner el total y el dinero que no te ha dado que
 * ya tiene el"*. Por deudor, la deuda de concesion (`v_cartera`); el efectivo
 * por entregar, ver `NOTA_EFECTIVO_NO_SEPARABLE`. **Pura.**
 */
export function textoQuienDebe(
  filas: readonly FilaCarteraVista[],
  filtro?: string | null,
  /**
   * FASE 11 (D112): el bloque de `v_efectivo_por_entregar` ya armado
   * (`textoEfectivoPorEntregar`). Si viene, sustituye a la nota; si no (la
   * migracion `d112` no esta aplicada), la nota sigue diciendo la verdad.
   */
  efectivo?: string | null
): string {
  const cierre = efectivo && efectivo.trim() ? efectivo : NOTA_EFECTIVO_NO_SEPARABLE
  const renglones = filas
    .map((f) => ({ f, deuda: Math.max(0, Number(f.deuda) || 0) }))
    .filter((r) => r.deuda > 0.005)
  if (filtro && filas.length === 0) {
    return `No encuentro a "${filtro}" en la cartera. Pregunta "quien me debe" para ver la lista.`
  }
  if (renglones.length === 0) {
    return filtro
      ? `${filas.map((f) => f.nombre).join(', ')}: no te debe nada de concesion hoy.\n${cierre}`
      : sinDatos('cartera con deuda') + (cierre === NOTA_EFECTIVO_NO_SEPARABLE ? '' : '\n\n' + cierre)
  }
  const totalDeuda = renglones.reduce((s, r) => s + r.deuda, 0)
  const lineas: string[] = [`QUIEN DEBE — ${pesos(totalDeuda)} de concesion`, '']
  const ordenadas = [...renglones].sort((a, b) => b.deuda - a.deuda)
  for (const r of ordenadas.slice(0, TOPE_RENGLONES)) {
    lineas.push(`${r.f.nombre} (${r.f.rol}) — debe ${pesos(r.deuda)} de concesion`)
  }
  if (ordenadas.length > TOPE_RENGLONES) lineas.push(`... y ${ordenadas.length - TOPE_RENGLONES} mas.`)
  lineas.push('', cierre)
  return lineas.join('\n')
}

export interface RenglonPrecio {
  producto: string
  publico: number
  /** Lo que se le cobra a esa entidad (la cascada); `null` = solo publico. */
  entidad: number | null
}

/** **Pura.** `nombre` null = solo el precio al publico. */
export function textoPrecios(renglones: readonly RenglonPrecio[], nombre: string | null, rol?: string): string {
  if (renglones.length === 0) return sinDatos('precios')
  const lineas = [
    nombre ? `PRECIOS — publico y ${nombre}${rol ? ` (${rol})` : ''}` : 'PRECIOS AL PUBLICO',
    ''
  ]
  for (const r of renglones) {
    lineas.push(
      nombre && r.entidad !== null
        ? `   ${r.producto}: publico ${pesos(r.publico)} · a ${nombre} ${pesos(r.entidad)}`
        : `   ${r.producto}: ${pesos(r.publico)}`
    )
  }
  return lineas.join('\n')
}
