/**
 * Cazador F0 · WP-2a — LA BITACORA DEL BOT (solo-agregar).
 *
 * El bot de Telegram no tiene credenciales de Supabase, a proposito: todo lo
 * que escribe pasa por esta API con `x-bot-token` (bot/LEEME.md). Esta ruta es
 * la unica puerta de `bitacora`:
 *
 *   · `anotar`     — INSERT de 1..50 filas con `ON CONFLICT (clave) DO NOTHING`.
 *                    Idempotente: el bot reintenta su cola local sin duplicar.
 *   · `etiquetar`  — pone las etiquetas de una NOTA, solo si estaban vacias.
 *   · `marcar`     — cambia `procesado` (la cola del tope de la suscripcion).
 *   · `pendientes` — lee lo que tiene `procesado = false` (solo lectura).
 *   · `norman`     — los telegram_id a quienes se avisa un apagon (solo lectura).
 *
 * Lo demas lo rechaza la base: el trigger `tg_bitacora_solo_agregar`
 * (20261017084900_cazador_f0_bitacora.sql) no deja cambiar ni borrar nada mas,
 * aunque esta ruta lo intentara.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { clienteDeServicio, tokenValido } from '@/lib/bot-servidor'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import { normalizarFilaBitacora, normalizarEtiquetas, TOPE_FILAS_BITACORA } from '@/lib/bot-bitacora'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as Record<string, unknown>
    // `bitacora` aun no esta en `types/database`: cliente sin tipar, solo aqui.
    const supabase = clienteDeServicio(request) as unknown as SupabaseClient
    const accion = String(cuerpo.accion ?? '')

    if (accion === 'anotar') {
      const crudas = Array.isArray(cuerpo.filas) ? cuerpo.filas : []
      if (crudas.length === 0 || crudas.length > TOPE_FILAS_BITACORA) {
        return NextResponse.json({ error: `filas: de 1 a ${TOPE_FILAS_BITACORA}.` }, { status: 400 })
      }
      const filas = []
      for (const c of crudas) {
        const f = normalizarFilaBitacora(c)
        if (!f.ok) return NextResponse.json({ error: f.error }, { status: 400 })
        filas.push(f.fila)
      }
      const { error } = await supabase
        .from('bitacora')
        .upsert(filas, { onConflict: 'clave', ignoreDuplicates: true })
      if (error) {
        console.error('[bot/bitacora] anotar:', error)
        return NextResponse.json({ error: 'No pude escribir la bitacora.' }, { status: 500 })
      }
      return NextResponse.json({ ok: true, recibidas: filas.length })
    }

    if (accion === 'etiquetar') {
      const clave = String(cuerpo.clave ?? '')
      const etiquetas = normalizarEtiquetas(cuerpo.etiquetas)
      if (clave === '' || !etiquetas) {
        return NextResponse.json({ error: 'clave y etiquetas son obligatorias.' }, { status: 400 })
      }
      const { data, error } = await supabase
        .from('bitacora')
        .update({ etiquetas })
        .eq('clave', clave)
        .eq('etiquetas', '{}')
        .select('id')
      if (error) {
        console.error('[bot/bitacora] etiquetar:', error)
        return NextResponse.json({ error: 'No pude etiquetar.' }, { status: 500 })
      }
      return NextResponse.json({ ok: true, etiquetadas: (data ?? []).length })
    }

    if (accion === 'marcar') {
      const claves = Array.isArray(cuerpo.claves) ? cuerpo.claves.map(String).filter(Boolean) : []
      if (claves.length === 0 || claves.length > TOPE_FILAS_BITACORA || typeof cuerpo.procesado !== 'boolean') {
        return NextResponse.json({ error: 'claves (1..50) y procesado (boolean).' }, { status: 400 })
      }
      const { data, error } = await supabase
        .from('bitacora')
        .update({ procesado: cuerpo.procesado })
        .in('clave', claves)
        .select('id')
      if (error) {
        console.error('[bot/bitacora] marcar:', error)
        return NextResponse.json({ error: 'No pude marcar.' }, { status: 500 })
      }
      return NextResponse.json({ ok: true, marcadas: (data ?? []).length })
    }

    if (accion === 'pendientes') {
      const limite = Math.min(Math.max(Number(cuerpo.limite) || 50, 1), 200)
      const { data, error } = await supabase
        .from('bitacora')
        .select('clave, chat_id, telegram_id, persona, fecha, texto, transcripcion, origen')
        .eq('procesado', false)
        .neq('origen', 'bot')
        .order('fecha', { ascending: true })
        .limit(limite)
      if (error) {
        console.error('[bot/bitacora] pendientes:', error)
        return NextResponse.json({ error: 'No pude leer la bitacora.' }, { status: 500 })
      }
      return NextResponse.json({ ok: true, filas: data ?? [] })
    }

    if (accion === 'norman') {
      // A quien se le avisa un apagon: las identidades `esNorman` (ADMIN sin
      // marca de aprobacion y sin rol de bot). Solo ids; nada mas sale.
      const { data, error } = await supabase
        .from('bot_identidades')
        .select('*, entidades!inner(rol)') // `*`: funciona con o sin `rol_bot` (WP-6)
        .eq('activo', true)
      if (error) {
        console.error('[bot/bitacora] norman:', error)
        return NextResponse.json({ error: 'No pude leer las identidades.' }, { status: 500 })
      }
      const ids = (data ?? [])
        .filter((f) => {
          const r = f as unknown as { requiere_aprobacion: boolean; rol_bot: string | null; entidades: { rol: string } }
          // Auditoria 2026-11-03: Norman es ademas SU telegram_id.
          return (
            r.entidades?.rol === 'ADMIN' &&
            !r.requiere_aprobacion &&
            !r.rol_bot &&
            Number((f as unknown as { telegram_id: number }).telegram_id) === NORMAN_TELEGRAM_ID
          )
        })
        .map((f) => Number((f as unknown as { telegram_id: number }).telegram_id))
      return NextResponse.json({ ok: true, telegram_ids: ids })
    }

    return NextResponse.json({ error: 'accion invalida.' }, { status: 400 })
  } catch (e) {
    console.error('[bot/bitacora]', e)
    return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
  }
}
