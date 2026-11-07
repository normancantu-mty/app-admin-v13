/**
 * AG-01 Fase 1 — PASO 2 y 3 de D-E30: se propone UNA fila y se sella.
 *
 * Entra lo que el LLM extrajo del lenguaje natural. Sale un borrador guardado
 * del lado del servidor, con su sello, y el texto que la persona va a leer.
 * **Aqui NO se escribe nada en `finanzas_ledger`.**
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { clienteDeServicio, conservaPendientes, leerCatalogo, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { contextoDelCuerpo } from '@/lib/bot-pendiente'
import { fetchTodasLasFilas, type ConsultaPaginable } from '@/lib/paginacion'
import {
  buscarDuplicado,
  mensajeDeConfirmacion,
  normalizarPropuesta,
  sellarPayload,
  VENTANA_DUPLICADO_HORAS,
  type MovimientoReciente
} from '@/lib/bot-gastos'
import {
  avisoDeDuplicado,
  conOjo,
  derivarCompra,
  diceCompra,
  esCategoriaDeInsumo,
  mensajeDeCompra,
  ojoDeGastoDeInsumo,
  payloadDeCompra,
  sellarCompra,
  type Derivacion
} from '@/lib/bot-compra'
import { leerInsumosDeCompra } from '@/lib/bot-compra-servidor'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      /** FASE 9 (D94): el chat donde se hablo; en privado es la persona. */
      chat_id?: unknown
      propuesta?: Record<string, unknown>
      id_cuenta?: unknown
      /** Con que se propuso, para que un reinicio del bot no lo pierda. No se sella. */
      contexto_bot?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)

    // Un telegram_id sin mapeo NO escribe nada y tampoco averigua si el bot
    // existe para otros. No hay auto-registro (Q-14).
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json(
        { error: 'No te tengo dado de alta. Pideselo a Norman.' },
        { status: 403 }
      )
    }
    // FASE 9 (D96): el gasto deja de ser de cualquiera dado de alta.
    if (permisoDeAccion(actorDe(identidad), 'gasto') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['gasto'] }, { status: 403 })
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

    const fila = normalizada.payload

    // ── 2026-11-07: ¿ES COMPRA DE INSUMO? ──────────────────────────────────
    // Un gasto de insumo con insumo y cantidad claros deja de ser gasto: se
    // escribe como la pantalla de compra (dinero + entrada al almacen). Si falta
    // uno de los dos, sigue siendo gasto y el mensaje dice la diferencia y pide
    // UNA cosa (`lib/bot-compra.ts`).
    const pedido = (cuerpo.propuesta ?? {}) as Record<string, unknown>
    const pideInsumo = typeof pedido.id_insumo === 'string' && pedido.id_insumo !== ''
    // Bug en vivo 2026-11-07: "compra/compre ..." tambien lee el catalogo, aunque
    // el modelo le haya puesto otra categoria (lo decide `derivarCompra`).
    const insumos =
      esCategoriaDeInsumo(fila.categoria) || pideInsumo || diceCompra(pedido.texto_dicho) ? await leerInsumosDeCompra(supabase) : []
    const derivacion: Derivacion =
      insumos.length > 0
        ? derivarCompra({
            categoria: fila.categoria,
            subcategoria: fila.subcategoria,
            descripcion: normalizada.descripcionOriginal,
            monto: fila.monto,
            idInsumoElegido: pedido.id_insumo,
            cantidadContestada: pedido.cantidad_insumo,
            textoDicho: pedido.texto_dicho,
            insumos
          })
        : { modo: 'gasto', falta: null }
    const compra = derivacion.modo === 'compra' ? payloadDeCompra(fila, derivacion, identidad.idEntidad) : null

    // ── Duplicados: avisa, no bloquea ───────────────────────────────────────
    const desde = new Date(Date.now() - VENTANA_DUPLICADO_HORAS * 60 * 60 * 1000).toISOString()
    const tipoQueSeEscribe = compra ? 'COMPRA_INSUMOS' : fila.tipo_movimiento
    const origenQueSeEscribe = compra ? compra.id_cuenta_origen : fila.id_cuenta_origen
    // Se busca en la MISMA columna que va a escribir. Buscar duplicados de una
    // compra de insumos entre los gastos con `id_cuenta_destino` no encontraria
    // nunca nada, y un detector que nunca encuentra nada es indistinguible de
    // uno apagado.
    // ERP-25: paginado. El detector de duplicados barre una ventana de horas;
    // truncada, deja de encontrar justo cuando hay muchos movimientos — que es
    // cuando mas falta hace. Un detector que no encuentra nada es
    // indistinguible de uno apagado, y esto lo apagaria sin avisar.
    const recientes = await fetchTodasLasFilas<MovimientoReciente>(() => {
      const consulta = supabase
        .from('finanzas_ledger')
        .select('id, monto, categoria, descripcion, fecha_movimiento, usuario_creador')
        .eq('tipo_movimiento', tipoQueSeEscribe)
        .eq('status', 'ACTIVO')
        .gte('fecha_movimiento', desde)

      return (
        origenQueSeEscribe !== null
          ? consulta.eq('id_cuenta_origen', origenQueSeEscribe)
          : consulta.eq('id_cuenta_destino', fila.id_cuenta_destino as string)
      ) as unknown as ConsultaPaginable<MovimientoReciente>
    }, 'bot/gasto/proponer: duplicados recientes')

    const duplicado = buscarDuplicado(
      { monto: normalizada.payload.monto, categoria: normalizada.payload.categoria },
      recientes,
      new Date()
    )

    // ── Un solo borrador PENDIENTE por persona ──────────────────────────────
    // Proponer algo nuevo cancela lo anterior. Con dos abiertos, un "va" es
    // ambiguo, y preguntarle a la persona cual de los dos convierte la interfaz
    // en justo lo que Q-14 prohibe: identificadores que recordar.    // Fase 8 (D79): con `conservar_pendientes` la propuesta se SUMA a las que
    // esperan su boton (varios hechos en un mensaje). Sin el, lo de siempre.
    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = compra ? sellarCompra(compra) : sellarPayload(normalizada.payload)
    const contextoBot = contextoDelCuerpo(cuerpo.contexto_bot, {
      cuentas: identidad.cuentas,
      id_cuenta: idCuenta
    })

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: (compra && derivacion.modo === 'compra'
          ? {
              tipo: 'compra_insumo',
              compra,
              meta: {
                id_entidad: identidad.idEntidad,
                id_cuenta: idCuenta,
                descripcion_original: normalizada.descripcionOriginal,
                insumo: derivacion.insumo.nombre,
                avisos: normalizada.avisos,
                duplicado_de: duplicado?.id ?? null,
                contexto_bot: contextoBot
              }
            }
          : {
              fila: normalizada.payload,
              meta: {
                id_entidad: identidad.idEntidad,
                id_cuenta: idCuenta,
                descripcion_original: normalizada.descripcionOriginal,
                categoria_nueva: normalizada.categoriaNueva,
                avisos: normalizada.avisos,
                duplicado_de: duplicado?.id ?? null,
                contexto_bot: contextoBot
              }
            }) as unknown as Json
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
      // 2026-11-07: `compra_insumo` cuando al VA se escribe dinero + almacen.
      tipo: compra ? 'compra_insumo' : 'gasto',
      // Lo que el bot pregunta UNA vez para volverlo compra (botones o numero).
      compra_falta: derivacion.modo === 'gasto' ? derivacion.falta : null,
      compra_opciones:
        derivacion.modo === 'gasto' && derivacion.falta === 'insumo'
          ? derivacion.opciones.map((i) => ({ id: i.id, nombre: i.nombre }))
          : [],
      mensaje:
        compra && derivacion.modo === 'compra'
          ? mensajeDeCompra(
              compra,
              derivacion.insumo,
              derivacion.dicho,
              { nombreCuenta, nombreEntidad: identidad.nombreEntidad },
              [...(duplicado ? [avisoDeDuplicado(duplicado)] : []), ...normalizada.avisos]
            )
          : conOjo(
              mensajeDeConfirmacion(
                normalizada.payload,
                { nombreCuenta, nombreEntidad: identidad.nombreEntidad },
                normalizada.avisos,
                duplicado
              ),
              ojoDeGastoDeInsumo(derivacion)
            )
    })
  } catch (e) {
    console.error('[bot] proponer reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
