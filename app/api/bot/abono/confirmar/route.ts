/**
 * AG-02 Fase 2 — Se escribe el abono EXACTO que se enseno.
 *
 * ─── LA PROPIEDAD DE SEGURIDAD DE ESTE ARCHIVO ──────────────────────────────
 *
 * Entra `{telegram_id, borrador_id, sello}`. **No entra ninguna fila, ni un
 * monto, ni un uuid de entidad.** El abono que se va a escribir lo busca este
 * endpoint en `bot_borradores`, le vuelve a calcular el hash, y lo compara
 * contra dos cosas: el sello guardado con el borrador y el que manda quien
 * confirma. Si cualquiera de los dos no empata, **no se escribe nada.**
 *
 * Entre el "va" y el `INSERT` no hay por donde meter una llamada al modelo,
 * porque no hay ningun campo que el modelo pudiera mandar.
 *
 * ─── LO QUE ESTE ENDPOINT VUELVE A COMPROBAR, Y POR QUE ─────────────────────
 * Un abono no es una fila: es una por pedido mas una por el sobrante. Entre la
 * propuesta y el "va" pudo entrar OTRO abono contra los mismos pedidos —desde
 * la pantalla, o desde otro chat—. Por eso aqui se releen los saldos y se
 * comprueba que cada aplicacion siga cabiendo. Sin eso, dos capturas seguidas
 * pagarian dos veces el mismo pedido y la cartera quedaria cuadrada en total
 * y mentirosa por pedido.
 */

import { NextResponse } from 'next/server'
import type { Json, TablesInsert } from '@/types/database'
import {
  clienteDeServicio,
  leerTicketsAbiertos,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import {
  abrirPuerta,
  pasarAEspera,
  reclamarAprobacion,
  actorDe,
  alcanceDeCaptura,
  aprobadoresDelBot,
  cuentaDeLaMatrizParaAbono,
  nombreDeEtiqueta,
  redDe
} from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import {
  filasDeAbono,
  referenciaEsInocua,
  REFERENCIAS_ABONO,
  selloAbonoCoincide,
  sumaCuadra,
  type PayloadAbono,
  type RenglonDesglose
} from '@/lib/bot-abonos'
import { aCentavos } from '@/lib/abonos'
import { registrarAviso } from '@/lib/avisos-server'

export const dynamic = 'force-dynamic'

interface BorradorAbono {
  tipo?: string
  abono: PayloadAbono
  meta: {
    nombre_deudor: string
    rol_deudor: string
    deuda_antes: number
    nota_original: string
    nombre_cuenta_origen: string
    nombre_cuenta_destino: string
    desglose: RenglonDesglose[]
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

    const quien = await resolverIdentidad(supabase, telegramId)
    if (!quien) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }
    if (permisoDeAccion(actorDe(quien), 'abono') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['abono'] }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()

    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    // El borrador es de quien lo creo. Sin esto, cualquiera dado de alta podria
    // confirmar la captura de otro con solo tener el id.
    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    // De aqui en adelante, la identidad es la del AUTOR del borrador (D98): con
    // el Aprobar de Norman se escribe la captura de Kevin, con su etiqueta.
    const identidad = puerta.autor

    const guardado = borrador.payload as unknown as BorradorAbono
    // El discriminador, comprobado ANTES de mirar nada mas: un borrador de gasto
    // que llegue aqui se rechaza diciendo la verdad, en vez de fallar por sello
    // roto y cancelarlo de paso.
    if (guardado?.tipo !== 'abono') {
      return NextResponse.json({ error: 'Ese borrador no es un abono.' }, { status: 409 })
    }

    const abono = guardado.abono

    // ── LOS DOS SELLOS ──────────────────────────────────────────────────────
    if (!abono || !selloAbonoCoincide(abono, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para el abono', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloAbonoCoincide(abono, selloRecibido)) {
      return NextResponse.json(
        { error: 'El sello no empata con lo que te ensene. No escribo nada.' },
        { status: 409 }
      )
    }

    // ── La identidad, otra vez contra la fila sellada ────────────────────────
    // Si a alguien le cambiaron la cuenta o la etiqueta despues de proponer, el
    // abono viejo ya no se escribe.
    // FASE 9 (D97): la cuenta destino de un DST es la de la matriz (la del
    // aprobador), releida aqui; la de un ADMIN, de su lista cerrada.
    const esDeLaMatriz = identidad.rolEntidad === 'ADMIN'
    const cuentaMatriz = esDeLaMatriz ? null : await cuentaDeLaMatrizParaAbono(supabase)
    const cuentaValida = esDeLaMatriz
      ? identidad.cuentas.some((c) => c.id === abono.id_cuenta_destino)
      : cuentaMatriz?.id === abono.id_cuenta_destino
    const red = await redDe(supabase, identidad, alcanceDeCaptura(identidad))
    if (
      !cuentaValida ||
      (red !== null && !red.has(abono.id_entidad)) ||
      abono.usuario_creador !== `telegram:${identidad.etiqueta}`
    ) {
      return NextResponse.json(
        { error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' },
        { status: 409 }
      )
    }
    if (abono.id_cuenta_origen === abono.id_cuenta_destino) {
      return NextResponse.json({ error: 'Origen y destino son la misma cuenta.' }, { status: 409 })
    }

    // ── La referencia: la defensa fiscal, comprobada tambien AQUI ────────────
    // Una defensa que solo corre en el camino feliz no es una defensa. El valor
    // esta sellado, asi que esto solo puede fallar si alguien toco la lista
    // cerrada en el codigo — y ese es exactamente el dia en que importa.
    if (
      !(REFERENCIAS_ABONO as readonly string[]).includes(abono.referencia) ||
      !referenciaEsInocua(abono.referencia)
    ) {
      return NextResponse.json(
        { error: 'La referencia de ese abono no esta en la lista cerrada. No escribo nada.' },
        { status: 422 }
      )
    }

    // ── EL INVARIANTE: la suma de las filas es el monto capturado ────────────
    if (!sumaCuadra(abono)) {
      return NextResponse.json(
        { error: 'El reparto no cuadra con el monto. No escribo nada.' },
        { status: 409 }
      )
    }

    // ── Los saldos, RELEIDOS: pudo entrar otro abono mientras tanto ──────────
    if (abono.aplicaciones.length > 0) {
      const tickets = await leerTicketsAbiertos(supabase, abono.id_entidad)
      const saldo = new Map(tickets.map((t) => [t.id_ticket, aCentavos(t.saldo)]))
      for (const aplicacion of abono.aplicaciones) {
        const disponible = saldo.get(aplicacion.id_ticket)
        if (disponible === undefined || aCentavos(aplicacion.monto) > disponible) {
          return NextResponse.json(
            {
              error:
                'Uno de los pedidos ya cambio de saldo desde que te lo ensene (alguien mas ' +
                'abono?). No escribo nada: vuelve a dictarlo para recalcular el reparto.'
            },
            { status: 409 }
          )
        }
      }
    }

    // ── D98: el VA de quien requiere aprobacion NO escribe ──────────────────
    if (puerta.modo === 'esperar') {
      return pasarAEspera(supabase, borradorId, identidad, 'un abono')
    }
    // D106: con dos aprobadores, el primero que aprieta gana; el otro no escribe.
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

    // ── EL INSERT. Un solo INSERT multi-fila: una sentencia, atomica. ────────
    // Es la unica atomicidad disponible en este sistema, y la razon esta en la
    // cabecera de `app/actions/abonos.ts`.
    const filas = filasDeAbono(abono, esDeLaMatriz) as unknown as TablesInsert<'finanzas_ledger'>[]
    const { data: creadas, error } = await supabase
      .from('finanzas_ledger')
      .insert(filas)
      .select('id')

    if (error || !creadas || creadas.length === 0) {
      console.error('[bot] no se pudo escribir el abono:', error)
      return NextResponse.json(
        { error: 'No pude escribirlo. No quedo nada a medias.' },
        { status: 500 }
      )
    }

    await supabase
      .from('bot_borradores')
      .update({
        estado: 'CONFIRMADO',
        id_registro: creadas[0].id,
        resuelto_en: new Date().toISOString()
      })
      .eq('id', borradorId)

    // ── Los avisos van DESPUES de que las filas existen, para poder apuntarles ─
    // El texto original, completo, cuando hubo que desactivarlo fiscalmente. Sin
    // este aviso lo que la persona dijo se perderia y solo quedaria la version
    // raspada.
    if (guardado.meta.nota_original && guardado.meta.nota_original !== abono.nota) {
      await registrarAviso(supabase, {
        tipo: 'W17',
        idEntidad: abono.id_entidad,
        mensaje:
          'La nota del abono traia una frase que el ERP lee como pago de impuesto. Se guardo ' +
          'desactivada para no mover el pasivo fiscal; el texto original esta aqui.',
        tabla: 'finanzas_ledger',
        idRegistro: creadas[0].id,
        datosCapturados: {
          origen: abono.usuario_creador,
          nota_original: guardado.meta.nota_original,
          nota_escrita: abono.nota
        }
      })
    }

    // El sobrante no es un error, pero si algo que alguien tiene que mirar: es
    // dinero cobrado que no cuelga de ningun pedido.
    if (abono.sobrante > 0 && abono.aplicaciones.length > 0) {
      await registrarAviso(supabase, {
        tipo: 'W16',
        idEntidad: abono.id_entidad,
        mensaje:
          `Abono de $${abono.monto.toFixed(2)} capturado por Telegram: $${abono.sobrante.toFixed(2)} ` +
          'quedaron a cuenta porque sobraron despues de cubrir los pedidos abiertos.',
        tabla: 'finanzas_ledger',
        idRegistro: creadas[0].id,
        datosCapturados: {
          origen: abono.usuario_creador,
          monto: abono.monto,
          sobrante: abono.sobrante,
          pedidos_cubiertos: abono.aplicaciones.length
        }
      })
    }

    // ── D97: el abono de un DST espera a Norman, como en la app ─────────────
    // Las filas ya estan escritas como ABONO_PENDIENTE: no cuentan en
    // `v_cartera` ni en `v_saldo_entidad` hasta que se aprueban. Los ids se
    // guardan en `meta` (no esta sellado) para que el boton Aprobar del bot los
    // encuentre despues de un reinicio.
    if (!esDeLaMatriz) {
      await supabase
        .from('bot_borradores')
        .update({
          payload: {
            ...guardado,
            meta: { ...guardado.meta, ids_pendientes: creadas.map((f) => f.id) }
          } as unknown as Json
        })
        .eq('id', borradorId)
      const autorNombre = nombreDeEtiqueta(identidad.etiqueta)
      return NextResponse.json({
        ok: true,
        pendiente_de_aprobacion: true,
        borrador_id: borradorId,
        ids: creadas.map((f) => f.id),
        filas_escritas: creadas.length,
        avisar_a: await aprobadoresDelBot(supabase, identidad),
        mensaje:
          `Listo: registre el abono de $${abono.monto.toFixed(2)}. Queda PENDIENTE hasta que Norman o Kevin lo aprueben.`,
        mensaje_aprobador:
          `${autorNombre} registro un abono de $${abono.monto.toFixed(2)} de ${guardado.meta.nombre_deudor}. ¿Lo apruebo?`
      })
    }

    return NextResponse.json({
      ok: true,
      ids: creadas.map((f) => f.id),
      filas_escritas: creadas.length,
      pedidos_cubiertos: abono.aplicaciones.length,
      sobrante: abono.sobrante
    })
  } catch (e) {
    console.error('[bot] confirmar abono reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
