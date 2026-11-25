/**
 * REGALO DESDE EL BOT — PROPONER. Escrito el 2026-11-20 por un ejecutor del Socio.
 *
 * Entra `{telegram_id, chat_id?, texto}`. No escribe inventario: lee catalogo y
 * existencia de la matriz y guarda un borrador sellado. La escritura es
 * `/api/bot/regalo/confirmar` con VA, y usa `registrarRegalo`, la misma que el
 * formulario de `/panel/regalos`.
 *
 * Contesta, sin escribir nada:
 *  - `no_es_regalo: true` si el texto no habla de regalar (o "regalo" es
 *    sustantivo: "iba de regalo") o no dice piezas: el
 *    bot sigue su camino normal con ese mensaje. Un numero sin tamano con alguien de la
 *    lista ("Norman regalo 3 a Casa Verde") SI es un regalo: se pregunta el tamano.
 *  - `pregunta` si falta UNA cosa (quien, motivo, una presentacion que no existe).
 *    Quien: solo el equipo, un distribuidor o un local. A otro nombre no se le guarda
 *    nada ni se le carga a quien dicta: se pregunta, con los parecidos.
 *  - `consulta: true` + `texto` si lo que pide es el contador ("regalos", "cuantos
 *    regalos lleva Kevin"): botellas y razones, nunca dinero.
 * Destino (2026-11-25): si se le dio a un distribuidor o local, va en el borrador y se suma a sus regalos.
 * `completa: {falta, dicho}` es la respuesta a esa pregunta: se junta con `texto`.
 * Nunca pide costo ni precio. Si no alcanza la existencia NO pregunta: la propuesta lo avisa y se guarda igual.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { clienteDeServicio, conservaPendientes, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { completarRegalo, contestarDuda, fechaMenosDias, hablaDeRegalo, horaCapturaMx, leerConsultaRegalos, leerRegalo, nombraBotella, numerosSueltos, regaloParecido, textoContador, textoRecibidos } from '@/lib/regalos'
import { entidadesDeConsulta } from '@/lib/regalos-quien'
import { hoyMx, idMatriz, leerCartera, leerProductosRegalo, leerQuienes, stocksDe } from '@/lib/regalos-servidor'
import {
  MENSAJE_REGALO_NO_PERMITIDO,
  PERMISO_REGALO,
  mensajeDeRegalo,
  preguntaDeRegalo,
  sellarRegalo,
  type PayloadRegalo
} from '@/lib/bot-regalo'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as { telegram_id?: unknown; chat_id?: unknown; texto?: unknown; completa?: { falta?: unknown; dicho?: unknown } }
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }
    let texto = String(cuerpo.texto ?? '').slice(0, 500)
    const completa = cuerpo.completa ? { falta: String(cuerpo.completa.falta ?? ''), dicho: String(cuerpo.completa.dicho ?? '').slice(0, 300) } : null
    const dictado = texto
    if (!hablaDeRegalo(texto)) return NextResponse.json({ ok: false, no_es_regalo: true })

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta. Pideselo a Norman.' }, { status: 403 })
    }

    if (!cuerpo.completa && leerConsultaRegalos(texto, identidad.etiqueta, []) !== null) {
      if (permisoDeAccion(actorDe(identidad), PERMISO_REGALO) === 'no') {
        return NextResponse.json({ error: MENSAJE_REGALO_NO_PERMITIDO }, { status: 403 })
      }
      const [cartera, lista] = await Promise.all([leerCartera(supabase), leerQuienes(supabase)])
      const pide = leerConsultaRegalos(texto, identidad.etiqueta, [...cartera.porPersona.map((g) => g.clave), ...lista.map((q) => q.nombre)])?.quien ?? ''
      // De un distribuidor o local se ensena lo que se le ha DADO y, si regalo algo, tambien eso.
      const { entidades, deNombre, ambiguas } = entidadesDeConsulta(texto, pide, lista)
      const partes = entidades.map((q) => textoRecibidos(cartera, { nombre: q.nombre, ids: q.ids ?? [] }))
      const regalo = pide !== '' && cartera.porPersona.some((g) => g.clave.toLowerCase() === pide.toLowerCase())
      if (entidades.length === 0 || (regalo && deNombre)) partes.push(textoContador(cartera, pide))
      if (ambiguas.length > 0) partes.push(`Tambien: ${ambiguas.map((q) => q.nombre).join(', ')}. Para ver lo que se le ha dado, pregunta con el nombre completo.`)
      return NextResponse.json({ ok: true, consulta: true, texto: partes.join('\n\n') })
    }

    const [productos, quienes] = await Promise.all([leerProductosRegalo(supabase), leerQuienes(supabase)])
    if (completa?.falta === 'quien') {
      // La pregunta pudo ser por quien lo dio o por a quien se le dio: se relee el dictado para saber cual era.
      const previa = leerRegalo(dictado, productos, identidad.etiqueta, quienes)
      texto = contestarDuda(dictado, !previa.ok && previa.falta === 'quien' ? previa.duda : undefined, completa.dicho, quienes)
    } else if (completa) {
      texto = completarRegalo(dictado, completa.falta, completa.dicho, quienes)
    }
    const lectura = leerRegalo(texto, productos, identidad.etiqueta, quienes)
    // "me regalaron un dia libre": habla de regalar, pero no de piezas. No es un regalo de botellas.
    // "regale una botella en la expo" SI es de botellas: se pregunta cual (antes caia a gasto y pedia el costo).
    if (!lectura.ok && (lectura.falta === 'no_es_regalo' || (lectura.falta === 'piezas' && lectura.cuantas === undefined && !completa && !nombraBotella(texto)))) return NextResponse.json({ ok: false, no_es_regalo: true })

    // El permiso, despues de saber que SI es un regalo: a quien no le toca se le dice.
    if (permisoDeAccion(actorDe(identidad), PERMISO_REGALO) === 'no') {
      return NextResponse.json({ error: MENSAJE_REGALO_NO_PERMITIDO }, { status: 403 })
    }
    // Se pregunta UNA vez: si la respuesta no dice el tamano, se dice que no se registro y no queda nada en el aire.
    if (!lectura.ok && completa?.falta === 'piezas' && lectura.falta === 'piezas' && lectura.cuantas !== undefined) {
      return NextResponse.json({ ok: false, falta: 'tamano', texto, pregunta: 'No entendí el tamaño y no registré nada. Mándalo completo: "Norman regaló 3 grandes a Casa Verde".' })
    }
    if (!lectura.ok) {
      return NextResponse.json({ ok: false, falta: lectura.falta, texto, pregunta: preguntaDeRegalo(lectura, productos) })
    }

    const matriz = await idMatriz(supabase)
    const lineas = lectura.piezas.map((x) => ({ id_producto: x.producto.id, cantidad: x.cantidad }))
    const stocks = await stocksDe(supabase, matriz.id, lineas.map((l) => l.id_producto))
    // Dos entidades con el mismo nombre y tipo: no se adivina a cual. Se guarda sin destino y se avisa.
    const ids = lectura.destino?.ids ?? []
    const avisos: string[] = []
    // "Norman regalo 3…" y contestan "1 grande": manda la respuesta, y se dice.
    const dichas = completa?.falta === 'piezas' ? numerosSueltos(dictado, quienes)[0]?.cuantas : undefined
    const total = lineas.reduce((a, l) => a + l.cantidad, 0)
    if (dichas !== undefined && dichas !== total) avisos.push(`Dictaste ${dichas} y la respuesta suma ${total}: queda en ${total}.`)
    if (lectura.destino && ids.length !== 1) {
      avisos.push(`Hay ${ids.length} con el nombre ${lectura.destino.nombre}: no lo sumo a ninguno. Para que cuente, registralo en la web (Regalos) y escoge cual.`)
    }
    const payload: PayloadRegalo = {
      id_entidad: matriz.id,
      // "ayer Kevin regalo..." -> ayer. Otra fecha: el formulario web.
      fecha: fechaMenosDias(hoyMx(), lectura.diasAtras),
      quien_regalo: lectura.quien,
      motivo: lectura.motivo,
      usuario_creador: `telegram:${identidad.etiqueta}`,
      lineas,
      ...(lectura.destino && ids.length === 1 ? { id_entidad_destino: ids[0] } : {})
    }
    if (payload.id_entidad_destino) {
      // El mismo regalo dictado de las dos formas contaria doble: se avisa, no se bloquea. Si la lectura falla, se propone igual.
      try {
        const cartera = await leerCartera(supabase)
        if (!cartera.hayDestinos) avisos.push(`Falta correr el SQL del destino: se guarda, pero todavia no cuenta en la ficha de ${lectura.destino?.nombre}.`)
        const ya = regaloParecido(cartera, payload)
        if (ya) avisos.push(`Ya hay un regalo igual para ${lectura.destino?.nombre} ese dia (de ${ya.quien_regalo}${horaCapturaMx(ya.creado_en) ? `, capturado ${horaCapturaMx(ya.creado_en)}` : ''}). Si es el mismo, no contestes VA.`)
      } catch (e) {
        console.error('[bot] regalo: no pude revisar si ya estaba:', e)
      }
    }

    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = sellarRegalo(payload)
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: { tipo: 'regalo', regalo: payload, meta: { entidad: matriz.nombre } } as unknown as Json
      })
      .select('id')
      .single()
    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de regalo:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje: mensajeDeRegalo(payload, productos, matriz.nombre, stocks, quienes, avisos)
    })
  } catch (e) {
    console.error('[bot] proponer regalo reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
