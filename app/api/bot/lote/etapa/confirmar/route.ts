/**
 * Lote v2 — escribe la ETAPA exacta que se enseno (aditivo 2 o destilacion).
 *
 * Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
 *
 * Entra `{telegram_id, borrador_id, sello}` y nada mas. Mismo orden que el lote
 * (D101): sellos -> espera del TRABAJADOR -> reclamo del aprobador -> escritura.
 * La escritura es UNA funcion SQL (`registrar_etapa_lote`): la etapa, sus
 * entradas y sus garrafas, todo o nada.
 *
 * Con la destilacion se devuelve el resumen de la fermentacion: dias (fecha de
 * produccion -> fecha de destilacion) y temperatura min/max/promedio del
 * periodo, LEIDA de `temperatura_diaria` (no se calcula al vuelo contra la API).
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import {
  abrirPuerta,
  actorDe,
  liberarReclamo,
  marcarConfirmado,
  pasarAEspera,
  reclamarAprobacion
} from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import {
  mensajeDeFermentacion,
  resumenTemperatura,
  selloEtapaCoincide,
  type DiaTemperatura,
  type PayloadEtapa
} from '@/lib/bot-lote-ciclo'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as { telegram_id?: unknown; borrador_id?: unknown; sello?: unknown }
    const telegramId = Number(cuerpo.telegram_id)
    const borradorId = String(cuerpo.borrador_id ?? '')
    const selloRecibido = String(cuerpo.sello ?? '')
    if (!Number.isSafeInteger(telegramId) || borradorId === '') {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }
    const supabase = clienteDeServicio(request)
    const quien = await resolverIdentidad(supabase, telegramId)
    if (!quien) return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    if (permisoDeAccion(actorDe(quien), 'lote') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['lote'] }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()
    if (!borrador) return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    const identidad = puerta.autor

    const guardado = borrador.payload as unknown as { tipo?: string; etapa?: PayloadEtapa }
    if (guardado?.tipo !== 'lote_etapa') {
      return NextResponse.json({ error: 'Ese borrador no es una etapa de lote.' }, { status: 409 })
    }
    const etapa = guardado.etapa
    if (!etapa || !selloEtapaCoincide(etapa, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para la etapa', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloEtapaCoincide(etapa, selloRecibido)) {
      return NextResponse.json({ error: 'El sello no empata con lo que te ensene. No escribo nada.' }, { status: 409 })
    }
    if (etapa.usuario_creador !== `telegram:${identidad.etiqueta}`) {
      return NextResponse.json({ error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' }, { status: 409 })
    }

    const queEs = `${etapa.etapa === 'aditivo_2' ? 'el aditivo 2' : etapa.etapa === 'destilacion' ? 'la destilacion' : 'el fin de la fermentacion'} del lote ${etapa.codigo_lote}`
    if (puerta.modo === 'esperar') {
      return pasarAEspera(supabase, borradorId, identidad, queEs)
    }
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

    const sinTipos = supabase as unknown as SupabaseClient

    // Fase 7B: el fin de la fermentacion escribe la CABECERA, como la web
    // (`guardarLoteAction`), y solo si el lote aun no tiene fin: el UPDATE lleva
    // `fecha_fin_fermentacion is null`, asi que dos confirmaciones no se pisan.
    if (etapa.etapa === 'fin_fermentacion') {
      const { data: hecho, error: errFin } = await sinTipos
        .from('lotes')
        .update({
          fecha_fin_fermentacion: etapa.fecha,
          ...(etapa.horas_fermentacion !== undefined ? { horas_fermentacion: etapa.horas_fermentacion } : {})
        })
        .eq('id', etapa.id_lote)
        .is('fecha_fin_fermentacion', null)
        .select('id, fecha_inicio')
      const filas = (hecho ?? []) as { id: string; fecha_inicio: string }[]
      if (errFin || filas.length !== 1) {
        await liberarReclamo(supabase, borradorId, puerta.modo)
        console.error('[bot] no se pudo registrar el fin de fermentacion', etapa.codigo_lote, errFin)
        return NextResponse.json(
          { error: errFin ? 'No pude escribirlo. No quedo nada a medias.' : `El lote ${etapa.codigo_lote} ya tenia fin de fermentacion. No escribi nada.` },
          { status: errFin ? 500 : 409 }
        )
      }
      const avisoFin = await marcarConfirmado(supabase, borradorId, etapa.id_lote)
      const inicio = filas[0].fecha_inicio
      const { data: diasT } = await sinTipos
        .from('temperatura_diaria')
        .select('fecha, fuente, t_min, t_max, t_prom')
        .gte('fecha', inicio)
        .lte('fecha', etapa.fecha)
      const resumenFin = resumenTemperatura((diasT ?? []) as DiaTemperatura[], inicio, etapa.fecha)
      return NextResponse.json({
        ...(avisoFin ? { aviso_marca: avisoFin } : {}),
        ok: true,
        id_lote: etapa.id_lote,
        codigo_lote: etapa.codigo_lote,
        etapa: etapa.etapa,
        fermentacion: { desde: inicio, hasta: etapa.fecha, horas: etapa.horas_fermentacion ?? null, temperatura: resumenFin },
        mensaje:
          `Quedo el fin de la fermentacion del lote ${etapa.codigo_lote}.` +
          (etapa.horas_fermentacion !== undefined ? ` Horas: ${etapa.horas_fermentacion}.` : '') +
          '\n' + mensajeDeFermentacion(inicio, etapa.fecha, resumenFin)
      })
    }

    const { error } = await sinTipos.rpc('registrar_etapa_lote', {
      p_id_lote: etapa.id_lote,
      p_etapa: etapa.etapa,
      p_fecha: etapa.fecha,
      p_telegram_id: etapa.telegram_id,
      p_usuario: etapa.usuario_creador,
      p_entradas: etapa.entradas,
      p_garrafas: etapa.garrafas,
      p_datos: {
        // Fase 7A: la cantidad con SU unidad (el aditivo 2 va en gramos); antes
        // la llave era `kg` y con GRAMOS habria dicho "kg: 1500".
        ...(etapa.etapa === 'aditivo_2'
          ? { cantidad: etapa.entradas[0]?.cantidad ?? null, unidad: etapa.unidad_entrada ?? 'kg' }
          : { garrafas: etapa.garrafas.length }),
        ...(etapa.notas ? { notas: etapa.notas } : {})
      }
    })
    if (error) {
      await liberarReclamo(supabase, borradorId, puerta.modo)
      const repetida = String((error as { message?: string }).message ?? '').includes('ETAPA_YA_REGISTRADA')
      console.error('[bot] no se pudo registrar la etapa', etapa.codigo_lote, etapa.etapa, error)
      return NextResponse.json(
        { error: repetida ? `Eso ya estaba registrado en el lote ${etapa.codigo_lote}. No escribi nada.` : 'No pude escribirlo. No quedo nada a medias.' },
        { status: repetida ? 409 : 500 }
      )
    }
    const avisoMarca = await marcarConfirmado(supabase, borradorId, etapa.id_lote)

    let mensaje = etapa.etapa === 'aditivo_2' ? `Quedo el aditivo 2 del lote ${etapa.codigo_lote}.` : `Quedo la destilacion del lote ${etapa.codigo_lote}: ${etapa.garrafas.length} garrafa(s).`
    let fermentacion: Record<string, unknown> | null = null
    if (etapa.etapa === 'destilacion') {
      const { data: lote } = await supabase.from('lotes').select('fecha_inicio').eq('id', etapa.id_lote).maybeSingle()
      if (lote) {
        const { data: dias } = await sinTipos
          .from('temperatura_diaria')
          .select('fecha, fuente, t_min, t_max, t_prom')
          .gte('fecha', lote.fecha_inicio)
          .lte('fecha', etapa.fecha)
        const resumen = resumenTemperatura((dias ?? []) as DiaTemperatura[], lote.fecha_inicio, etapa.fecha)
        fermentacion = { desde: lote.fecha_inicio, hasta: etapa.fecha, temperatura: resumen }
        mensaje += '\n' + mensajeDeFermentacion(lote.fecha_inicio, etapa.fecha, resumen)
      }
    }
    return NextResponse.json({
      ...(avisoMarca ? { aviso_marca: avisoMarca } : {}),
      ok: true,
      id_lote: etapa.id_lote,
      codigo_lote: etapa.codigo_lote,
      etapa: etapa.etapa,
      fermentacion,
      mensaje
    })
  } catch (e) {
    console.error('[bot] confirmar etapa reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
