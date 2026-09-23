/**
 * FASE 9 (D95) — PROPONER EL ALTA DE UN MIEMBRO DEL GRUPO. Solo Norman.
 *
 * Entra `{telegram_id (Norman), chat_id, miembro_telegram_id, texto,
 * id_entidad?}`. `texto` es lo que Norman contesto al mensaje del miembro
 * ("este es Gilberto"); `id_entidad` llega cuando ya eligio con un boton.
 * Reglas y porque: `lib/bot-miembro.ts`.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import {
  clienteDeServicio,
  conservaPendientes,
  cuentaUsableporElBot,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { actorDe, cuentaDeLaMatrizParaAbono } from '@/lib/bot-aprobacion'
import { buscarPorNombre } from '@/lib/bot-nombres'
import { ENTIDAD_PENDIENTE_DE_ASIGNAR } from '@/lib/avisos'
import {
  etiquetaDeNombre,
  mensajeDeAltaMiembro,
  nombreDelRegistro,
  sellarMiembro,
  type PayloadAltaMiembro
} from '@/lib/bot-miembro'

export const dynamic = 'force-dynamic'

const TOPE_OPCIONES = 12

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      chat_id?: unknown
      miembro_telegram_id?: unknown
      texto?: unknown
      id_entidad?: unknown
    }
    const telegramId = Number(cuerpo.telegram_id)
    const miembro = Number(cuerpo.miembro_telegram_id)
    if (!Number.isSafeInteger(telegramId) || !Number.isSafeInteger(miembro) || miembro <= 0) {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }
    if (permisoDeAccion(actorDe(identidad), 'registrar') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO.registrar }, { status: 403 })
    }

    const { data: yaEsta } = await supabase
      .from('bot_identidades')
      .select('etiqueta, activo')
      .eq('telegram_id', miembro)
      .maybeSingle()
    if (yaEsta) {
      return NextResponse.json(
        { error: `Esa persona ya esta registrada como "${yaEsta.etiqueta}"${yaEsta.activo ? '' : ' (dada de baja)'}.` },
        { status: 409 }
      )
    }

    const nombre = nombreDelRegistro(cuerpo.texto)
    const { data: filas } = await supabase.from('entidades').select('id, nombre, rol').order('nombre')
    const entidades = (filas ?? [])
      .filter((e) => e.id !== ENTIDAD_PENDIENTE_DE_ASIGNAR)
      .map((e) => ({ id: e.id, nombre: e.nombre ?? '(sin nombre)', rol: e.rol ?? '' }))
    // La Matriz va primero en los botones: es la opcion de Kevin.
    const opciones = [...entidades].sort((a, b) => Number(b.rol === 'ADMIN') - Number(a.rol === 'ADMIN'))

    const idPedido = String(cuerpo.id_entidad ?? '')
    let entidad = idPedido !== '' ? entidades.find((e) => e.id === idPedido) : undefined
    if (idPedido !== '' && !entidad) {
      return NextResponse.json({ error: 'Esa entidad ya no existe.' }, { status: 422 })
    }
    if (!entidad) {
      const hallazgo = buscarPorNombre(nombre, entidades, (e) => [e.nombre])
      if (!hallazgo.ok) {
        return NextResponse.json({
          ok: false,
          hay_que_elegir: true,
          campo: 'entidad',
          nombre,
          mensaje:
            nombre === ''
              ? 'Dime quien es: "este es Gilberto".'
              : `¿${nombre} es de cual? (La Matriz es para alguien como Kevin: propone y tu apruebas.)`,
          opciones: (hallazgo.motivo === 'ambiguo' ? hallazgo.candidatos : opciones)
            .slice(0, TOPE_OPCIONES)
            .map((e) => ({ id: e.id, nombre: e.nombre, rol: e.rol }))
        })
      }
      entidad = hallazgo.elegido
    }

    // ── La cuenta (NOT NULL en `bot_identidades`) ───────────────────────────
    let idCuenta: string | null = null
    if (entidad.rol === 'ADMIN') {
      idCuenta = (await cuentaDeLaMatrizParaAbono(supabase))?.id ?? null
    } else {
      const { data: cuentas } = await supabase
        .from('cuentas_financieras')
        .select('id, nombre, tipo_fiscalidad')
        .eq('id_entidad', entidad.id)
        .order('nombre')
      idCuenta = (cuentas ?? []).filter(cuentaUsableporElBot)[0]?.id ?? null
    }
    if (!idCuenta) {
      return NextResponse.json(
        { error: `${entidad.nombre} no tiene una cuenta que el bot pueda usar. Dale una en la app primero.` },
        { status: 422 }
      )
    }

    const { data: etiquetas } = await supabase.from('bot_identidades').select('etiqueta')
    const etiqueta = etiquetaDeNombre(nombre || entidad.nombre, new Set((etiquetas ?? []).map((e) => e.etiqueta)))
    if (!etiqueta) {
      return NextResponse.json({ error: 'No pude sacar un nombre corto para registrarlo.' }, { status: 422 })
    }

    const alta: PayloadAltaMiembro = {
      telegram_id: miembro,
      etiqueta,
      id_entidad: entidad.id,
      id_cuenta_destino: idCuenta,
      // A la Matriz, SIEMPRE con aprobacion: un segundo aprobador no se crea
      // desde un chat (lo mas cerrado; va como pregunta en el informe).
      requiere_aprobacion: entidad.rol === 'ADMIN',
      creado_por: `telegram:${identidad.etiqueta}`
    }

    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }
    const sello = sellarMiembro(alta)
    const meta = { nombre: nombre || entidad.nombre, entidad: entidad.nombre, rol: entidad.rol }
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: { tipo: 'alta_miembro', alta, meta } as unknown as Json
      })
      .select('id')
      .single()
    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de alta de miembro:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje: mensajeDeAltaMiembro({
        nombre: meta.nombre,
        entidad: entidad.nombre,
        rol: entidad.rol,
        requiereAprobacion: alta.requiere_aprobacion
      })
    })
  } catch (e) {
    console.error('[bot] proponer alta de miembro reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
