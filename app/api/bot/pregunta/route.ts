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
 */

import { NextResponse } from 'next/server'
import { resolverIdentidad, tokenValido, type ClienteServicio } from '@/lib/bot-servidor'
import { clienteDeSoloLectura } from '@/lib/bot-solo-lectura'
import { esGrupo, permisoDeConsulta, type ConsultaBot } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { fechaLocal, sumarDias } from '@/lib/fechas'
import { medianocheMXaISO } from '@/lib/date-format'
import { fetchTodasLasFilas, type ConsultaPaginable } from '@/lib/paginacion'
import { pieDeConsulta } from '@/lib/bot-consultas'
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
  detalle_ticket: 'ventas'
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
  p: Exclude<Pregunta, { tipo: 'ninguna' }>,
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
  const [{ data: detalles }, { data: entidades }] = await Promise.all([
    supabase.from('ticket_detalles').select('cantidad, precio_unitario, subtotal_linea, id_producto').eq('id_ticket', t.id),
    supabase.from('entidades').select('id, nombre').in('id', [t.id_vendedor, t.id_comprador].filter((x): x is string => Boolean(x)))
  ])
  const idsProd = [...new Set((detalles ?? []).map((d) => d.id_producto).filter((x): x is string => Boolean(x)))]
  const { data: productos } = idsProd.length
    ? await supabase.from('catalogo_productos').select('id, nombre').in('id', idsProd)
    : { data: [] as { id: string; nombre: string }[] }
  const nombreEnt = new Map((entidades ?? []).map((e) => [e.id, String(e.nombre ?? '')]))
  const nombreProd = new Map((productos ?? []).map((x) => [x.id, String(x.nombre ?? '')]))
  return (
    textoTicket(
      {
        ...t,
        vendedor: nombreEnt.get(t.id_vendedor ?? '') || '—',
        comprador: nombreEnt.get(t.id_comprador ?? '') || 'Publico en General'
      },
      (detalles ?? []).map((d) => ({
        cantidad: d.cantidad,
        precio_unitario: d.precio_unitario,
        subtotal_linea: d.subtotal_linea,
        producto: nombreProd.get(d.id_producto ?? '') || '(producto)'
      }))
    ) + pieDeConsulta('transacciones_tickets + ticket_detalles')
  )
}

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as { telegram_id?: unknown; chat_id?: unknown; texto?: unknown }
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

    const pregunta = interpretarPregunta(texto, cuentas, fechaLocal(new Date()))
    if (pregunta.tipo === 'ninguna') {
      return NextResponse.json({ ok: true, reconocida: false, motivo: pregunta.motivo, texto: textoDeNinguna(pregunta), privado: false })
    }

    const permiso = permisoDeConsulta(actor, CONSULTA_DE_PREGUNTA[pregunta.tipo])
    // Hoy todas estas son cifra de la empresa: solo quien ve TODO. Un alcance
    // acotado (DST/LOC) no se intenta filtrar aqui; se niega entero.
    if (!permiso.ok || permiso.alcance !== 'todo') {
      return NextResponse.json({ error: NO_TE_TOCA }, { status: 403 })
    }
    const privado = permiso.privado && esGrupo(cuerpo.chat_id, telegramId)
    const respuesta = await contestar(supabase, pregunta, cuentas, identidad.idEntidad)
    return NextResponse.json({ ok: true, reconocida: true, tipo: pregunta.tipo, texto: respuesta, privado })
  } catch (e) {
    console.error('[bot] pregunta reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
