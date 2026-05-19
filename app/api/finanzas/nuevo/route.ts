import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { TablesInsert } from '@/types/database'

export const dynamic = 'force-dynamic'

type TipoMovimiento = 'INGRESO_VENTA' | 'GASTO_OPERATIVO' | 'TRANSFERENCIA'
type FinanzaInsert = TablesInsert<'finanzas_ledger'>

interface NuevoMovimientoPayload {
  tipo_movimiento?: TipoMovimiento
  categoria?: string
  cuenta_destino?: string
  cuenta_origen?: string | null
  subcategoria?: string | null
  monto?: number
  descripcion?: string
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as NuevoMovimientoPayload
    const tipoMovimiento = payload.tipo_movimiento
    const categoria = payload.categoria?.trim()
    const cuentaDestino = payload.cuenta_destino?.trim()
    const cuentaOrigen = payload.cuenta_origen?.trim()
    const subcategoria = payload.subcategoria?.trim() || null
    const descripcion = payload.descripcion?.trim() || null
    const monto = Number(payload.monto)

    if (!tipoMovimiento || !['INGRESO_VENTA', 'GASTO_OPERATIVO', 'TRANSFERENCIA'].includes(tipoMovimiento)) {
      return NextResponse.json({ error: 'tipo_movimiento inválido.' }, { status: 400 })
    }
    if (tipoMovimiento !== 'TRANSFERENCIA' && !categoria) {
      return NextResponse.json({ error: 'categoria es obligatoria.' }, { status: 400 })
    }
    if (!cuentaDestino) {
      return NextResponse.json({ error: 'cuenta_destino inválida.' }, { status: 400 })
    }
    if (tipoMovimiento === 'TRANSFERENCIA') {
      if (!cuentaOrigen) {
        return NextResponse.json({ error: 'cuenta_origen inválida para transferencia.' }, { status: 400 })
      }
      if (cuentaOrigen === cuentaDestino) {
        return NextResponse.json({ error: 'cuenta_origen y cuenta_destino deben ser diferentes.' }, { status: 400 })
      }
    }
    if (!Number.isFinite(monto) || monto <= 0) {
      return NextResponse.json({ error: 'monto inválido.' }, { status: 400 })
    }

    const cookieStore = await cookies()
    const supabase = createServerClient(
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

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user?.email) {
      return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })
    }

    const { data: entidad, error: entidadError } = await supabase
      .from('entidades')
      .select('id, rol')
      .eq('email', user.email)
      .single()

    if (entidadError || !entidad) {
      return NextResponse.json({ error: 'No se pudo validar identidad operativa.' }, { status: 403 })
    }

    if (entidad.rol === 'SOCIO') {
      return NextResponse.json({ error: 'Acceso denegado para rol SOCIO.' }, { status: 403 })
    }

    const validarCuentaPropia = async (idCuenta: string): Promise<boolean> => {
      const { data: cuentaPropia, error: cuentaError } = await supabase
        .from('cuentas_financieras')
        .select('id')
        .eq('id', idCuenta)
        .eq('id_entidad', entidad.id)
        .maybeSingle()

      if (cuentaError) {
        console.error('🚨 [ERROR VALIDACION CUENTA PROPIA]:', cuentaError)
        return false
      }

      return Boolean(cuentaPropia?.id)
    }

    const cuentaDestinoValida = await validarCuentaPropia(cuentaDestino)
    if (!cuentaDestinoValida) {
      return NextResponse.json({ error: 'Cuenta destino fuera de tu alcance operativo.' }, { status: 403 })
    }

    if (tipoMovimiento === 'TRANSFERENCIA') {
      const cuentaOrigenValida = await validarCuentaPropia(cuentaOrigen!)
      if (!cuentaOrigenValida) {
        return NextResponse.json({ error: 'Cuenta origen fuera de tu alcance operativo.' }, { status: 403 })
      }

      const transferPayload: FinanzaInsert[] = [
        {
          tipo_movimiento: 'EGRESO_TRASPASO',
          categoria: 'TRANSFERENCIA',
          categoria_gasto: descripcion ?? 'Traspaso entre cuentas',
          monto,
          id_cuenta_destino: cuentaOrigen,
          usuario_creador: user.email,
          status: 'ACTIVO',
        },
        {
          tipo_movimiento: 'INGRESO_TRASPASO',
          categoria: 'TRANSFERENCIA',
          categoria_gasto: descripcion ?? 'Traspaso entre cuentas',
          monto,
          id_cuenta_destino: cuentaDestino,
          usuario_creador: user.email,
          status: 'ACTIVO',
        }
      ]

      const { data, error } = await supabase
        .from('finanzas_ledger')
        .insert(transferPayload)
        .select('id')

      if (error) {
        console.error('🚨 [ERROR CRÍTICO SUPABASE]:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ ok: true, ids: (data || []).map((item) => item.id) })
    }

    const insertPayload: FinanzaInsert = {
      tipo_movimiento: tipoMovimiento,
      categoria,
      categoria_gasto: descripcion ?? subcategoria,
      monto,
      id_cuenta_destino: cuentaDestino,
      usuario_creador: user.email,
      status: 'ACTIVO',
    }

    const { data, error } = await supabase
      .from('finanzas_ledger')
      .insert(insertPayload)
      .select('id')
      .single()

    if (error) {
      console.error('🚨 [ERROR CRÍTICO SUPABASE]:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, id: data.id })
  } catch (error: any) {
    console.error('🚨 [ERROR CRÍTICO SUPABASE]:', error)
    return NextResponse.json(
      { error: error?.message || 'Error interno al crear movimiento.' },
      { status: 500 }
    )
  }
}
