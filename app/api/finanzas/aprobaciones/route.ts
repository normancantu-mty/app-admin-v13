import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getCurrentUser } from '@/lib/auth-utils'
import { CATEGORIA_ABONO_PENDIENTE, CATEGORIA_ABONO_REAL } from '@/lib/finance-utils'
import { fetchTodasLasFilas } from '@/lib/paginacion'

// Cliente por request con la sesion del usuario. El cliente browser de
// '@/lib/supabase' viaja sin sesion desde un route handler (o sea, como `anon`):
// con RLS encendido no leeria nada, y desde el prompt 1 `anon` ya no puede
// escribir, asi que el PATCH de aprobar/rechazar tampoco funcionaba.
async function getSupabaseRoute() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    }
  )
}

type AprobacionAction = 'APPROVE' | 'REJECT'

function calcularDesgloseFiscal(
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

export async function GET() {
  try {
    const currentUser = await getCurrentUser()
    if (currentUser?.rol !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Solo ADMIN puede consultar la cola de aprobaciones.' },
        { status: 403 }
      )
    }

    const supabase = await getSupabaseRoute()
    // ERP-25: paginado. Es la cola de aprobaciones. Truncada no da error: da una
    // cola corta, y un abono que nadie ve es un abono que nadie aprueba.
    const data = await fetchTodasLasFilas<unknown>(
      () =>
        supabase
          .from('finanzas_ledger')
          .select(`
        id,
        fecha_movimiento,
        monto,
        categoria_gasto,
        entidad_relacionada:entidades!id_entidad_relacionada(nombre),
        cuenta_destino:cuentas_financieras!id_cuenta_destino(nombre)
      `)
          .eq('status', 'ACTIVO')
          .eq('categoria', CATEGORIA_ABONO_PENDIENTE)
          .eq('tipo_movimiento', 'ABONO_DEUDA')
          .order('fecha_movimiento', { ascending: false }),
      'aprobaciones pendientes'
    )

    return NextResponse.json({ approvals: data })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error interno al obtener pendientes.' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: Request) {
  try {
    const currentUser = await getCurrentUser()
    if (currentUser?.rol !== 'ADMIN') {
      return NextResponse.json({ error: 'Solo ADMIN puede aprobar/rechazar abonos.' }, { status: 403 })
    }

    const body = await request.json()
    const id = body?.id as string | undefined
    const action = body?.action as AprobacionAction | undefined

    if (!id || !action || !['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json({ error: 'Payload inválido.' }, { status: 400 })
    }

    const supabase = await getSupabaseRoute()
    const { data: movimiento, error: movimientoError } = await supabase
      .from('finanzas_ledger')
      .select('id, tipo_movimiento, categoria, monto, id_cuenta_destino, id_entidad_relacionada, status')
      .eq('id', id)
      .eq('status', 'ACTIVO')
      .eq('categoria', CATEGORIA_ABONO_PENDIENTE)
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
        .update({ status: 'ANULADO' })
        .eq('id', id)
        .eq('categoria', CATEGORIA_ABONO_PENDIENTE)

      if (rejectError) {
        return NextResponse.json({ error: rejectError.message }, { status: 500 })
      }

      return NextResponse.json({ ok: true })
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
        return NextResponse.json({ error: cuentaError.message }, { status: 500 })
      }

      const desglose = calcularDesgloseFiscal(movimiento.monto, cuenta?.tipo_fiscalidad || '')

      const { error: baseError } = await supabase
        .from('finanzas_ledger')
        .update({ monto: desglose.base, categoria: CATEGORIA_ABONO_REAL, status: 'ACTIVO' })
        .eq('id', id)
        .eq('categoria', CATEGORIA_ABONO_PENDIENTE)

      if (baseError) {
        return NextResponse.json({ error: baseError.message }, { status: 500 })
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
          return NextResponse.json({ error: reservasError.message }, { status: 500 })
        }
      }
    } else {
      const { error: approveErrorSimple } = await supabase
        .from('finanzas_ledger')
        .update({ categoria: CATEGORIA_ABONO_REAL, status: 'ACTIVO' })
        .eq('id', id)
        .eq('categoria', CATEGORIA_ABONO_PENDIENTE)

      if (approveErrorSimple) {
        return NextResponse.json({ error: approveErrorSimple.message }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error interno al procesar aprobación.' },
      { status: 500 }
    )
  }
}
