import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth-utils'

type AprobacionAction = 'APPROVE' | 'REJECT'

function calcularFugaFiscal(
  monto: number,
  tipoFiscalidad: string,
  idCuentaDestino: string
) {
  if (tipoFiscalidad === 'IVA_ONLY') {
    const base = monto / 1.16
    const iva = monto - base
    const ivaRedondeado = Math.round(iva * 100) / 100

    return {
      tipo_movimiento: 'GASTO_OPERATIVO',
      categoria: 'Fuga_Fiscal_IVA',
      monto: ivaRedondeado,
      id_cuenta_origen: idCuentaDestino,
      categoria_gasto: 'Subsidio IVA por abono bancario',
      status: 'APPROVED'
    }
  }

  if (tipoFiscalidad === 'FULL_TAX') {
    const base = monto / 1.7748
    const impuestos = monto - base
    const impuestosRedondeados = Math.round(impuestos * 100) / 100

    return {
      tipo_movimiento: 'GASTO_OPERATIVO',
      categoria: 'Fuga_Fiscal_IEPS_IVA',
      monto: impuestosRedondeados,
      id_cuenta_origen: idCuentaDestino,
      categoria_gasto: 'Subsidio IEPS+IVA por abono bancario',
      status: 'APPROVED'
    }
  }

  return null
}

export async function GET() {
  try {
    const currentUser = await getCurrentUser()
    if (!currentUser || (currentUser.rol !== 'ADMIN' && currentUser.rol !== 'SUB-ADMIN')) {
      return NextResponse.json({ error: 'Solo ADMIN puede ver aprobaciones pendientes.' }, { status: 403 })
    }

    const { data, error } = await supabase
      .from('finanzas_ledger')
      .select(`
        id,
        fecha_movimiento,
        monto,
        categoria_gasto,
        entidad_relacionada:entidades!id_entidad_relacionada(nombre),
        cuenta_destino:cuentas_financieras!id_cuenta_destino(nombre)
      `)
      .eq('status', 'PENDING')
      .eq('tipo_movimiento', 'ABONO_DEUDA')
      .order('fecha_movimiento', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ approvals: data || [] })
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Error interno al obtener pendientes.' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: Request) {
  try {
    const currentUser = await getCurrentUser()
    if (!currentUser || currentUser.rol !== 'ADMIN') {
      return NextResponse.json({ error: 'Solo ADMIN puede aprobar/rechazar abonos.' }, { status: 403 })
    }

    const body = await request.json()
    const id = body?.id as string | undefined
    const action = body?.action as AprobacionAction | undefined

    if (!id || !action || !['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json({ error: 'Payload inválido.' }, { status: 400 })
    }

    const { data: movimiento, error: movimientoError } = await supabase
      .from('finanzas_ledger')
      .select('id, tipo_movimiento, categoria, monto, id_cuenta_destino, status')
      .eq('id', id)
      .eq('status', 'PENDING')
      .single()

    if (movimientoError || !movimiento) {
      return NextResponse.json(
        { error: 'No se encontró el movimiento pendiente o ya fue procesado.' },
        { status: 404 }
      )
    }

    if (action === 'REJECT') {
      const { error: rejectError } = await supabase
        .from('finanzas_ledger')
        .update({ status: 'REJECTED' })
        .eq('id', id)
        .eq('status', 'PENDING')

      if (rejectError) {
        return NextResponse.json({ error: rejectError.message }, { status: 500 })
      }

      return NextResponse.json({ ok: true })
    }

    const { error: approveError } = await supabase
      .from('finanzas_ledger')
      .update({ status: 'APPROVED' })
      .eq('id', id)
      .eq('status', 'PENDING')

    if (approveError) {
      return NextResponse.json({ error: approveError.message }, { status: 500 })
    }

    // CRITICAL GUARDRAIL:
    // Fuga Fiscal se ejecuta solo cuando ADMIN aprueba el ABONO pendiente.
    if (
      movimiento.tipo_movimiento === 'ABONO_DEUDA' &&
      movimiento.categoria === 'ABONO_REAL' &&
      movimiento.id_cuenta_destino
    ) {
      const { data: cuenta, error: cuentaError } = await supabase
        .from('cuentas_financieras')
        .select('tipo_fiscalidad')
        .eq('id', movimiento.id_cuenta_destino)
        .single()

      if (cuentaError) {
        return NextResponse.json({ error: cuentaError.message }, { status: 500 })
      }

      const fugaFiscal = calcularFugaFiscal(
        movimiento.monto,
        cuenta?.tipo_fiscalidad || '',
        movimiento.id_cuenta_destino
      )

      if (fugaFiscal) {
        const { error: fugaError } = await supabase
          .from('finanzas_ledger')
          .insert(fugaFiscal)

        if (fugaError) {
          return NextResponse.json({ error: fugaError.message }, { status: 500 })
        }
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Error interno al procesar aprobación.' },
      { status: 500 }
    )
  }
}
