/**
 * ESTADO DE CUENTA DE UN CLIENTE PARA LA IMAGEN DEL BOT (2026-11-23).
 * **Este endpoint no escribe. No puede:** usa `clienteDeSoloLectura`.
 *
 * Escrito el 2026-11-23 por un ejecutor del Socio. Devuelve los DATOS (no la
 * imagen): el bot la dibuja con la plantilla aprobada. El calculo y sus reglas
 * viven en `lib/bot-estado-cuenta.ts`, puras y probadas.
 *
 * - Permiso: el mismo de "cuanto debe X" (`permisoDeConsulta(actor, 'deuda')`) y,
 *   como en `/api/bot/pregunta`, solo quien ve TODO (la Matriz). No amplia nada:
 *   a quien no ve todo se le contesta `reconocida: false` y sigue como antes.
 * - Ambiguo, no encontrado, o no cuadra con `v_cartera`: se dice, y NO va `estado`.
 */

import { NextResponse } from 'next/server'
import { resolverIdentidad, tokenValido, type ClienteServicio } from '@/lib/bot-servidor'
import { clienteDeSoloLectura } from '@/lib/bot-solo-lectura'
import { esGrupo, permisoDeConsulta } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { fechaLocal } from '@/lib/fechas'
import { fetchTodasLasFilas, type ConsultaPaginable } from '@/lib/paginacion'
import { leerCartera } from '@/lib/vistas'
import type { EntidadDePregunta, ProductoDePregunta } from '@/lib/bot-pregunta-erp'
import {
  armarEstadoDeCuenta,
  leyendaDeEstado,
  quienEs,
  textoAmbiguo,
  textoNoCuadra,
  textoNoEncontrado,
  textoSinCartera,
  type DetalleDeEstado,
  type DineroDeEstado,
  type PiezasDeEstado,
  type TicketDeEstado
} from '@/lib/bot-estado-cuenta'

export const dynamic = 'force-dynamic'

/** Lo que no es ANULADO, contando el status nulo como ACTIVO (la regla de v_cartera). */
const NO_ANULADO = 'status.is.null,status.neq.ANULADO'

async function leerDelCliente(supabase: ClienteServicio, id: string) {
  const [tickets, dinero, piezas] = await Promise.all([
    fetchTodasLasFilas<TicketDeEstado>(
      () =>
        supabase
          .from('transacciones_tickets')
          .select('id, fecha_transaccion, total_cobrado_real, monto_base_ingreso, condicion_pago, status')
          .eq('id_comprador', id)
          .or(NO_ANULADO)
          .order('fecha_transaccion', { ascending: true }) as unknown as ConsultaPaginable<TicketDeEstado>,
      'estado de cuenta: tickets'
    ),
    fetchTodasLasFilas<DineroDeEstado>(
      () =>
        supabase
          .from('finanzas_ledger')
          .select('id, fecha_movimiento, tipo_movimiento, monto, categoria, status, es_entrega_efectivo, metodo_pago')
          .eq('id_entidad_relacionada', id)
          .in('tipo_movimiento', ['ABONO_DEUDA', 'CARGO_DEUDA'])
          .or(NO_ANULADO)
          .order('fecha_movimiento', { ascending: true }) as unknown as ConsultaPaginable<DineroDeEstado>,
      'estado de cuenta: dinero'
    ),
    fetchTodasLasFilas<PiezasDeEstado>(
      () =>
        supabase
          .from('inventario_ledger')
          .select('id, fecha_movimiento, tipo_movimiento, cantidad, id_producto, id_entidad_origen, id_entidad_destino, status, costo_unitario_movimiento, notas')
          .in('tipo_movimiento', ['ENTRADA_CONCESION', 'DEVOLUCION_FISICA'])
          .or(`id_entidad_destino.eq.${id},id_entidad_origen.eq.${id}`)
          .order('fecha_movimiento', { ascending: true }) as unknown as ConsultaPaginable<PiezasDeEstado>,
      'estado de cuenta: piezas'
    )
  ])
  const ids = tickets.filter((t) => t.condicion_pago === 'CONCESION').map((t) => t.id)
  const detalles = ids.length
    ? await fetchTodasLasFilas<DetalleDeEstado>(
        () =>
          supabase
            .from('ticket_detalles')
            .select('id_ticket, id_producto, cantidad, precio_unitario, subtotal_linea')
            .in('id_ticket', ids) as unknown as ConsultaPaginable<DetalleDeEstado>,
        'estado de cuenta: detalles'
      )
    : []
  return { tickets, dinero, piezas, detalles }
}

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      chat_id?: unknown
      texto?: unknown
      /** El boton de "¿cual de ellos?". */
      id_entidad?: unknown
    }
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }
    const texto = String(cuerpo.texto ?? '').slice(0, 500)

    const supabase = clienteDeSoloLectura()
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta. Pideselo a Norman.' }, { status: 403 })
    }
    // El permiso va ANTES de leer un solo nombre (auditoria 2026-11-07).
    const permiso = permisoDeConsulta(actorDe(identidad), 'deuda')
    if (!permiso.ok) return NextResponse.json({ error: 'Esa consulta no te toca con tu alta.' }, { status: 403 })
    if (permiso.alcance !== 'todo') {
      return NextResponse.json({ ok: true, reconocida: false, motivo: 'acotada', privado: false })
    }
    const privado = permiso.privado && esGrupo(cuerpo.chat_id, telegramId)

    const [ents, prods, ctas] = await Promise.all([
      supabase.from('entidades').select('id, nombre, rol').order('nombre'),
      supabase.from('catalogo_productos').select('id, nombre, tipo, unidad_medida, ml_por_unidad').order('nombre'),
      supabase.from('cuentas_financieras').select('id, nombre').order('nombre')
    ])
    const fallo = ents.error ? 'entidades' : prods.error ? 'catalogo_productos' : ctas.error ? 'cuentas_financieras' : null
    if (fallo) return NextResponse.json({ error: `No pude leer ${fallo}.` }, { status: 500 })
    const entidades: EntidadDePregunta[] = (ents.data ?? []).map((e) => ({ id: e.id, nombre: String(e.nombre ?? ''), rol: String(e.rol ?? '') }))
    const productos = (prods.data ?? []) as unknown as ProductoDePregunta[]
    const cuentas = (ctas.data ?? []).map((c) => ({ id: c.id, nombre: String(c.nombre ?? '') }))

    let cliente: EntidadDePregunta
    if (cuerpo.id_entidad !== undefined && cuerpo.id_entidad !== null) {
      const elegido = entidades.find((e) => e.id === String(cuerpo.id_entidad) && (e.rol === 'DST' || e.rol === 'LOC'))
      if (!elegido) return NextResponse.json({ error: 'Ese cliente ya no esta en la base.' }, { status: 422 })
      cliente = elegido
    } else {
      const q = quienEs(texto, entidades, cuentas)
      if (q.tipo === 'cuenta') return NextResponse.json({ ok: true, reconocida: false, motivo: 'cuenta', privado: false })
      if (q.tipo === 'ambiguo') {
        return NextResponse.json({
          ok: true, reconocida: true, motivo: 'cliente_ambiguo', privado: false, texto: textoAmbiguo(q),
          opciones: q.candidatos.map((c) => ({ id: c.id, nombre: c.nombre }))
        })
      }
      if (q.tipo === 'no_encontrado') {
        return NextResponse.json({ ok: true, reconocida: true, motivo: 'cliente_no_encontrado', privado: false, texto: textoNoEncontrado(q.dicho) })
      }
      cliente = q.cliente
    }

    const [cartera, datos] = await Promise.all([leerCartera(supabase), leerDelCliente(supabase, cliente.id)])
    const fila = cartera.find((f) => f.id_entidad === cliente.id) ?? null
    if (!fila) {
      return NextResponse.json({ ok: true, reconocida: true, motivo: 'sin_cartera', privado: false, texto: textoSinCartera(cliente) })
    }
    const acreedor = fila.id_acreedor ? (entidades.find((e) => e.id === fila.id_acreedor)?.nombre ?? 'sin nombre en el ERP') : null
    const r = armarEstadoDeCuenta({ cliente, fila, acreedor, ...datos, productos, hoy: fechaLocal(new Date()) })
    if (!r.cuadra) {
      return NextResponse.json({ ok: true, reconocida: true, motivo: 'no_cuadra', privado, texto: textoNoCuadra(cliente, r) })
    }
    return NextResponse.json({ ok: true, reconocida: true, motivo: null, privado, texto: leyendaDeEstado(r.estado), estado: r.estado })
  } catch (e) {
    console.error('[bot] estado de cuenta reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
