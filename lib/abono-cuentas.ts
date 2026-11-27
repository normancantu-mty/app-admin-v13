/**
 * LA REGLA DE CUENTAS DE UN ABONO, ESCRITA UNA SOLA VEZ (2026-11-26, MAPA n7).
 *
 * Antes vivia solo dentro de `registrarAbonoAction` (`app/actions/abonos.ts`), y
 * el bot tenia la suya: cuando un DST capturaba el abono de SU local por
 * Telegram, el dinero entraba a la cuenta de la MATRIZ (`app/api/bot/abono/
 * proponer`), mientras la web lo mandaba, bien, a la cuenta del DST (D8). Dos
 * reglas para el mismo dinero son dos verdades. Desde hoy la web y el bot llaman
 * a esta funcion.
 *
 * Pura: sin red y sin base. Quien la llama resuelve las dos cuentas (id, dueno y
 * rol del dueno) y, si captura un ADMIN, el DST padre del deudor.
 *
 * Los textos de error y de concepto son los de la web, letra por letra: un abono
 * del bot tiene que ser indistinguible de uno de la pantalla.
 */

export const CONCEPTO_CARGO_ADMIN_A_DIST = 'Cargo de Deuda (Admin -> Distribuidor)'
export const CONCEPTO_ABONO_DIST_A_ADMIN = 'Abono de Deuda (Distribuidor -> Admin)'
export const CONCEPTO_ABONO_LOCAL_A_DST = 'Abono de Deuda (Local -> Distribuidor)'

export interface CuentaDelAbono {
  id: string
  /** Dueno de la cuenta. */
  id_entidad: string | null
  /** Rol del dueno, en mayusculas. */
  rol: string | null
}

export interface HechosDelAbono {
  /** Rol de quien captura (la sesion de la web o la identidad del bot). */
  rolCaptura: string
  idEntidadCaptura: string
  /** La entidad que abona: el deudor. */
  idEntidadDeudor: string
  /**
   * El DST padre del deudor, cuando el deudor es un LOC de un DST. Solo pesa si
   * captura un ADMIN y escoge como destino la cuenta de ese DST (el dinero lo
   * recibio el distribuidor). `null` = el camino de siempre.
   */
  idDstDelDeudor?: string | null
  origen: CuentaDelAbono
  destino: CuentaDelAbono
}

export type ReglaDelAbono =
  | {
      ok: true
      /** Local -> su DST: ni origen ni destino son de la matriz. */
      esLocalASuDst: boolean
      tipoMovimiento: 'CARGO_DEUDA' | 'ABONO_DEUDA'
      /** Abono de un no-ADMIN a la matriz: entra PENDIENTE hasta que un ADMIN lo aprueba. */
      requiereAprobacionAdmin: boolean
      concepto: string
      /** La cuenta del lado que no es la matriz (la del deudor, salvo en un CARGO). */
      cuentaNoAdmin: CuentaDelAbono
    }
  | { ok: false; error: string }

/**
 * D8 (2026-10-29): un DST que captura el abono de una entidad que no es el mismo
 * esta capturando el de SU local (la red ya se valido antes). Ese dinero es del
 * DST, no de la matriz.
 */
export function esAbonoDeDstPorSuLocal(
  rolCaptura: string,
  idEntidadCaptura: string,
  idEntidadDeudor: string
): boolean {
  return rolCaptura === 'DST' && idEntidadDeudor !== idEntidadCaptura
}

export function reglaDeCuentasDelAbono(h: HechosDelAbono): ReglaDelAbono {
  const dstPorSuLocal = esAbonoDeDstPorSuLocal(h.rolCaptura, h.idEntidadCaptura, h.idEntidadDeudor)
  // 2026-11-26: la matriz registra lo que el DST cobro a su local. Solo si el
  // destino es una cuenta del DST padre del deudor; cualquier otra cuenta no-ADMIN
  // sigue cayendo en la regla cruzada de siempre (y se rechaza ahi).
  const adminPorElDst =
    h.rolCaptura === 'ADMIN' &&
    Boolean(h.idDstDelDeudor) &&
    h.destino.id_entidad === h.idDstDelDeudor &&
    h.destino.rol === 'DST'
  const esLocalASuDst = dstPorSuLocal || adminPorElDst

  const origenEsAdmin = h.origen.rol === 'ADMIN'
  const destinoEsAdmin = h.destino.rol === 'ADMIN'

  let cuentaNoAdmin: CuentaDelAbono
  if (esLocalASuDst) {
    // D8: origen = cuenta del local, destino = cuenta propia del DST. Nada de
    // ADMIN en ninguno de los dos lados. Mismo patron que la cobranza del DST
    // sobre su LOC (auditoria.ts: destino en la cuenta del DST, sin aprobacion).
    const dstReceptor = dstPorSuLocal ? h.idEntidadCaptura : h.idDstDelDeudor
    if (h.destino.id_entidad !== dstReceptor) {
      return {
        ok: false,
        error: 'El abono de tu local entra a tu propia cuenta, no a la de la matriz ni a otra.'
      }
    }
    if (h.origen.id_entidad !== h.idEntidadDeudor) {
      return { ok: false, error: 'La cuenta de origen tiene que ser del local.' }
    }
    cuentaNoAdmin = h.origen
  } else {
    // Regla original (`abono/page.tsx:148-154`): solo transferencias cruzadas
    // ADMIN <-> no-ADMIN.
    const transferenciaValida = (origenEsAdmin && !destinoEsAdmin) || (!origenEsAdmin && destinoEsAdmin)
    if (!transferenciaValida) {
      return {
        ok: false,
        error: 'Solo se permiten transferencias cruzadas entre ADMIN y Distribuidor/Local.'
      }
    }
    // La cuenta que no es de ADMIN tiene que ser de la entidad del expediente.
    cuentaNoAdmin = origenEsAdmin ? h.destino : h.origen
    if (cuentaNoAdmin.id_entidad !== h.idEntidadDeudor) {
      return { ok: false, error: 'La cuenta del distribuidor no pertenece a la entidad del movimiento.' }
    }
  }

  // Admin -> Dist: CARGO_DEUDA. Dist -> Admin: ABONO_DEUDA. Regla original.
  // D8: Local -> su DST tambien es ABONO_DEUDA (baja la deuda del LOC en v_cartera).
  const tipoMovimiento: 'CARGO_DEUDA' | 'ABONO_DEUDA' =
    !esLocalASuDst && origenEsAdmin && !destinoEsAdmin ? 'CARGO_DEUDA' : 'ABONO_DEUDA'

  const requiereAprobacionAdmin =
    h.rolCaptura !== 'ADMIN' && tipoMovimiento === 'ABONO_DEUDA' && !origenEsAdmin && destinoEsAdmin

  const concepto =
    tipoMovimiento === 'CARGO_DEUDA'
      ? CONCEPTO_CARGO_ADMIN_A_DIST
      : esLocalASuDst
        ? CONCEPTO_ABONO_LOCAL_A_DST
        : CONCEPTO_ABONO_DIST_A_ADMIN

  return { ok: true, esLocalASuDst, tipoMovimiento, requiereAprobacionAdmin, concepto, cuentaNoAdmin }
}
