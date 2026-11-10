/**
 * AG-01 Fase 1 — PASO 5 de D-E30: se escribe el objeto EXACTO que se enseno.
 *
 * ─── LA PROPIEDAD DE SEGURIDAD DE ESTE ARCHIVO ──────────────────────────────
 *
 * Entra `{telegram_id, borrador_id, sello}`. **No entra ninguna fila.** El
 * objeto que se va a escribir lo busca este endpoint en `bot_borradores`, y
 * antes de escribirlo vuelve a calcularle el hash y lo compara contra dos
 * cosas: el sello guardado con el borrador y el sello que trae quien confirma.
 * Si cualquiera de los dos no empata, **no se escribe nada.**
 *
 * De esta manera "el LLM ya no lo vuelve a tocar" deja de ser intencion de
 * diseno y pasa a ser algo que el codigo no puede violar aunque quiera: entre
 * el "va" y el `INSERT` no hay por donde meter una llamada al modelo, porque no
 * hay ningun campo que el modelo pudiera mandar.
 *
 * El modo de fallo que esto ataca esta documentado con ticket en otro proyecto:
 * `langchain-ai/langchain` #33787 — su middleware de human-in-the-loop
 * reintentaba la tool call ORIGINAL en vez de la editada. No es teorico.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, leerCatalogo, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { abrirPuerta, pasarAEspera, reclamarAprobacion, liberarReclamo, marcarConfirmado, actorDe } from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import {
  CATEGORIA_SIN_CATEGORIZAR_BOT,
  esCatalogoDeParejas,
  filaEnCatalogo,
  selloCoincide,
  validarCategoriaNueva,
  type PayloadGasto
} from '@/lib/bot-gastos'
import { registrarAviso } from '@/lib/avisos-server'
import { confirmarCompraDeBorrador, type BorradorCompra } from '@/lib/bot-compra-servidor'

export const dynamic = 'force-dynamic'

interface BorradorGuardado {
  /**
   * El discriminador. Los borradores de la Fase 1 se guardaron SIN el, asi que
   * `undefined` cuenta como gasto: una guarda que invalidara lo ya escrito
   * rompeira las capturas a medias en vez de protegerlas.
   */
  tipo?: string
  fila: PayloadGasto
  meta: {
    id_entidad: string
    id_cuenta?: string
    descripcion_original: string
    avisos: string[]
    duplicado_de: string | null
  }
}

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      borrador_id?: unknown
      sello?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    const borradorId = String(cuerpo.borrador_id ?? '')
    const selloRecibido = String(cuerpo.sello ?? '')

    if (!Number.isSafeInteger(telegramId) || borradorId === '') {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)

    const quien = await resolverIdentidad(supabase, telegramId)
    if (!quien) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }
    if (permisoDeAccion(actorDe(quien), 'gasto') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['gasto'] }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()

    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    // El borrador es de quien lo creo. Sin esto, cualquiera dado de alta podria
    // confirmar la captura de otro con solo tener el id.
    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    // De aqui en adelante, la identidad es la del AUTOR del borrador (D98): con
    // el Aprobar de Norman se escribe la captura de Kevin, con su etiqueta.
    const identidad = puerta.autor

    const guardado = borrador.payload as unknown as BorradorGuardado
    // 2026-11-07: la compra de insumo dictada como gasto se confirma por aqui
    // (el bot no sabe de antemano cual de las dos le salio), pero se escribe con
    // la MISMA funcion que la pantalla de compra: dinero + entrada al almacen.
    if (guardado?.tipo === 'compra_insumo') {
      return confirmarCompraDeBorrador(supabase, {
        borradorId,
        selloGuardado: String(borrador.sello ?? ''),
        selloRecibido,
        guardado: borrador.payload as unknown as BorradorCompra,
        identidad,
        modo: puerta.modo
      })
    }
    // AG-02: un borrador de ABONO que llegue aqui se rechaza diciendo la verdad.
    // Sin esta linea caeria por sello roto —el hash de un abono nunca empata con
    // el de un gasto— y de paso lo CANCELARIA, que es un dano real por un
    // enrutamiento equivocado.
    if (guardado?.tipo && guardado.tipo !== 'gasto') {
      return NextResponse.json({ error: 'Ese borrador no es un gasto.' }, { status: 409 })
    }
    const fila = guardado?.fila

    // ── LOS DOS SELLOS ──────────────────────────────────────────────────────
    // 1. Contra el guardado: detecta que alguien haya tocado la fila en la base
    //    entre la propuesta y el "va".
    // 2. Contra el que manda quien confirma: detecta que el proceso del bot
    //    este confirmando algo distinto de lo que enseno.
    if (!fila || !selloCoincide(fila, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para el borrador', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloCoincide(fila, selloRecibido)) {
      return NextResponse.json(
        { error: 'El sello no empata con lo que te ensene. No escribo nada.' },
        { status: 409 }
      )
    }

    // La identidad se vuelve a comprobar contra la fila sellada: si a alguien le
    // cambiaron la cuenta o la etiqueta despues de proponer, la fila vieja ya no
    // se escribe.
    // Exactamente UNA columna lleva cuenta. La otra en null, o la fila es
    // ambigua y no se escribe: un ledger con las dos puestas no dice de donde
    // salio el dinero.
    const cuentaDeLaFila = fila.id_cuenta_origen ?? fila.id_cuenta_destino
    const columnasLlenas = [fila.id_cuenta_origen, fila.id_cuenta_destino].filter(
      (v) => v !== null && v !== undefined
    ).length
    if (
      columnasLlenas !== 1 ||
      !cuentaDeLaFila ||
      !identidad.cuentas.some((c) => c.id === cuentaDeLaFila) ||
      fila.usuario_creador !== `telegram:${identidad.etiqueta}`
    ) {
      return NextResponse.json(
        { error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' },
        { status: 409 }
      )
    }

    // ── D98: el VA de quien requiere aprobacion NO escribe ──────────────────
    if (puerta.modo === 'esperar') {
      return pasarAEspera(supabase, borradorId, identidad, 'un gasto')
    }
    // D106: con dos aprobadores, el primero que aprieta gana; el otro no escribe.
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

    // ── LA CATEGORIA NUEVA, SI LA HAY ───────────────────────────────────────
    // No se le cree a la bandera que dejo el proponer: se mira el catalogo AQUI.
    // Si la categoria sellada no esta en el catalogo, es nueva, y **se vuelve a
    // validar antes de crearla**. Esa segunda pasada no es paranoia: el nombre
    // entra a la columna `categoria`, que `v_pasivo_fiscal` concatena para
    // decidir si hubo un pago de impuesto. Una defensa que solo corre en el
    // camino feliz no es una defensa.
    const catalogo = await leerCatalogo(supabase)
    const enCatalogo = filaEnCatalogo(fila, catalogo)

    // 2026-11-03 - UNA SOLA LISTA. Con `categorias_movimiento` el gasto NO crea
    // categorias: se agregan desde el ERP o con su propia puerta en el bot. Si
    // la pareja sellada ya no esta activa (alguien la desactivo entre el VA y
    // este clic), no se escribe: se dice y se vuelve a dictar.
    if (
      esCatalogoDeParejas(catalogo) &&
      fila.categoria !== CATEGORIA_SIN_CATEGORIZAR_BOT &&
      !enCatalogo
    ) {
      await liberarReclamo(supabase, borradorId, puerta.modo)
      return NextResponse.json(
        {
          error:
            `La categoria "${fila.categoria}${fila.subcategoria ? ' / ' + fila.subcategoria : ''}" ` +
            'ya no esta activa en la lista. No escribi nada: vuelve a dictar el gasto.'
        },
        { status: 409 }
      )
    }

    // Solo con el catalogo de RESPALDO (la lista no contesto) sigue vivo el
    // camino viejo de la categoria nueva en `bot_categorias`.
    const esNueva =
      !esCatalogoDeParejas(catalogo) &&
      fila.categoria !== CATEGORIA_SIN_CATEGORIZAR_BOT &&
      !enCatalogo

    if (esNueva) {
      const juicio = validarCategoriaNueva(fila.categoria, catalogo)
      if (!juicio.ok) {
        await liberarReclamo(supabase, borradorId, puerta.modo)
        return NextResponse.json(
          { error: `No puedo crear la categoria "${fila.categoria}": ${juicio.motivo}.` },
          { status: 422 }
        )
      }
      // La forma de fila de una categoria nueva es SIEMPRE la de gasto. Comprar
      // insumos mueve otra columna y eso no se infiere de un nombre (E-237):
      // si algun dia hace falta otra `COMPRA_INSUMOS`, se declara a mano.
      const { error: errorCat } = await supabase.from('bot_categorias').insert({
        nombre: juicio.nombre,
        ayuda: '',
        tipo_movimiento: 'GASTO_OPERATIVO',
        columna: 'destino',
        creada_por: fila.usuario_creador
      })
      if (errorCat) {
        console.error('[bot] no pude crear la categoria', juicio.nombre, errorCat)
        await liberarReclamo(supabase, borradorId, puerta.modo)
        return NextResponse.json(
          { error: 'No pude crear esa categoria. No escribi nada.' },
          { status: 500 }
        )
      }
    }

    // ── EL INSERT. Nada entre el sello y esta linea toca el payload. ─────────
    const { data: creada, error } = await supabase
      .from('finanzas_ledger')
      .insert(fila)
      .select('id')
      .single()

    if (error || !creada) {
      console.error('[bot] no se pudo escribir el gasto:', error)
      await liberarReclamo(supabase, borradorId, puerta.modo)
      return NextResponse.json({ error: 'No pude escribirlo. No quedo nada a medias.' }, { status: 500 })
    }

    // D107: la marca se revisa; si falla, el reclamo se queda (no se repite).
    const avisoMarca = await marcarConfirmado(supabase, borradorId, creada.id)

    // ── Los avisos van DESPUES de que la fila existe, para poder apuntarle ───
    // (mismo orden que `app/api/finanzas/nuevo/route.ts`). Si el aviso fallara,
    // la fila ya entro: es el orden correcto.
    if (fila.categoria === CATEGORIA_SIN_CATEGORIZAR_BOT) {
      await registrarAviso(supabase, {
        tipo: 'W14',
        idEntidad: guardado.meta.id_entidad,
        mensaje:
          `Gasto de $${fila.monto.toFixed(2)} capturado por Telegram sin categoria mapeable. ` +
          `Entro como ${CATEGORIA_SIN_CATEGORIZAR_BOT}: hay que clasificarlo.`,
        tabla: 'finanzas_ledger',
        idRegistro: creada.id,
        datosCapturados: {
          origen: fila.usuario_creador,
          monto: fila.monto,
          descripcion_original: guardado.meta.descripcion_original
        }
      })
    }

    // El texto original, completo, cuando hubo que desactivarlo fiscalmente.
    // Sin este aviso, lo que la persona dijo se perderia y solo quedaria la
    // version raspada.
    if (guardado.meta.descripcion_original !== fila.descripcion) {
      await registrarAviso(supabase, {
        tipo: 'W14',
        idEntidad: guardado.meta.id_entidad,
        mensaje:
          'El concepto traia una frase que el ERP lee como pago de impuesto. Se guardo ' +
          'desactivada para no mover el pasivo fiscal; el texto original esta aqui.',
        tabla: 'finanzas_ledger',
        idRegistro: creada.id,
        datosCapturados: {
          origen: fila.usuario_creador,
          descripcion_original: guardado.meta.descripcion_original,
          descripcion_escrita: fila.descripcion
        }
      })
    }

    return NextResponse.json({
      ok: true,
      id: creada.id,
      categoria_creada: esNueva ? fila.categoria : null,
      ...(avisoMarca ? { aviso_marca: avisoMarca } : {})
    })
  } catch (e) {
    console.error('[bot] confirmar reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
