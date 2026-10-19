/**
 * Lote v2 — LA PUERTA DEL CICLO DEL LOTE para el latido del bot.
 *
 * Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
 *
 * El bot no tiene credenciales de Supabase: lo que necesita para recordar cosas
 * entra y sale por aqui, con `x-bot-token`. Una ruta, cuatro acciones (mismo
 * patron que `/api/bot/bitacora`):
 *
 *   · `leer`        — lotes de la ventana con sus etapas y recordatorios ya
 *                     mandados, quien abrio cada lote, los ADMIN, los dias de
 *                     temperatura que ya hay, y todos los codigos (para el
 *                     consecutivo L-DD-MM.N). Solo lectura.
 *   · `reclamar`    — INSERT ... ON CONFLICT DO NOTHING en `lote_recordatorios`.
 *                     `reclamado: true` solo para el que inserto: cada
 *                     recordatorio sale UNA vez aunque el bot se reinicie o dos
 *                     latidos se crucen. El estado vive en la base, no en RAM.
 *   · `reintentar`  — (ronda 2) si un recordatorio se reclamo pero NO salio a
 *                     nadie, el siguiente latido lo vuelve a reclamar con un
 *                     compare-and-swap sobre `intentos` (gana UNO). El tope lo
 *                     pone el bot (YAML) y aqui se acota a TOPE_INTENTOS.
 *   · `entregado`   — (ronda 2) al menos un envio salio: `entregado_en = now()`.
 *                     Ya no se reintenta.
 *   · `temperatura` — upsert de dias de temperatura (fuente 'open-meteo
 *                     exterior' o 'manual'). PROXY sin anclar: es el aire de
 *                     fuera, no el mosto.
 *   · `muestra`     — constancia "ya guarde la muestra": quien y cuando. Sin
 *                     VA (no mueve cifras); idempotente por (lote, 'muestra').
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { actorDe } from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { diaDeTemperatura, esTipoRecordatorio } from '@/lib/bot-lote-ciclo'
import { fechaLocal } from '@/lib/fechas'

export const dynamic = 'force-dynamic'

const VENTANA_MAXIMA_DIAS = 120
const TOPE_INTENTOS = 10

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as Record<string, unknown>
    const tipada = clienteDeServicio(request)
    // Las tablas del ciclo aun no estan en `types/database`: sin tipar, solo aqui.
    const supabase = tipada as unknown as SupabaseClient
    const accion = String(cuerpo.accion ?? '')

    if (accion === 'leer') {
      const ventana = Math.min(Math.max(Number(cuerpo.ventana_dias) || 30, 1), VENTANA_MAXIMA_DIAS)
      const desde = new Date(Date.now() - ventana * 86400000)
      const desdeFecha = fechaLocal(desde)
      const { data: lotes, error } = await supabase
        .from('lotes')
        .select('id, codigo_lote, fecha_inicio, creado_en')
        .gte('fecha_inicio', desdeFecha)
        .order('fecha_inicio', { ascending: true })
      if (error) {
        console.error('[bot/ciclo] leer lotes:', error)
        return NextResponse.json({ error: 'No pude leer los lotes.' }, { status: 500 })
      }
      const ids = (lotes ?? []).map((l) => l.id as string)
      const [etapas, recordatorios, borradores, identidades, temperaturas, codigos] = await Promise.all([
        ids.length
          ? supabase.from('lote_etapas').select('id, id_lote, etapa, fecha, telegram_id, registrado_por, registrado_en').in('id_lote', ids)
          : Promise.resolve({ data: [], error: null }),
        ids.length
          ? supabase.from('lote_recordatorios').select('id_lote, tipo, enviado_en, intentos, entregado_en').in('id_lote', ids)
          : Promise.resolve({ data: [], error: null }),
        ids.length
          ? supabase.from('bot_borradores').select('telegram_id, id_registro, payload').eq('estado', 'CONFIRMADO').in('id_registro', ids)
          : Promise.resolve({ data: [], error: null }),
        supabase.from('bot_identidades').select('*, entidades!inner(rol)').eq('activo', true),
        supabase.from('temperatura_diaria').select('fecha, fuente, t_min, t_max, t_prom').gte('fecha', desdeFecha),
        supabase.from('lotes').select('codigo_lote')
      ])
      for (const r of [etapas, recordatorios, borradores, identidades, temperaturas, codigos]) {
        if (r.error) {
          console.error('[bot/ciclo] leer:', r.error)
          return NextResponse.json({ error: 'No pude leer el ciclo.' }, { status: 500 })
        }
      }
      // Quien abrio el lote: el autor del borrador `lote` que lo escribio (no las etapas).
      const abridor = new Map<string, number>()
      for (const b of (borradores.data ?? []) as { telegram_id: number; id_registro: string; payload: { tipo?: string } }[]) {
        if (b.payload?.tipo === 'lote') abridor.set(b.id_registro, Number(b.telegram_id))
      }
      // ADMIN = entidad con rol ADMIN, identidad activa, sin rol de bot (mismo criterio que `bitacora`/norman,
      // pero aqui SI entra quien requiere aprobacion: el recordatorio es informativo).
      const admins = ((identidades.data ?? []) as { telegram_id: number; rol_bot?: string | null; entidades?: { rol?: string } }[])
        .filter((f) => f.entidades?.rol === 'ADMIN' && !f.rol_bot)
        .map((f) => Number(f.telegram_id))
      const filas = (lotes ?? []).map((l) => ({
        id: l.id,
        codigo_lote: l.codigo_lote,
        fecha_inicio: l.fecha_inicio,
        creado_en: l.creado_en,
        abrio_telegram_id: abridor.get(l.id as string) ?? null,
        etapas: ((etapas.data ?? []) as { id_lote: string }[]).filter((e) => e.id_lote === l.id),
        recordatorios: ((recordatorios.data ?? []) as { id_lote: string }[]).filter((r) => r.id_lote === l.id)
      }))
      return NextResponse.json({
        ok: true,
        hoy: fechaLocal(new Date()),
        lotes: filas,
        admins: [...new Set(admins)],
        temperaturas: temperaturas.data ?? [],
        codigos: ((codigos.data ?? []) as { codigo_lote: string }[]).map((c) => c.codigo_lote)
      })
    }

    if (accion === 'reclamar') {
      const idLote = String(cuerpo.id_lote ?? '')
      if (idLote === '' || !esTipoRecordatorio(cuerpo.tipo)) {
        return NextResponse.json({ error: 'id_lote y tipo validos.' }, { status: 400 })
      }
      const { data, error } = await supabase
        .from('lote_recordatorios')
        .upsert({ id_lote: idLote, tipo: cuerpo.tipo }, { onConflict: 'id_lote,tipo', ignoreDuplicates: true })
        .select('id_lote')
      if (error) {
        console.error('[bot/ciclo] reclamar:', error)
        return NextResponse.json({ error: 'No pude reclamar el recordatorio.' }, { status: 500 })
      }
      return NextResponse.json({ ok: true, reclamado: (data ?? []).length === 1 })
    }

    if (accion === 'reintentar' || accion === 'entregado') {
      const idLote = String(cuerpo.id_lote ?? '')
      if (idLote === '' || !esTipoRecordatorio(cuerpo.tipo)) {
        return NextResponse.json({ error: 'id_lote y tipo validos.' }, { status: 400 })
      }
      if (accion === 'entregado') {
        const { error } = await supabase
          .from('lote_recordatorios')
          .update({ entregado_en: new Date().toISOString() })
          .eq('id_lote', idLote)
          .eq('tipo', cuerpo.tipo)
          .is('entregado_en', null)
        if (error) {
          console.error('[bot/ciclo] entregado:', error)
          return NextResponse.json({ error: 'No pude marcarlo entregado.' }, { status: 500 })
        }
        return NextResponse.json({ ok: true })
      }
      const intentos = Number(cuerpo.intentos)
      if (!Number.isSafeInteger(intentos) || intentos < 1 || intentos >= TOPE_INTENTOS) {
        return NextResponse.json({ ok: true, reclamado: false })
      }
      const { data, error } = await supabase
        .from('lote_recordatorios')
        .update({ intentos: intentos + 1 })
        .eq('id_lote', idLote)
        .eq('tipo', cuerpo.tipo)
        .eq('intentos', intentos)
        .is('entregado_en', null)
        .select('id_lote')
      if (error) {
        console.error('[bot/ciclo] reintentar:', error)
        return NextResponse.json({ error: 'No pude reclamar el reintento.' }, { status: 500 })
      }
      return NextResponse.json({ ok: true, reclamado: (data ?? []).length === 1 })
    }

    if (accion === 'temperatura') {
      const crudos = Array.isArray(cuerpo.dias) ? cuerpo.dias : []
      if (crudos.length === 0 || crudos.length > 400) {
        return NextResponse.json({ error: 'dias: de 1 a 400.' }, { status: 400 })
      }
      const dias = []
      for (const c of crudos) {
        const d = diaDeTemperatura(c)
        if (!d) return NextResponse.json({ error: 'Un dia de temperatura no es valido.' }, { status: 400 })
        dias.push(d)
      }
      const { error } = await supabase.from('temperatura_diaria').upsert(dias, { onConflict: 'fecha,fuente' })
      if (error) {
        console.error('[bot/ciclo] temperatura:', error)
        return NextResponse.json({ error: 'No pude guardar la temperatura.' }, { status: 500 })
      }
      return NextResponse.json({ ok: true, guardados: dias.length })
    }

    if (accion === 'muestra') {
      const telegramId = Number(cuerpo.telegram_id)
      const idLote = String(cuerpo.id_lote ?? '')
      if (!Number.isSafeInteger(telegramId) || idLote === '') {
        return NextResponse.json({ error: 'telegram_id e id_lote validos.' }, { status: 400 })
      }
      const quien = await resolverIdentidad(tipada, telegramId)
      if (!quien) return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
      if (permisoDeAccion(actorDe(quien), 'lote') === 'no') {
        return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['lote'] }, { status: 403 })
      }
      const { data: lote } = await tipada.from('lotes').select('id, codigo_lote').eq('id', idLote).maybeSingle()
      if (!lote) return NextResponse.json({ error: 'Ese lote ya no existe.' }, { status: 404 })
      const { data, error } = await supabase
        .from('lote_etapas')
        .upsert(
          {
            id_lote: idLote,
            etapa: 'muestra',
            fecha: fechaLocal(new Date()),
            telegram_id: telegramId,
            registrado_por: `telegram:${quien.etiqueta}`,
            datos: {}
          },
          { onConflict: 'id_lote,etapa', ignoreDuplicates: true }
        )
        .select('id')
      if (error) {
        console.error('[bot/ciclo] muestra:', error)
        return NextResponse.json({ error: 'No pude anotar la muestra.' }, { status: 500 })
      }
      const nueva = (data ?? []).length === 1
      return NextResponse.json({
        ok: true,
        nueva,
        mensaje: nueva
          ? `Anotado: ${quien.etiqueta} guardo la muestra del lote ${lote.codigo_lote}.`
          : `La muestra del lote ${lote.codigo_lote} ya estaba anotada.`
      })
    }

    return NextResponse.json({ error: 'accion desconocida.' }, { status: 400 })
  } catch (e) {
    console.error('[bot/ciclo] reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
