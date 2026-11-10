/**
 * POST /api/suscripciones — alta y edicion del catalogo de suscripciones desde
 * la web v2 (Finanzas > Suscripciones). Escrito el 2026-11-09 por el Socio
 * (ejecutor). Solo ADMIN, y el RLS de `suscripciones` lo vuelve a exigir
 * (`mi_rol() = 'ADMIN'`). La regla vive en `lib/suscripciones.ts`.
 *
 * Nunca borra: "Ya no la tengo" es `activa = false` (se reactiva aqui mismo).
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getCurrentUser } from '@/lib/auth-utils'
import { getServerSupabaseClient } from '@/lib/server-session'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { cuentaUsableporElBot } from '@/lib/bot-servidor'
import { validarSuscripcion } from '@/lib/suscripciones'
import { esTablaFaltante } from '@/lib/suscripciones-leer'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const usuario = await getCurrentUser()
    if (!usuario) return NextResponse.json({ error: 'Sin sesion.' }, { status: 401 })
    if (!puedeCapturarMatriz(usuario.rol)) {
      return NextResponse.json({ error: 'Las suscripciones las edita un ADMIN.' }, { status: 403 })
    }
    const cuerpo = (await request.json()) as Record<string, unknown>
    const juicio = validarSuscripcion(cuerpo)
    if (!juicio.ok) return NextResponse.json({ error: `No la guardo: ${juicio.motivo}.` }, { status: 422 })
    const v = juicio.valores

    const tipada = await getServerSupabaseClient()
    // La tabla aun no esta en `types/database`: sin tipar, solo aqui.
    const supabase = tipada as unknown as SupabaseClient

    // La cuenta, si viene, es de la matriz y el bot la puede usar (los mismos
    // vetos que el bot: nada de cuentas fiscales ni de Fresnillo).
    if (v.id_cuenta) {
      const { data: cuenta } = await tipada
        .from('cuentas_financieras')
        .select('id, nombre, tipo_fiscalidad, id_entidad')
        .eq('id', v.id_cuenta)
        .maybeSingle()
      if (!cuenta || cuenta.id_entidad !== usuario.id || !cuentaUsableporElBot(cuenta)) {
        return NextResponse.json({ error: 'Esa cuenta no se puede usar para suscripciones.' }, { status: 422 })
      }
    }

    const fila = { ...v, actualizada_en: new Date().toISOString() }
    const id = Number(cuerpo.id)
    const r = Number.isSafeInteger(id) && id > 0
      ? await supabase.from('suscripciones').update(fila).eq('id', id).select('id').maybeSingle()
      : await supabase.from('suscripciones').insert(fila).select('id').single()
    if (r.error) {
      const code = (r.error as { code?: string }).code
      if (code === '23505') return NextResponse.json({ error: 'Ya hay una suscripcion con ese nombre.' }, { status: 409 })
      if (esTablaFaltante(r.error)) {
        return NextResponse.json({ error: 'Falta aplicar la migracion de suscripciones en la base.' }, { status: 409 })
      }
      console.error('[suscripciones] guardar:', r.error)
      return NextResponse.json({ error: 'No pude guardarla.' }, { status: 500 })
    }
    if (!r.data) return NextResponse.json({ error: 'Esa suscripcion no existe.' }, { status: 404 })
    return NextResponse.json({ ok: true, id: (r.data as { id: number }).id })
  } catch (e) {
    console.error('[suscripciones] reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
