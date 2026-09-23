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
  leerCodigosDeLote,
  leerFormatosDeBotella,
  leerInsumosDeLote,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
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
      propuesta?: Record<string, unknown>
      insumos?: InsumoPedido[]
      envasado?: EnvasadoPedido[]
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
    if (identidad.rolEntidad !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Registrar produccion es de la matriz; tu alta no alcanza.' },
        { status: 403 }
      )
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

    const normalizado = normalizarLote(cuerpo.propuesta ?? {}, {
      etiqueta: identidad.etiqueta,
      ahora: new Date(),
      codigosTomados,
      insumos,
      envasado
    })
    if (!normalizado.ok) {
      return NextResponse.json({ error: normalizado.error }, { status: 422 })
    }

    // Un solo borrador PENDIENTE por persona. Misma regla que las otras tres
    // fases, y compartida con ellas a proposito: con dos borradores abiertos de
    // distinto tipo, un "va" seria ambiguo.
    await supabase
      .from('bot_borradores')
      .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
      .eq('telegram_id', telegramId)
      .eq('estado', 'PENDIENTE')

    const sello = sellarLote(normalizado.payload)

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
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
