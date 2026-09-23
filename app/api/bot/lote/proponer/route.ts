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
  faltantesDeEmpaque,
  mensajeDeAgregarALote,
  movimientosDeEnvasado,
  sellarAgregar,
  type LoteExistente,
  type MovimientoEnvasado,
  type PayloadAgregar
} from '@/lib/bot-envasado'
import { fechaLocal } from '@/lib/fechas'
import type { ClienteServicio } from '@/lib/bot-servidor'
import { fetchTodasLasFilas } from '@/lib/paginacion'

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
 * Fase 8, D82: lo que el envasado le va a hacer al inventario de la matriz y el
 * empaque que no alcanza. Solo LEE (receta, nombres, stock): corre igual en
 * ensayo. La escritura es `registrar_en_lote`, en la ruta de confirmar.
 */
async function inventarioDelEnvasado(
  supabase: ClienteServicio,
  envasado: readonly { id_producto: string; botellas: number }[]
): Promise<{ movimientos: MovimientoEnvasado[]; nombres: Map<string, string>; avisos: string[] }> {
  if (envasado.length === 0) return { movimientos: [], nombres: new Map(), avisos: [] }
  const ids = envasado.map((e) => e.id_producto)
  const [{ data: receta }, { data: admin }] = await Promise.all([
    supabase
      .from('recetas_produccion')
      .select('id_producto_terminado, id_insumo, cantidad_requerida')
      .in('id_producto_terminado', ids),
    supabase.from('entidades').select('id').eq('rol', 'ADMIN').limit(1).maybeSingle()
  ])
  const movimientos = envasado.flatMap((e) =>
    movimientosDeEnvasado(
      e.id_producto,
      e.botellas,
      (receta ?? [])
        .filter((r) => r.id_producto_terminado === e.id_producto)
        .map((r) => ({ id_insumo: r.id_insumo, cantidad_requerida: Number(r.cantidad_requerida) }))
    )
  )
  const idsMovidos = [...new Set(movimientos.map((m) => m.id_producto))]
  const { data: productos } = await supabase
    .from('catalogo_productos')
    .select('id, nombre')
    .in('id', idsMovidos)
  // ERP-25: vista sobre el ledger -> paginada, aunque hoy sean unas cuantas filas.
  const idAdmin = admin?.id
  const stock = idAdmin
    ? await fetchTodasLasFilas<{ id_producto: string | null; stock: number | null }>(
        () =>
          supabase
            .from('v_stock_por_cubeta')
            .select('id_producto, stock')
            .eq('id_entidad', idAdmin)
            .in('id_producto', idsMovidos),
        'stock del empaque'
      )
    : []
  const nombres = new Map((productos ?? []).map((p) => [p.id, p.nombre] as [string, string]))
  const hay = new Map<string, number>()
  for (const f of stock ?? []) {
    if (!f.id_producto) continue
    hay.set(f.id_producto, (hay.get(f.id_producto) ?? 0) + Number(f.stock ?? 0))
  }
  return { movimientos, nombres, avisos: faltantesDeEmpaque(movimientos, hay, nombres) }
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

    // ── D81: ¿LOTE NUEVO, O AGREGAR A UNO QUE YA EXISTE? ───────────────────
    const propuesta = cuerpo.propuesta ?? {}
    const lleno = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''
    const codigoDictado = lleno(propuesta.codigo_lote) ? String(propuesta.codigo_lote).trim() : null
    const tandasPedidas = Array.isArray(propuesta.tandas) ? propuesta.tandas : []
    const agregar = esAgregarALote({
      codigoDictado,
      codigosTomados,
      hayInsumos: insumos.length > 0,
      hayTandas: tandasPedidas.length > 0,
      hayEnvasado: envasado.length > 0,
      hayFermentacion: ['dias_fermentacion', 'horas_fermentacion', 'fecha_inicio'].some((k) =>
        lleno(propuesta[k])
      )
    })

    if (agregar) {
      const ahora = new Date()
      const destino = elegirLoteDestino(codigoDictado, await leerLotes(supabase), fechaLocal(ahora))
      if (!destino.ok) {
        return NextResponse.json({ error: destino.error }, { status: 422 })
      }
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
      const avisos = [...validado.avisos, ...inv.avisos]

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

    // D82: un lote NUEVO con envasado tambien mueve inventario al confirmar;
    // la falta de empaque se dice aqui, antes del VA.
    const invNuevo = await inventarioDelEnvasado(supabase, normalizado.payload.envasado)
    if (invNuevo.movimientos.length > 0) {
      normalizado.avisos.push(
        'Al darle VA, el envasado entra al inventario de la matriz y se descuenta su empaque.'
      )
      normalizado.avisos.push(...invNuevo.avisos)
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
