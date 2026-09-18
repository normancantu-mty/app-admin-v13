import {
  isTipoMovimientoEntrada,
  isTipoMovimientoSalida,
  isTipoMovimientoTraslado,
  type TipoMovimientoInventario
} from '@/lib/inventario-types'

/**
 * ERP-16 — un movimiento de inventario SIEMPRE dice de quien es el stock que
 * mueve. Aqui vive esa regla, y es el unico lugar donde vive.
 *
 * ─── EL DEFECTO, Y NO ES EL QUE DECIA EL TICKET ──────────────────────────────
 *
 * `compras.ts` y `devoluciones.ts` escriben `ENTRADA_COMPRA` sin
 * `id_entidad_destino`. El ticket decia que el tablero de inventario "descarta"
 * esas filas y que por eso habia dos stocks. **Medido el 2026-09-14, es al
 * reves, y es peor:** `app/dashboard/inventario/page.tsx` hace
 *
 *     const destinoEsAdmin = !destino || destino.rol === 'ADMIN'
 *
 * o sea que un destino NULO se interpreta como la Matriz. No se descarta nada:
 * la compra de cualquier entidad aterriza en el stock de la Matriz **y el
 * numero se ve perfectamente normal**. Esa es la frase de Norman -"falla pero
 * no registra una falla"- en una linea de codigo. Mientras haya una sola
 * matriz el default acierta por accidente; el dia que un local capture su
 * propia compra, el inventario de la Matriz sube por mercancia que nunca
 * estuvo ahi, sin un error, sin un aviso y sin nadie mirando.
 *
 * ─── LA MEDICION QUE FIJA EL ALCANCE (2026-09-14, base gnnqxtsdrbvmlkhfemjw) ──
 *
 *   484 filas en `inventario_ledger`. Por tipo:
 *     ENTRADA_CONCESION  125  destino SIEMPRE, origen nunca   -> coherente
 *     SALIDA_CONCESION   125  origen  SIEMPRE, destino nunca  -> coherente
 *     TRASPASO           110  origen  SIEMPRE                 -> coherente
 *     SALIDA_VENTA        55  origen  SIEMPRE                 -> coherente
 *     PRODUCCION          26  destino SIEMPRE                 -> coherente
 *     MERMA               11  origen  SIEMPRE                 -> coherente
 *     ENTRADA_COMPRA      32  -> 18 SIN destino NI origen
 *
 * `ENTRADA_COMPRA` es el UNICO tipo con filas huerfanas, y las 18 son todas del
 * 22 al 26 de mayo de 2026. Desde entonces las unicas `ENTRADA_COMPRA` que se
 * escriben vienen del POS, que si pone el destino. O sea: la regla de abajo ya
 * la cumplen 466 de 484 filas. No se esta inventando un invariante nuevo, se
 * esta escribiendo el que el sistema ya sigue.
 *
 * ─── POR QUE ESTO LANZA EN LUGAR DE LEVANTAR UN AVISO ────────────────────────
 *
 * ERP-59 dejo la regla contraria para los casos W3/W9: si el hecho fisico
 * ocurrio -las botellas existen- se registra igual y lo que falto sale como
 * aviso. Aqui NO aplica, y la diferencia importa: ninguna de estas entidades
 * viene del formulario. Las siete escrituras de `inventario_ledger` derivan la
 * entidad de la SESION o de una fila ya validada contra la base. Un movimiento
 * sin entidad no es un dato incompleto del usuario: es un error de programacion
 * en el unico camino que lo puede producir. Tragarselo con un aviso seria
 * volver a poner un default silencioso, que es justo lo que ERP-16 cierra.
 *
 * ─── LAS TRES CAPAS, PORQUE UNA SOLA SE OLVIDA ───────────────────────────────
 *
 *   1. esta funcion, llamada antes de cada INSERT           -> falla en corrida
 *   2. `tests/inventario-invariante.spec.ts`, que EXIGE que cada archivo que
 *      inserta en `inventario_ledger` la llame                -> falla en push
 *   3. `supabase/migrations/..._erp16_check_entidad_...sql`, un CHECK en
 *      Postgres. ESCRITA Y NO APLICADA: es restrictiva, y las 18 filas viejas
 *      la violan. Que hacer con ellas lo decide Norman         -> el juez final
 */

/** Lo minimo que hay que ver de un movimiento para juzgarlo. */
export type MovimientoJuzgable = {
  tipo_movimiento?: string | null
  id_entidad_destino?: string | null
  id_entidad_origen?: string | null
}

/**
 * El motivo por el que un movimiento viola el invariante, o `null` si lo
 * cumple. Pura: sin base, sin red. Es la que prueban los controles negativos.
 */
export function motivoEntidadFaltante(mov: MovimientoJuzgable): string | null {
  const tipo = mov.tipo_movimiento ?? null

  if (!tipo) {
    return 'el movimiento no trae `tipo_movimiento`'
  }

  // LOS TRASLADOS VAN PRIMERO, Y EL ORDEN ES EL ARREGLO.
  //
  // Un traslado esta en las dos listas, asi que si esto fuera despues de la
  // rama de ENTRADA, el `return` de alla lo atraparia, pediria solo el destino
  // y dejaria pasar MEDIA devolucion: entra a la matriz y no sale de nadie.
  // Ese era ERP-15. La base ya la rechaza desde la migracion `20260918014009`,
  // pero llegar hasta alla devuelve un error de constraint en vez de una frase
  // que se entienda, y esta puerta existe precisamente para eso.
  if (isTipoMovimientoTraslado(tipo)) {
    if (!mov.id_entidad_origen || !mov.id_entidad_destino) {
      const falta = !mov.id_entidad_origen ? 'id_entidad_origen' : 'id_entidad_destino'
      return (
        `\`${tipo}\` es un TRASLADO y no trae \`${falta}\`: una devolucion a medias ` +
        'deja el producto existiendo en los dos lados a la vez (ERP-15). Van las dos ' +
        'entidades en la MISMA fila: de quien sale, y a quien llega'
      )
    }
    if (mov.id_entidad_origen === mov.id_entidad_destino) {
      return (
        `\`${tipo}\` sale y llega a la misma entidad (\`${mov.id_entidad_origen}\`): ` +
        'no movio nada, y el stock que suma es el mismo que resta'
      )
    }
    return null
  }

  if (isTipoMovimientoEntrada(tipo)) {
    return mov.id_entidad_destino
      ? null
      : `\`${tipo}\` es una ENTRADA y no trae \`id_entidad_destino\`: el stock entraria a nadie, ` +
          'y los tableros leen un destino nulo como si fuera la Matriz (ERP-16)'
  }

  if (isTipoMovimientoSalida(tipo)) {
    return mov.id_entidad_origen
      ? null
      : `\`${tipo}\` es una SALIDA y no trae \`id_entidad_origen\`: el stock saldria de nadie ` +
          '(ERP-16)'
  }

  // Ni entrada ni salida. Hoy el unico asi es `LIQUIDACION_INTERNA`, que esta
  // en INVENTARIO_TIPOS_MOVIMIENTO y en ninguna de las dos listas: si alguien
  // lo escribiera, no moveria stock en ningun tablero y nadie se enteraria. Es
  // la misma falla silenciosa por otra puerta, asi que tambien se detiene aqui.
  return (
    `\`${tipo}\` no esta en TIPOS_MOVIMIENTO_ENTRADA ni en TIPOS_MOVIMIENTO_SALIDA ` +
    '(lib/inventario-types.ts): ningun tablero lo sumaria ni lo restaria, y la fila ' +
    'existiria sin mover nada'
  )
}

/**
 * La puerta. Se llama con el payload -uno o varios- ANTES del `.insert()`.
 * Lanza, no devuelve: una violacion aqui es un defecto del codigo, y un valor
 * de retorno se puede ignorar sin que el compilador diga nada.
 */
export function exigirEntidadDelMovimiento(
  movimientos: MovimientoJuzgable | MovimientoJuzgable[],
  contexto: string
): void {
  const lista = Array.isArray(movimientos) ? movimientos : [movimientos]

  for (const [indice, mov] of lista.entries()) {
    const motivo = motivoEntidadFaltante(mov)
    if (motivo) {
      throw new Error(
        `[ERP-16] ${contexto}: movimiento ${indice + 1} de ${lista.length} rechazado. ${motivo}.`
      )
    }
  }
}

/** Reexportado para que el centinela y los tableros hablen del mismo tipo. */
export type { TipoMovimientoInventario }
