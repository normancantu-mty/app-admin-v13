import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database, TablesInsert } from '@/types/database'
import { marcaDeTraspaso } from '@/lib/traspaso-pareja'
import { CATEGORIA_SIN_CATEGORIZAR, normalizarCategoriaGasto } from '@/lib/avisos'
import { registrarAviso } from '@/lib/avisos-server'

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
    // ── W14 · ERP-59 ────────────────────────────────────────────────────────
    // Hasta el 2026-09-05 esta linea decia:
    //
    //     if (tipoMovimiento !== 'TRANSFERENCIA' && !categoria) {
    //       return NextResponse.json({ error: 'categoria es obligatoria.' }, { status: 400 })
    //     }
    //
    // Es la causa mecanica de los $0.00 de gasto capturado desde el 1 de julio
    // de 2026 (historico: $87,753.57). Un egreso sin categoria es un egreso
    // CAPTURADO: el dinero salio, y lo unico que falta es la etiqueta. Tirarlo
    // entero por eso no dejaba el sistema limpio, lo dejaba vacio.
    //
    // El egreso entra completo — los dos lados del asiento, monto incluido — y
    // con categoria `SIN_CATEGORIZAR`. **Nunca `NULL`**: un valor que grita se
    // revisa; un NULL se pierde entre los legitimos.
    const categoriaResuelta = normalizarCategoriaGasto(categoria)
    const faltabaCategoria = categoriaResuelta === CATEGORIA_SIN_CATEGORIZAR
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
    const supabase = createServerClient<Database>(
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

    // v2 · categorias cerradas (tabla categorias_movimiento, 2026-10-28). Un egreso
    // con categoria tiene que traer una pareja categoria/subcategoria de la lista;
    // uno sin categoria sigue entrando como SIN_CATEGORIZAR (ERP-59, arriba).
    if (tipoMovimiento === 'GASTO_OPERATIVO' && !faltabaCategoria) {
      const { data: lista, error: listaError } = await supabase
        .from('categorias_movimiento')
        .select('categoria, subcategoria')
        .eq('tipo', 'EGRESO')
        .eq('activa', true)
      if (listaError) {
        return NextResponse.json({ error: 'No se pudo leer la lista de categorias.' }, { status: 500 })
      }
      if ((lista ?? []).length > 0) {
        const existe = (lista ?? []).some(
          (fila) => fila.categoria === categoriaResuelta && fila.subcategoria === subcategoria
        )
        if (!existe) {
          return NextResponse.json(
            { error: 'Categoria y subcategoria tienen que ser de la lista cerrada.' },
            { status: 400 }
          )
        }
      }
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

      // La liga de las dos patas: sin ella, anular una descuadraria las cuentas.
      const marca = marcaDeTraspaso(randomUUID())
      const transferPayload: FinanzaInsert[] = [
        {
          tipo_movimiento: 'EGRESO_TRASPASO',
          categoria: 'TRANSFERENCIA',
          subcategoria: marca,
          categoria_gasto: descripcion ?? 'Traspaso entre cuentas',
          monto,
          id_cuenta_destino: cuentaOrigen,
          usuario_creador: user.email,
          status: 'ACTIVO',
        },
        {
          tipo_movimiento: 'INGRESO_TRASPASO',
          categoria: 'TRANSFERENCIA',
          subcategoria: marca,
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
      categoria: categoriaResuelta,
      subcategoria,
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

    // El aviso se registra DESPUES de que la fila existe, para que pueda
    // apuntarle. Si el aviso fallara, la fila ya entro: es el orden correcto.
    if (faltabaCategoria) {
      await registrarAviso(supabase, {
        tipo: 'W14',
        idEntidad: entidad.id,
        mensaje:
          `Egreso de $${monto.toFixed(2)} capturado sin categoria. Entro como ` +
          `${CATEGORIA_SIN_CATEGORIZAR}: hay que clasificarlo.`,
        tabla: 'finanzas_ledger',
        idRegistro: data.id,
        datosCapturados: {
          tipo_movimiento: tipoMovimiento,
          monto,
          descripcion,
          subcategoria
        }
      })
    }

    return NextResponse.json({ ok: true, id: data.id, aviso: faltabaCategoria ? 'W14' : null })
  } catch (error: any) {
    console.error('🚨 [ERROR CRÍTICO SUPABASE]:', error)
    return NextResponse.json(
      { error: error?.message || 'Error interno al crear movimiento.' },
      { status: 500 }
    )
  }
}
