/**
 * La aprobacion de un abono PENDIENTE: la logica que era el PATCH de
 * `app/api/finanzas/aprobaciones/route.ts`, **extraida sin cambiarla** para
 * que la pantalla (`PendingApprovalsPanel`) y el boton Aprobar del bot (FASE 9,
 * D97) llamen LA MISMA funcion. Aprobado desde un lado, el otro lo ve: el
 * estado vive en la fila (`categoria`), no en quien lo aprobo.
 *
 * Quien puede aprobar lo decide el que llama (la ruta exige ADMIN; el bot,
 * `esAprobador`). Aqui solo se aprueba o se rechaza.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CATEGORIA_ABONO_PENDIENTE, CATEGORIA_ABONO_REAL } from '@/lib/finance-utils'

export type AprobacionAction = 'APPROVE' | 'REJECT'

export function calcularDesgloseFiscal(
  monto: number,
  tipoFiscalidad: string
) {
  if (tipoFiscalidad === 'FULL_TAX') {
    const base = monto / 1.7748
    const ieps = base * 0.53
    const iva = (base + ieps) * 0.16
    return {
      base: Math.round(base * 100) / 100,
      iva: Math.round(iva * 100) / 100,
      ieps: Math.round(ieps * 100) / 100
    }
  }

  if (tipoFiscalidad === 'IVA_ONLY') {
    const base = monto / 1.16
    const iva = base * 0.16
    return {
      base: Math.round(base * 100) / 100,
      iva: Math.round(iva * 100) / 100,
      ieps: 0
    }
  }

  return {
    base: Math.round(monto * 100) / 100,
    iva: 0,
    ieps: 0
  }
}

export type ResultadoAprobacion = { ok: true } | { ok: false; status: number; error: string }

export async function resolverAprobacionDeAbono(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  id: string,
  action: AprobacionAction
): Promise<ResultadoAprobacion> {
  const { data: movimiento, error: movimientoError } = await supabase
    .from('finanzas_ledger')
    .select('id, tipo_movimiento, categoria, monto, id_cuenta_destino, id_entidad_relacionada, status')
    .eq('id', id)
    .eq('status', 'ACTIVO')
    .eq('categoria', CATEGORIA_ABONO_PENDIENTE)
    .single()

  if (movimientoError || !movimiento) {
    return { ok: false, status: 404, error: 'No se encontró el movimiento pendiente o ya fue procesado.' }
  }

  if (action === 'REJECT') {
    const { error: rejectError } = await supabase
      .from('finanzas_ledger')
      .update({ status: 'ANULADO' })
      .eq('id', id)
      .eq('categoria', CATEGORIA_ABONO_PENDIENTE)

    if (rejectError) {
      return { ok: false, status: 500, error: rejectError.message }
    }

    return { ok: true }
  }

  if (
    movimiento.tipo_movimiento === 'ABONO_DEUDA' &&
    movimiento.id_cuenta_destino
  ) {
    const { data: cuenta, error: cuentaError } = await supabase
      .from('cuentas_financieras')
      .select('tipo_fiscalidad')
      .eq('id', movimiento.id_cuenta_destino)
      .single()

    if (cuentaError) {
      return { ok: false, status: 500, error: cuentaError.message }
    }

    const desglose = calcularDesgloseFiscal(movimiento.monto, cuenta?.tipo_fiscalidad || '')

    const { error: baseError } = await supabase
      .from('finanzas_ledger')
      .update({ monto: desglose.base, categoria: CATEGORIA_ABONO_REAL, status: 'ACTIVO' })
      .eq('id', id)
      .eq('categoria', CATEGORIA_ABONO_PENDIENTE)

    if (baseError) {
      return { ok: false, status: 500, error: baseError.message }
    }

    const reservas: Array<{
      tipo_movimiento: 'PASIVO_IVA' | 'PASIVO_IEPS'
      categoria: string
      monto: number
      id_cuenta_destino: string
      id_entidad_relacionada: string | null
      categoria_gasto: string
      status: 'ACTIVO'
    }> = []

    if (desglose.iva > 0) {
      reservas.push({
        tipo_movimiento: 'PASIVO_IVA',
        categoria: 'RESERVA_FISCAL_IVA',
        monto: desglose.iva,
        id_cuenta_destino: movimiento.id_cuenta_destino,
        id_entidad_relacionada: movimiento.id_entidad_relacionada ?? null,
        categoria_gasto: 'Reserva IVA por cobro de deuda aprobado',
        status: 'ACTIVO'
      })
    }

    if (desglose.ieps > 0) {
      reservas.push({
        tipo_movimiento: 'PASIVO_IEPS',
        categoria: 'RESERVA_FISCAL_IEPS',
        monto: desglose.ieps,
        id_cuenta_destino: movimiento.id_cuenta_destino,
        id_entidad_relacionada: movimiento.id_entidad_relacionada ?? null,
        categoria_gasto: 'Reserva IEPS por cobro de deuda aprobado',
        status: 'ACTIVO'
      })
    }

    if (reservas.length > 0) {
      const { error: reservasError } = await supabase
        .from('finanzas_ledger')
        .insert(reservas)

      if (reservasError) {
        return { ok: false, status: 500, error: reservasError.message }
      }
    }
  } else {
    const { error: approveErrorSimple } = await supabase
      .from('finanzas_ledger')
      .update({ categoria: CATEGORIA_ABONO_REAL, status: 'ACTIVO' })
      .eq('id', id)
      .eq('categoria', CATEGORIA_ABONO_PENDIENTE)

    if (approveErrorSimple) {
      return { ok: false, status: 500, error: approveErrorSimple.message }
    }
  }

  return { ok: true }
}
