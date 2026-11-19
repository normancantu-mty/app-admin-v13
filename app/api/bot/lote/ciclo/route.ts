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
 *                     consecutivo). 2026-11-18: `codigos` trae tambien los
 *                     ALIAS (nombres anteriores) y `siguiente` es el
 *                     consecutivo de `siguiente_codigo_lote()` (fuente unica en
 *                     SQL). Solo lectura.
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
 *   · `estado`      — (D-010, 2026-11-19) `lotes.estado_proceso` =
 *                     FERMENTACION | DESTILADO | TERMINADO, por nombre o alias.
 *                     Mismo permiso que `muestra` (solo `si`). Si la columna aun
 *                     no existe, 409 con mensaje: no truena.
 *
 * D-010: `leer` trae por lote `estado_proceso` (null si la columna aun no
 * existe: se lee con `*`) e `insumos` {sku: cantidad} de `lote_entradas`, para
 * que el bot no recuerde nada a un lote DESTILADO/TERMINADO o ya completo.
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { actorDe } from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { diaDeTemperatura, esTipoRecordatorio } from '@/lib/bot-lote-ciclo'
import { fechaLocal } from '@/lib/fechas'
import { aliasPorLote, nombreDelLote, nombresTomados, type FilaAlias } from '@/lib/lote-alias'

export const dynamic = 'force-dynamic'

const VENTANA_MAXIMA_DIAS = 120
const TOPE_INTENTOS = 10
const ESTADOS_PROCESO = ['FERMENTACION', 'DESTILADO', 'TERMINADO'] as const

/** La columna `estado_proceso` todavia no existe (42703 / PGRST204). */
function faltaColumna(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === '42703' || error.code === 'PGRST204' || /estado_proceso/i.test(error.message ?? '')
}

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
        // `*` y no la lista: tolera que `estado_proceso` (D-010) aun no exista.
        .select('*')
        .gte('fecha_inicio', desdeFecha)
        .order('fecha_inicio', { ascending: true })
      if (error) {
        console.error('[bot/ciclo] leer lotes:', error)
        return NextResponse.json({ error: 'No pude leer los lotes.' }, { status: 500 })
      }
      const ids = (lotes ?? []).map((l) => l.id as string)
      const [etapas, recordatorios, borradores, identidades, temperaturas, codigos, alias, siguiente, entradas] = await Promise.all([
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
        supabase.from('lotes').select('codigo_lote'),
        supabase.from('lote_alias').select('id_lote, alias'),
        supabase.rpc('siguiente_codigo_lote'),
        ids.length
          ? supabase.from('lote_entradas').select('id_lote, cantidad, catalogo_productos(sku)').in('id_lote', ids)
          : Promise.resolve({ data: [], error: null })
      ])
      for (const r of [etapas, recordatorios, borradores, identidades, temperaturas, codigos, alias, siguiente, entradas]) {
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
      // D-010: lo que ya entro a cada lote, por SKU (el bot decide si ya esta completo).
      const insumosDe = new Map<string, Record<string, number>>()
      for (const e of (entradas.data ?? []) as unknown as {
        id_lote: string
        cantidad: number | null
        catalogo_productos: { sku?: string | null } | { sku?: string | null }[] | null
      }[]) {
        const cat = Array.isArray(e.catalogo_productos) ? e.catalogo_productos[0] : e.catalogo_productos
        const sku = cat?.sku
        if (!sku) continue
        const m = insumosDe.get(e.id_lote) ?? {}
        m[sku] = (m[sku] ?? 0) + Number(e.cantidad ?? 0)
        insumosDe.set(e.id_lote, m)
      }
      const filas = (lotes ?? []).map((l) => ({
        id: l.id,
        estado_proceso: (l as { estado_proceso?: string | null }).estado_proceso ?? null,
        insumos: insumosDe.get(l.id as string) ?? {},
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
        codigos: nombresTomados(
          ((codigos.data ?? []) as { codigo_lote: string }[]).map((c) => c.codigo_lote),
          (alias.data ?? []) as FilaAlias[]
        ),
        siguiente: typeof siguiente.data === 'string' ? siguiente.data : null
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
      // Auditoria 2026-11-03 (hallazgo 6): esto escribe sin borrador ni puerta,
      // asi que solo con `si` (Norman). `aprobacion` ya no basta: no hay Aprobar
      // que esperar en un boton suelto.
      const veredicto = permisoDeAccion(actorDe(quien), 'lote')
      if (veredicto === 'no') {
        return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['lote'] }, { status: 403 })
      }
      if (veredicto !== 'si') {
        return NextResponse.json(
          { error: 'La muestra guardada la anota el clic de Norman. Tu clic no escribio nada.' },
          { status: 403 }
        )
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

    if (accion === 'estado') {
      const telegramId = Number(cuerpo.telegram_id)
      const dicho = String(cuerpo.lote ?? '').trim()
      const estado = String(cuerpo.estado ?? '').trim().toUpperCase()
      if (!Number.isSafeInteger(telegramId) || dicho === '' || !(ESTADOS_PROCESO as readonly string[]).includes(estado)) {
        return NextResponse.json(
          { error: 'telegram_id, lote y estado (FERMENTACION, DESTILADO o TERMINADO) validos.' },
          { status: 400 }
        )
      }
      const quien = await resolverIdentidad(tipada, telegramId)
      if (!quien) return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
      const veredicto = permisoDeAccion(actorDe(quien), 'lote')
      if (veredicto === 'no') {
        return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['lote'] }, { status: 403 })
      }
      if (veredicto !== 'si') {
        return NextResponse.json(
          { error: 'El estado del lote lo cambia Norman o un ADMIN. No cambie nada.' },
          { status: 403 }
        )
      }
      const [todos, alias] = await Promise.all([
        supabase.from('lotes').select('id, codigo_lote'),
        supabase.from('lote_alias').select('id_lote, alias')
      ])
      if (todos.error || alias.error) {
        console.error('[bot/ciclo] estado leer:', todos.error ?? alias.error)
        return NextResponse.json({ error: 'No pude leer los lotes.' }, { status: 500 })
      }
      const porLote = aliasPorLote((alias.data ?? []) as FilaAlias[])
      const hallados = ((todos.data ?? []) as { id: string; codigo_lote: string }[]).filter((l) =>
        nombreDelLote(dicho, { codigo_lote: l.codigo_lote, alias: porLote.get(l.id) ?? [] })
      )
      if (hallados.length === 0) {
        return NextResponse.json({ error: `No encontre el lote ${dicho} (ni por nombre ni por alias).` }, { status: 404 })
      }
      if (hallados.length > 1) {
        return NextResponse.json({ error: `Hay mas de un lote que se llama ${dicho}. Corrigelo en la web.` }, { status: 409 })
      }
      const lote = hallados[0]
      const { data, error } = await supabase
        .from('lotes')
        .update({ estado_proceso: estado })
        .eq('id', lote.id)
        .select('codigo_lote, estado_proceso')
      if (error) {
        if (faltaColumna(error)) {
          return NextResponse.json(
            { error: 'La base todavia no tiene el estado del lote. No cambie nada; intentalo en un rato.' },
            { status: 409 }
          )
        }
        console.error('[bot/ciclo] estado:', error)
        return NextResponse.json({ error: 'No pude cambiar el estado del lote.' }, { status: 500 })
      }
      const fila = ((data ?? []) as { codigo_lote: string; estado_proceso: string | null }[])[0]
      const queda = fila?.estado_proceso ?? estado
      return NextResponse.json({
        ok: true,
        id_lote: lote.id,
        codigo_lote: lote.codigo_lote,
        estado_proceso: queda,
        mensaje:
          queda === estado
            ? `Listo: el lote ${lote.codigo_lote} quedo en ${queda}.`
            : `Pedi ${estado}, pero la base dejo el lote ${lote.codigo_lote} en ${queda}.`
      })
    }

    return NextResponse.json({ error: 'accion desconocida.' }, { status: 400 })
  } catch (e) {
    console.error('[bot/ciclo] reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
