/**
 * Lote v2, ronda 5 — EL ENVASADO DIARIO, SIN LOTE. Todo puro.
 *
 * Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
 *
 * Decision de Norman (chat, 2026-10-19): la produccion de un lote termina en la
 * DESTILACION (kg y % de alcohol por garrafa). El ENVASADO de botellas es otra
 * cosa: se hace a diario, sin importar el lote, y por ahora NO se relaciona con
 * ningun lote. Entonces:
 *   1. un envasado nunca abre ni pide un lote (se retiro "envasado sin lote
 *      ofrece abrirlo" de WP-7a);
 *   2. si el mensaje dice un codigo L-, el envasado se registra igual, sin
 *      vinculo: el codigo dicho va a la nota.
 *
 * Lo escribe `registrar_envasado_diario` (migracion 20261019150000, seccion 7):
 * `lote_envasado` con `id_lote` NULL + el mismo inventario que el envasado de
 * un lote (`movimientos_de_envasado`: +N PRODUCCION del terminado, TRASPASO del
 * empaque) y el mismo candado de empaque (D92). El borrador es `envasado_diario`
 * y se confirma por `/api/bot/lote/confirmar`, con la misma puerta de
 * aprobacion (D98/D101).
 */

import { sellar, selloEmpata } from '@/lib/bot-sello'
import { fechaLocal, fechaParaPersona } from '@/lib/fechas'
import { TOPE_BOTELLAS, type EnvasadoLote, type FormatoDeBotella } from '@/lib/bot-lotes'

export interface PayloadEnvasadoDiario {
  fecha: string
  usuario_creador: string
  envasado: EnvasadoLote[]
  /** '' si no hay nada que anotar; el codigo L- dicho, si lo dijeron. */
  nota: string
}

/** El orden es parte del sello. Ver `lib/bot-sello.ts`. */
export const LLAVES_ENVASADO_DIARIO = ['envasado', 'fecha', 'nota', 'usuario_creador'] as const

export function sellarEnvasadoDiario(p: PayloadEnvasadoDiario): string {
  return sellar(p, LLAVES_ENVASADO_DIARIO)
}

export function selloEnvasadoDiarioCoincide(p: PayloadEnvasadoDiario, sello: unknown): boolean {
  return selloEmpata(p, LLAVES_ENVASADO_DIARIO, sello)
}

/** La nota del envasado: el codigo de lote dicho, que NO lo liga a ese lote. */
export function notaDelEnvasado(codigoDicho: string | null | undefined): string {
  const c = String(codigoDicho ?? '').trim().toUpperCase()
  return c === '' ? '' : `codigo dicho: ${c} (el envasado no se liga al lote)`
}

export type ResultadoEnvasadoDiario =
  | {
      ok: true
      payload: PayloadEnvasadoDiario
      desglose: { nombre: string; botellas: number }[]
      avisos: string[]
    }
  | { ok: false; error: string }

/**
 * Las lineas pedidas (formato ya resuelto) -> lo que se escribe. Mismos topes
 * que el envasado de un lote (`normalizarLote`): botellas enteras, > 0, <=
 * TOPE_BOTELLAS; el mismo formato dicho dos veces se suma.
 */
export function normalizarEnvasadoDiario(
  lineas: readonly { formato: FormatoDeBotella; botellas: number }[],
  ctx: { etiqueta: string; ahora: Date; codigoDicho?: string | null }
): ResultadoEnvasadoDiario {
  if (lineas.length === 0) return { ok: false, error: 'Cuantas botellas, y de que formato?' }
  const avisos: string[] = []
  const porFormato = new Map<string, { formato: FormatoDeBotella; botellas: number }>()
  for (const linea of lineas) {
    const botellas = Number(linea.botellas)
    if (!Number.isInteger(botellas) || botellas <= 0) {
      return { ok: false, error: `No entendi cuantas botellas de ${linea.formato.nombre}.` }
    }
    if (botellas > TOPE_BOTELLAS) return { ok: false, error: `${botellas} botellas es demasiado. Revisalo.` }
    const previa = porFormato.get(linea.formato.id)
    porFormato.set(linea.formato.id, { formato: linea.formato, botellas: (previa?.botellas ?? 0) + botellas })
    if (previa) avisos.push(`Sume las botellas de ${linea.formato.nombre}.`)
  }
  const filas = [...porFormato.values()]
  return {
    ok: true,
    payload: {
      fecha: fechaLocal(ctx.ahora),
      usuario_creador: `telegram:${ctx.etiqueta}`,
      envasado: filas.map((f) => ({ id_producto: f.formato.id, botellas: f.botellas })),
      nota: notaDelEnvasado(ctx.codigoDicho)
    },
    desglose: filas.map((f) => ({ nombre: f.formato.nombre, botellas: f.botellas })),
    avisos
  }
}

function corto(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

export function mensajeDeEnvasadoDiario(
  p: PayloadEnvasadoDiario,
  desglose: readonly { nombre: string; botellas: number }[],
  movimientos: readonly { nombre: string; tipo: 'PRODUCCION' | 'TRASPASO'; cantidad: number }[],
  avisos: readonly string[]
): string {
  const lineas = ['Esto es lo que voy a escribir. Revisalo:', '', `ENVASADO DEL DIA (${fechaParaPersona(p.fecha)}), sin lote:`]
  for (const e of desglose) lineas.push(`   ${e.botellas} de ${e.nombre}`)
  if (p.nota) lineas.push('', `Nota: ${p.nota}`)
  if (movimientos.length > 0) {
    lineas.push('', 'INVENTARIO DE LA MATRIZ:')
    for (const m of movimientos) lineas.push(`   ${m.tipo === 'PRODUCCION' ? '+' : '-'}${corto(m.cantidad)} ${m.nombre}`)
  }
  for (const aviso of avisos) lineas.push('', `OJO: ${aviso}`)
  lineas.push('', 'Contesta VA para escribirlo, o dime que cambio.')
  return lineas.join('\n')
}
