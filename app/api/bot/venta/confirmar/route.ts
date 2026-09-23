/**
 * AG-05 Fase 3 — Se escribe la venta EXACTA que se enseno.
 *
 * ─── LA PROPIEDAD DE SEGURIDAD DE ESTE ARCHIVO ──────────────────────────────
 *
 * Entra `{telegram_id, borrador_id, sello}`. **No entra ninguna fila, ni un
 * precio, ni un uuid de producto.** La venta que se va a escribir la busca este
 * endpoint en `bot_borradores`, le vuelve a calcular el hash, y lo compara
 * contra dos cosas: el sello guardado con el borrador y el que manda quien
 * confirma. Si cualquiera de los dos no empata, **no se escribe nada.**
 *
 * Entre el "va" y el ticket no hay por donde meter una llamada al modelo, porque
 * no hay ningun campo que el modelo pudiera mandar. Es la misma propiedad de las
 * Fases 1 y 2, y aqui vale mas: una venta escribe cuatro tablas.
 *
 * ─── QUIEN ESCRIBE DE VERDAD ────────────────────────────────────────────────
 *
 * `registrarVenta` (`lib/venta-servidor.ts`), **el mismo motor que la pantalla
 * del POS**, con el cliente de servicio y un `OperadorDeVenta` armado desde
 * `bot_identidades`. Este archivo no calcula ni una comision ni un impuesto ni
 * una deduccion de inventario: si lo hiciera, habria dos motores de venta y el
 * dia que uno cambiara, el otro seguiria cobrando con las reglas viejas.
 *
 * Por eso tampoco se relee el stock aqui: la cascada PAGADO -> CONSIGNADO y su
 * freno ante inventario insuficiente viven dentro de `registrarVenta` y corren
 * en el momento de escribir, que es el unico momento en que el dato sirve. Una
 * comprobacion adelantada en este archivo seria una segunda verdad sobre el
 * mismo numero.
 *
 * ─── LO QUE SI SE VUELVE A COMPROBAR AQUI, Y POR QUE ────────────────────────
 * La IDENTIDAD contra la fila sellada. Entre la propuesta y el "va" pudieron
 * cambiarle la cuenta o la etiqueta a quien dicto, o darlo de baja. El sello
 * garantiza que la venta no cambio; no garantiza que quien la propuso siga
 * pudiendo escribirla.
 */

import { NextResponse } from 'next/server'
import {
  clienteDeServicio,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import {
  selloVentaCoincide,
  type DesgloseRenglon,
  type PayloadVenta
} from '@/lib/bot-venta'
import { registrarVenta, type OperadorDeVenta } from '@/lib/venta-servidor'

export const dynamic = 'force-dynamic'

interface BorradorVenta {
  tipo?: string
  venta: PayloadVenta
  meta: {
    nombre_vendedor: string
    nombre_comprador: string
    rol_comprador: string
    zona: string
    nombre_cuenta_destino: string
    desglose: DesgloseRenglon[]
    avisos: string[]
  }
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
    }

    const telegramId = Number(cuerpo.telegram_id)
    const borradorId = String(cuerpo.borrador_id ?? '')
    const selloRecibido = String(cuerpo.sello ?? '')

    if (!Number.isSafeInteger(telegramId) || borradorId === '') {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)

    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }
    if (identidad.rolEntidad !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Capturar ventas por chat es de la matriz; tu alta no alcanza.' },
        { status: 403 }
      )
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado')
      .eq('id', borradorId)
      .maybeSingle()

    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    // El borrador es de quien lo creo. Sin esto, cualquiera dado de alta podria
    // confirmar la captura de otro con solo tener el id.
    if (borrador.telegram_id !== telegramId) {
      return NextResponse.json({ error: 'Ese borrador no es tuyo.' }, { status: 403 })
    }
    if (borrador.estado !== 'PENDIENTE') {
      return NextResponse.json(
        { error: `Ese borrador ya esta ${borrador.estado.toLowerCase()}.` },
        { status: 409 }
      )
    }

    const guardado = borrador.payload as unknown as BorradorVenta
    // ── EL DISCRIMINADOR, ANTES DE MIRAR NADA MAS ───────────────────────────
    // Un borrador de gasto o de abono que llegue a esta ruta se rechaza diciendo
    // la verdad. **Sin esta linea fallaria por sello roto** —el hash de un abono
    // sobre las llaves de una venta nunca empata— y la rama del sello roto
    // CANCELA el borrador: una ruta equivocada del proceso del bot le borraria a
    // la persona una captura buena y le diria ademas que "la propuesta cambio".
    if (guardado?.tipo !== 'venta') {
      return NextResponse.json({ error: 'Ese borrador no es una venta.' }, { status: 409 })
    }

    const venta = guardado.venta

    // ── LOS DOS SELLOS ──────────────────────────────────────────────────────
    if (!venta || !selloVentaCoincide(venta, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para la venta', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloVentaCoincide(venta, selloRecibido)) {
      return NextResponse.json(
        { error: 'El sello no empata con lo que te ensene. No escribo nada.' },
        { status: 409 }
      )
    }

    // ── La identidad, otra vez contra la fila sellada ────────────────────────
    if (
      venta.id_vendedor !== identidad.idEntidad ||
      !identidad.cuentas.some((c) => c.id === venta.id_cuenta_destino) ||
      venta.usuario_creador !== `telegram:${identidad.etiqueta}`
    ) {
      return NextResponse.json(
        { error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' },
        { status: 409 }
      )
    }

    // ── El alcance, comprobado tambien AQUI ─────────────────────────────────
    // Una defensa que solo corre en el camino feliz no es una defensa. El campo
    // ni siquiera existe en `PayloadVenta`, asi que esto solo puede fallar el
    // dia que alguien se lo agregue — y ese es exactamente el dia que importa.
    if (venta.id_comprador === venta.id_vendedor) {
      return NextResponse.json(
        { error: 'El comprador y el vendedor son la misma entidad. No escribo eso.' },
        { status: 409 }
      )
    }
    if (venta.items.length === 0 || !(venta.total_cobrado_real > 0)) {
      return NextResponse.json({ error: 'Esa venta esta vacia. No escribo nada.' }, { status: 409 })
    }

    // ── LA ESCRITURA. Un solo `registrarVenta`, que por dentro es un solo RPC ─
    // `registrar_venta_atomica` (ERP-11): las cuatro tablas en una transaccion
    // de Postgres. Es la unica atomicidad real que existe en este sistema, y es
    // la razon por la que el bot puede escribir una venta sin inventarse un
    // rollback compensatorio como el que ERP-11 elimino.
    const operador: OperadorDeVenta = {
      // Lo que va a quedar en `usuario_creador` de las cuatro tablas. Va sellado
      // desde la propuesta y ya se comprobo arriba contra la etiqueta viva: el
      // rastro dice `telegram:<quien>`, no "sistema".
      email: venta.usuario_creador,
      idEntidad: identidad.idEntidad,
      rol: identidad.rolEntidad
    }

    const resultado = await registrarVenta(supabase, operador, {
      idVendedor: venta.id_vendedor,
      idComprador: venta.id_comprador,
      // **No se manda `origenInventarioId`**: sin el, el motor lo iguala al
      // vendedor. Es la triangulacion rechazada, expresada por omision.
      idCuentaDestino: venta.id_cuenta_destino,
      condicion_pago: venta.condicion_pago,
      subtotalCatalogo: venta.subtotal_catalogo,
      totalCobradoReal: venta.total_cobrado_real,
      // Los tres campos fiscales del payload del POS **el motor los ignora**: los
      // recalcula el mismo con `calculateReverseTaxes` contra la cuenta destino
      // (`lib/venta-servidor.ts`, desglose fiscal). Se mandan en cero para que
      // quede claro que de aqui no sale ningun impuesto; el numero que la persona
      // leyo en la confirmacion salio de esa misma funcion y esa misma cuenta.
      montoBaseIngreso: 0,
      impuestoIvaCalculado: 0,
      impuestoIepsCalculado: 0,
      items: venta.items
    })

    if (!resultado.ok || !resultado.ticketId) {
      // El borrador se queda PENDIENTE a proposito: el motor no dejo nada a
      // medias (el RPC es atomico), asi que la propuesta sigue siendo valida y
      // la persona puede volver a decir "va" cuando se arregle lo que fallo
      // —tipicamente inventario insuficiente, que se resuelve produciendo—.
      return NextResponse.json(
        { error: resultado.error ?? 'No pude escribir la venta.' },
        { status: 422 }
      )
    }

    await supabase
      .from('bot_borradores')
      .update({
        estado: 'CONFIRMADO',
        id_registro: resultado.ticketId,
        resuelto_en: new Date().toISOString()
      })
      .eq('id', borradorId)

    return NextResponse.json({
      ok: true,
      ticket_id: resultado.ticketId,
      total: venta.total_cobrado_real,
      condicion_pago: venta.condicion_pago,
      nombre_comprador: guardado.meta?.nombre_comprador ?? 'Publico en General',
      // FASE 1b: de donde saca el bot el comprobante. **Es una ruta relativa y
      // no una URL publica**: esa ruta exige el mismo `x-bot-token`, asi que el
      // proceso del bot tiene que bajar el PNG el mismo y subirlo a Telegram.
      // Pasarsela a `sendPhoto` como URL no funcionaria — Telegram la pediria
      // sin el header y recibiria un 401.
      ruta_imagen: `/api/documento/${resultado.ticketId}/imagen`
    })
  } catch (e) {
    console.error('[bot] confirmar venta reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
