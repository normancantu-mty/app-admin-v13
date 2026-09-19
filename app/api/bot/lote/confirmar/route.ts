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
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import {
  mensajeDeRendimiento,
  selloLoteCoincide,
  type DesgloseLote,
  type PayloadLote,
  type RendimientoDelLote
} from '@/lib/bot-lotes'

export const dynamic = 'force-dynamic'

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

    const supabase = clienteDeServicio()

    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }
    if (identidad.rolEntidad !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Registrar produccion es de la matriz; tu alta no alcanza.' },
        { status: 403 }
      )
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado')
      .eq('id', borradorId)
      .maybeSingle()

    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    if (borrador.telegram_id !== telegramId) {
      return NextResponse.json({ error: 'Ese borrador no es tuyo.' }, { status: 403 })
    }
    if (borrador.estado !== 'PENDIENTE') {
      return NextResponse.json(
        { error: `Ese borrador ya esta ${borrador.estado.toLowerCase()}.` },
        { status: 409 }
      )
    }

    const guardado = borrador.payload as unknown as BorradorLote
    // El discriminador, ANTES del sello y por la misma razon que en la venta:
    // sin el, un borrador de otro tipo caeria en la rama del sello roto, que
    // CANCELA, y una ruta equivocada del bot borraria una captura buena.
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

    // El codigo, RELEIDO: entre la propuesta y el "va" pudo entrar otro lote con
    // el mismo codigo desde la pantalla. `codigo_lote` es `unique`, asi que sin
    // esto el choque llegaria como un error de Postgres.
    const { data: yaExiste } = await supabase
      .from('lotes')
      .select('id')
      .eq('codigo_lote', lote.codigo_lote)
      .maybeSingle()
    if (yaExiste) {
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

    // ── 2, 3 y 4. LOS HIJOS. Un INSERT multi-fila por tabla ─────────────────
    if (lote.entradas.length > 0) {
      const { error } = await supabase
        .from('lote_entradas')
        .insert(lote.entradas.map((e) => ({ id_lote: idLote, ...e })))
      if (error) {
        await deshacer('las entradas', error)
        return NextResponse.json(
          { error: 'No pude escribir lo que entro al lote. Deshice el lote entero.' },
          { status: 500 }
        )
      }
    }

    if (lote.tandas.length > 0) {
      const { error } = await supabase
        .from('lote_salidas')
        .insert(lote.tandas.map((t) => ({ id_lote: idLote, ...t })))
      if (error) {
        await deshacer('las tandas', error)
        return NextResponse.json(
          { error: 'No pude escribir las tandas. Deshice el lote entero.' },
          { status: 500 }
        )
      }
    }

    if (lote.envasado.length > 0) {
      const { error } = await supabase
        .from('lote_envasado')
        .insert(lote.envasado.map((e) => ({ id_lote: idLote, ...e })))
      if (error) {
        await deshacer('el envasado', error)
        return NextResponse.json(
          { error: 'No pude escribir el envasado. Deshice el lote entero.' },
          { status: 500 }
        )
      }
    }

    await supabase
      .from('bot_borradores')
      .update({
        estado: 'CONFIRMADO',
        id_registro: idLote,
        resuelto_en: new Date().toISOString()
      })
      .eq('id', borradorId)

    // ── EL RENDIMIENTO, LEIDO DE LA VISTA (D-198) ───────────────────────────
    // Si la lectura falla no se deshace nada: el lote quedo bien escrito y lo
    // unico que se pierde es el resumen. Un rollback aqui destruiria una
    // captura buena por no poder ensenar un numero.
    const { data: rendimiento } = await supabase
      .from('v_lote_rendimiento')
      .select(
        'alcohol_absoluto_l, litros_al_grado_objetivo, botellas_750_teoricas, grado_ponderado, alcanza_el_grado_diluyendo, costo_por_ml, tandas_sin_grado, insumos_sin_costo, faltan_costo'
      )
      .eq('id', idLote)
      .maybeSingle()

    const comoNumero = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v)

    const resumen: RendimientoDelLote | null = rendimiento
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

    return NextResponse.json({
      ok: true,
      id_lote: idLote,
      codigo_lote: lote.codigo_lote,
      filas_escritas:
        1 + lote.entradas.length + lote.tandas.length + lote.envasado.length,
      rendimiento: resumen,
      mensaje: mensajeDeRendimiento(resumen)
    })
  } catch (e) {
    console.error('[bot] confirmar lote reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
