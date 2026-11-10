/**
 * 2026-11-07 — LA COMPRA DE INSUMO DEL BOT, LADO DEL SERVIDOR.
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web).
 *
 * Dos piezas: leer el catalogo de insumos para proponer, y confirmar un
 * borrador `compra_insumo`. La escritura NO vive aqui: es
 * `escribirCompraInsumos` (`lib/compra-insumos.ts`), la MISMA funcion que llama
 * la pantalla de compra. Aqui solo va lo que es del bot: los dos sellos, la
 * identidad contra la fila sellada, la puerta de aprobacion y la marca.
 *
 * Sin `'use server'` a proposito (ver `lib/bot-servidor.ts`).
 */

import { NextResponse } from 'next/server'
import type { ClienteServicio, IdentidadBot } from '@/lib/bot-servidor'
import { liberarReclamo, marcarConfirmado, pasarAEspera, reclamarAprobacion, actorDe, type ModoPuerta } from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { escribirCompraInsumos } from '@/lib/compra-insumos'
import { selloCompraCoincide, type InsumoDeCompra, type PayloadCompra } from '@/lib/bot-compra'
import { registrarAviso } from '@/lib/avisos-server'

/**
 * Los insumos del catalogo. Si la lectura falla devuelve `[]`: la propuesta
 * sigue siendo el gasto de siempre, nunca se pierde la captura por esto.
 */
export async function leerInsumosDeCompra(supabase: ClienteServicio): Promise<InsumoDeCompra[]> {
  const { data, error } = await supabase
    .from('catalogo_productos')
    .select('id, nombre, unidad_medida')
    .eq('tipo', 'INSUMO')
    .order('nombre', { ascending: true })
  if (error) {
    console.error('[bot] no pude leer los insumos para la compra:', error)
    return []
  }
  return (data ?? []).map((f) => ({ id: f.id, nombre: String(f.nombre ?? ''), unidad_medida: f.unidad_medida ?? null }))
}

export interface BorradorCompra {
  tipo: 'compra_insumo'
  compra: PayloadCompra
  meta: {
    id_entidad: string
    id_cuenta?: string
    descripcion_original: string
    insumo: string
  }
}

/**
 * Confirma un borrador `compra_insumo`. La ruta ya resolvio quien aprieta y
 * abrio la puerta (`identidad` es la del AUTOR, D98).
 */
export async function confirmarCompraDeBorrador(
  supabase: ClienteServicio,
  args: {
    borradorId: string
    selloGuardado: string
    selloRecibido: string
    guardado: BorradorCompra
    identidad: IdentidadBot
    modo: ModoPuerta
  }
): Promise<NextResponse> {
  const { borradorId, selloGuardado, selloRecibido, guardado, identidad, modo } = args
  const compra = guardado?.compra

  // ── LOS DOS SELLOS (igual que el gasto) ─────────────────────────────────
  if (!compra || !selloCompraCoincide(compra, selloGuardado)) {
    await supabase
      .from('bot_borradores')
      .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
      .eq('id', borradorId)
    console.error('[bot] SELLO ROTO en la base para la compra', borradorId)
    return NextResponse.json(
      { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
      { status: 409 }
    )
  }
  if (!selloCompraCoincide(compra, selloRecibido)) {
    return NextResponse.json({ error: 'El sello no empata con lo que te ensene. No escribo nada.' }, { status: 409 })
  }

  // La compra mete material al almacen: ademas del gasto, pide el permiso de
  // entrada de insumo (el trabajador lo tiene; quien no, no compra por aqui).
  if (permisoDeAccion(actorDe(identidad), 'entrada_insumo') === 'no') {
    return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['entrada_insumo'] }, { status: 403 })
  }

  // La identidad contra la fila sellada: si le cambiaron la entidad, la cuenta
  // o la etiqueta despues de proponer, la compra vieja ya no se escribe.
  if (
    compra.id_entidad !== identidad.idEntidad ||
    compra.usuario_creador !== `telegram:${identidad.etiqueta}` ||
    !identidad.cuentas.some((c) => c.id === compra.id_cuenta_origen)
  ) {
    return NextResponse.json({ error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' }, { status: 409 })
  }

  if (modo === 'esperar') {
    return pasarAEspera(supabase, borradorId, identidad, 'una compra de insumo')
  }
  const reclamo = await reclamarAprobacion(supabase, borradorId, modo)
  if (reclamo) return reclamo

  // ── LA ESCRITURA: la MISMA funcion que la pantalla de compra ─────────────
  const resultado = await escribirCompraInsumos(supabase, {
    idInsumo: compra.id_insumo,
    cantidad: compra.cantidad,
    costoTotal: compra.costo_total,
    idCuentaOrigen: compra.id_cuenta_origen,
    idEntidad: compra.id_entidad,
    usuarioCreador: compra.usuario_creador,
    categoria: compra.categoria,
    subcategoria: compra.subcategoria,
    descripcion: compra.descripcion,
    fechaMovimiento: compra.fecha_movimiento,
    notas: compra.notas
  })
  if (!resultado.ok) {
    await liberarReclamo(supabase, borradorId, modo)
    return NextResponse.json({ error: resultado.error }, { status: 500 })
  }

  const avisoMarca = await marcarConfirmado(supabase, borradorId, resultado.idFinanzas ?? resultado.idInventario)

  if (guardado.meta?.descripcion_original && guardado.meta.descripcion_original !== compra.descripcion) {
    await registrarAviso(supabase, {
      tipo: 'W14',
      idEntidad: compra.id_entidad,
      mensaje:
        'El concepto traia una frase que el ERP lee como pago de impuesto. Se guardo ' +
        'desactivada para no mover el pasivo fiscal; el texto original esta aqui.',
      tabla: 'finanzas_ledger',
      idRegistro: resultado.idFinanzas ?? undefined,
      datosCapturados: {
        origen: compra.usuario_creador,
        descripcion_original: guardado.meta.descripcion_original,
        descripcion_escrita: compra.descripcion
      }
    })
  }

  return NextResponse.json({
    ok: true,
    id: resultado.idFinanzas ?? resultado.idInventario,
    id_inventario: resultado.idInventario,
    categoria_creada: null,
    compra: { insumo: resultado.insumo, cantidad: compra.cantidad },
    ...(avisoMarca ? { aviso_marca: avisoMarca } : {})
  })
}
