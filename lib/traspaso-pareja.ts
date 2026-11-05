/**
 * 2026-11-05 — LAS DOS PATAS DE UN TRASPASO ENTRE CUENTAS, LIGADAS.
 *
 * Un traspaso son dos filas de `finanzas_ledger`: `EGRESO_TRASPASO` en la cuenta
 * que da e `INGRESO_TRASPASO` en la que recibe (`saldo_cuenta` lee la cuenta
 * afectada de `id_cuenta_destino` en las dos). Sueltas son dinero que aparece o
 * desaparece: anular una sola deja $25,000 de mas o de menos en una cuenta.
 *
 * ─── LA LIGA ────────────────────────────────────────────────────────────────
 * `subcategoria = 'traspaso:<uuid>'`, igual en las dos filas. Se escogio esa
 * columna porque (medido el 2026-11-05):
 *   · no hay migracion: la columna ya existe y no tiene CHECK;
 *   · nadie la edita despues: `editar_descripcion` toca `descripcion`, no esta;
 *   · la lista cerrada de categorias solo se valida para INGRESO_VENTA y
 *     GASTO_OPERATIVO (`app/api/finanzas/nuevo/route.ts`), y los reportes que la
 *     leen saltan los traspasos antes de clasificar (`lib/v2/dinero.ts`).
 *
 * La otra familia que usa estos tipos, `convertir_transferencias`, marca en
 * `descripcion` y lleva tres filas: aqui no tiene marca, y por eso tampoco se
 * deja anular de a una (ver `anularFinanzas`).
 */

export const PREFIJO_MARCA_TRASPASO = 'traspaso:'
/** La `categoria` con la que la web ya escribe sus traspasos. */
export const CATEGORIA_TRASPASO = 'TRANSFERENCIA'

export const MENSAJE_PAREJA_INCOMPLETA =
  'Ese traspaso no tiene sus dos filas completas: no anulo una sola pata, porque ' +
  'el dinero apareceria o desapareceria. Hay que revisarlo a mano.'

export const MENSAJE_SIN_MARCA =
  'Esa fila es una pata de un traspaso o de una conversion sin su pareja marcada. ' +
  'Anular solo esa descuadraria las cuentas: no la anulo.'

export function esPataDeTraspaso(tipo: string | null | undefined): boolean {
  return tipo === 'EGRESO_TRASPASO' || tipo === 'INGRESO_TRASPASO'
}

export function marcaDeTraspaso(uuid: string): string {
  return PREFIJO_MARCA_TRASPASO + uuid
}

export function esMarcaDeTraspaso(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.length > PREFIJO_MARCA_TRASPASO.length && valor.startsWith(PREFIJO_MARCA_TRASPASO)
}

export interface PataDeTraspaso {
  id: string
  tipo_movimiento: string | null
  monto: number | string | null
  status: string | null
}

export type JuicioDePareja = { ok: true; ids: [string, string] } | { ok: false; error: string }

/**
 * Exactamente una salida y una entrada, del mismo monto y las dos activas. **Pura.**
 * Cualquier otra cosa no se anula: mas vale un error en la cara que media pareja.
 */
export function juzgarPareja(filas: readonly PataDeTraspaso[]): JuicioDePareja {
  if (filas.length !== 2) return { ok: false, error: MENSAJE_PAREJA_INCOMPLETA }
  const egreso = filas.find((f) => f.tipo_movimiento === 'EGRESO_TRASPASO')
  const ingreso = filas.find((f) => f.tipo_movimiento === 'INGRESO_TRASPASO')
  if (!egreso || !ingreso) return { ok: false, error: MENSAJE_PAREJA_INCOMPLETA }
  if (Number(egreso.monto) !== Number(ingreso.monto)) return { ok: false, error: MENSAJE_PAREJA_INCOMPLETA }
  if (egreso.status !== 'ACTIVO' || ingreso.status !== 'ACTIVO') {
    return { ok: false, error: MENSAJE_PAREJA_INCOMPLETA }
  }
  return { ok: true, ids: [egreso.id, ingreso.id] }
}
