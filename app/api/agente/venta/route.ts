/**
 * ERP-45 — La puerta del agente de mensajeria (LucIA) al ERP.
 *
 * `{accion: 'venta'}` escribe la venta con `registrarVenta` (el motor del POS),
 * y si trae `envio_cobrado > 0`, el envio cobrado como ingreso ligado a ese ticket.
 * `{accion: 'gasto_envio'}` escribe el costo del envio local o de la guia.
 * Las reglas y el porque viven en `lib/agente-venta.ts`; aqui solo el orden.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio } from '@/lib/bot-servidor'
import { registrarVenta } from '@/lib/venta-servidor'
import {
  CATEGORIA_ENVIO_COBRADO,
  VENDEDOR_AGENTE,
  autorDelPedido,
  cuentaDestinoAgente,
  filaDeGastoEnvio,
  filasDeEnvioCobrado,
  payloadDeVentaAgente,
  tokenAgenteValido,
  validarGastoEnvio,
  validarVenta
} from '@/lib/agente-venta'

export const dynamic = 'force-dynamic'

type Cliente = ReturnType<typeof clienteDeServicio>

/**
 * El envio cobrado de ESA venta, una sola vez. Se llama tanto con ticket nuevo
 * como con ticket que ya existia: si la venta entro y el envio no (fallo entre
 * las dos escrituras), el reintento lo completa sin duplicar nada.
 */
async function asegurarEnvioCobrado(
  supabase: Cliente,
  args: { pedidoId: number; envioCobrado: number; idTicket: string; idCuenta: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(args.envioCobrado > 0)) return { ok: true }

  const { data: previo, error: errorPrevio } = await supabase
    .from('finanzas_ledger')
    .select('id')
    .eq('id_ticket', args.idTicket)
    .eq('categoria', CATEGORIA_ENVIO_COBRADO)
    .eq('status', 'ACTIVO')
    .order('fecha_movimiento', { ascending: true })
    .limit(1)
  if (errorPrevio) return { ok: false, error: 'No pude revisar si ya estaba el envio cobrado.' }
  if (previo && previo.length > 0) return { ok: true }

  const { data: cuenta, error: errorCuenta } = await supabase
    .from('cuentas_financieras')
    .select('tipo_fiscalidad')
    .eq('id', args.idCuenta)
    .single()
  const tipo = String(cuenta?.tipo_fiscalidad ?? '').toUpperCase()
  if (errorCuenta || (tipo !== 'FULL_TAX' && tipo !== 'IVA_ONLY' && tipo !== 'LIBRE')) {
    return { ok: false, error: 'La cuenta de la venta no tiene tipo_fiscalidad valido; no adivino el impuesto del envio.' }
  }

  // Un solo insert = una sola transaccion: el ingreso y su IVA entran juntos o no entra ninguno.
  const { error } = await supabase
    .from('finanzas_ledger')
    .insert(filasDeEnvioCobrado({ ...args, tipoFiscalidad: tipo }))
  if (error) return { ok: false, error: `No pude escribir el envio cobrado: ${error.message}` }
  return { ok: true }
}

export async function POST(request: Request) {
  if (!tokenAgenteValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  let cuerpo: Record<string, unknown>
  try {
    cuerpo = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'El cuerpo no es JSON.' }, { status: 400 })
  }

  try {
    if (cuerpo.accion === 'venta') {
      const v = validarVenta(cuerpo)
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
      const cuenta = cuentaDestinoAgente(v.valor.metodoPago)
      if (!cuenta.ok) return NextResponse.json({ error: cuenta.error }, { status: 422 })

      const autor = autorDelPedido(v.valor.pedidoId)
      const supabase = clienteDeServicio(request)

      // Segundo piso de idempotencia: si este pedido ya tiene ticket vivo, es el mismo.
      const { data: previo, error: errorPrevio } = await supabase
        .from('transacciones_tickets')
        .select('id, total_cobrado_real, id_cuenta_destino')
        .eq('usuario_creador', autor)
        .eq('status', 'ACTIVO')
        .order('fecha_transaccion', { ascending: true })
        .limit(1)
      if (errorPrevio) {
        return NextResponse.json({ error: 'No pude revisar si ya existia la venta. No escribi nada.' }, { status: 502 })
      }
      if (previo && previo.length > 0) {
        const envio = await asegurarEnvioCobrado(supabase, {
          pedidoId: v.valor.pedidoId,
          envioCobrado: v.valor.envioCobrado,
          idTicket: previo[0].id,
          idCuenta: previo[0].id_cuenta_destino ?? cuenta.valor
        })
        if (!envio.ok) {
          return NextResponse.json({ error: `La venta ya estaba (ticket ${previo[0].id}) pero el envio cobrado no entro: ${envio.error} Reintentar lo completa sin duplicar.` }, { status: 502 })
        }
        return NextResponse.json({ ok: true, ticket_id: previo[0].id, total: previo[0].total_cobrado_real, envio_cobrado: v.valor.envioCobrado, ya_existia: true })
      }

      const resultado = await registrarVenta(
        supabase,
        { email: autor, idEntidad: VENDEDOR_AGENTE, rol: 'ADMIN' },
        payloadDeVentaAgente(v.valor, cuenta.valor)
      )
      if (!resultado.ok || !resultado.ticketId) {
        return NextResponse.json({ error: resultado.error ?? 'No pude escribir la venta.' }, { status: 422 })
      }
      const envio = await asegurarEnvioCobrado(supabase, {
        pedidoId: v.valor.pedidoId,
        envioCobrado: v.valor.envioCobrado,
        idTicket: resultado.ticketId,
        idCuenta: cuenta.valor
      })
      if (!envio.ok) {
        // La venta SI entro. Se contesta error para que el cerebro no la de por registrada:
        // su reintento cae en "ya existia" y completa el envio.
        return NextResponse.json({ error: `La venta entro (ticket ${resultado.ticketId}) pero el envio cobrado no: ${envio.error} Reintentar lo completa sin duplicar.` }, { status: 502 })
      }
      return NextResponse.json({ ok: true, ticket_id: resultado.ticketId, total: v.valor.total, envio_cobrado: v.valor.envioCobrado, ya_existia: false })
    }

    if (cuerpo.accion === 'gasto_envio') {
      const g = validarGastoEnvio(cuerpo)
      if (!g.ok) return NextResponse.json({ error: g.error }, { status: 400 })
      const autor = autorDelPedido(g.valor.pedidoId)
      const supabase = clienteDeServicio(request)

      const { data: previo, error: errorPrevio } = await supabase
        .from('finanzas_ledger')
        .select('id, monto')
        .eq('usuario_creador', autor)
        .eq('categoria', 'Logistica_Envios')
        .eq('status', 'ACTIVO')
        .order('fecha_movimiento', { ascending: true })
        .limit(1)
      if (errorPrevio) {
        return NextResponse.json({ error: 'No pude revisar si ya existia el gasto. No escribi nada.' }, { status: 502 })
      }
      if (previo && previo.length > 0) {
        return NextResponse.json({ ok: true, id_gasto: previo[0].id, monto: previo[0].monto, ya_existia: true })
      }

      const { data: fila, error } = await supabase
        .from('finanzas_ledger')
        .insert(filaDeGastoEnvio(g.valor))
        .select('id')
        .single()
      if (error || !fila) {
        return NextResponse.json({ error: `No pude escribir el gasto: ${error?.message ?? 'sin fila'}` }, { status: 422 })
      }
      return NextResponse.json({ ok: true, id_gasto: fila.id, monto: g.valor.monto, ya_existia: false })
    }

    return NextResponse.json({ error: 'accion debe ser venta o gasto_envio.' }, { status: 400 })
  } catch (e) {
    console.error('[agente] venta reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
