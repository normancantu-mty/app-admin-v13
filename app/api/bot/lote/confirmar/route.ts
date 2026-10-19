/**
 * AG-05 Fase 3 — Se escribe el LOTE exacto que se enseno, en cuatro tablas.
 *
 * ─── LA PROPIEDAD DE SEGURIDAD DE ESTE ARCHIVO ──────────────────────────────
 *
 * Entra `{telegram_id, borrador_id, sello}`. **No entra ninguna fila, ni un
 * litro, ni un grado.** El lote se relee de `bot_borradores`, se le recalcula el
 * hash y se compara contra el sello guardado y contra el que manda quien
 * confirma. Si cualquiera de los dos no empata, no se escribe nada.
 *
 * ─── LA ATOMICIDAD, QUE AQUI SI SE PUEDE ────────────────────────────────────
 *
 * Son cuatro tablas y **no hay transaccion**: este repositorio no tiene ninguna
 * (ver CLAUDE.md). Pero los tres hijos cuelgan de `lotes` con
 * `on delete cascade`, y cada uno se escribe con UN solo `INSERT` multi-fila,
 * que Postgres si ejecuta atomicamente. Entonces el unico estado a medias
 * posible es "el lote existe y le faltan hijos", y **eso se deshace con un solo
 * `DELETE` sobre `lotes`**, que arrastra lo que hubiera quedado.
 *
 * Fase 8 (D82): los hijos ya no son tres INSERT sueltos sino UNA llamada a
 * `registrar_en_lote`, que en la misma transaccion escribe las entradas, las
 * tandas, el envasado **y su inventario** (+ terminado, - empaque). Si falla, no
 * queda nada de ella; el `DELETE` de la cabecera sigue siendo la compensacion,
 * y sigue siendo segura: la funcion no dejo ni una fila de `inventario_ledger`.
 *
 * Fase 8 (D81): un borrador `lote_agregar` es envasar (o sumar tandas o
 * insumos) a un lote que YA existe. No crea cabecera, asi que no hay nada que
 * deshacer: la funcion escribe todo o nada.
 *
 * Es una compensacion de un paso, no la cascada de `DELETE`s que ERP-11 quito
 * de la venta. Y es segura de una forma que aquella no era: un lote a medias no
 * movio dinero ni inventario, asi que borrarlo no deja un hueco en ningun
 * ledger. Nada apunta todavia a `lotes`.
 *
 * ─── D-198: EL NUMERO QUE SE DEVUELVE NO LO CALCULO ESTE ARCHIVO ────────────
 *
 * Despues de escribir se RELEE `v_lote_rendimiento` para este lote y se manda
 * lo que la vista diga. Alcohol absoluto, litros al grado objetivo, si alcanza
 * diluyendo y el costo por mililitro son de la vista, en SQL, sobre las filas
 * que acaban de quedar. El bot no reimplementa esa aritmetica ni una vez: el
 * numero que Norman lee en Telegram es el mismo que va a ver en la pantalla
 * porque es, literalmente, la misma fila.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { clienteDeServicio, resolverIdentidad, tokenValido, type IdentidadBot } from '@/lib/bot-servidor'
import {
  abrirPuerta,
  pasarAEspera,
  reclamarAprobacion,
  liberarReclamo,
  marcarConfirmado,
  actorDe,
  type ModoPuerta
} from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO, ROL_TRABAJADOR } from '@/lib/bot-permisos'
import {
  mensajeDeRendimiento,
  selloLoteCoincide,
  type DesgloseLote,
  type PayloadLote,
  type RendimientoDelLote
} from '@/lib/bot-lotes'
import { selloAgregarCoincide, type PayloadAgregar } from '@/lib/bot-envasado'

export const dynamic = 'force-dynamic'

/**
 * La unica escritura de hijos de un lote. Ver la migracion
 * `20260923053510_fase8_d82_envasar_mueve_inventario.sql`.
 */
async function registrarEnLote(
  supabase: ReturnType<typeof clienteDeServicio>,
  idLote: string,
  hijos: Pick<PayloadLote, 'entradas' | 'tandas' | 'envasado' | 'usuario_creador'>
) {
  return supabase.rpc('registrar_en_lote', {
    p_id_lote: idLote,
    p_entradas: hijos.entradas as unknown as Json,
    p_tandas: hijos.tandas as unknown as Json,
    p_envasado: hijos.envasado as unknown as Json,
    p_usuario: hijos.usuario_creador
  })
}

async function leerRendimiento(
  supabase: ReturnType<typeof clienteDeServicio>,
  idLote: string
): Promise<RendimientoDelLote | null> {
  const { data: rendimiento } = await supabase
    .from('v_lote_rendimiento')
    .select(
      'alcohol_absoluto_l, litros_al_grado_objetivo, botellas_750_teoricas, grado_ponderado, alcanza_el_grado_diluyendo, costo_por_ml, tandas_sin_grado, insumos_sin_costo, faltan_costo'
    )
    .eq('id', idLote)
    .maybeSingle()

  const comoNumero = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v)

  return rendimiento
    ? {
        alcohol_absoluto_l: comoNumero(rendimiento.alcohol_absoluto_l),
        litros_al_grado_objetivo: comoNumero(rendimiento.litros_al_grado_objetivo),
        botellas_750_teoricas: comoNumero(rendimiento.botellas_750_teoricas),
        grado_ponderado: comoNumero(rendimiento.grado_ponderado),
        alcanza_el_grado_diluyendo: rendimiento.alcanza_el_grado_diluyendo,
        costo_por_ml: comoNumero(rendimiento.costo_por_ml),
        tandas_sin_grado: comoNumero(rendimiento.tandas_sin_grado),
        insumos_sin_costo: comoNumero(rendimiento.insumos_sin_costo),
        faltan_costo: rendimiento.faltan_costo ?? null
      }
    : null
}

interface BorradorAgregar {
  tipo: 'lote_agregar'
  agregar: PayloadAgregar
}

interface BorradorLote {
  tipo?: string
  lote: PayloadLote
  meta: {
    desglose: DesgloseLote
    avisos: string[]
    codigo_sugerido: boolean
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
    if (permisoDeAccion(actorDe(quien), 'lote') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['lote'] }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()

    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    // De aqui en adelante, la identidad es la del AUTOR del borrador (D98): con
    // el Aprobar de Norman se escribe la captura de Kevin, con su etiqueta.
    const identidad = puerta.autor

    const guardado = borrador.payload as unknown as BorradorLote
    // El discriminador, ANTES del sello y por la misma razon que en la venta:
    // sin el, un borrador de otro tipo caeria en la rama del sello roto, que
    // CANCELA, y una ruta equivocada del bot borraria una captura buena.
    if (guardado?.tipo === 'lote_agregar') {
      return confirmarAgregar(
        supabase,
        borradorId,
        borrador.sello,
        selloRecibido,
        (borrador.payload as unknown as BorradorAgregar).agregar,
        identidad,
        puerta.modo
      )
    }
    if (guardado?.tipo !== 'lote') {
      return NextResponse.json({ error: 'Ese borrador no es un lote.' }, { status: 409 })
    }

    const lote = guardado.lote

    // ── LOS DOS SELLOS ──────────────────────────────────────────────────────
    if (!lote || !selloLoteCoincide(lote, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para el lote', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloLoteCoincide(lote, selloRecibido)) {
      return NextResponse.json(
        { error: 'El sello no empata con lo que te ensene. No escribo nada.' },
        { status: 409 }
      )
    }

    if (lote.usuario_creador !== `telegram:${identidad.etiqueta}`) {
      return NextResponse.json(
        { error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' },
        { status: 409 }
      )
    }

    // ── D98: el VA de quien requiere aprobacion NO escribe ──────────────────
    if (puerta.modo === 'esperar') {
      return pasarAEspera(supabase, borradorId, identidad, 'un lote')
    }
    // D106: con dos aprobadores, el primero que aprieta gana; el otro no escribe.
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

    // El codigo, RELEIDO: entre la propuesta y el "va" pudo entrar otro lote con
    // el mismo codigo desde la pantalla. `codigo_lote` es `unique`, asi que sin
    // esto el choque llegaria como un error de Postgres.
    const { data: yaExiste } = await supabase
      .from('lotes')
      .select('id')
      .eq('codigo_lote', lote.codigo_lote)
      .maybeSingle()
    if (yaExiste) {
      await liberarReclamo(supabase, borradorId, puerta.modo)
      return NextResponse.json(
        { error: `El lote ${lote.codigo_lote} ya existe. Dame otro codigo.` },
        { status: 409 }
      )
    }

    // ── 1. LA CABECERA ──────────────────────────────────────────────────────
    const { data: creado, error: errorLote } = await supabase
      .from('lotes')
      .insert({
        codigo_lote: lote.codigo_lote,
        fecha_inicio: lote.fecha_inicio,
        fecha_fin_fermentacion: lote.fecha_fin_fermentacion,
        horas_fermentacion: lote.horas_fermentacion,
        notas: lote.notas || null,
        usuario_creador: lote.usuario_creador
      })
      .select('id')
      .single()

    if (errorLote || !creado) {
      console.error('[bot] no se pudo crear el lote:', errorLote)
      await liberarReclamo(supabase, borradorId, puerta.modo)
      return NextResponse.json(
        { error: 'No pude escribir el lote. No quedo nada a medias.' },
        { status: 500 }
      )
    }

    const idLote = creado.id

    /** Deshace el lote entero. Un solo DELETE; el `on delete cascade` hace el resto. */
    const deshacer = async (paso: string, detalle: unknown) => {
      console.error(`[bot] fallo ${paso} del lote ${idLote}:`, detalle)
      await supabase.from('lotes').delete().eq('id', idLote)
    }

    // ── 2. LOS HIJOS Y SU INVENTARIO: una funcion, una transaccion (D82) ────
    let filasInventario = 0
    if (lote.entradas.length + lote.tandas.length + lote.envasado.length > 0) {
      const { data: hechos, error } = await registrarEnLote(supabase, idLote, lote)
      if (error) {
        await deshacer('los hijos', error)
        // Si el DELETE fallara, el codigo del lote ya existe y el siguiente
        // Aprobar choca con "ya existe": soltar el reclamo no duplica nada.
        await liberarReclamo(supabase, borradorId, puerta.modo)
        return NextResponse.json(
          { error: 'No pude escribir el lote. Deshice el lote entero; el inventario no se movio.' },
          { status: 500 }
        )
      }
      filasInventario = Number((hechos as { filas_inventario?: unknown } | null)?.filas_inventario ?? 0)
    }

    // D107: la marca se revisa; si falla, el reclamo se queda (no se repite).
    const avisoMarca = await marcarConfirmado(supabase, borradorId, idLote)

    // ── EL RENDIMIENTO, LEIDO DE LA VISTA (D-198) ───────────────────────────
    // Si la lectura falla no se deshace nada: el lote quedo bien escrito y lo
    // unico que se pierde es el resumen. Un rollback aqui destruiria una
    // captura buena por no poder ensenar un numero.
    // WP-6: lo que capturo un TRABAJADOR no regresa con rendimiento (es cifra
    // agregada), aunque lo apruebe Norman: la respuesta puede caer en el grupo.
    const resumen = identidad.rolEntidad === ROL_TRABAJADOR ? null : await leerRendimiento(supabase, idLote)

    return NextResponse.json({
      ...(avisoMarca ? { aviso_marca: avisoMarca } : {}),
      ok: true,
      id_lote: idLote,
      codigo_lote: lote.codigo_lote,
      filas_escritas:
        1 + lote.entradas.length + lote.tandas.length + lote.envasado.length,
      filas_inventario: filasInventario,
      rendimiento: resumen,
      mensaje:
        identidad.rolEntidad === ROL_TRABAJADOR
          ? 'Quedo escrito el lote ' + lote.codigo_lote + '.'
          : mensajeDeRendimiento(resumen)
    })
  } catch (e) {
    console.error('[bot] confirmar lote reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}

/**
 * D81: agregar a un lote que YA existe. Mismos dos sellos que el lote nuevo;
 * la escritura entera es `registrar_en_lote` (todo o nada), sin cabecera que
 * crear ni que deshacer.
 */
async function confirmarAgregar(
  supabase: ReturnType<typeof clienteDeServicio>,
  borradorId: string,
  selloGuardado: string,
  selloRecibido: string,
  agregar: PayloadAgregar | undefined,
  identidad: IdentidadBot,
  modo: ModoPuerta
) {
  const etiqueta = identidad.etiqueta
  if (!agregar || !selloAgregarCoincide(agregar, selloGuardado)) {
    await supabase
      .from('bot_borradores')
      .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
      .eq('id', borradorId)
    console.error('[bot] SELLO ROTO en la base para agregar a lote', borradorId)
    return NextResponse.json(
      { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
      { status: 409 }
    )
  }
  if (!selloAgregarCoincide(agregar, selloRecibido)) {
    return NextResponse.json(
      { error: 'El sello no empata con lo que te ensene. No escribo nada.' },
      { status: 409 }
    )
  }
  if (agregar.usuario_creador !== `telegram:${etiqueta}`) {
    return NextResponse.json(
      { error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' },
      { status: 409 }
    )
  }

  // ── FASE 10 (D101): el VA de quien requiere aprobacion NO escribe ────────
  // Hasta la Fase 9 esta rama salia del handler ANTES de la espera, y el VA de
  // Kevin escribia el envasado sin el Aprobar de Norman. Mismo orden que el lote
  // nuevo: sellos -> espera -> escritura.
  if (modo === 'esperar') {
    return pasarAEspera(supabase, borradorId, identidad, `envasar o agregar al lote ${agregar.codigo_lote}`)
  }
  // D106: con dos aprobadores, el primero que aprieta gana; el otro no escribe.
  const reclamo = await reclamarAprobacion(supabase, borradorId, modo)
  if (reclamo) return reclamo

  const { data: hechos, error } = await registrarEnLote(supabase, agregar.id_lote, agregar)
  if (error) {
    console.error('[bot] no se pudo agregar al lote', agregar.codigo_lote, error)
    await liberarReclamo(supabase, borradorId, modo)
    return NextResponse.json(
      { error: 'No pude escribirlo. No quedo nada a medias: ni envasado ni inventario.' },
      { status: 500 }
    )
  }

  // D107: la marca se revisa; si falla, el reclamo se queda (no se repite).
  const avisoMarca = await marcarConfirmado(supabase, borradorId, agregar.id_lote)

  // WP-6: igual que arriba, sin rendimiento para lo que capturo un trabajador.
  const resumen = identidad.rolEntidad === ROL_TRABAJADOR ? null : await leerRendimiento(supabase, agregar.id_lote)
  const filasInventario = Number((hechos as { filas_inventario?: unknown } | null)?.filas_inventario ?? 0)
  const botellas = agregar.envasado.reduce((a, e) => a + e.botellas, 0)
  const lineas = []
  if (botellas > 0) {
    lineas.push(
      `Envasado: ${botellas} botella${botellas === 1 ? '' : 's'}; ` +
        `${filasInventario} movimiento${filasInventario === 1 ? '' : 's'} de inventario.`
    )
  }
  const rendimiento = mensajeDeRendimiento(resumen)
  if (rendimiento) lineas.push(rendimiento)

  return NextResponse.json({
    ...(avisoMarca ? { aviso_marca: avisoMarca } : {}),
    ok: true,
    id_lote: agregar.id_lote,
    codigo_lote: agregar.codigo_lote,
    filas_inventario: filasInventario,
    rendimiento: resumen,
    mensaje: lineas.join('\n')
  })
}
