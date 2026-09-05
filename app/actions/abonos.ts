'use server'

/**
 * Registro de abonos / transferencias manuales.
 *
 * Sustituye al INSERT que el formulario `distribuidores/[id]/abono` hacia
 * directo a PostgREST desde el navegador, cuyo unico control era un `alert()`.
 *
 * DECISION DE DISENO [DOC02 - YAGNI] - por que NO hay tabla de aplicaciones.
 * `finanzas_ledger.id_ticket` es una sola columna: un movimiento cuelga de UN
 * ticket. Cuando un abono cubre varios pedidos, aqui se escribe UNA FILA POR
 * TICKET (mismo metodo de pago, misma fecha, misma nota, monto repartido) en un
 * UNICO INSERT multi-fila, que Postgres ejecuta como una sola sentencia y por
 * lo tanto es atomico - el resto del sistema no tiene ninguna transaccion, asi
 * que esta es la unica atomicidad disponible.
 * La alternativa correcta a largo plazo seria una tabla `abono_aplicaciones`
 * (N:M entre movimiento y ticket). Hoy no hace falta: nada la leeria, y obliga
 * a un segundo INSERT no atomico. Si algun dia hace falta re-aplicar un abono
 * DESPUES de guardarlo, ese es el momento de crearla, no antes.
 *
 * INVARIANTE QUE NO SE PUEDE ROMPER: la suma de los montos de las filas escritas
 * es exactamente igual al monto capturado. `lib/distribuidores-saldos.ts` suma
 * los ABONO_DEUDA por `id_entidad_relacionada` sin mirar `id_ticket`, asi que
 * partir un abono en varias filas NO mueve ningun saldo - mientras la suma
 * cuadre. Por eso todo el reparto se hace en centavos enteros.
 */

import { revalidatePath } from 'next/cache'
import type { TablesInsert } from '@/types/database'
import {
  getServerSupabaseClient,
  resolverSesionOperador,
  type ClienteServidor,
  type SesionOperador
} from '@/lib/server-session'
import { registrarAviso } from '@/lib/avisos-server'
import { resolverCuentaOrigenPorDefecto, type CuentaCandidata } from '@/lib/avisos'
import { CATEGORIA_ABONO_PENDIENTE, CATEGORIA_ABONO_REAL } from '@/lib/finance-utils'
import {
  aCentavos,
  aPesos,
  esMetodoPagoValido,
  repartirAbonoFifo,
  type TicketPendienteCentavos
} from '@/lib/abonos'

type FinanzaInsert = TablesInsert<'finanzas_ledger'>

/** Zacatecas es UTC-6 todo el anio. Un input `date` no trae hora ni zona. */
const OFFSET_MX = '-06:00'
const MS_OFFSET_MX = 6 * 60 * 60 * 1000

export interface PropuestaTicketAbono {
  id_ticket: string
  fecha_transaccion: string | null
  total_cobrado_real: number
  ya_aplicado: number
  saldo: number
  /** Lo que el FIFO propone aplicar a este ticket. Editable en el formulario. */
  propuesto: number
}

export interface PropuestaAbono {
  tickets: PropuestaTicketAbono[]
  /** Dinero que no alcanzo a cubrir ningun pedido: queda "a cuenta", sin ticket. */
  sobrante: number
  deudaPendienteTickets: number
}

export interface PropuestaAbonoResult {
  success: boolean
  data?: PropuestaAbono
  error?: string
}

export interface AplicacionAbonoInput {
  id_ticket: string
  monto: number
}

export interface RegistrarAbonoPayload {
  idEntidad: string
  idCuentaOrigen: string
  idCuentaDestino: string
  monto: number
  /** 'YYYY-MM-DD'. No se aceptan fechas futuras. */
  fechaPago: string
  metodoPago: string | null
  /** Texto libre -> columna `descripcion`. */
  nota: string
  /** Etiqueta corta -> columna `categoria_gasto` (comportamiento historico). */
  referencia: string
  aplicaciones: AplicacionAbonoInput[]
}

export interface RegistrarAbonoResult {
  success: boolean
  error?: string
  requiereAprobacionAdmin?: boolean
  filasEscritas?: number
}

/**
 * Un ADMIN abona contra cualquier entidad. Cualquier otro rol queda acotado a
 * `mis_entidades()` - la MISMA funcion que usa la politica `finanzas_ins_dst`,
 * para que el chequeo de la app y el de RLS no puedan divergir.
 */
async function autorizarEntidadObjetivo(
  supabase: ClienteServidor,
  sesion: SesionOperador,
  idEntidad: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (sesion.rol === 'ADMIN') return { ok: true }

  if (sesion.rol !== 'DST') {
    return {
      ok: false,
      error: `Tu rol (${sesion.rol}) no tiene permiso para registrar movimientos financieros.`
    }
  }

  const { data, error } = await supabase.rpc('mis_entidades')
  if (error) {
    return { ok: false, error: `No se pudo verificar tu alcance: ${error.message}` }
  }

  const permitidas = new Set((data ?? []).map((valor) => String(valor)))
  if (!permitidas.has(idEntidad)) {
    return { ok: false, error: 'No autorizado: solo puedes abonar en tu cuenta o la de tus locales.' }
  }

  return { ok: true }
}

/** Fecha de hoy (YYYY-MM-DD) leida en hora de Zacatecas, no en UTC. */
function hoyEnMexico(): string {
  return new Date(Date.now() - MS_OFFSET_MX).toISOString().slice(0, 10)
}

/**
 * Convierte la fecha capturada en el timestamptz que va al ledger.
 * - Hoy   -> el instante real de captura (identico al `now()` de siempre).
 * - Atras -> mediodia de Zacatecas, para que la fila se lea en el dia correcto
 *   tanto en UTC como en UTC-6.
 */
function resolverFechaMovimiento(fechaPago: string): {
  valor: string
  aviso: { tipo: 'W10' | 'W11'; mensaje: string; capturado: string } | null
} {
  const fecha = String(fechaPago || '').trim()

  // -- W10 y W11 . ERP-59 ---------------------------------------------------
  // Hasta el 2026-09-05 los tres caminos de abajo devolvian `{ ok: false }` y
  // el abono se perdia entero. **Un pago mal fechado sigue siendo un pago**: el
  // dinero se movio. La fecha es la etiqueta, y una etiqueta que falta se
  // rellena con un default honesto y se grita en la cola.
  //
  // Nada de esto parte un asiento en dos: el abono se escribe COMPLETO, con
  // todas sus filas y su monto. Lo unico que cambia es de que dia se cuelga.
  const formatoValido = /^\d{4}-\d{2}-\d{2}$/.test(fecha)
  const hoy = hoyEnMexico()

  if (!formatoValido) {
    return {
      valor: new Date().toISOString(),
      aviso: {
        tipo: 'W10',
        mensaje: `Fecha de pago ilegible ("${fecha || '<vacia>'}"). El abono entro con la fecha de hoy.`,
        capturado: fecha
      }
    }
  }

  if (fecha > hoy) {
    // Se ancla a HOY y no se guarda en el futuro a proposito: una fila con
    // fecha futura desaparece de todo filtro "hasta hoy" -- seria un pago que
    // existe y no se ve en ninguna pantalla, que es peor que uno mal fechado.
    return {
      valor: new Date().toISOString(),
      aviso: {
        tipo: 'W11',
        mensaje: `Fecha de pago futura (${fecha}). El abono se anclo a hoy (${hoy}).`,
        capturado: fecha
      }
    }
  }

  if (fecha === hoy) {
    return { valor: new Date().toISOString(), aviso: null }
  }

  const anclada = new Date(`${fecha}T12:00:00${OFFSET_MX}`)
  if (Number.isNaN(anclada.getTime())) {
    return {
      valor: new Date().toISOString(),
      aviso: {
        tipo: 'W10',
        mensaje: `Fecha de pago no valida ("${fecha}"). El abono entro con la fecha de hoy.`,
        capturado: fecha
      }
    }
  }

  return { valor: anclada.toISOString(), aviso: null }
}

/**
 * Tickets CONCESION vivos de la entidad con saldo > 0, del mas antiguo al mas
 * nuevo. Saldo = `total_cobrado_real` menos lo ya aplicado a ese ticket.
 *
 * "Ya aplicado" cuenta los ABONO_DEUDA no anulados, INCLUIDOS los pendientes de
 * aprobacion: un abono pendiente ya reclamo ese pedido, y si no se contara, dos
 * capturas seguidas propondrian pagar dos veces el mismo ticket.
 */
async function cargarTicketsPendientes(
  supabase: ClienteServidor,
  idEntidad: string
): Promise<{ ok: true; tickets: PropuestaTicketAbono[] } | { ok: false; error: string }> {
  const { data: ticketsRaw, error: ticketsError } = await supabase
    .from('transacciones_tickets')
    .select('id, fecha_transaccion, total_cobrado_real, condicion_pago, status')
    .eq('id_comprador', idEntidad)
    .eq('condicion_pago', 'CONCESION')
    .in('status', ['ACTIVO', 'APPROVED'])
    .order('fecha_transaccion', { ascending: true })

  if (ticketsError) {
    return { ok: false, error: `No se pudieron leer los pedidos: ${ticketsError.message}` }
  }

  const tickets = ticketsRaw ?? []
  if (!tickets.length) {
    return { ok: true, tickets: [] }
  }

  const ids = tickets.map((ticket) => ticket.id)
  const { data: aplicadosRaw, error: aplicadosError } = await supabase
    .from('finanzas_ledger')
    .select('id_ticket, monto, status, tipo_movimiento')
    .in('id_ticket', ids)
    .eq('tipo_movimiento', 'ABONO_DEUDA')
    .in('status', ['ACTIVO', 'APPROVED'])

  if (aplicadosError) {
    return { ok: false, error: `No se pudo leer lo ya aplicado: ${aplicadosError.message}` }
  }

  const aplicadoPorTicket = new Map<string, number>()
  for (const fila of aplicadosRaw ?? []) {
    if (!fila.id_ticket) continue
    aplicadoPorTicket.set(
      fila.id_ticket,
      (aplicadoPorTicket.get(fila.id_ticket) ?? 0) + aCentavos(Number(fila.monto) || 0)
    )
  }

  const pendientes: PropuestaTicketAbono[] = []
  for (const ticket of tickets) {
    const totalCentavos = aCentavos(Number(ticket.total_cobrado_real) || 0)
    const aplicadoCentavos = aplicadoPorTicket.get(ticket.id) ?? 0
    const saldoCentavos = totalCentavos - aplicadoCentavos
    if (saldoCentavos <= 0) continue

    pendientes.push({
      id_ticket: ticket.id,
      fecha_transaccion: ticket.fecha_transaccion,
      total_cobrado_real: aPesos(totalCentavos),
      ya_aplicado: aPesos(aplicadoCentavos),
      saldo: aPesos(saldoCentavos),
      propuesto: 0
    })
  }

  return { ok: true, tickets: pendientes }
}

/**
 * Propuesta FIFO: se muestra en el formulario y es EDITABLE antes de guardar.
 * Nunca se guarda nada sin que el usuario la vea.
 */
export async function getPropuestaAbonoAction(
  idEntidad: string,
  monto: number
): Promise<PropuestaAbonoResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesion = await resolverSesionOperador(supabase)
    if (!sesion.ok) return { success: false, error: sesion.error }

    const entidadId = String(idEntidad || '').trim()
    if (!entidadId) return { success: false, error: 'Falta la entidad.' }

    const permiso = await autorizarEntidadObjetivo(supabase, sesion.sesion, entidadId)
    if (!permiso.ok) return { success: false, error: permiso.error }

    const pendientes = await cargarTicketsPendientes(supabase, entidadId)
    if (!pendientes.ok) return { success: false, error: pendientes.error }

    const deudaPendienteCentavos = pendientes.tickets.reduce(
      (suma, ticket) => suma + aCentavos(ticket.saldo),
      0
    )

    const montoNum = Number(monto)
    const montoCentavos = Number.isFinite(montoNum) && montoNum > 0 ? aCentavos(montoNum) : 0

    const candidatos: TicketPendienteCentavos[] = pendientes.tickets.map((ticket) => ({
      id_ticket: ticket.id_ticket,
      saldo_centavos: aCentavos(ticket.saldo)
    }))

    const { aplicaciones, sobranteCentavos } = repartirAbonoFifo(candidatos, montoCentavos)
    const propuestoPorTicket = new Map(aplicaciones.map((a) => [a.id_ticket, a.centavos]))

    return {
      success: true,
      data: {
        tickets: pendientes.tickets.map((ticket) => ({
          ...ticket,
          propuesto: aPesos(propuestoPorTicket.get(ticket.id_ticket) ?? 0)
        })),
        sobrante: aPesos(sobranteCentavos),
        deudaPendienteTickets: aPesos(deudaPendienteCentavos)
      }
    }
  } catch (error) {
    console.error('Error calculando propuesta de abono:', error)
    return { success: false, error: 'No se pudo calcular la propuesta de aplicacion.' }
  }
}

export async function registrarAbonoAction(
  payload: RegistrarAbonoPayload
): Promise<RegistrarAbonoResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesionResult = await resolverSesionOperador(supabase)
    if (!sesionResult.ok) return { success: false, error: sesionResult.error }
    const sesion = sesionResult.sesion

    const idEntidad = String(payload?.idEntidad || '').trim()
    const idCuentaOrigen = String(payload?.idCuentaOrigen || '').trim()
    const idCuentaDestino = String(payload?.idCuentaDestino || '').trim()

    // -- W13 . ERP-59 ---------------------------------------------------------
    // Hasta el 2026-09-05 este `if` era uno solo para los tres campos:
    //
    //     if (!idEntidad || !idCuentaOrigen || !idCuentaDestino) return ...
    //
    // Se parte en tres porque **solo el origen se ablanda**. Sin entidad, el
    // abono es una deuda que nadie baja; sin destino, no hay a donde mandar el
    // dinero. Los dos siguen bloqueando.
    if (!idEntidad) {
      return { success: false, error: 'Completa la entidad del movimiento.' }
    }
    if (!idCuentaDestino) {
      return { success: false, error: 'Completa la cuenta de destino.' }
    }

    const permiso = await autorizarEntidadObjetivo(supabase, sesion, idEntidad)
    if (!permiso.ok) return { success: false, error: permiso.error }

    // El default: la cuenta de la PROPIA entidad del expediente. Los tres vetos
    // (nunca ADMIN, nunca FULL_TAX, nunca "fresnillo") viven en
    // `resolverCuentaOrigenPorDefecto` y estan probados en `tests/avisos.spec.ts`.
    // Si ninguna cuenta sobrevive a los vetos NO hay default: se rechaza. Mejor
    // un rechazo que un asiento en la cuenta equivocada -- ahi es donde el
    // Account_Firewall (regla 1) y el motor de impuesto inverso (regla 2) se
    // rompen en silencio.
    let idCuentaOrigenResuelta = idCuentaOrigen
    let avisoCuentaOrigen: { mensaje: string; capturado: Record<string, unknown> } | null = null

    if (!idCuentaOrigen) {
      const { data: propiasRaw, error: propiasError } = await supabase
        .from('cuentas_financieras')
        .select('id, nombre, id_entidad, tipo_fiscalidad, entidad:entidades!inner(rol)')
        .eq('id_entidad', idEntidad)

      if (propiasError) {
        return { success: false, error: `No se pudieron leer las cuentas: ${propiasError.message}` }
      }

      const candidatas: CuentaCandidata[] = (propiasRaw ?? []).map((fila) => {
        const dueno = Array.isArray(fila.entidad) ? fila.entidad[0] : fila.entidad
        return {
          id: fila.id,
          nombre: String(fila.nombre ?? ''),
          id_entidad: fila.id_entidad,
          rol_entidad: dueno?.rol ? String(dueno.rol).toUpperCase() : null,
          tipo_fiscalidad: fila.tipo_fiscalidad ?? null
        }
      })

      const resolucion = resolverCuentaOrigenPorDefecto(idEntidad, candidatas)
      if (!resolucion.ok) {
        return { success: false, error: `Falta la cuenta de origen. ${resolucion.motivo}` }
      }

      idCuentaOrigenResuelta = resolucion.idCuenta
      const elegida = candidatas.find((cuenta) => cuenta.id === resolucion.idCuenta)
      avisoCuentaOrigen = {
        mensaje:
          'Abono capturado sin cuenta de origen. Entro contra la cuenta propia de ' +
          `la entidad ("${elegida?.nombre ?? resolucion.idCuenta}"), nunca contra una ` +
          'cuenta ADMIN ni contra la cuenta fiscal.',
        capturado: { cuenta_origen_capturada: null, cuenta_usada: resolucion.idCuenta }
      }
    }

    if (idCuentaOrigenResuelta === idCuentaDestino) {
      return { success: false, error: 'Origen y destino deben ser diferentes.' }
    }

    const montoNum = Number(payload?.monto)
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      return { success: false, error: 'El monto debe ser mayor a cero.' }
    }
    const montoCentavos = aCentavos(montoNum)

    const fecha = resolverFechaMovimiento(payload?.fechaPago)

    // -- W12 . ERP-59 ---------------------------------------------------------
    // Antes: `return { success: false, error: 'Metodo de pago no valido...' }`.
    // El metodo de pago es una ETIQUETA -- no mueve un peso ni cambia el monto,
    // el tipo de movimiento o la cuenta. Hoy sale de un `<select>`, pero el bot
    // de Telegram va a mandar texto libre ("transferencia bancaria"), y perder
    // el abono entero por no reconocer la palabra es exactamente el problema
    // que ERP-59 viene a cerrar. El abono entra sin metodo y el texto tal cual
    // se capturo queda guardado en el aviso.
    const metodoPagoRaw = payload?.metodoPago ? String(payload.metodoPago).trim() : ''
    const metodoNoReconocido = Boolean(metodoPagoRaw) && !esMetodoPagoValido(metodoPagoRaw)
    const metodoPago = metodoNoReconocido ? null : metodoPagoRaw || null

    // --- Cuentas: la validacion que antes solo existia en el <select> del navegador.
    const { data: cuentasRaw, error: cuentasError } = await supabase
      .from('cuentas_financieras')
      .select('id, id_entidad, entidad:entidades!inner(id, rol)')
      .in('id', [idCuentaOrigenResuelta, idCuentaDestino])

    if (cuentasError) {
      return { success: false, error: `No se pudieron leer las cuentas: ${cuentasError.message}` }
    }

    interface CuentaResuelta {
      id: string
      id_entidad: string | null
      rol: string | null
    }
    const cuentas = new Map<string, CuentaResuelta>()
    for (const cuenta of cuentasRaw ?? []) {
      const owner = Array.isArray(cuenta.entidad) ? cuenta.entidad[0] : cuenta.entidad
      cuentas.set(cuenta.id, {
        id: cuenta.id,
        id_entidad: cuenta.id_entidad,
        rol: owner?.rol ? String(owner.rol).toUpperCase() : null
      })
    }

    const cuentaOrigen = cuentas.get(idCuentaOrigenResuelta)
    const cuentaDestino = cuentas.get(idCuentaDestino)
    if (!cuentaOrigen || !cuentaDestino) {
      return { success: false, error: 'No se pudo resolver origen/destino.' }
    }

    const origenEsAdmin = cuentaOrigen.rol === 'ADMIN'
    const destinoEsAdmin = cuentaDestino.rol === 'ADMIN'

    // Regla original (`abono/page.tsx:148-154`): solo transferencias cruzadas
    // ADMIN <-> no-ADMIN. No se toca.
    const transferenciaValida =
      (origenEsAdmin && !destinoEsAdmin) || (!origenEsAdmin && destinoEsAdmin)
    if (!transferenciaValida) {
      return {
        success: false,
        error: 'Solo se permiten transferencias cruzadas entre ADMIN y Distribuidor/Local.'
      }
    }

    // La cuenta que no es de ADMIN tiene que ser de la entidad del expediente:
    // es exactamente lo que ofrecia el formulario, ahora verificado en servidor.
    const cuentaNoAdmin = origenEsAdmin ? cuentaDestino : cuentaOrigen
    if (cuentaNoAdmin.id_entidad !== idEntidad) {
      return {
        success: false,
        error: 'La cuenta del distribuidor no pertenece a la entidad del movimiento.'
      }
    }

    // Admin -> Dist: CARGO_DEUDA. Dist -> Admin: ABONO_DEUDA. Regla original.
    const tipoMovimiento: 'CARGO_DEUDA' | 'ABONO_DEUDA' =
      origenEsAdmin && !destinoEsAdmin ? 'CARGO_DEUDA' : 'ABONO_DEUDA'

    const requiereAprobacionAdmin =
      sesion.rol !== 'ADMIN' &&
      tipoMovimiento === 'ABONO_DEUDA' &&
      !origenEsAdmin &&
      destinoEsAdmin

    const categoria = requiereAprobacionAdmin
      ? CATEGORIA_ABONO_PENDIENTE
      : tipoMovimiento === 'ABONO_DEUDA'
        ? CATEGORIA_ABONO_REAL
        : null

    const conceptoAutomatico =
      tipoMovimiento === 'CARGO_DEUDA'
        ? 'Cargo de Deuda (Admin -> Distribuidor)'
        : 'Abono de Deuda (Distribuidor -> Admin)'
    const referencia = String(payload?.referencia || '').trim() || conceptoAutomatico
    const nota = String(payload?.nota || '').trim() || null

    // --- Aplicacion a pedidos. Un CARGO_DEUDA no paga pedidos: nunca se reparte.
    const aplicacionesInput =
      tipoMovimiento === 'ABONO_DEUDA' && Array.isArray(payload?.aplicaciones)
        ? payload.aplicaciones
        : []

    const aplicacionesCentavos: { id_ticket: string; centavos: number }[] = []

    if (aplicacionesInput.length) {
      const pendientes = await cargarTicketsPendientes(supabase, idEntidad)
      if (!pendientes.ok) return { success: false, error: pendientes.error }
      const saldoPorTicket = new Map(
        pendientes.tickets.map((ticket) => [ticket.id_ticket, aCentavos(ticket.saldo)])
      )

      const vistos = new Set<string>()
      for (const aplicacion of aplicacionesInput) {
        const idTicket = String(aplicacion?.id_ticket || '').trim()
        const centavos = aCentavos(Number(aplicacion?.monto))

        if (!idTicket) continue
        if (!Number.isFinite(centavos) || centavos <= 0) continue

        if (vistos.has(idTicket)) {
          return { success: false, error: 'Un mismo pedido aparece dos veces en la aplicacion.' }
        }
        vistos.add(idTicket)

        const saldo = saldoPorTicket.get(idTicket)
        if (saldo === undefined) {
          return {
            success: false,
            error: 'Uno de los pedidos ya no tiene saldo pendiente. Vuelve a calcular la propuesta.'
          }
        }
        if (centavos > saldo) {
          return {
            success: false,
            error: `No puedes aplicar mas de $${aPesos(saldo)} a un pedido que ya solo debe eso.`
          }
        }

        aplicacionesCentavos.push({ id_ticket: idTicket, centavos })
      }
    }

    // Lo que no se aplico a ningun pedido va como una fila "a cuenta", sin
    // ticket - el comportamiento historico de las 45 filas que ya existen.
    const sumaAplicada = aplicacionesCentavos.reduce((suma, a) => suma + a.centavos, 0)
    if (sumaAplicada > montoCentavos) {
      return { success: false, error: 'La suma aplicada a pedidos excede el monto del abono.' }
    }
    const sobranteCentavos = montoCentavos - sumaAplicada

    const base: Omit<FinanzaInsert, 'monto' | 'id_ticket'> = {
      tipo_movimiento: tipoMovimiento,
      id_cuenta_origen: idCuentaOrigen,
      id_cuenta_destino: idCuentaDestino,
      id_entidad_relacionada: idEntidad,
      categoria,
      categoria_gasto: referencia,
      descripcion: nota,
      metodo_pago: metodoPago,
      fecha_movimiento: fecha.valor,
      usuario_creador: sesion.email, // de la sesion, NUNCA del cliente
      status: 'ACTIVO'
    }

    const filas: FinanzaInsert[] = aplicacionesCentavos.map((aplicacion) => ({
      ...base,
      monto: aPesos(aplicacion.centavos),
      id_ticket: aplicacion.id_ticket
    }))

    if (sobranteCentavos > 0 || filas.length === 0) {
      filas.push({ ...base, monto: aPesos(sobranteCentavos), id_ticket: null })
    }

    const totalEscrito = filas.reduce((suma, fila) => suma + aCentavos(fila.monto), 0)
    if (totalEscrito !== montoCentavos) {
      return {
        success: false,
        error: 'El reparto no cuadra con el monto capturado. No se registro nada.'
      }
    }

    // Un solo INSERT multi-fila: una sentencia, atomica. Ver cabecera.
    const { data: filasEscritas, error: insertError } = await supabase
      .from('finanzas_ledger')
      .insert(filas)
      .select('id')
    if (insertError) {
      return { success: false, error: `Error al registrar el abono: ${insertError.message}` }
    }

    // ── Los avisos de ERP-59, ya con el abono dentro ──────────────────────────
    // Se registran DESPUES del INSERT y apuntan a la primera fila escrita. Los
    // tres pueden coincidir en un mismo abono (fecha ilegible + metodo raro +
    // sin cuenta de origen): son avisos distintos porque se arreglan por
    // separado, y colapsarlos en uno obligaria a reabrirlo al arreglar el primero.
    const idPrimeraFila = filasEscritas?.[0]?.id

    if (fecha.aviso) {
      await registrarAviso(supabase, {
        tipo: fecha.aviso.tipo,
        idEntidad,
        mensaje: fecha.aviso.mensaje,
        tabla: 'finanzas_ledger',
        idRegistro: idPrimeraFila,
        datosCapturados: { fecha_capturada: fecha.aviso.capturado, fecha_usada: fecha.valor }
      })
    }

    if (metodoNoReconocido) {
      await registrarAviso(supabase, {
        tipo: 'W12',
        idEntidad,
        mensaje:
          `Metodo de pago no reconocido ("${metodoPagoRaw}"). El abono entro sin ` +
          'metodo; el texto capturado quedo guardado aqui.',
        tabla: 'finanzas_ledger',
        idRegistro: idPrimeraFila,
        datosCapturados: { metodo_pago_capturado: metodoPagoRaw }
      })
    }

    if (avisoCuentaOrigen) {
      await registrarAviso(supabase, {
        tipo: 'W13',
        idEntidad,
        mensaje: avisoCuentaOrigen.mensaje,
        tabla: 'finanzas_ledger',
        idRegistro: idPrimeraFila,
        datosCapturados: avisoCuentaOrigen.capturado
      })
    }

    if (fecha.aviso || metodoNoReconocido || avisoCuentaOrigen) {
      revalidatePath('/dashboard/avisos')
    }

    revalidatePath(`/dashboard/distribuidores/${idEntidad}`)
    revalidatePath('/dashboard/distribuidores')
    revalidatePath('/dashboard/finanzas')

    return { success: true, requiereAprobacionAdmin, filasEscritas: filas.length }
  } catch (error) {
    console.error('Error registrando abono:', error)
    return { success: false, error: 'No se pudo registrar el abono.' }
  }
}
