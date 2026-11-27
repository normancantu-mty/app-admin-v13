/**
 * AG-02 Fase 2 — COBRANZA. Se propone un abono completo y se SELLA.
 *
 * Entra lo que el LLM extrajo (a quien, cuanto, como, y una nota). Sale un
 * borrador guardado del lado del servidor, con su sello, y el texto que la
 * persona va a leer. **Aqui NO se escribe nada en `finanzas_ledger`.**
 *
 * ─── LO QUE ESTE ENDPOINT DECIDE Y EL MODELO NO ─────────────────────────────
 *   · el `id_entidad` del deudor  — el modelo manda un NOMBRE; se empata contra
 *     la lista cerrada de `v_cartera`, y si hay duda se pregunta con botones.
 *   · las DOS cuentas             — origen es la cuenta propia del deudor,
 *     destino sale de la identidad (`bot_identidades`), nunca de la peticion.
 *   · el reparto por pedido       — FIFO con la misma funcion que la pantalla.
 *   · la `referencia`             — lista cerrada. Es la trampa fiscal de la
 *     fase: esa columna alimenta `v_pasivo_fiscal`.
 *
 * ─── POR QUE SOLO ADMIN ─────────────────────────────────────────────────────
 * Un abono lo cobra la matriz: el movimiento va de la cuenta del deudor a una
 * cuenta ADMIN. Una identidad DST o LOC no tiene ninguna cuenta ADMIN a la que
 * mandar el dinero, y ademas caeria en el camino de `ABONO_PENDIENTE` (aprobacion
 * de un ADMIN), que es una maquinaria de aprobacion que hoy no existe en el bot.
 * **El default es el restrictivo**, igual que `ventas` en la Fase 3: hoy la unica
 * identidad dada de alta es ADMIN, y el dia que se de de alta un distribuidor
 * esto tiene que decidirse ANTES, no descubrirse despues.
 *
 * ─── 2026-11-26 (MAPA n7): A QUE CUENTA ENTRA, CON LA REGLA DE LA WEB ────────
 *   · DST que abona por SU local: entra a la cuenta PROPIA del DST, como en la
 *     web (D8), y no a la de la matriz. Sin aprobacion de la matriz (ABONO_REAL).
 *   · ADMIN que dicta el abono de un local de un DST: se AVISA en la propuesta
 *     ("es local de X; el dinero lo recibiste tu o el?") y se ofrece tambien la
 *     cuenta del DST para escogerla. **No se bloquea** (el ERP avisa, nunca
 *     bloquea).
 *   La decision es `reglaDeCuentasDelAbono` (`lib/abono-cuentas.ts`), la misma
 *   funcion que llama `app/actions/abonos.ts`.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import {
  clienteDeServicio,
  conservaPendientes,
  leerCuentaDelDeudor,
  leerTicketsAbiertos,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { actorDe, alcanceDeCaptura, cuentaDeLaMatrizParaAbono, redDe } from '@/lib/bot-aprobacion'
import { contextoDelCuerpo } from '@/lib/bot-pendiente'
import { leerCartera } from '@/lib/vistas'
import { esAbonoDeDstPorSuLocal, reglaDeCuentasDelAbono } from '@/lib/abono-cuentas'
import { leerCuentasConDueno, leerCuentasUsablesDe, leerDstDelLocal } from '@/lib/bot-abono-destino'
import {
  buscarDeudor,
  mensajeDeConfirmacionAbono,
  normalizarAbono,
  sellarAbono,
  sumaCuadra,
  type Deudor,
  type ReferenciaAbono
} from '@/lib/bot-abonos'

export const dynamic = 'force-dynamic'

/** Cuantos deudores se ofrecen como botones cuando hay que preguntar. */
const TOPE_OPCIONES = 9

function aDeudor(fila: {
  id_entidad: string
  nombre: string
  rol: string
  deuda: number
  dias_sin_abono: number | null
}): Deudor {
  return {
    id_entidad: fila.id_entidad,
    nombre: fila.nombre,
    rol: fila.rol,
    deuda: Number(fila.deuda),
    dias_sin_abono: fila.dias_sin_abono
  }
}

/** Lo que viaja al bot de cada deudor. Una sola forma para las dos respuestas. */
function comoOpciones(lista: readonly Deudor[]) {
  return lista.slice(0, TOPE_OPCIONES).map((d) => ({
    id_entidad: d.id_entidad,
    nombre: d.nombre,
    rol: d.rol,
    deuda: d.deuda
  }))
}

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      /** FASE 9 (D94): el chat donde se hablo; en privado es la persona. */
      chat_id?: unknown
      propuesta?: Record<string, unknown>
      /** El nombre que dijo la persona. Solo se usa para BUSCAR, nunca se escribe. */
      deudor?: unknown
      /** Cuando la persona ya eligio con un boton: el uuid, validado contra la lista. */
      id_deudor?: unknown
      id_cuenta?: unknown
      /** Con que se propuso, para que un reinicio del bot no lo pierda. No se sella. */
      contexto_bot?: unknown
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
    if (permisoDeAccion(actorDe(identidad), 'abono') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['abono'] }, { status: 403 })
    }

    const esDeLaMatriz = identidad.rolEntidad === 'ADMIN'
    const pedida = String(cuerpo.id_cuenta ?? '')

    // ── El deudor. La lista cerrada es la cartera con saldo, leida al momento ──
    const cartera = await leerCartera(supabase)
    // FASE 9 (D96): un DST abona solo en su cuenta o la de sus locales
    // (`app/actions/abonos.ts:127-152`, la misma regla).
    const red = await redDe(supabase, identidad, alcanceDeCaptura(identidad))
    const deudores = cartera
      .filter((f) => Number(f.deuda) > 0.005)
      .map(aDeudor)
      .filter((d) => red === null || red.has(d.id_entidad))
    if (deudores.length === 0) {
      return NextResponse.json(
        { error: 'Hoy nadie debe nada en la cartera. No hay a quien abonarle.' },
        { status: 422 }
      )
    }

    const idPedido = String(cuerpo.id_deudor ?? '')
    let deudor: Deudor | undefined
    if (idPedido !== '') {
      // Vino de un boton. **Se valida contra la lista igual**: el proceso del bot
      // no puede nombrar una entidad que no este en la cartera de este momento.
      deudor = deudores.find((d) => d.id_entidad === idPedido)
      if (!deudor) {
        return NextResponse.json(
          { error: 'Ese ya no aparece en la cartera con saldo. Vuelve a dictarlo.' },
          { status: 422 }
        )
      }
    } else {
      const hallazgo = buscarDeudor(cuerpo.deudor, deudores)
      if (!hallazgo.ok) {
        const dicho = String(cuerpo.deudor ?? '').trim()
        const mensaje =
          hallazgo.motivo === 'ambiguo'
            ? `"${dicho}" me da mas de uno. Cual es?`
            : hallazgo.motivo === 'sin-nombre'
              ? 'No entendi de quien es el abono. Quien te pago?'
              : `No encontre a "${dicho}" entre los que deben. Es alguno de estos?`
        // **No se elige el mas parecido.** Se devuelven las opciones y las
        // resuelve un boton: escribir dinero en la entidad equivocada no se
        // corrige solo, hay que anular la fila y recapturar.
        return NextResponse.json({
          ok: false,
          hay_que_elegir: true,
          motivo: hallazgo.motivo,
          mensaje,
          opciones: comoOpciones(hallazgo.candidatos)
        })
      }
      deudor = hallazgo.deudor
    }

    // ── La cuenta de DESTINO: la de la identidad, o una de SU lista cerrada ──
    // Identico a la Fase 1: un id que no este en la lista cerrada no existe para
    // este endpoint, venga de donde venga. Ahi es donde queda fuera la
    // `Cuenta Fresnillo` (FULL_TAX), que `cuentaUsableporElBot` ya filtro.
    // Se decide DESPUES del deudor (2026-11-26): a que cuenta entra depende de
    // quien paga; un local de un DST le debe a su DST, no a la matriz.
    const dstPorSuLocal = esAbonoDeDstPorSuLocal(identidad.rolEntidad, identidad.idEntidad, deudor.id_entidad)
    /** Las que se ofrecen para escoger. Vacia = no se escoge (la de la matriz para un DST). */
    let cuentasOfrecidas: { id: string; nombre: string }[] = []
    /** Solo para un ADMIN: el DST del que cuelga el local que paga, si lo hay. */
    let dstDelDeudor: { id: string; nombre: string } | null = null
    let cuentasDelDst: { id: string; nombre: string }[] = []
    let idCuentaDestino: string
    let nombreCuentaDestino: string
    if (esDeLaMatriz) {
      dstDelDeudor = await leerDstDelLocal(supabase, deudor.id_entidad)
      const nombreDst = dstDelDeudor?.nombre ?? ''
      if (dstDelDeudor) cuentasDelDst = await leerCuentasUsablesDe(supabase, dstDelDeudor.id)
      const deDst = cuentasDelDst.map((c) => ({ id: c.id, nombre: `${c.nombre} (de ${nombreDst})` }))
      cuentasOfrecidas = [...identidad.cuentas, ...deDst]
      if (pedida !== '' && !cuentasOfrecidas.some((c) => c.id === pedida)) {
        return NextResponse.json({ error: 'Esa cuenta no es tuya o esta vetada.' }, { status: 422 })
      }
      idCuentaDestino = pedida !== '' ? pedida : identidad.idCuenta
      nombreCuentaDestino =
        cuentasOfrecidas.find((c) => c.id === idCuentaDestino)?.nombre ?? identidad.nombreCuenta
    } else if (dstPorSuLocal) {
      // D8, como la web: el abono de SU local entra a la cuenta propia del DST.
      cuentasOfrecidas = identidad.cuentas
      if (cuentasOfrecidas.length === 0) {
        return NextResponse.json(
          {
            error:
              'El abono de tu local entra a tu propia cuenta, y no tengo ninguna tuya que pueda usar. ' +
              'Pidele a Norman que te la de de alta.'
          },
          { status: 422 }
        )
      }
      if (pedida !== '' && !cuentasOfrecidas.some((c) => c.id === pedida)) {
        return NextResponse.json({ error: 'Esa cuenta no es tuya o esta vetada.' }, { status: 422 })
      }
      idCuentaDestino =
        pedida !== ''
          ? pedida
          : cuentasOfrecidas.some((c) => c.id === identidad.idCuenta)
            ? identidad.idCuenta
            : cuentasOfrecidas[0].id
      nombreCuentaDestino = cuentasOfrecidas.find((c) => c.id === idCuentaDestino)?.nombre ?? '(cuenta)'
    } else {
      // FASE 9 (D97): el abono de un DST (de SU deuda) entra a la cuenta de la
      // MATRIZ (la del aprobador) y queda PENDIENTE hasta que Norman lo aprueba.
      const matriz = await cuentaDeLaMatrizParaAbono(supabase)
      if (!matriz) {
        return NextResponse.json({ error: 'No encuentro la cuenta de la matriz. No propongo nada.' }, { status: 500 })
      }
      if (pedida !== '' && pedida !== matriz.id) {
        return NextResponse.json({ error: 'La cuenta de la matriz la escoge Norman al aprobar.' }, { status: 422 })
      }
      idCuentaDestino = matriz.id
      nombreCuentaDestino = matriz.nombre
    }

    const cuentaOrigen = await leerCuentaDelDeudor(supabase, deudor.id_entidad)
    if (!cuentaOrigen.ok) {
      return NextResponse.json(
        { error: `No puedo registrarle el abono a ${deudor.nombre}: ${cuentaOrigen.motivo}.` },
        { status: 422 }
      )
    }
    if (cuentaOrigen.idCuenta === idCuentaDestino) {
      return NextResponse.json(
        { error: 'Origen y destino serian la misma cuenta. No escribo eso.' },
        { status: 422 }
      )
    }

    // ── La regla de cuentas de la WEB, la misma funcion ──────────────────────
    // Decide si el par origen/destino vale, si entra PENDIENTE y con que concepto.
    const duenos = await leerCuentasConDueno(supabase, [cuentaOrigen.idCuenta, idCuentaDestino])
    const origenConDueno = duenos.get(cuentaOrigen.idCuenta)
    const destinoConDueno = duenos.get(idCuentaDestino)
    if (!origenConDueno || !destinoConDueno) {
      return NextResponse.json({ error: 'No se pudo resolver origen/destino.' }, { status: 422 })
    }
    const regla = reglaDeCuentasDelAbono({
      rolCaptura: identidad.rolEntidad,
      idEntidadCaptura: identidad.idEntidad,
      idEntidadDeudor: deudor.id_entidad,
      idDstDelDeudor: dstDelDeudor?.id ?? null,
      origen: origenConDueno,
      destino: destinoConDueno
    })
    if (!regla.ok) {
      return NextResponse.json({ error: regla.error }, { status: 422 })
    }
    if (regla.tipoMovimiento !== 'ABONO_DEUDA') {
      return NextResponse.json({ error: 'Eso seria un cargo, no un abono. No lo escribo por aqui.' }, { status: 422 })
    }

    const tickets = await leerTicketsAbiertos(supabase, deudor.id_entidad)

    const normalizada = normalizarAbono(
      cuerpo.propuesta ?? {},
      {
        deudor,
        idCuentaOrigen: cuentaOrigen.idCuenta,
        nombreCuentaOrigen: cuentaOrigen.nombre,
        idCuentaDestino,
        nombreCuentaDestino,
        etiqueta: identidad.etiqueta,
        tickets,
        // `ABONO_DEUDA` comprobado arriba: el concepto es uno de los dos de la lista.
        referencia: regla.concepto as ReferenciaAbono
      },
      new Date()
    )
    if (!normalizada.ok) {
      return NextResponse.json({ error: normalizada.error }, { status: 422 })
    }

    // ── AVISA, no bloquea: el local que paga es de un distribuidor ───────────
    // MAPA n7 (2026-11-26): un LOC hijo de un DST le debe a su DST. Si el dinero
    // lo recibio el DST y entra a la matriz, baja una deuda que no es de la matriz.
    // Lo sabe Norman, no el sistema: se pregunta y se deja escoger la cuenta.
    if (esDeLaMatriz && dstDelDeudor) {
      const dst = dstDelDeudor.nombre
      if (regla.esLocalASuDst) {
        normalizada.avisos.push(
          `Este local es de ${dst}. El dinero entra a la cuenta de ${dst} ("${nombreCuentaDestino}"), ` +
            'no a la matriz, y baja la deuda del local con su distribuidor.'
        )
      } else {
        const suCuenta =
          cuentasDelDst.length > 0
            ? `Si lo recibio ${dst}, escoge su cuenta ("${cuentasDelDst[0].nombre}") con Cambiar cuenta.`
            : `${dst} no tiene una cuenta que yo pueda usar; si lo recibio el, no lo escribas aqui.`
        normalizada.avisos.push(
          `Este local es de ${dst}; el dinero lo recibiste tu o el? Asi como esta entra a ` +
            `"${nombreCuentaDestino}" (la matriz) y baja la deuda que el local tiene con su distribuidor. ` +
            suCuenta
        )
      }
    }

    // El invariante, comprobado ANTES de guardar el borrador: si el reparto no
    // suma el monto, no hay nada que ensenar.
    if (!sumaCuadra(normalizada.payload)) {
      console.error('[bot] el reparto del abono no cuadra', normalizada.payload)
      return NextResponse.json(
        { error: 'El reparto no cuadra con el monto. No escribo nada.' },
        { status: 500 }
      )
    }

    // ── Un solo borrador PENDIENTE por persona ──────────────────────────────
    // Misma regla que la Fase 1, y **compartida con ella a proposito**: proponer
    // un abono cancela un gasto a medias y al reves. Con dos borradores abiertos
    // de distinto tipo, un "va" seria ambiguo.    // Fase 8 (D79): con `conservar_pendientes` la propuesta se SUMA a las que
    // esperan su boton (varios hechos en un mensaje). Sin el, lo de siempre.
    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = sellarAbono(normalizada.payload)

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: {
          // El discriminador. Sin el, `/gasto/confirmar` tendria que adivinar el
          // tipo por la forma del objeto, y adivinar es justo lo que este
          // sistema no hace con nada que escriba dinero.
          tipo: 'abono',
          abono: normalizada.payload,
          meta: {
            nombre_deudor: deudor.nombre,
            rol_deudor: deudor.rol,
            deuda_antes: deudor.deuda,
            nota_original: normalizada.notaOriginal,
            nombre_cuenta_origen: cuentaOrigen.nombre,
            nombre_cuenta_destino: nombreCuentaDestino,
            desglose: normalizada.desglose,
            avisos: normalizada.avisos,
            contexto_bot: contextoDelCuerpo(cuerpo.contexto_bot, {
              // Un DST no cambia la cuenta de la matriz: lo mismo que se le contesta abajo.
              cuentas: cuentasOfrecidas,
              id_cuenta: idCuentaDestino,
              id_deudor: deudor.id_entidad,
              nombre_deudor: deudor.nombre
            })
          }
        } as unknown as Json
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de abono:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      id_deudor: deudor.id_entidad,
      nombre_deudor: deudor.nombre,
      id_cuenta: idCuentaDestino,
      // Un DST no cambia la cuenta de la matriz; la suya si (abono de su local).
      // Un ADMIN ve tambien la del DST cuando el local que paga es de uno.
      cuentas: cuentasOfrecidas,
      // La cartera viva entera, en la MISMA forma que cuando hay que elegir: el
      // proceso del bot la cachea para dos cosas —darle vocabulario al extractor
      // y poder ofrecer "otro deudor" sin volver a preguntar— y una sola forma
      // evita que el bot tenga dos listas de lo mismo que puedan discrepar.
      opciones: comoOpciones(deudores),
      mensaje: mensajeDeConfirmacionAbono(
        normalizada.payload,
        {
          deudor,
          nombreCuentaOrigen: cuentaOrigen.nombre,
          nombreCuentaDestino,
          desglose: normalizada.desglose
        },
        normalizada.avisos
      ) + (regla.requiereAprobacionAdmin ? '\n\nQueda PENDIENTE: no cuenta hasta que Norman lo apruebe.' : '')
    })
  } catch (e) {
    console.error('[bot] proponer abono reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
