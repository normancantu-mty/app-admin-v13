/**
 * PREGUNTAS AL ERP DESDE EL BOT (2026-11-07). **Este endpoint no escribe. No puede.**
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web,
 * Fase 2). Contesta lo que `/api/bot/consulta` no cubre: saldo de una cuenta,
 * saldos, movimientos de una cuenta en un periodo, ventas de un periodo y el
 * detalle de un ticket.
 *
 * - **Fisicamente de solo lectura:** el cliente es `clienteDeSoloLectura`, cuyo
 *   `fetch` solo deja salir GET/HEAD (`lib/bot-solo-lectura.ts`).
 * - **Sin modelo:** `interpretarPregunta` (`lib/bot-pregunta.ts`) es puro y trata
 *   el texto como dato. Lo que no reconoce contesta `reconocida: false` con un
 *   "no la puedo contestar con certeza", nunca con una cifra adivinada.
 * - **Permisos:** `permisoDeConsulta` de `lib/bot-permisos.ts`, igual que la
 *   consulta. Dinero de cuentas = `gastos`; tickets y ventas = `ventas`. Hoy
 *   las dos son solo de ADMIN (Norman y Kevin). En un grupo va por privado.
 * - **Lo que NO cumple:** usa la llave de servicio (no pasa por RLS). Ver la
 *   propuesta en `supabase/migraciones_propuestas/`.
 *
 * Fase 6 (2026-11-07): cartera de un cliente, sus ultimos movimientos, cartera
 * total, botellas, inventario e insumos, y lo que se acaba
 * (`lib/bot-pregunta-erp.ts`). Mismo candado y mismos permisos: solo quien ve
 * TODO (ADMIN). A un DST/LOC se le contesta `reconocida: false, motivo:
 * 'acotada'` para que el bot siga a `/api/bot/consulta`, que ya le recorta la
 * cartera y el stock a su red; asi esta fase no le quita nada que ya tenia.
 * Un nombre ambiguo devuelve `opciones` (botones); el boton vuelve aqui con
 * `eleccion: { para, id_entidad }`.
 */

import { NextResponse } from 'next/server'
import { resolverIdentidad, tokenValido, type ClienteServicio } from '@/lib/bot-servidor'
import { clienteDeSoloLectura } from '@/lib/bot-solo-lectura'
import { esGrupo, permisoDeConsulta, type ConsultaBot } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { fechaLocal, sumarDias } from '@/lib/fechas'
import { medianocheMXaISO } from '@/lib/date-format'
import { fetchTodasLasFilas, type ConsultaPaginable } from '@/lib/paginacion'
import { pieDeConsulta, textoQuienDebe } from '@/lib/bot-consultas'
import { leerCartera, leerEfectivoPorEntregar, leerStockPorCubeta, type FilaCarteraVista } from '@/lib/vistas'
import { textoEfectivoPorEntregar } from '@/lib/bot-entrega'
import {
  eventosDelCliente,
  MOVIMIENTOS_POR_DEFECTO,
  STATUS_DE_LA_VISTA,
  stockDeInsumos,
  textoBotellas,
  textoDeudaCliente,
  textoInventario,
  textoMovimientosCliente,
  textoSeAcaba,
  type DineroDelCliente,
  type EntidadDePregunta,
  type InsumoNegativo,
  type MovimientoDeInsumo,
  type NombresDelErp,
  type PiezasDelCliente,
  type TicketDelCliente
} from '@/lib/bot-pregunta-erp'
import { STATUS_QUE_CUENTAN, type MovimientoDinero } from '@/lib/v2/dinero'
import {
  interpretarPregunta,
  textoDeNinguna,
  textoMovimientos,
  textoSaldo,
  textoSaldos,
  textoTicket,
  textoVentasPeriodo,
  ticketsDelFolio,
  type Periodo,
  type Pregunta,
  type TicketDeVenta
} from '@/lib/bot-pregunta'

export const dynamic = 'force-dynamic'

/** Cada pregunta, con el nombre que tiene en la tabla de permisos. */
const CONSULTA_DE_PREGUNTA: Record<Exclude<Pregunta['tipo'], 'ninguna'>, ConsultaBot> = {
  saldo_cuenta: 'gastos',
  saldos: 'gastos',
  movimientos_cuenta: 'gastos',
  ventas_periodo: 'ventas',
  detalle_ticket: 'ventas',
  deuda_cliente: 'deuda',
  movimientos_cliente: 'deuda',
  cartera_total: 'deuda',
  stock: 'inventario',
  inventario: 'inventario',
  se_acaba: 'inventario'
}

/** Las de la Fase 6: a quien no ve todo se le delega a `/api/bot/consulta`. */
const DE_LA_FASE_6 = new Set<Pregunta['tipo']>(['deuda_cliente', 'movimientos_cliente', 'cartera_total', 'stock', 'inventario', 'se_acaba'])

const ACOTADA =
  'Esa la contesto con lo de tu alta: pregunta "quien me debe" o "stock" y te digo lo de tu red.'

/** Entidades y productos: con esto se reconoce de quien o de que se habla. Un error se dice. */
async function leerNombres(supabase: ClienteServicio): Promise<NombresDelErp & { error: string | null }> {
  const [{ data: ents, error: e1 }, { data: prods, error: e2 }] = await Promise.all([
    supabase.from('entidades').select('id, nombre, rol').order('nombre'),
    supabase.from('catalogo_productos').select('id, nombre, tipo, unidad_medida, ml_por_unidad').order('nombre')
  ])
  return {
    entidades: (ents ?? []).map((e) => ({ id: e.id, nombre: String(e.nombre ?? ''), rol: String(e.rol ?? '') })),
    productos: (prods ?? []).map((p) => ({
      id: p.id,
      nombre: String(p.nombre ?? ''),
      tipo: String(p.tipo ?? ''),
      unidad_medida: p.unidad_medida ?? null,
      ml_por_unidad: (p as { ml_por_unidad?: number | string | null }).ml_por_unidad ?? null
    })),
    error: e1 ? 'entidades' : e2 ? 'catalogo_productos' : null
  }
}

/** Lo que no es ANULADO, contando el status nulo como ACTIVO (la regla de v_cartera). */
const NO_ANULADO = 'status.is.null,status.neq.ANULADO'

async function contestarErp(
  supabase: ClienteServicio,
  p: Extract<Pregunta, { tipo: 'deuda_cliente' | 'movimientos_cliente' | 'cartera_total' | 'stock' | 'inventario' | 'se_acaba' }>,
  nombres: NombresDelErp
): Promise<string> {
  const rolDe = new Map(nombres.entidades.map((e) => [e.id, e.rol]))
  if (p.tipo === 'deuda_cliente' || p.tipo === 'movimientos_cliente') {
    const cartera = await leerCartera(supabase)
    const fila: FilaCarteraVista | null = cartera.find((f) => f.id_entidad === p.cliente.id) ?? null
    if (p.tipo === 'deuda_cliente') {
      return textoDeudaCliente(p.cliente, fila) + pieDeConsulta('v_cartera', fila?.calculado_en ?? null)
    }
    const id = p.cliente.id
    const [tk, fin, inv] = await Promise.all([
      fetchTodasLasFilas<TicketDelCliente>(
        () =>
          supabase
            .from('transacciones_tickets')
            .select('id, fecha_transaccion, total_cobrado_real, monto_base_ingreso, condicion_pago, status')
            .eq('id_comprador', id)
            .or(NO_ANULADO)
            .order('fecha_transaccion', { ascending: false }) as unknown as ConsultaPaginable<TicketDelCliente>,
        'pregunta tickets del cliente'
      ),
      fetchTodasLasFilas<DineroDelCliente>(
        () =>
          supabase
            .from('finanzas_ledger')
            .select('id, fecha_movimiento, tipo_movimiento, monto, categoria, status, es_entrega_efectivo')
            .eq('id_entidad_relacionada', id)
            .in('tipo_movimiento', ['ABONO_DEUDA', 'CARGO_DEUDA'])
            .or(NO_ANULADO)
            .order('fecha_movimiento', { ascending: false }) as unknown as ConsultaPaginable<DineroDelCliente>,
        'pregunta dinero del cliente'
      ),
      fetchTodasLasFilas<PiezasDelCliente>(
        () =>
          supabase
            .from('inventario_ledger')
            .select('id, fecha_movimiento, tipo_movimiento, cantidad, id_producto, id_entidad_origen, id_entidad_destino, status')
            .in('tipo_movimiento', ['ENTRADA_CONCESION', 'DEVOLUCION_FISICA'])
            .or(`id_entidad_destino.eq.${id},id_entidad_origen.eq.${id}`)
            .order('fecha_movimiento', { ascending: false }) as unknown as ConsultaPaginable<PiezasDelCliente>,
        'pregunta piezas del cliente'
      )
    ])
    const nombreProducto = new Map(nombres.productos.map((x) => [x.id, x.nombre]))
    const eventos = eventosDelCliente(p.cliente, tk, fin, inv, nombreProducto)
    return (
      textoMovimientosCliente(p.cliente, fila, eventos, p.n || MOVIMIENTOS_POR_DEFECTO) +
      pieDeConsulta('transacciones_tickets + finanzas_ledger + inventario_ledger, reglas de v_cartera')
    )
  }
  if (p.tipo === 'cartera_total') {
    const filas = await leerCartera(supabase)
    const efectivo = await leerEfectivoPorEntregar(supabase)
    return (
      textoQuienDebe(filas, null, efectivo ? textoEfectivoPorEntregar(efectivo) : null) +
      pieDeConsulta('v_cartera', filas[0]?.calculado_en ?? null)
    )
  }
  const terminado = await leerStockPorCubeta(supabase)
  if (p.tipo === 'stock') return textoBotellas(terminado, p, rolDe) + pieDeConsulta('v_stock_por_cubeta')

  const idsInsumo = nombres.productos.filter((x) => x.tipo === 'INSUMO').map((x) => x.id)
  const movs = idsInsumo.length
    ? await fetchTodasLasFilas<MovimientoDeInsumo>(
        () =>
          supabase
            .from('inventario_ledger')
            .select('id_producto, tipo_movimiento, cantidad, id_entidad_origen, id_entidad_destino, status')
            .in('status', [...STATUS_DE_LA_VISTA])
            .in('id_producto', idsInsumo) as unknown as ConsultaPaginable<MovimientoDeInsumo>,
        'pregunta insumos'
      )
    : []
  const insumos = stockDeInsumos(movs, nombres.productos, nombres.entidades)
  if (p.tipo === 'inventario') {
    return (
      textoInventario(terminado, insumos, nombres.productos, rolDe, p.soloInsumos) +
      pieDeConsulta('v_stock_por_cubeta; insumos con la regla de v_insumos_en_negativo sin el filtro de negativos')
    )
  }
  const negativos = await fetchTodasLasFilas<InsumoNegativo>(
    () => (supabase as unknown as { from(t: string): { select(c: string): unknown } }).from('v_insumos_en_negativo').select('entidad, insumo, unidad_medida, stock, faltante') as ConsultaPaginable<InsumoNegativo>,
    'v_insumos_en_negativo'
  )
  return textoSeAcaba(negativos, terminado, insumos, nombres.productos, rolDe) + pieDeConsulta('v_insumos_en_negativo + v_stock_por_cubeta')
}

const NO_TE_TOCA = 'Esa consulta es de la empresa; tu alta solo alcanza a lo tuyo.'

interface CuentaConEntidad {
  id: string
  nombre: string
  id_entidad: string | null
}

/** El rango en instantes: [medianoche MX de `desde`, medianoche MX del dia despues de `hasta`). */
function rango(p: Periodo): { desde: string; hasta: string } {
  return { desde: medianocheMXaISO(p.desde) as string, hasta: medianocheMXaISO(sumarDias(p.hasta, 1)) as string }
}

/** `saldo_cuenta` por GET (es STABLE): el cliente no deja salir un POST. */
async function leerSaldo(supabase: ClienteServicio, idCuenta: string): Promise<number | null> {
  const { data, error } = await supabase.rpc('saldo_cuenta', { p_id_cuenta: idCuenta }, { get: true })
  if (error || data === null || data === undefined) return null
  const saldo = Number(data)
  return Number.isFinite(saldo) ? saldo : null
}

const COLUMNAS_TICKET = 'id, fecha_transaccion, total_cobrado_real, condicion_pago, status, id_comprador, id_vendedor, usuario_creador'
type FilaTicket = TicketDeVenta & { id_vendedor: string | null; usuario_creador: string | null }

async function contestar(
  supabase: ClienteServicio,
  p: Extract<Pregunta, { tipo: 'saldo_cuenta' | 'saldos' | 'movimientos_cuenta' | 'ventas_periodo' | 'detalle_ticket' }>,
  cuentas: CuentaConEntidad[],
  idEntidad: string
): Promise<string> {
  if (p.tipo === 'saldo_cuenta') {
    return textoSaldo(p.cuenta, await leerSaldo(supabase, p.cuenta.id)) + pieDeConsulta('saldo_cuenta()')
  }
  if (p.tipo === 'saldos') {
    const propias = cuentas.filter((c) => c.id_entidad === idEntidad)
    const filas = await Promise.all(propias.map(async (c) => ({ nombre: c.nombre, saldo: await leerSaldo(supabase, c.id) })))
    return textoSaldos(filas) + pieDeConsulta('saldo_cuenta()')
  }
  if (p.tipo === 'movimientos_cuenta') {
    const r = rango(p.periodo)
    const movs = await fetchTodasLasFilas<MovimientoDinero>(
      () =>
        supabase
          .from('finanzas_ledger')
          .select('id, tipo_movimiento, monto, status, categoria, subcategoria, categoria_gasto, descripcion, fecha_movimiento, id_cuenta_origen, id_cuenta_destino, id_entidad_relacionada, usuario_creador')
          .or(`id_cuenta_origen.eq.${p.cuenta.id},id_cuenta_destino.eq.${p.cuenta.id}`)
          .in('status', [...STATUS_QUE_CUENTAN])
          .gte('fecha_movimiento', r.desde)
          .lt('fecha_movimiento', r.hasta)
          .order('fecha_movimiento', { ascending: true }) as unknown as ConsultaPaginable<MovimientoDinero>,
      'pregunta movimientos'
    )
    return textoMovimientos(p.cuenta, p.periodo, movs, p.periodoDicho) + pieDeConsulta('finanzas_ledger, regla de saldo_cuenta()')
  }
  if (p.tipo === 'ventas_periodo') {
    const r = rango(p.periodo)
    const tickets = await fetchTodasLasFilas<TicketDeVenta>(
      () =>
        supabase
          .from('transacciones_tickets')
          .select('id, fecha_transaccion, total_cobrado_real, condicion_pago, status, id_comprador')
          .eq('status', 'ACTIVO')
          .gte('fecha_transaccion', r.desde)
          .lt('fecha_transaccion', r.hasta)
          .order('fecha_transaccion', { ascending: true }) as unknown as ConsultaPaginable<TicketDeVenta>,
      'pregunta ventas'
    )
    return textoVentasPeriodo(p.periodo, tickets) + pieDeConsulta('transacciones_tickets, regla de v_ventas_por_mes')
  }
  // detalle_ticket: el folio son los 8 primeros del id (`folioDeTicket`).
  const todos = await fetchTodasLasFilas<FilaTicket>(
    () =>
      supabase
        .from('transacciones_tickets')
        .select(COLUMNAS_TICKET)
        .order('fecha_transaccion', { ascending: false }) as unknown as ConsultaPaginable<FilaTicket>,
    'pregunta ticket'
  )
  const hallados = ticketsDelFolio(p.folio, todos)
  if (hallados.length === 0) return `No encuentro ningun ticket con folio ${p.folio}.`
  if (hallados.length > 1) {
    return `Hay ${hallados.length} tickets que empiezan con ${p.folio}; dame mas caracteres del folio.`
  }
  const t = hallados[0]
  // Ante un error de lectura se dice "no pude leer": "(sin renglones)" o
  // "Publico en General" serian datos inventados (auditoria 2026-11-07).
  const [{ data: detalles, error: errorDetalles }, { data: entidades, error: errorEntidades }] = await Promise.all([
    supabase.from('ticket_detalles').select('cantidad, precio_unitario, subtotal_linea, id_producto').eq('id_ticket', t.id),
    supabase.from('entidades').select('id, nombre').in('id', [t.id_vendedor, t.id_comprador].filter((x): x is string => Boolean(x)))
  ])
  if (errorDetalles) {
    return `No pude leer los renglones del ticket ${p.folio} (ticket_detalles). No invento el detalle.`
  }
  if (errorEntidades) {
    return `No pude leer quien vendio ni quien compro en el ticket ${p.folio} (entidades). No lo invento.`
  }
  const idsProd = [...new Set((detalles ?? []).map((d) => d.id_producto).filter((x): x is string => Boolean(x)))]
  const { data: productos, error: errorProductos } = idsProd.length
    ? await supabase.from('catalogo_productos').select('id, nombre').in('id', idsProd)
    : { data: [] as { id: string; nombre: string }[], error: null }
  if (errorProductos) {
    return `No pude leer los productos del ticket ${p.folio} (catalogo_productos). No invento el detalle.`
  }
  const nombreEnt = new Map((entidades ?? []).map((e) => [e.id, String(e.nombre ?? '')]))
  const nombreProd = new Map((productos ?? []).map((x) => [x.id, String(x.nombre ?? '')]))
  return (
    textoTicket(
      {
        ...t,
        // Sin id es dato real (venta al publico); con id y sin nombre, se dice.
        vendedor: t.id_vendedor ? nombreEnt.get(t.id_vendedor) || '(no encontrado en entidades)' : '—',
        comprador: t.id_comprador ? nombreEnt.get(t.id_comprador) || '(no encontrado en entidades)' : 'Publico en General'
      },
      (detalles ?? []).map((d) => ({
        cantidad: d.cantidad,
        precio_unitario: d.precio_unitario,
        subtotal_linea: d.subtotal_linea,
        producto: (d.id_producto && nombreProd.get(d.id_producto)) || '(producto no encontrado)'
      }))
    ) + pieDeConsulta('transacciones_tickets + ticket_detalles')
  )
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
      /** Fase 6: el boton de "¿cual de ellos?". */
      eleccion?: { para?: unknown; id_entidad?: unknown }
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
    const actor = actorDe(identidad)

    // Las cuentas que se pueden nombrar: todas para quien ve todo (la web le
    // ensena todas a un ADMIN); las de su alta para cualquier otro.
    const veTodo = permisoDeConsulta(actor, 'gastos')
    let cuentas: CuentaConEntidad[]
    if (veTodo.ok && veTodo.alcance === 'todo') {
      const { data } = await supabase.from('cuentas_financieras').select('id, nombre, id_entidad').order('nombre')
      cuentas = (data ?? []).map((c) => ({ id: c.id, nombre: String(c.nombre ?? ''), id_entidad: c.id_entidad }))
    } else {
      cuentas = identidad.cuentas.map((c) => ({ ...c, id_entidad: identidad.idEntidad }))
    }

    const hoy = fechaLocal(new Date())
    let pregunta = interpretarPregunta(texto, cuentas, hoy)
    let nombres: NombresDelErp | null = null
    const eleccion = cuerpo.eleccion
    if (eleccion || pregunta.tipo === 'ninguna') {
      // Los nombres solo se leen si la Fase 2 no la reconocio: lo de antes no cambia.
      const leidos = await leerNombres(supabase)
      if (leidos.error) {
        return NextResponse.json({ error: `No pude leer ${leidos.error}.` }, { status: 500 })
      }
      nombres = leidos
      if (eleccion) {
        const cliente = leidos.entidades.find(
          (e) => e.id === String(eleccion.id_entidad ?? '') && (e.rol === 'DST' || e.rol === 'LOC')
        )
        if (!cliente) return NextResponse.json({ error: 'Ese cliente ya no esta en la base.' }, { status: 422 })
        pregunta =
          eleccion.para === 'movimientos'
            ? { tipo: 'movimientos_cliente', cliente, n: MOVIMIENTOS_POR_DEFECTO }
            : { tipo: 'deuda_cliente', cliente }
      } else {
        pregunta = interpretarPregunta(texto, cuentas, hoy, leidos)
      }
    }
    if (pregunta.tipo === 'ninguna') {
      const opciones =
        pregunta.motivo === 'cliente_ambiguo'
          ? { para: pregunta.para, opciones: pregunta.candidatos.map((c: EntidadDePregunta) => ({ id: c.id, nombre: c.nombre })) }
          : {}
      return NextResponse.json({ ok: true, reconocida: false, motivo: pregunta.motivo, texto: textoDeNinguna(pregunta), privado: false, ...opciones })
    }

    const permiso = permisoDeConsulta(actor, CONSULTA_DE_PREGUNTA[pregunta.tipo])
    if (DE_LA_FASE_6.has(pregunta.tipo) && permiso.ok && permiso.alcance !== 'todo') {
      return NextResponse.json({ ok: true, reconocida: false, motivo: 'acotada', texto: ACOTADA, privado: false })
    }
    // Hoy todas estas son cifra de la empresa: solo quien ve TODO. Un alcance
    // acotado (DST/LOC) no se intenta filtrar aqui; se niega entero.
    if (!permiso.ok || permiso.alcance !== 'todo') {
      return NextResponse.json({ error: NO_TE_TOCA }, { status: 403 })
    }
    const privado = permiso.privado && esGrupo(cuerpo.chat_id, telegramId)
    const respuesta =
      DE_LA_FASE_6.has(pregunta.tipo) && nombres
        ? await contestarErp(supabase, pregunta as Parameters<typeof contestarErp>[1], nombres)
        : await contestar(supabase, pregunta as Parameters<typeof contestar>[1], cuentas, identidad.idEntidad)
    return NextResponse.json({ ok: true, reconocida: true, tipo: pregunta.tipo, texto: respuesta, privado })
  } catch (e) {
    console.error('[bot] pregunta reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
