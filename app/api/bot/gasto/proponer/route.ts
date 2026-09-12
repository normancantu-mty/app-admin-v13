/**
 * AG-01 Fase 1 — PASO 2 y 3 de D-E30: se propone UNA fila y se sella.
 *
 * Entra lo que el LLM extrajo del lenguaje natural. Sale un borrador guardado
 * del lado del servidor, con su sello, y el texto que la persona va a leer.
 * **Aqui NO se escribe nada en `finanzas_ledger`.**
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { clienteDeServicio, leerCatalogo, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import {
  buscarDuplicado,
  mensajeDeConfirmacion,
  normalizarPropuesta,
  sellarPayload,
  VENTANA_DUPLICADO_HORAS,
  type MovimientoReciente
} from '@/lib/bot-gastos'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      propuesta?: Record<string, unknown>
      id_cuenta?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }

    const supabase = clienteDeServicio()

    // Un telegram_id sin mapeo NO escribe nada y tampoco averigua si el bot
    // existe para otros. No hay auto-registro (Q-14).
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json(
        { error: 'No te tengo dado de alta. Pideselo a Norman.' },
        { status: 403 }
      )
    }

    // La cuenta, si viene, se valida contra la LISTA CERRADA de la identidad y
    // no contra la base: un id que no este en `identidad.cuentas` no existe
    // para este endpoint, venga de donde venga. Sin esto, el boton "cambiar
    // cuenta" seria un campo de texto libre apuntando a `cuentas_financieras`.
    const pedida = String(cuerpo.id_cuenta ?? '')
    const idCuenta =
      pedida !== '' && identidad.cuentas.some((c) => c.id === pedida) ? pedida : identidad.idCuenta
    if (pedida !== '' && idCuenta !== pedida) {
      return NextResponse.json({ error: 'Esa cuenta no es tuya o esta vetada.' }, { status: 422 })
    }
    const nombreCuenta =
      identidad.cuentas.find((c) => c.id === idCuenta)?.nombre ?? identidad.nombreCuenta

    // El catalogo se lee en CADA propuesta, no se cachea: crece con el uso y una
    // copia en memoria haria que el bot no viera la categoria que el mismo acaba
    // de crear hace un minuto.
    const catalogo = await leerCatalogo(supabase)

    const normalizada = normalizarPropuesta(
      cuerpo.propuesta ?? {},
      { idCuenta, etiqueta: identidad.etiqueta },
      new Date(),
      catalogo
    )
    if (!normalizada.ok) {
      return NextResponse.json({ error: normalizada.error }, { status: 422 })
    }

    // ── Duplicados: avisa, no bloquea ───────────────────────────────────────
    const desde = new Date(Date.now() - VENTANA_DUPLICADO_HORAS * 60 * 60 * 1000).toISOString()
    const fila = normalizada.payload
    // Se busca en la MISMA columna que va a escribir. Buscar duplicados de una
    // compra de insumos entre los gastos con `id_cuenta_destino` no encontraria
    // nunca nada, y un detector que nunca encuentra nada es indistinguible de
    // uno apagado.
    let consulta = supabase
      .from('finanzas_ledger')
      .select('id, monto, categoria, descripcion, fecha_movimiento, usuario_creador')
      .eq('tipo_movimiento', fila.tipo_movimiento)
      .eq('status', 'ACTIVO')
      .gte('fecha_movimiento', desde)
    consulta =
      fila.id_cuenta_origen !== null
        ? consulta.eq('id_cuenta_origen', fila.id_cuenta_origen)
        : consulta.eq('id_cuenta_destino', fila.id_cuenta_destino as string)
    const { data: recientes } = await consulta

    const duplicado = buscarDuplicado(
      { monto: normalizada.payload.monto, categoria: normalizada.payload.categoria },
      (recientes ?? []) as MovimientoReciente[],
      new Date()
    )

    // ── Un solo borrador PENDIENTE por persona ──────────────────────────────
    // Proponer algo nuevo cancela lo anterior. Con dos abiertos, un "va" es
    // ambiguo, y preguntarle a la persona cual de los dos convierte la interfaz
    // en justo lo que Q-14 prohibe: identificadores que recordar.
    await supabase
      .from('bot_borradores')
      .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
      .eq('telegram_id', telegramId)
      .eq('estado', 'PENDIENTE')

    const sello = sellarPayload(normalizada.payload)

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        sello,
        payload: {
          fila: normalizada.payload,
          meta: {
            id_entidad: identidad.idEntidad,
            id_cuenta: idCuenta,
            descripcion_original: normalizada.descripcionOriginal,
            categoria_nueva: normalizada.categoriaNueva,
            avisos: normalizada.avisos,
            duplicado_de: duplicado?.id ?? null
          }
        } as unknown as Json
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      id_cuenta: idCuenta,
      cuentas: identidad.cuentas,
      categorias: catalogo.map((c) => c.nombre),
      categoria_nueva: normalizada.categoriaNueva,
      mensaje: mensajeDeConfirmacion(
        normalizada.payload,
        { nombreCuenta, nombreEntidad: identidad.nombreEntidad },
        normalizada.avisos,
        duplicado
      )
    })
  } catch (e) {
    console.error('[bot] proponer reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
