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
import { leerCartera } from '@/lib/vistas'
import {
  buscarDeudor,
  mensajeDeConfirmacionAbono,
  normalizarAbono,
  sellarAbono,
  sumaCuadra,
  type Deudor
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
      propuesta?: Record<string, unknown>
      /** El nombre que dijo la persona. Solo se usa para BUSCAR, nunca se escribe. */
      deudor?: unknown
      /** Cuando la persona ya eligio con un boton: el uuid, validado contra la lista. */
      id_deudor?: unknown
      id_cuenta?: unknown
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
    if (identidad.rolEntidad !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Registrar cobranza es de la matriz; tu alta no alcanza.' },
        { status: 403 }
      )
    }

    // ── La cuenta de DESTINO: la de la identidad, o una de SU lista cerrada ──
    // Identico a la Fase 1: un id que no este en `identidad.cuentas` no existe
    // para este endpoint, venga de donde venga. Ahi es donde queda fuera la
    // `Cuenta Fresnillo` (FULL_TAX), que `cuentaUsableporElBot` ya filtro.
    const pedida = String(cuerpo.id_cuenta ?? '')
    if (pedida !== '' && !identidad.cuentas.some((c) => c.id === pedida)) {
      return NextResponse.json({ error: 'Esa cuenta no es tuya o esta vetada.' }, { status: 422 })
    }
    const idCuentaDestino = pedida !== '' ? pedida : identidad.idCuenta
    const nombreCuentaDestino =
      identidad.cuentas.find((c) => c.id === idCuentaDestino)?.nombre ?? identidad.nombreCuenta

    // ── El deudor. La lista cerrada es la cartera con saldo, leida al momento ──
    const cartera = await leerCartera(supabase)
    const deudores = cartera.filter((f) => Number(f.deuda) > 0.005).map(aDeudor)
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
        tickets
      },
      new Date()
    )
    if (!normalizada.ok) {
      return NextResponse.json({ error: normalizada.error }, { status: 422 })
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
            avisos: normalizada.avisos
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
      cuentas: identidad.cuentas,
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
      )
    })
  } catch (e) {
    console.error('[bot] proponer abono reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
