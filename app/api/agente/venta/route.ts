/**
 * ERP-45 — La puerta del agente de mensajeria (LucIA) al ERP.
 *
 * `{accion: 'venta'}` escribe la venta con `registrarVenta` (el motor del POS).
 * `{accion: 'gasto_envio'}` escribe el costo del envio local o de la guia.
 * Las reglas y el porque viven en `lib/agente-venta.ts`; aqui solo el orden.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio } from '@/lib/bot-servidor'
import { registrarVenta } from '@/lib/venta-servidor'
import {
  VENDEDOR_AGENTE,
  autorDelPedido,
  cuentaDestinoAgente,
  filaDeGastoEnvio,
  payloadDeVentaAgente,
  tokenAgenteValido,
  validarGastoEnvio,
  validarVenta
} from '@/lib/agente-venta'

export const dynamic = 'force-dynamic'

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
        .select('id, total_cobrado_real')
        .eq('usuario_creador', autor)
        .eq('status', 'ACTIVO')
        .order('fecha_transaccion', { ascending: true })
        .limit(1)
      if (errorPrevio) {
        return NextResponse.json({ error: 'No pude revisar si ya existia la venta. No escribi nada.' }, { status: 502 })
      }
      if (previo && previo.length > 0) {
        return NextResponse.json({ ok: true, ticket_id: previo[0].id, total: previo[0].total_cobrado_real, ya_existia: true })
      }

      const resultado = await registrarVenta(
        supabase,
        { email: autor, idEntidad: VENDEDOR_AGENTE, rol: 'ADMIN' },
        payloadDeVentaAgente(v.valor, cuenta.valor)
      )
      if (!resultado.ok || !resultado.ticketId) {
        return NextResponse.json({ error: resultado.error ?? 'No pude escribir la venta.' }, { status: 422 })
      }
      return NextResponse.json({ ok: true, ticket_id: resultado.ticketId, total: v.valor.total, ya_existia: false })
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
