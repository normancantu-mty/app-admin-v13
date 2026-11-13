/**
 * POST /api/categorias/nueva — alta de categoria/subcategoria desde la web v2.
 * Escrito el 2026-11-03 por el ejecutor del Socio. Solo ADMIN (y el RLS de
 * `categorias_movimiento` lo vuelve a exigir: `mi_rol() = 'ADMIN'`). La regla
 * vive en `lib/categorias-movimiento.ts`, la misma que usa el bot.
 */

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth-utils'
import { getServerSupabaseClient } from '@/lib/server-session'
import { esAdmin } from '@/lib/v2/roles'
import { validarAltaCategoria, type FilaCategoria } from '@/lib/categorias-movimiento'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const usuario = await getCurrentUser()
    if (!usuario) return NextResponse.json({ error: 'Sin sesion.' }, { status: 401 })
    if (!esAdmin(usuario.rol)) {
      return NextResponse.json({ error: 'Agregar categorias lo hace un ADMIN.' }, { status: 403 })
    }
    const cuerpo = (await request.json()) as { tipo?: unknown; categoria?: unknown; subcategoria?: unknown }
    const supabase = await getServerSupabaseClient()
    const { data: filas, error: errLectura } = await supabase
      .from('categorias_movimiento')
      .select('tipo, categoria, subcategoria, orden')
    if (errLectura) return NextResponse.json({ error: 'No pude leer la lista de categorias.' }, { status: 500 })
    const juicio = validarAltaCategoria(cuerpo, (filas ?? []) as FilaCategoria[])
    if (!juicio.ok) return NextResponse.json({ error: `No la agrego: ${juicio.motivo}.` }, { status: 422 })
    const { error } = await supabase.from('categorias_movimiento').insert({
      tipo: juicio.tipo,
      categoria: juicio.categoria,
      subcategoria: juicio.subcategoria,
      orden: juicio.orden,
      activa: true
    })
    if (error) {
      const choque = (error as { code?: string }).code === '23505'
      return NextResponse.json(
        { error: choque ? 'Esa categoria/subcategoria ya existe.' : 'No pude guardarla.' },
        { status: choque ? 409 : 500 }
      )
    }
    return NextResponse.json({
      ok: true,
      categoria: juicio.categoria,
      subcategoria: juicio.subcategoria,
      categoria_nueva: juicio.categoriaNueva
    })
  } catch (e) {
    console.error('[categorias] alta reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
