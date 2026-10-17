/**
 * AG-05 Fase 3 — EL LOTE. Se propone completo y se SELLA. Aqui no se escribe.
 *
 * Mismo patron que gasto, abono y venta: entra lo que el LLM extrajo, sale un
 * borrador guardado del lado del servidor con su sello, y el texto que la
 * persona va a leer. **Este endpoint no toca ninguna de las cuatro tablas de
 * ERP-84.**
 *
 * ─── LO QUE ESTE ENDPOINT DECIDE Y EL MODELO NO ─────────────────────────────
 *   · el `id_insumo`    — el modelo manda un NOMBRE ("chile", "agua"); se
 *     empata contra `catalogo_productos` y si hay duda se pregunta con botones.
 *   · el `id_producto` del envasado — igual, contra los formatos que declaran
 *     `ml_por_unidad`. Un formato sin ml no puede envasar un lote.
 *   · el `codigo_lote` cuando no se dicto — se PROPONE `L-AAAAMMDD` y se
 *     ensena marcado como propuesta, con boton para cambiarlo.
 *   · el numero de tanda — es el orden en que se dictaron, 1..n. El modelo no
 *     numera nada.
 *
 * ─── D-198: LO QUE NO SE DECIDE EN NINGUN LADO DE ESTE ARCHIVO ──────────────
 * El rendimiento. Ni litros al grado objetivo, ni alcohol absoluto, ni botellas
 * teoricas, ni costo por mililitro. Todo eso lo calcula `v_lote_rendimiento` en
 * SQL, y `confirmar` lo lee DESPUES de escribir. El bot captura; el ERP calcula.
 *
 * ─── POR QUE SOLO ADMIN ─────────────────────────────────────────────────────
 * Porque asi lo dice la base: las cuatro tablas de ERP-84 tienen politicas de
 * `insert` solo para ADMIN (`lotes_ins_admin` y sus tres hermanas). El bot entra
 * con `service_role`, que salta la RLS, asi que **si esta linea no estuviera,
 * el bot seria la unica puerta del sistema por la que un DST podria escribir
 * produccion.** La autorizacion que la RLS ya no puede hacer, la hace esto.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import {
  clienteDeServicio,
  conservaPendientes,
  leerCodigosDeLote,
  leerFormatosDeBotella,
  leerInsumosDeLote,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion, MENSAJE_NO_PERMITIDO, ROL_TRABAJADOR } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import {
  buscarFormato,
  buscarInsumo,
  mensajeDeConfirmacionLote,
  normalizarLote,
  sellarLote,
  type FormatoDeBotella,
  type InsumoDelCatalogo,
  type LineaEnvasadoPedida,
  type LineaInsumoPedida
} from '@/lib/bot-lotes'
import {
  elegirLoteDestino,
  esAgregarALote,
  mensajeDeAgregarALote,
  mensajeFaltaEmpaque,
  sellarAgregar,
  type FaltanteEmpaque,
  type LoteExistente,
  type PayloadAgregar,
  VENTANA_LOTE_ABIERTO_DIAS
} from '@/lib/bot-envasado'
import { fechaLocal } from '@/lib/fechas'
import type { ClienteServicio } from '@/lib/bot-servidor'
import { inventarioDelEnvasado } from '@/lib/bot-empaque-servidor'

export const dynamic = 'force-dynamic'

const TOPE_OPCIONES = 9
const TOPE_RENGLONES = 20

interface InsumoPedido {
  insumo?: unknown
  id_insumo?: unknown
  cantidad?: unknown
}

interface EnvasadoPedido {
  formato?: unknown
  id_producto?: unknown
  botellas?: unknown
}

function opcionesDeInsumo(lista: readonly InsumoDelCatalogo[]) {
  return lista.slice(0, TOPE_OPCIONES).map((i) => ({
    id: i.id,
    nombre: i.nombre,
    sku: i.sku,
    unidad: i.unidad_medida
  }))
}

/**
 * D92: si el envasado dejaria un insumo en negativo, NO hay propuesta ni VA:
 * se dice que falta y se pregunta que paso. El bot guarda esta peticion y la
 * vuelve a proponer cuando la entrada del insumo quede escrita.
 */
function respuestaFaltaEmpaque(
  envasado: readonly { nombre: string; botellas: number }[],
  faltantes: FaltanteEmpaque[],
  resuelto: readonly { id_producto: string; botellas: number }[],
  /** WP-6: a un TRABAJADOR no se le ensena el stock (ni en el texto ni en el JSON). */
  sinCifras = false
) {
  return NextResponse.json({
    ok: false,
    falta_empaque: true,
    faltantes: sinCifras ? faltantes.map((f) => ({ id_insumo: f.id_insumo, nombre: f.nombre, ocupa: f.ocupa })) : faltantes,
    // Lo que el bot manda a `/api/bot/inventario/proponer`: el envasado ya
    // resuelto (ids), para que la entrada ofrezca justo esos insumos.
    envasado: resuelto.map((e) => ({ id_producto: e.id_producto, botellas: e.botellas })),
    mensaje: mensajeFaltaEmpaque(envasado, faltantes, sinCifras)
  })
}

async function leerLotes(supabase: ClienteServicio): Promise<LoteExistente[]> {
  const { data } = await supabase.from('lotes').select('id, codigo_lote, fecha_inicio')
  return (data ?? []).filter(
    (l): l is LoteExistente => typeof l.codigo_lote === 'string' && typeof l.fecha_inicio === 'string'
  )
}

function opcionesDeFormato(lista: readonly FormatoDeBotella[]) {
  return lista.slice(0, TOPE_OPCIONES).map((f) => ({
    id: f.id,
    nombre: f.nombre,
    sku: f.sku,
    ml: f.ml_por_unidad
  }))
}

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
      insumos?: InsumoPedido[]
      envasado?: EnvasadoPedido[]
      /** Cazador F0 (WP-7a): la persona apreto "Abrir lote nuevo" tras un envasado sin lote abierto. */
      abrir_lote_nuevo?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)

    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json(
        { error: 'No te tengo dado de alta. Pideselo a Norman.' },
        { status: 403 }
      )
    }
    if (permisoDeAccion(actorDe(identidad), 'lote') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['lote'] }, { status: 403 })
    }

    const [catalogoInsumos, formatos, codigosTomados] = await Promise.all([
      leerInsumosDeLote(supabase),
      leerFormatosDeBotella(supabase),
      leerCodigosDeLote(supabase)
    ])
    if (catalogoInsumos.length === 0 || formatos.length === 0) {
      return NextResponse.json(
        { error: 'No pude leer el catalogo. No propongo nada a ciegas.' },
        { status: 500 }
      )
    }

    // ── LOS INSUMOS ─────────────────────────────────────────────────────────
    const pedidos = Array.isArray(cuerpo.insumos) ? cuerpo.insumos : []
    if (pedidos.length > TOPE_RENGLONES) {
      return NextResponse.json(
        { error: `Son ${pedidos.length} insumos distintos. Eso va en la pantalla.` },
        { status: 422 }
      )
    }

    const insumos: LineaInsumoPedida[] = []
    for (let i = 0; i < pedidos.length; i++) {
      const pedido = pedidos[i]
      const idPedido = String(pedido.id_insumo ?? '')
      let insumo: InsumoDelCatalogo | undefined

      if (idPedido !== '') {
        insumo = catalogoInsumos.find((x) => x.id === idPedido)
        if (!insumo) {
          return NextResponse.json(
            { error: 'Ese insumo ya no esta en el catalogo. Vuelve a dictarlo.' },
            { status: 422 }
          )
        }
      } else {
        const hallazgo = buscarInsumo(pedido.insumo, catalogoInsumos)
        if (!hallazgo.ok) {
          const dicho = String(pedido.insumo ?? '').trim()
          const mensaje =
            hallazgo.motivo === 'ambiguo'
              ? `"${dicho}" me da mas de uno. Cual es?`
              : hallazgo.motivo === 'sin-nombre'
                ? 'No entendi que entro al lote.'
                : `No encontre "${dicho}" entre los insumos. Es alguno de estos?`
          return NextResponse.json({
            ok: false,
            hay_que_elegir: true,
            campo: 'insumo',
            indice: i,
            motivo: hallazgo.motivo,
            mensaje,
            opciones: opcionesDeInsumo(hallazgo.candidatos)
          })
        }
        insumo = hallazgo.elegido
      }

      insumos.push({ insumo, cantidad: Number(pedido.cantidad) })
    }

    // ── EL ENVASADO ─────────────────────────────────────────────────────────
    const envasadoPedido = Array.isArray(cuerpo.envasado) ? cuerpo.envasado : []
    const envasado: LineaEnvasadoPedida[] = []
    for (let i = 0; i < envasadoPedido.length; i++) {
      const pedido = envasadoPedido[i]
      const idPedido = String(pedido.id_producto ?? '')
      let formato: FormatoDeBotella | undefined

      if (idPedido !== '') {
        formato = formatos.find((f) => f.id === idPedido)
        if (!formato) {
          return NextResponse.json(
            { error: 'Ese formato ya no existe. Vuelve a dictarlo.' },
            { status: 422 }
          )
        }
      } else {
        // **"200 botellas" a secas NO se adivina.** El formato decide cuantos
        // mililitros salieron del lote, o sea el rendimiento entero; suponer
        // 750 porque es el mas comun convertiria una suposicion en un numero
        // que despues se lee como medido.
        const hallazgo = buscarFormato(pedido.formato, formatos)
        if (!hallazgo.ok) {
          const dicho = String(pedido.formato ?? '').trim()
          const mensaje =
            hallazgo.motivo === 'sin-nombre'
              ? 'De cual formato son las botellas?'
              : hallazgo.motivo === 'ambiguo'
                ? `"${dicho}" me da mas de uno. Cual es?`
                : `No encontre el formato "${dicho}". Es alguno de estos?`
          return NextResponse.json({
            ok: false,
            hay_que_elegir: true,
            campo: 'formato',
            indice: i,
            motivo: hallazgo.motivo,
            mensaje,
            opciones: opcionesDeFormato(hallazgo.candidatos)
          })
        }
        formato = hallazgo.elegido
      }

      envasado.push({ formato, botellas: Number(pedido.botellas) })
    }

    // ── D81: ¿LOTE NUEVO, O AGREGAR A UNO QUE YA EXISTE? ───────────────────
    const propuesta = cuerpo.propuesta ?? {}
    const lleno = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''
    const codigoDictado = lleno(propuesta.codigo_lote) ? String(propuesta.codigo_lote).trim() : null
    const tandasPedidas = Array.isArray(propuesta.tandas) ? propuesta.tandas : []
    let agregar = esAgregarALote({
      codigoDictado,
      codigosTomados,
      hayInsumos: insumos.length > 0,
      hayTandas: tandasPedidas.length > 0,
      hayEnvasado: envasado.length > 0,
      hayFermentacion: ['dias_fermentacion', 'horas_fermentacion', 'fecha_inicio'].some((k) =>
        lleno(propuesta[k])
      )
    })

    // Cazador F0 (WP-7a): el destino se decide ANTES del camino de agregar,
    // para poder caer al del lote nuevo cuando no hay ninguno abierto.
    const ahoraDestino = new Date()
    const destino = agregar
      ? elegirLoteDestino(codigoDictado, await leerLotes(supabase), fechaLocal(ahoraDestino))
      : null
    if (destino && !destino.ok && destino.motivo === 'sin_abiertos') {
      // Antes era un 422 y el envasado se perdia. Ahora se OFRECE abrir el
      // lote; con el boton, el bot repite la peticion con `abrir_lote_nuevo`
      // y cae al camino del lote nuevo (que valida y revisa el empaque igual
      // que siempre). Nada se escribe sin el VA.
      if (cuerpo.abrir_lote_nuevo !== true) {
        return NextResponse.json({
          ok: false,
          ofrecer_abrir_lote: true,
          mensaje:
            `No tengo ningun lote abierto (de los ultimos ${VENTANA_LOTE_ABIERTO_DIAS} dias). ` +
            'Abro un lote nuevo con este envasado? Si es de un lote viejo, dime el codigo.'
        })
      }
      agregar = false
    } else if (destino && !destino.ok) {
      return NextResponse.json({ error: destino.error }, { status: 422 })
    }

    if (agregar && destino && destino.ok) {
      const ahora = ahoraDestino
      // Se valida con la MISMA puerta que el lote nuevo (cantidades, grados,
      // topes). El codigo va como dictado y sin "tomados": aqui el lote existe
      // a proposito. Del resultado solo se usan los hijos.
      const validado = normalizarLote(
        { tandas: tandasPedidas, codigo_lote: destino.lote.codigo_lote },
        { etiqueta: identidad.etiqueta, ahora, codigosTomados: [], insumos, envasado }
      )
      if (!validado.ok) {
        return NextResponse.json({ error: validado.error }, { status: 422 })
      }
      const p = validado.payload
      if (p.entradas.length === 0 && p.tandas.length === 0 && p.envasado.length === 0) {
        return NextResponse.json(
          { error: `Que le agrego al lote ${destino.lote.codigo_lote}? No oi insumos, tandas ni botellas.` },
          { status: 422 }
        )
      }
      const payloadAgregar: PayloadAgregar = {
        id_lote: destino.lote.id,
        codigo_lote: destino.lote.codigo_lote,
        usuario_creador: validado.payload.usuario_creador,
        entradas: validado.payload.entradas,
        tandas: validado.payload.tandas,
        envasado: validado.payload.envasado
      }
      const inv = await inventarioDelEnvasado(supabase, payloadAgregar.envasado)
      if (inv.faltantes.length > 0) {
        return respuestaFaltaEmpaque(
          validado.desglose.envasado,
          inv.faltantes,
          payloadAgregar.envasado,
          identidad.rolEntidad === ROL_TRABAJADOR
        )
      }
      const avisos = [...validado.avisos]

      // Fase 8 (D79): con `conservar_pendientes` se suma a las que esperan.
      if (!conservaPendientes(cuerpo)) {
        await supabase
          .from('bot_borradores')
          .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
          .eq('telegram_id', telegramId)
          .eq('estado', 'PENDIENTE')
      }

      const selloAgregar = sellarAgregar(payloadAgregar)
      const { data: borradorAgregar, error: errorAgregar } = await supabase
        .from('bot_borradores')
        .insert({
          telegram_id: telegramId,
          chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
          sello: selloAgregar,
          payload: {
            tipo: 'lote_agregar',
            agregar: payloadAgregar,
            meta: { avisos }
          } as unknown as Json
        })
        .select('id')
        .single()

      if (errorAgregar || !borradorAgregar) {
        console.error('[bot] no se pudo guardar el borrador de agregar a lote:', errorAgregar)
        return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
      }

      return NextResponse.json({
        ok: true,
        borrador_id: borradorAgregar.id,
        sello: selloAgregar,
        codigo_lote: destino.lote.codigo_lote,
        agregar: true,
        movimientos: inv.movimientos,
        mensaje: mensajeDeAgregarALote(
          destino.lote,
          destino.porDefault,
          {
            insumos: validado.desglose.insumos,
            tandas: validado.desglose.tandas.map((t) => ({ litros: t.litros, grado: t.grado })),
            envasado: validado.desglose.envasado,
            movimientos: inv.movimientos.map((m) => ({
              nombre: inv.nombres.get(m.id_producto) ?? m.id_producto,
              tipo: m.tipo_movimiento,
              cantidad: m.cantidad
            }))
          },
          avisos
        )
      })
    }

    const normalizado = normalizarLote(propuesta, {
      etiqueta: identidad.etiqueta,
      ahora: new Date(),
      codigosTomados,
      insumos,
      envasado
    })
    if (!normalizado.ok) {
      return NextResponse.json({ error: normalizado.error }, { status: 422 })
    }

    // D82: un lote NUEVO con envasado tambien mueve inventario al confirmar.
    // D92: sin el empaque registrado no hay propuesta; se pregunta.
    const invNuevo = await inventarioDelEnvasado(supabase, normalizado.payload.envasado)
    if (invNuevo.faltantes.length > 0) {
      return respuestaFaltaEmpaque(
        normalizado.desglose.envasado,
        invNuevo.faltantes,
        normalizado.payload.envasado,
        identidad.rolEntidad === ROL_TRABAJADOR
      )
    }
    if (invNuevo.movimientos.length > 0) {
      normalizado.avisos.push(
        'Al darle VA, el envasado entra al inventario de la matriz y se descuenta su empaque.'
      )
    }

    // Un solo borrador PENDIENTE por persona. Misma regla que las otras tres
    // fases, y compartida con ellas a proposito: con dos borradores abiertos de
    // distinto tipo, un "va" seria ambiguo.    // Fase 8 (D79): con `conservar_pendientes` la propuesta se SUMA a las que
    // esperan su boton (varios hechos en un mensaje). Sin el, lo de siempre.
    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = sellarLote(normalizado.payload)

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: {
          tipo: 'lote',
          lote: normalizado.payload,
          meta: {
            desglose: normalizado.desglose,
            avisos: normalizado.avisos,
            codigo_sugerido: normalizado.codigoSugerido
          }
        } as unknown as Json
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de lote:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      codigo_lote: normalizado.payload.codigo_lote,
      codigo_sugerido: normalizado.codigoSugerido,
      insumos: opcionesDeInsumo(catalogoInsumos),
      formatos: opcionesDeFormato(formatos),
      mensaje: mensajeDeConfirmacionLote(
        normalizado.payload,
        normalizado.desglose,
        normalizado.avisos,
        normalizado.codigoSugerido
      )
    })
  } catch (e) {
    console.error('[bot] proponer lote reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
