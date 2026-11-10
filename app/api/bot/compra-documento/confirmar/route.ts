/**
 * 2026-11-08 — Se escribe la COMPRA DE UN DOCUMENTO exactamente como se enseno.
 *
 * Escrito el 2026-11-08 por el ejecutor del Socio (bot: compra desde foto, multilinea).
 *
 * Entra `{telegram_id, borrador_id, sello, id_cuenta}`. El clic en una cuenta ES
 * la confirmacion: la cuenta tiene que estar en la lista sellada que se ensena
 * como botones y en las cuentas vivas del alta. Todo lo demas (insumos,
 * cantidades, costos con IVA, flete, ids) sale del borrador sellado.
 *
 * La escritura es `escribirCompraDocumento` (`lib/compra-insumos.ts`): el mismo
 * nucleo de la compra de la web, con un insert por tabla y la misma
 * compensacion. El grupo queda ligado por su marca y se anula entero.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { abrirPuerta, actorDe, marcarConfirmado } from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { escribirCompraDocumento } from '@/lib/compra-insumos'
import { selloCompraDocumentoCoincide, type PayloadCompraDocumento } from '@/lib/bot-compra-documento'

export const dynamic = 'force-dynamic'

const MENSAJE_YA_ESTABA = 'Esa compra ya estaba registrada. No la apunte dos veces.'
const MENSAJE_SOLO_DIRECTO = 'Esta compra solo la registra quien la propuso con su propio VA.'

function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
      id_cuenta?: unknown
    }
    const telegramId = Number(cuerpo.telegram_id)
    const borradorId = String(cuerpo.borrador_id ?? '')
    const selloRecibido = String(cuerpo.sello ?? '')
    const idCuenta = String(cuerpo.id_cuenta ?? '')
    if (!Number.isSafeInteger(telegramId) || borradorId === '' || idCuenta === '') {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const quien = await resolverIdentidad(supabase, telegramId)
    if (!quien) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()
    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    const guardado = borrador.payload as unknown as { tipo?: string; compra?: PayloadCompraDocumento }
    const compra = guardado?.compra
    if (guardado?.tipo !== 'compra_documento' || !compra) {
      return NextResponse.json({ error: 'Ese borrador no es una compra de documento.' }, { status: 409 })
    }

    if (borrador.estado === 'CONFIRMADO' && Number(borrador.telegram_id) === telegramId) {
      return NextResponse.json({ ok: true, ya_estaba: true, mensaje: MENSAJE_YA_ESTABA })
    }

    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    if (puerta.modo !== 'directo') {
      return NextResponse.json({ error: MENSAJE_SOLO_DIRECTO }, { status: 403 })
    }

    // ── LOS DOS SELLOS ──────────────────────────────────────────────────────
    if (!selloCompraDocumentoCoincide(compra, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para la compra de documento', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a mandar la foto.' },
        { status: 409 }
      )
    }
    if (!selloCompraDocumentoCoincide(compra, selloRecibido)) {
      return NextResponse.json({ error: 'El sello no empata con lo que te ensene. No escribo nada.' }, { status: 409 })
    }

    // ── Lo que el sello no puede garantizar, RELEIDO ─────────────────────────
    const actor = actorDe(quien)
    if (permisoDeAccion(actor, 'gasto') !== 'si') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['gasto'] }, { status: 403 })
    }
    if (permisoDeAccion(actor, 'entrada_insumo') !== 'si') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['entrada_insumo'] }, { status: 403 })
    }
    if (
      compra.id_entidad !== quien.idEntidad ||
      compra.usuario_creador !== `telegram:${quien.etiqueta}` ||
      !compra.cuentas.includes(idCuenta) ||
      !quien.cuentas.some((c) => c.id === idCuenta)
    ) {
      return NextResponse.json(
        { error: 'Esa cuenta o tu alta cambiaron desde la propuesta. Vuelve a mandar la foto.' },
        { status: 409 }
      )
    }

    // ── LA ESCRITURA: el nucleo de la compra de la web ───────────────────────
    // Ronda 2: una COTIZACION se da por pagada AL CLIC: esa es su fecha (el
    // sello cubre lo que se enseno; la fecha del clic no se puede sellar antes).
    const aEscribir: PayloadCompraDocumento =
      compra.tipo_documento === 'cotizacion' ? { ...compra, fecha_movimiento: new Date().toISOString() } : compra
    const r = await escribirCompraDocumento(supabase, aEscribir, idCuenta)
    if (!r.ok) {
      return NextResponse.json({ error: r.error }, { status: 500 })
    }
    const primera = r.idsFinanzas[0] ?? null
    const avisoMarca = await marcarConfirmado(supabase, borradorId, primera)
    if (r.yaEstaba) {
      return NextResponse.json({ ok: true, ya_estaba: true, id: primera, mensaje: MENSAJE_YA_ESTABA })
    }

    const cuenta = quien.cuentas.find((c) => c.id === idCuenta)?.nombre ?? '(cuenta)'
    const piezas = compra.lineas.map((l) => `- ${l.cantidad} ${l.unidad} ${l.insumo}`)
    const mensaje = [
      `Listo. Registre la compra completa, ${pesos(compra.total)} de ${cuenta}.`,
      `Entraron al almacen (${compra.lineas.length} ${compra.lineas.length === 1 ? 'linea' : 'lineas'}):`,
      ...piezas,
      ...(compra.gastos.length
        ? [`Gasto aparte ligado: ${compra.gastos.map((g) => pesos(g.monto)).join(', ')}.`]
        : []),
      'Si la anulas, se anula todo junto.'
    ].join('\n')

    return NextResponse.json({
      ok: true,
      id: primera,
      ids_finanzas: r.idsFinanzas,
      ids_inventario: r.idsInventario,
      mensaje,
      ...(avisoMarca ? { aviso_marca: avisoMarca } : {})
    })
  } catch (e) {
    console.error('[bot] confirmar compra de documento reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
