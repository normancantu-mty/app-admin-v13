/**
 * AG-02 Fase 2 — La logica pura de la COBRANZA por Telegram.
 *
 * Mismo principio que la Fase 1: **el LLM propone; de aqui en adelante nadie lo
 * vuelve a generar.** Se normaliza contra listas cerradas, se sella, se ensena,
 * y lo que se escribe es ese objeto exacto. Lo que cambia respecto al gasto es
 * que un abono **no es UNA fila**: es una por pedido cubierto, mas una por el
 * sobrante. Por eso lo sellado es el payload entero y la expansion a filas vive
 * aqui, pura y determinista (`filasDeAbono`).
 *
 * ─── POR QUE ESTE ARCHIVO EXISTE, SI YA HABIA MAQUINARIA DE ABONOS ──────────
 *
 * `app/actions/abonos.ts` lleva `'use server'` y sus dos acciones arrancan con
 * `getServerSupabaseClient()` + `resolverSesionOperador()`, o sea **cookies de
 * sesion de operador**. El bot entra con identidad de servicio (`service_role`)
 * y un `telegram_id`, que no trae correo ni `auth_id`: **no puede llamarlas**.
 * Lo que SI se reusa es todo lo puro — `repartirAbonoFifo`, `aCentavos`,
 * `aPesos`, `esMetodoPagoValido` (`lib/abonos.ts`) — y el criterio de
 * autorizacion se replica en el endpoint, igual que hizo la Fase 1 con el gasto.
 *
 * ─── 🔴 LA TRAMPA FISCAL DE ESTA FASE ───────────────────────────────────────
 *
 * `referencia` escribe en la columna **`categoria_gasto`**, y `v_pasivo_fiscal`
 * arma su texto como `categoria || ' ' || categoria_gasto || ' ' ||
 * descripcion`. O sea que esa columna **alimenta al clasificador fiscal**: un
 * texto con la subcadena equivocada ahi inventa un pago de impuesto que nadie
 * hizo. En la Fase 1 se resolvio con D-169 (`categoria_gasto` siempre null);
 * **aqui no se puede**, porque el comportamiento historico de los abonos usa esa
 * columna. La salida es la LISTA CERRADA de abajo: `referencia` sale del
 * servidor, nunca del modelo, nunca de texto libre, nunca de lo que se dicto.
 *
 * Que el riesgo es real y no teorico lo dice produccion: medido el 2026-09-12,
 * `categoria_gasto` de los `ABONO_DEUDA` ya trae `"abono david"`,
 * `"6  de cada presentacion"` y `"fue transferencia del cliente, es lo mismo"`.
 */

import { fechaParaPersona } from '@/lib/fechas'
import {
  aCentavos,
  aPesos,
  esMetodoPagoValido,
  METODOS_PAGO,
  repartirAbonoFifo,
  type TicketPendienteCentavos
} from '@/lib/abonos'
import { desactivarTextoFiscal, disparadoresFiscalesEn, TOPE_DESCRIPCION } from '@/lib/bot-gastos'
import { buscarPorNombre, normalizarNombre, type FalloNombre } from '@/lib/bot-nombres'
import { canonizar, sellar, selloEmpata } from '@/lib/bot-sello'
import { CATEGORIA_ABONO_REAL } from '@/lib/finance-utils'

// ============================================================================
// 1. LA LISTA CERRADA DE `referencia`
// ============================================================================

/**
 * Las etiquetas que el bot puede escribir en `categoria_gasto`.
 *
 * **Hoy es UNA sola, y eso es una decision, no una lista a medio llenar.** El
 * valor es exactamente el concepto automatico que ya escribe la app
 * (`app/actions/abonos.ts`, `conceptoAutomatico`), para que un abono capturado
 * por Telegram sea indistinguible de uno capturado en la pantalla. Inventar un
 * vocabulario nuevo para una columna que ya esta sucia solo agrega un dialecto
 * mas al desorden.
 *
 * Lo que la lista compra no es variedad: es que **agregar una etiqueta sea un
 * cambio de codigo que pasa por la prueba fiscal** (`referenciaEsInocua`), y no
 * una frase que alguien dicta por voz.
 *
 * ⚠️ Ojo con la flecha: las 27 filas historicas traen `→` (unicode) porque son
 * anteriores al refactor; el codigo de hoy escribe `->` (ASCII). Se usa la del
 * codigo de hoy — la fuente es lo que la app escribe ahora, no lo que escribio
 * en mayo.
 */
export const REFERENCIAS_ABONO = ['Abono de Deuda (Distribuidor -> Admin)'] as const

export type ReferenciaAbono = (typeof REFERENCIAS_ABONO)[number]

export const REFERENCIA_POR_DEFECTO: ReferenciaAbono = REFERENCIAS_ABONO[0]

/** Vacio = la etiqueta no puede mover `v_pasivo_fiscal`. Se prueba sobre la lista entera. */
export function referenciaEsInocua(referencia: string): boolean {
  return disparadoresFiscalesEn(referencia).length === 0
}

/**
 * Empata exacto contra la lista cerrada, y **cae al default en vez de
 * rechazar**. Perder una etiqueta es barato; perder un abono por una palabra es
 * el error que ERP-59 vino a cerrar.
 */
export function normalizarReferencia(sugerida: unknown): ReferenciaAbono {
  const limpia = String(sugerida ?? '').trim()
  const encontrada = REFERENCIAS_ABONO.find((r) => r === limpia)
  return encontrada ?? REFERENCIA_POR_DEFECTO
}

// ============================================================================
// 2. EL METODO DE PAGO — etiqueta, no dinero
// ============================================================================

/**
 * Lo que la gente dice, mapeado al catalogo que acepta el CHECK de la base
 * (`finanzas_ledger_metodo_pago_check`). Duplicado a proposito respecto a
 * `METODOS_PAGO`: aquello es el catalogo, esto es el vocabulario hablado.
 */
const SINONIMOS_METODO: Array<[RegExp, (typeof METODOS_PAGO)[number]]> = [
  [/efectivo|cash|en mano|billete/i, 'EFECTIVO'],
  [/transferenc|transfer|spei|banc/i, 'TRANSFERENCIA'],
  [/deposit/i, 'DEPOSITO'],
  [/cheque/i, 'CHEQUE']
]

/**
 * Devuelve el metodo del catalogo, o `null` con el texto que no se reconocio.
 *
 * **Nunca rechaza.** El metodo de pago es una ETIQUETA: no mueve un peso, ni
 * cambia el monto, ni la cuenta, ni el tipo de movimiento. Es literalmente el
 * razonamiento de W12 en `app/actions/abonos.ts`, y ahi esta escrito que el bot
 * de Telegram iba a mandar texto libre. Aqui llega ese caso.
 */
export function normalizarMetodo(dicho: unknown): { metodo: string | null; noReconocido: string | null } {
  const texto = String(dicho ?? '').trim()
  if (texto === '') return { metodo: null, noReconocido: null }
  if (esMetodoPagoValido(texto.toUpperCase())) return { metodo: texto.toUpperCase(), noReconocido: null }
  for (const [patron, metodo] of SINONIMOS_METODO) {
    if (patron.test(texto)) return { metodo, noReconocido: null }
  }
  return { metodo: null, noReconocido: texto.slice(0, 60) }
}

// ============================================================================
// 3. EL DEUDOR — el modelo dice un NOMBRE, el servidor resuelve el uuid
// ============================================================================

export interface Deudor {
  id_entidad: string
  nombre: string
  rol: string
  deuda: number
  dias_sin_abono: number | null
}

/**
 * minusculas, sin acentos, sin puntuacion, un espacio entre palabras.
 *
 * Se re-exporta desde `lib/bot-nombres.ts`, que es donde vive desde que la Fase
 * 3 necesito el mismo empate para el comprador y para el producto. Sigue
 * exportandose aqui porque quien lo importa no tiene por que enterarse de la
 * mudanza.
 */
export { normalizarNombre }

export type FalloDeudor = FalloNombre

export type ResultadoDeudor =
  | { ok: true; deudor: Deudor }
  | { ok: false; motivo: FalloDeudor; candidatos: Deudor[] }

/**
 * Empata el nombre que dijo la persona contra la lista cerrada de deudores.
 *
 * ─── POR QUE EL MODELO NO ELIGE EL UUID ─────────────────────────────────────
 * Es el mismo patron que la cuenta en la Fase 1 y que el filtro de `stock` en la
 * Fase 3: **el modelo elige QUE, el servidor resuelve COMO**. Un uuid propuesto
 * por un LLM es un dato que nadie puede verificar leyendo la confirmacion.
 *
 * ─── Y POR QUE NO SE ESCOGE "EL MAS PARECIDO" ───────────────────────────────
 * Tres pasadas, de la mas estricta a la mas laxa, y **si una pasada devuelve mas
 * de un candidato se para ahi y se pregunta**. Adivinar entre "Dulceria el Eden"
 * y "Dulceria ruiz" escribe dinero en la cuenta equivocada, y eso no se corrige
 * solo: hay que anular la fila y volver a capturar. Preguntar cuesta un boton.
 *
 * El algoritmo vive en `lib/bot-nombres.ts` desde que la Fase 3 necesito el
 * mismo empate para el comprador de una venta y para el producto del catalogo.
 * Aqui solo queda de que lista se saca el nombre.
 */
export function buscarDeudor(dicho: unknown, deudores: readonly Deudor[]): ResultadoDeudor {
  const hallazgo = buscarPorNombre(dicho, deudores, (d) => [d.nombre])
  return hallazgo.ok
    ? { ok: true, deudor: hallazgo.elegido }
    : { ok: false, motivo: hallazgo.motivo, candidatos: hallazgo.candidatos }
}

// ============================================================================
// 4. EL PAYLOAD Y SU SELLO
// ============================================================================

export interface AplicacionAbono {
  id_ticket: string
  monto: number
}

/**
 * Lo que se sella y lo que se escribe. **No es una fila: es el abono entero.**
 * `aplicaciones` y `sobrante` entran al sello porque mover dinero de un pedido a
 * otro sin cambiar el total tiene que cambiar el hash — si no, el sello
 * vigilaria el monto y no el reparto.
 */
export interface PayloadAbono {
  id_entidad: string
  /** La cuenta PROPIA del deudor. El dinero sale de ahi. */
  id_cuenta_origen: string
  /** La cuenta ADMIN de quien captura. El dinero entra ahi. */
  id_cuenta_destino: string
  monto: number
  fecha_movimiento: string
  metodo_pago: string | null
  /** -> columna `categoria_gasto`. Lista cerrada. Ver la cabecera del archivo. */
  referencia: string
  /** -> columna `descripcion`. Ya desactivada fiscalmente. */
  nota: string
  usuario_creador: string
  aplicaciones: AplicacionAbono[]
  sobrante: number
}

/** El orden es parte del sello. Ver `lib/bot-sello.ts`. */
export const LLAVES_ABONO = [
  'aplicaciones',
  'fecha_movimiento',
  'id_cuenta_destino',
  'id_cuenta_origen',
  'id_entidad',
  'metodo_pago',
  'monto',
  'nota',
  'referencia',
  'sobrante',
  'usuario_creador'
] as const

export function abonoCanonico(payload: PayloadAbono): string {
  return canonizar(payload, LLAVES_ABONO)
}

export function sellarAbono(payload: PayloadAbono): string {
  return sellar(payload, LLAVES_ABONO)
}

export function selloAbonoCoincide(payload: PayloadAbono, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_ABONO, sello)
}

// ============================================================================
// 5. LA EXPANSION A FILAS — pura, determinista, y con su invariante
// ============================================================================

export interface FilaAbono {
  tipo_movimiento: 'ABONO_DEUDA'
  id_cuenta_origen: string
  id_cuenta_destino: string
  id_entidad_relacionada: string
  categoria: string
  categoria_gasto: string
  descripcion: string | null
  metodo_pago: string | null
  fecha_movimiento: string
  usuario_creador: string
  status: 'ACTIVO'
  monto: number
  id_ticket: string | null
}

/**
 * Del payload sellado a las filas exactas del ledger.
 *
 * Copia deliberada de la forma que produce `registrarAbonoAction`: UNA FILA POR
 * TICKET (mismo metodo, misma fecha, misma nota, monto repartido) mas una fila
 * sin ticket para lo que quedo "a cuenta". La razon esta escrita en la cabecera
 * de `app/actions/abonos.ts`: `finanzas_ledger.id_ticket` es una sola columna, y
 * el INSERT multi-fila es la unica atomicidad que tiene este sistema.
 *
 * **EL INVARIANTE QUE NO SE PUEDE ROMPER** (tambien de alla): la suma de los
 * montos escritos es exactamente el monto capturado. Medido el 2026-09-12,
 * `v_cartera` suma los `ABONO_DEUDA` por `id_entidad_relacionada` **sin mirar
 * `id_ticket`**, asi que partir el abono en varias filas no mueve ningun saldo
 * — mientras la suma cuadre. Por eso `sumaCuadra` corre otra vez en el confirmar
 * y no solo aqui: una defensa que solo corre en el camino feliz no es defensa.
 */
export function filasDeAbono(payload: PayloadAbono): FilaAbono[] {
  const base = {
    tipo_movimiento: 'ABONO_DEUDA' as const,
    id_cuenta_origen: payload.id_cuenta_origen,
    id_cuenta_destino: payload.id_cuenta_destino,
    id_entidad_relacionada: payload.id_entidad,
    // Siempre ABONO_REAL y nunca ABONO_PENDIENTE: solo una identidad ADMIN llega
    // hasta aqui (lo veta el endpoint), y para un ADMIN
    // `requiereAprobacionAdmin` es false en la accion original.
    categoria: CATEGORIA_ABONO_REAL,
    categoria_gasto: payload.referencia,
    descripcion: payload.nota || null,
    metodo_pago: payload.metodo_pago,
    fecha_movimiento: payload.fecha_movimiento,
    usuario_creador: payload.usuario_creador,
    status: 'ACTIVO' as const
  }

  const filas: FilaAbono[] = payload.aplicaciones.map((a) => ({
    ...base,
    monto: a.monto,
    id_ticket: a.id_ticket
  }))

  if (payload.sobrante > 0 || filas.length === 0) {
    filas.push({ ...base, monto: payload.sobrante, id_ticket: null })
  }

  return filas
}

/** La suma de las filas, en centavos, es exactamente el monto. Si no, no se escribe nada. */
export function sumaCuadra(payload: PayloadAbono): boolean {
  const escrito = filasDeAbono(payload).reduce((suma, fila) => suma + aCentavos(fila.monto), 0)
  return escrito === aCentavos(payload.monto)
}

// ============================================================================
// 6. LA PUERTA: lo que devuelve el LLM se normaliza aqui y en ningun otro lado
// ============================================================================

export const TOPE_ABONO = 500000
export const TOPE_NOTA = TOPE_DESCRIPCION

export interface TicketAbierto {
  id_ticket: string
  fecha: string | null
  saldo: number
}

export interface RenglonDesglose {
  id_ticket: string
  fecha: string | null
  saldo: number
  aplicado: number
}

export interface ContextoAbono {
  deudor: Deudor
  idCuentaOrigen: string
  nombreCuentaOrigen: string
  idCuentaDestino: string
  nombreCuentaDestino: string
  etiqueta: string
  /** Del mas antiguo al mas nuevo: el FIFO consume en el orden en que llegan. */
  tickets: readonly TicketAbierto[]
}

export interface PropuestaAbonoLLM {
  monto?: unknown
  metodo_pago?: unknown
  nota?: unknown
  fecha?: unknown
}

export interface ResultadoAbonoOk {
  ok: true
  payload: PayloadAbono
  avisos: string[]
  notaOriginal: string
  desglose: RenglonDesglose[]
}

export interface ResultadoAbonoFallido {
  ok: false
  error: string
}

/**
 * Convierte lo que devolvio el modelo en el abono exacto que se va a escribir.
 *
 * **Nada de lo que el LLM manda llega crudo a la base.** El monto se re-parsea,
 * el metodo se empata contra el catalogo, la nota se acota y se desactiva
 * fiscalmente, y los campos que decide el sistema —entidad, las dos cuentas, la
 * referencia, el autor, el status y **el reparto por pedido**— ni siquiera se
 * leen de la propuesta: entran por `contexto`. Es el patron *AI-Gateway*: el
 * modelo elige CUAL y CUANTO, nunca COMO se escribe.
 */
export function normalizarAbono(
  propuesta: PropuestaAbonoLLM,
  contexto: ContextoAbono,
  ahora: Date
): ResultadoAbonoOk | ResultadoAbonoFallido {
  const avisos: string[] = []

  const monto = Number(propuesta.monto)
  if (!Number.isFinite(monto) || monto <= 0) {
    return { ok: false, error: 'No entendi de cuanto fue el abono.' }
  }
  if (monto > TOPE_ABONO) {
    return {
      ok: false,
      error:
        `Un abono de ${monto} pesos por chat no: el tope es ${TOPE_ABONO}. ` +
        'Si es correcto, se captura en la pantalla.'
    }
  }
  // Dos decimales siempre: un monto con mas decimales se sella distinto cada vez
  // que alguien lo re-imprime y el sello dejaria de empatar consigo mismo.
  const montoRedondeado = Math.round(monto * 100) / 100
  const montoCentavos = aCentavos(montoRedondeado)

  // ── El reparto FIFO. Se calcula AQUI, con la funcion de `lib/abonos.ts` que
  //    ya usa la pantalla: dos repartos distintos para el mismo abono serian dos
  //    verdades sobre que pedido quedo pagado.
  const candidatos: TicketPendienteCentavos[] = contexto.tickets
    .filter((t) => aCentavos(t.saldo) > 0)
    .map((t) => ({ id_ticket: t.id_ticket, saldo_centavos: aCentavos(t.saldo) }))

  const { aplicaciones, sobranteCentavos } = repartirAbonoFifo(candidatos, montoCentavos)
  const aplicadoPorTicket = new Map(aplicaciones.map((a) => [a.id_ticket, a.centavos]))

  const desglose: RenglonDesglose[] = contexto.tickets.map((t) => ({
    id_ticket: t.id_ticket,
    fecha: t.fecha,
    saldo: t.saldo,
    aplicado: aPesos(aplicadoPorTicket.get(t.id_ticket) ?? 0)
  }))

  if (sobranteCentavos > 0) {
    avisos.push(
      `Sobran ${aPesos(sobranteCentavos).toFixed(2)} pesos despues de cubrir los pedidos abiertos. ` +
        'Entran "a cuenta", en una fila sin pedido: siguen contando como abono.'
    )
  }
  if (candidatos.length === 0) {
    avisos.push(
      'No tiene pedidos en concesion con saldo, asi que el abono entero entra a cuenta. ' +
        'El saldo de la cartera si baja.'
    )
  }
  if (montoRedondeado > contexto.deudor.deuda + 0.005) {
    avisos.push(
      `Es MAS de lo que debe: la cartera dice ${contexto.deudor.deuda.toFixed(2)} y estas ` +
        `registrando ${montoRedondeado.toFixed(2)}. Le quedaria saldo a favor.`
    )
  }

  // ── La nota. Mismo tratamiento fiscal que la descripcion del gasto: el texto
  //    entra a `descripcion`, que `v_pasivo_fiscal` concatena.
  const notaOriginal = String(propuesta.nota ?? '').trim().slice(0, TOPE_NOTA)
  let nota = notaOriginal
  const disparadores = disparadoresFiscalesEn(notaOriginal)
  if (disparadores.length > 0) {
    nota = desactivarTextoFiscal(notaOriginal)
    avisos.push(
      `Tu nota trae "${disparadores.join('", "')}", que es justo lo que el ERP lee para dar ` +
        `por pagado un impuesto. La guardo como "${nota}" para que no mueva el pasivo fiscal.`
    )
  }

  const { metodo, noReconocido } = normalizarMetodo(propuesta.metodo_pago)
  if (noReconocido) {
    avisos.push(
      `No reconoci "${noReconocido}" como forma de pago, asi que el abono entra sin metodo. ` +
        'El abono SI se registra: el metodo es una etiqueta, no mueve un peso.'
    )
  }

  // La fecha: si el modelo no la resuelve, hoy. Nunca en el futuro — una fila con
  // fecha futura desaparece de todo filtro "hasta hoy" (es el aviso W11 de
  // `app/actions/abonos.ts`, con el mismo razonamiento).
  let fecha = ahora
  const propuestaFecha = String(propuesta.fecha ?? '').trim()
  if (propuestaFecha !== '') {
    const parseada = new Date(propuestaFecha)
    if (!Number.isNaN(parseada.getTime())) {
      fecha = parseada > ahora ? ahora : parseada
      if (parseada > ahora) avisos.push('La fecha que entendi es futura; la anclo a hoy.')
    }
  }

  return {
    ok: true,
    avisos,
    notaOriginal,
    desglose,
    payload: {
      id_entidad: contexto.deudor.id_entidad,
      id_cuenta_origen: contexto.idCuentaOrigen,
      id_cuenta_destino: contexto.idCuentaDestino,
      monto: montoRedondeado,
      fecha_movimiento: fecha.toISOString(),
      metodo_pago: metodo,
      // NUNCA de la propuesta. Ver la cabecera del archivo.
      referencia: REFERENCIA_POR_DEFECTO,
      nota,
      usuario_creador: `telegram:${contexto.etiqueta}`,
      aplicaciones: aplicaciones.map((a) => ({
        id_ticket: a.id_ticket,
        monto: aPesos(a.centavos)
      })),
      sobrante: aPesos(sobranteCentavos)
    }
  }
}

// ============================================================================
// 7. EL MENSAJE DE CONFIRMACION
// ============================================================================

function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function dia(iso: string | null): string {
  if (!iso) return 's/f'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 's/f'
  // D70 (Fase 8): fecha de Mexico, formato unico.
  return fechaParaPersona(iso)
}

/**
 * Lo que lee la persona antes de decir "va".
 *
 * ─── POR QUE ENSENA EL DESGLOSE Y NO SOLO EL TOTAL ──────────────────────────
 * **Automation bias**: una confirmacion que se aprueba reconociendo el patron no
 * es una revision. En el gasto bastaba repetir monto y categoria; aqui el dato
 * que de verdad puede estar mal **no es el monto, es a QUE PEDIDO se aplica** —
 * y eso solo se puede revisar viendolo. Un abono aplicado al pedido equivocado
 * deja la cartera cuadrada en total y mentirosa por pedido.
 *
 * El total tambien se repite en palabras (`queda debiendo`) porque es la cifra
 * con la que se decide a quien se le vuelve a hablar.
 */
export function mensajeDeConfirmacionAbono(
  payload: PayloadAbono,
  contexto: {
    deudor: Deudor
    nombreCuentaOrigen: string
    nombreCuentaDestino: string
    desglose: readonly RenglonDesglose[]
  },
  avisos: readonly string[]
): string {
  const cubiertos = contexto.desglose.filter((r) => r.aplicado > 0)
  const quedaDebiendo = Math.max(0, contexto.deudor.deuda - payload.monto)

  const lineas = [
    'Esto es lo que voy a escribir. Revisalo:',
    '',
    `ABONO DE:   ${contexto.deudor.nombre} (${contexto.deudor.rol})`,
    `MONTO:      ${pesos(payload.monto)}`,
    `FECHA:      ${dia(payload.fecha_movimiento)}`,
    `METODO:     ${payload.metodo_pago ?? '(sin especificar)'}`,
    `CONCEPTO:   ${payload.nota || '(sin nota)'}`,
    '',
    `Debia ${pesos(contexto.deudor.deuda)} y queda debiendo ${pesos(quedaDebiendo)}.`
  ]

  if (cubiertos.length > 0) {
    lineas.push('', 'SE APLICA A ESTOS PEDIDOS (del mas viejo al mas nuevo):')
    for (const r of cubiertos) {
      const cierra = r.aplicado >= r.saldo - 0.005 ? ' — lo salda' : ' — parcial'
      lineas.push(`   ${dia(r.fecha)}  ${pesos(r.aplicado)} de ${pesos(r.saldo)}${cierra}`)
    }
  }
  if (payload.sobrante > 0) {
    lineas.push(`   a cuenta (sin pedido): ${pesos(payload.sobrante)}`)
  }

  lineas.push(
    '',
    `El dinero sale de "${contexto.nombreCuentaOrigen}" y entra a "${contexto.nombreCuentaDestino}".`,
    '(las cuentas no las elige el modelo: salen de tu alta y de la entidad que debe)'
  )

  for (const aviso of avisos) lineas.push('', `OJO: ${aviso}`)

  lineas.push('', 'Contesta VA para escribirlo, o dime que cambio.')
  return lineas.join('\n')
}
