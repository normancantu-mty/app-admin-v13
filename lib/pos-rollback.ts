/**
 * ERP-66 — LA COMPENSACION DEL POS DEJA DE FALLAR EN SILENCIO.
 *
 * `registrarVenta` escribe en cuatro tablas sin transaccion. Cuando un insert
 * intermedio falla, el codigo "deshace" borrando lo ya escrito. Ese borrado
 * descartaba su resultado: `await supabase.from(...).delete().eq(...)` sin mirar
 * el error ni las filas. Desde que DELETE es solo de ADMIN, la venta fallida de
 * un vendedor no-ADMIN tiene los tres borrados denegados, y el usuario ve
 * unicamente "Error al guardar detalles" mientras el ledger conserva una venta
 * que nunca ocurrio.
 *
 * Y hay un detalle que decide el diseno: **RLS no devuelve error en un DELETE
 * denegado**. Filtra las filas, asi que PostgREST responde 200 con cero filas
 * borradas. Mirar solo `error` no habria cazado el caso del ticket. Por eso el
 * borrado pide `.select('id')` y aqui se exige que el encabezado haya devuelto
 * al menos una fila.
 *
 * Este modulo es puro —no toca Supabase— para que el juicio se pueda probar sin
 * base ni credenciales.
 *
 * **El problema, con su nombre: compensating transaction failure** — cuando no
 * hay transaccion, el "undo" es otra escritura que tambien puede fallar, y si
 * nadie la verifica el sistema queda en el estado que el undo iba a evitar.
 */

export interface BorradoDeRollback {
  /** Tabla que se intento limpiar. El nombre del campo NO es `tabla` a proposito: ese es el que barre el centinela de avisos en tests/avisos.spec.ts. */
  nombreTabla: string
  /** Error de PostgREST, si lo hubo. */
  error: { message: string } | null
  /** Filas que el DELETE devolvio con `.select()`. `null` = no se midio. */
  filasBorradas: number | null
  /**
   * `true` cuando cero filas ya es un fallo: el encabezado del ticket existe con
   * certeza —lo acabamos de insertar—, asi que un borrado que no devuelve nada
   * significa que RLS lo bloqueo y el ticket sigue vivo.
   */
  exigeFilas: boolean
}

export interface ResultadoRollbackPOS {
  /** `true` si las tres tablas quedaron limpias. */
  ok: boolean
  /** Tablas donde quedo basura, con el motivo. Vacio si `ok`. */
  restos: string[]
  /** Texto para el usuario, o `null` si el rollback limpio. */
  aviso: string | null
}

/** Folio corto, el mismo que ya usan las categorias del ledger. */
export function folioCorto(ticketId: string): string {
  return ticketId.slice(0, 8).toUpperCase()
}

export function evaluarRollbackPOS(
  ticketId: string,
  borrados: BorradoDeRollback[]
): ResultadoRollbackPOS {
  const restos: string[] = []

  for (const borrado of borrados) {
    if (borrado.error) {
      restos.push(`${borrado.nombreTabla}: ${borrado.error.message}`)
      continue
    }
    if (borrado.exigeFilas && borrado.filasBorradas === 0) {
      restos.push(`${borrado.nombreTabla}: el borrado no afecto ninguna fila (permiso denegado)`)
    }
  }

  if (restos.length === 0) return { ok: true, restos: [], aviso: null }

  return {
    ok: false,
    restos,
    aviso:
      `La venta no se pudo completar y la limpieza tampoco: el ticket ${folioCorto(ticketId)} ` +
      `quedo a medias en la base. NO repitas la venta; reportalo a administracion con ese ` +
      `folio. Detalle: ${restos.join(' | ')}`
  }
}

/**
 * Une el error que aborto la venta con lo que haya dejado el rollback. Si el
 * rollback limpio, el mensaje es exactamente el de antes: nadie ve ruido nuevo
 * por un caso que si se resolvio.
 */
export function componerErrorDeVenta(
  errorOriginal: string,
  rollback: ResultadoRollbackPOS
): string {
  return rollback.ok ? errorOriginal : `${errorOriginal}. ${rollback.aviso}`
}
