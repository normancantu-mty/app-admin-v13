import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getCurrentUser } from '@/lib/auth-utils'
import { CATEGORIA_ABONO_PENDIENTE } from '@/lib/finance-utils'
import { resolverAprobacionDeAbono, type AprobacionAction } from '@/lib/aprobacion-abonos'
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

    // La logica vive en `lib/aprobacion-abonos.ts` desde la FASE 9 (D97): el
    // boton Aprobar del bot llama la MISMA funcion.
    const supabase = await getSupabaseRoute()
    const resultado = await resolverAprobacionDeAbono(supabase, id, action)
    if (!resultado.ok) {
      return NextResponse.json({ error: resultado.error }, { status: resultado.status })
    }
    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error interno al procesar aprobación.' },
      { status: 500 }
    )
  }
}
