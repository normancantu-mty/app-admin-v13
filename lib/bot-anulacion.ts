/**
 * AG-06 FASE 5 — ANULAR Y CORREGIR POR CHAT. La logica pura.
 *
 * ─── LAS TRES COSAS QUE SE PUEDEN PEDIR, Y POR QUE SON TRES Y NO UNA ────────
 *
 * `anular` .............. la fila pasa a `ANULADO`. Si cuelga de un ticket, se
 *                        va la venta entera (D4) y eso **se dice antes del "va"**
 *                        con el conteo real.
 * `recapturar` .......... lo que Norman llama "corregir": se anula la fila y se
 *                        escribe otra con el cambio, en UN solo "va" (D6). Para
 *                        la persona es editar; para el ledger es lo correcto.
 * `editar_descripcion` .. la UNICA edicion real que existe, y solo de
 *                        `finanzas_ledger.descripcion`.
 *
 * ─── POR QUE "EDITAR" NO ES UN `UPDATE`, SALVO ESE CASO ─────────────────────
 *
 * Barrido del repo: **no existe ninguna edicion de movimientos en ningun lado**,
 * y el patron declarado es *anular y recapturar* (D-E04, escrito literal en
 * `app/api/bot/abono/proponer/route.ts`). Cambiar un monto o una fecha con un
 * `UPDATE` descuadra la cartera, el pasivo fiscal, el corte del mes y hasta la
 * propia ventana de permiso — que se cuenta desde `fecha_movimiento`, o sea que
 * editar la fecha te regala ventana.
 *
 * ─── EL FILTRO FISCAL DE LA DESCRIPCION NO ES OPCIONAL ──────────────────────
 *
 * `v_pasivo_fiscal` **lee el texto** de `descripcion` y `categoria` para decidir
 * si hubo un pago de impuesto. Una descripcion editada sin pasar por
 * `desactivarTextoFiscal` puede inventar un pago de IVA que nadie hizo — y el
 * numero saldria en la pantalla de impuestos sin que exista la fila que lo
 * respalda. Por eso el filtro se aplica aqui, en la propuesta, y el texto que se
 * sella es el YA filtrado: entre el "va" y el UPDATE no hay donde meterlo.
 *
 * ─── Y LA REGLA QUE LA BASE NO VA A APLICAR ─────────────────────────────────
 *
 * El trigger `tg_vigilar_update_no_admin` solo deja que un no-ADMIN cambie
 * `status` — nada de `descripcion`. Con `service_role` ese trigger **se rinde**
 * (`mi_rol()` es NULL). Asi que la misma regla esta escrita aqui, en TypeScript,
 * y es la unica que existe cuando llama el bot: `puedeEditarDescripcion()`.
 */

import { canonizar, sellar, selloEmpata } from '@/lib/bot-sello'
import { desactivarTextoFiscal, TOPE_DESCRIPCION, type PayloadGasto } from '@/lib/bot-gastos'
import { VENTANA_EDICION_HORAS, VENTANA_EDICION_MS } from '@/lib/constants'

// ============================================================================
// 1. EL PAYLOAD Y SU SELLO
// ============================================================================

export type ModoAnulacion = 'anular' | 'recapturar' | 'editar_descripcion'
export type TablaAnulable = 'finanzas' | 'inventario'

export interface PayloadAnulacion {
  modo: ModoAnulacion
  tabla: TablaAnulable
  id_movimiento: string
  /** El ticket que arrastra, si la fila es de una venta. `null` si es suelta. */
  id_ticket: string | null
  usuario_creador: string
  /** Solo en `recapturar`: la fila nueva, ya normalizada por el servidor. */
  recaptura: PayloadGasto | null
  /** Solo en `editar_descripcion`: el texto YA pasado por el filtro fiscal. */
  descripcion_nueva: string | null
}

/**
 * El orden es parte del sello. Ver `lib/bot-sello.ts`.
 *
 * `recaptura` es un objeto ANIDADO, asi que aqui la canonizacion recursiva no es
 * un lujo: `jsonb` reordena las llaves de los objetos anidados al guardarlos, y
 * un sello que solo fijara el nivel de arriba dejaria de empatar al volver de la
 * base. Eso ya paso una vez con el abono (2026-09-12) y el sintoma es cruel — el
 * endpoint concluye "la propuesta cambio", cancela, y nunca se confirma nada.
 */
export const LLAVES_ANULACION = [
  'descripcion_nueva',
  'id_movimiento',
  'id_ticket',
  'modo',
  'recaptura',
  'tabla',
  'usuario_creador'
] as const

export function anulacionCanonica(payload: PayloadAnulacion): string {
  return canonizar(payload, LLAVES_ANULACION)
}

export function sellarAnulacion(payload: PayloadAnulacion): string {
  return sellar(payload, LLAVES_ANULACION)
}

export function selloAnulacionCoincide(payload: PayloadAnulacion, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_ANULACION, sello)
}

// ============================================================================
// 2. QUE MOVIMIENTOS SE LE PUEDEN OFRECER A QUIEN
// ============================================================================

/** Quien pide anular, tal como lo resuelve `bot_identidades`. */
export interface ActorDelBot {
  rol: string
  /** Lo que el bot escribe en `usuario_creador`: `telegram:<etiqueta>`. */
  autor: string
}

export function esAdminDelBot(actor: ActorDelBot): boolean {
  return actor.rol.toUpperCase() === 'ADMIN'
}

/**
 * El filtro con el que se ARMA la lista de botones.
 *
 * ─── POR QUE ESTO EXISTE, Y ES LA MITAD QUE IMPORTA ─────────────────────────
 * La autorizacion de verdad la hace `assertAnnullmentAllowed`
 * (`lib/anulacion-servidor.ts`) en el momento de escribir. Pero si la lista se
 * armara con un criterio MAS ANCHO que esa guarda, el bot ofreceria botones que
 * al pulsarse contestan "no autorizado" o "ventana expirada". **Ese es
 * exactamente el fallo que D-E25 existe para no repetir**: el mismo usuario veia
 * el boton habilitado y recibia el error al pulsarlo.
 *
 * Asi que este filtro reproduce la guarda, campo por campo:
 *   · ADMIN — sin restriccion de autor y sin ventana. Es lo que dice la guarda,
 *     y D3 manda no inventarle al bot una regla distinta de la de la app.
 *   · cualquier otro — solo lo que escribio EL MISMO, y solo dentro de las
 *     12 h de `VENTANA_EDICION_MS`. Importada, no copiada.
 */
export interface FiltroAnulables {
  soloDeAutor: string | null
  desdeISO: string | null
}

export function filtroDeAnulables(actor: ActorDelBot, ahora: Date = new Date()): FiltroAnulables {
  if (esAdminDelBot(actor)) return { soloDeAutor: null, desdeISO: null }
  return {
    soloDeAutor: actor.autor,
    desdeISO: new Date(ahora.getTime() - VENTANA_EDICION_MS).toISOString()
  }
}

/**
 * Cuantos movimientos se ofrecen. **Ocho, y el numero tiene dos razones.**
 *
 * La de bulto: un teclado de Telegram con veinte botones no se lee en un celular
 * y la persona acaba picando el que queda a la mano. La de fondo: esta lista es
 * el unico mecanismo que decide QUE fila se anula (D2), asi que su trabajo es
 * que se distingan entre si, no que esten todas. El que no aparece se busca por
 * la pantalla, que para eso existe.
 */
export const MOVIMIENTOS_OFRECIDOS = 8

// ============================================================================
// 3. COMO SE LE ENSENA CADA MOVIMIENTO
// ============================================================================

export interface MovimientoAnulable {
  tabla: TablaAnulable
  id: string
  fecha: string | null
  /** Lo que se pinta en el boton. Corto: cabe en una linea de celular. */
  etiqueta: string
  /** La linea de la lista, con mas detalle que el boton. */
  detalle: string
  id_ticket: string | null
  /**
   * Lo que la fila dice HOY, para poder corregir UN campo sin volver a llamar
   * al modelo. Es el mismo principio que `_reproponer` en el bot: re-extraer la
   * frase entera le daria al modelo licencia para cambiar campos que nadie
   * toco. Viaja al proceso del bot como memoria, **nunca como autoridad**: la
   * fila que se escribe es la que el servidor normaliza y sella.
   */
  valores: ValoresDeLaFila | null
}

export interface ValoresDeLaFila {
  monto: number
  categoria: string | null
  descripcion: string | null
  fecha: string | null
}

function dia(fecha: string | null): string {
  if (!fecha) return 'sin fecha'
  const d = new Date(fecha)
  if (Number.isNaN(d.getTime())) return 'sin fecha'
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })
}

function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Corta sin partir a la mitad una palabra que despues no se entiende. */
function recortar(texto: string, largo: number): string {
  const limpio = (texto ?? '').trim()
  return limpio.length <= largo ? limpio : limpio.slice(0, largo - 1) + '…'
}

export interface FilaFinanzasAnulable {
  id: string
  fecha_movimiento: string | null
  tipo_movimiento: string | null
  monto: number | null
  categoria: string | null
  descripcion: string | null
  id_ticket: string | null
}

export interface FilaInventarioAnulable {
  id: string
  fecha_movimiento: string | null
  tipo_movimiento: string | null
  cantidad: number | null
  notas: string | null
  producto: string | null
}

export function describirFinanzas(fila: FilaFinanzasAnulable): MovimientoAnulable {
  const monto = Number(fila.monto) || 0
  const que = fila.descripcion || fila.categoria || fila.tipo_movimiento || 'movimiento'
  return {
    tabla: 'finanzas',
    id: fila.id,
    fecha: fila.fecha_movimiento,
    // El MONTO va primero en el boton a proposito: entre dos gastos del mismo
    // dia es lo unico que de verdad los distingue de un vistazo.
    etiqueta: `${dia(fila.fecha_movimiento)} · ${pesos(monto)} · ${recortar(que, 22)}`,
    detalle:
      `${dia(fila.fecha_movimiento)} — ${pesos(monto)} — ${fila.tipo_movimiento ?? ''}` +
      (fila.categoria ? ` (${fila.categoria})` : '') +
      (fila.descripcion ? `: ${recortar(fila.descripcion, 60)}` : '') +
      (fila.id_ticket ? ' — de una VENTA' : ''),
    id_ticket: fila.id_ticket ? String(fila.id_ticket).trim() || null : null,
    valores: {
      monto,
      categoria: fila.categoria,
      descripcion: fila.descripcion,
      fecha: fila.fecha_movimiento
    }
  }
}

export function describirInventario(fila: FilaInventarioAnulable): MovimientoAnulable {
  const cantidad = Number(fila.cantidad) || 0
  const producto = fila.producto || 'producto'
  return {
    tabla: 'inventario',
    id: fila.id,
    fecha: fila.fecha_movimiento,
    etiqueta: `${dia(fila.fecha_movimiento)} · ${cantidad} pz · ${recortar(producto, 20)}`,
    detalle:
      `${dia(fila.fecha_movimiento)} — ${cantidad} pz de ${producto}` +
      (fila.tipo_movimiento ? ` (${fila.tipo_movimiento})` : ''),
    // `inventario_ledger` no tiene columna `id_ticket`: el enlace vive dentro de
    // `notas`. No se deduce aqui — anular una fila de inventario suelta NO
    // arrastra la venta, y decir lo contrario seria mentir en la confirmacion.
    id_ticket: null,
    // Una fila de inventario no se corrige por chat: cambiarle la cantidad
    // reescribe el stock de un producto, y el stock no se guarda como total
    // sino que se replaya desde el ledger entero. Se anula y se recaptura.
    valores: null
  }
}

/** Del mas nuevo al mas viejo, que es como la persona los recuerda. */
export function ordenarAnulables(
  movimientos: readonly MovimientoAnulable[]
): MovimientoAnulable[] {
  return [...movimientos].sort((a, b) => {
    const ta = a.fecha ? Date.parse(a.fecha) : 0
    const tb = b.fecha ? Date.parse(b.fecha) : 0
    return tb - ta
  })
}

/**
 * Que vino a hacer la persona. **No cambia una sola escritura**: lo que se
 * escribe lo decide `modo`, que viaja sellado. Esto solo decide el verbo con el
 * que se le habla.
 *
 * Hace falta porque la lista es la MISMA para los dos caminos, y sin esto
 * `/corregir` contestaba "Cual anulo?" — que es exactamente la palabra que
 * alguien no quiere leer cuando lo que pidio fue arreglar un concepto. Salio en
 * la prueba en vivo del 2026-09-19.
 */
export type AccionDeLista = 'anular' | 'corregir'

export function esAccionDeLista(v: unknown): v is AccionDeLista {
  return v === 'anular' || v === 'corregir'
}

export function textoDeLaLista(
  movimientos: readonly MovimientoAnulable[],
  actor: ActorDelBot,
  accion: AccionDeLista = 'anular'
): string {
  const verbo = accion === 'corregir' ? 'corregir' : 'anular'
  if (movimientos.length === 0) {
    return esAdminDelBot(actor)
      ? `No encuentro movimientos activos que ${verbo}.`
      : `No tienes movimientos tuyos de las ultimas ${VENTANA_EDICION_HORAS} horas. ` +
          'Pasadas esas horas solo los puede anular administracion.'
  }
  const lineas = movimientos.map((m, i) => `${i + 1}. ${m.detalle}`)
  const cabeza = accion === 'corregir' ? 'Cual corrijo?' : 'Cual anulo?'
  return cabeza + '\n\n' + lineas.join('\n')
}

// ============================================================================
// 4. EL AVISO DE CASCADA (D4)
// ============================================================================

export interface AlcanceCascada {
  idTicket: string | null
  filasFinanzas: number
  filasInventario: number
}

/**
 * **El mensaje que D4 exige, con el conteo real.**
 *
 * Anular una fila de finanzas que cuelga de un ticket anula la venta entera:
 * asi funciona hoy y no se cambia. Lo que estaba mal es que nadie lo dijera
 * antes del "va". *"Un usuario que no lo sabe es el modo de fallo."*
 *
 * El conteo se mide contra la base, no se estima: un "N filas" inventado seria
 * peor que no avisar, porque suena a que alguien lo verifico.
 */
export function avisoDeCascada(alcance: AlcanceCascada): string | null {
  if (!alcance.idTicket) return null
  const corto = alcance.idTicket.slice(0, 8)
  return (
    `⚠ Ojo: esa fila es de la venta TCK-${corto}. ` +
    `Anularla anula la venta ENTERA: el ticket, ${alcance.filasFinanzas} fila(s) de dinero ` +
    `y ${alcance.filasInventario} de inventario. El stock se devuelve.`
  )
}

// ============================================================================
// 5. LAS REGLAS QUE LA BASE NO VA A APLICAR
// ============================================================================

export interface JuicioEdicion {
  ok: boolean
  motivo?: string
}

/**
 * **Solo ADMIN edita una descripcion, y solo de una fila suelta.**
 *
 * Es la traduccion literal de la regla 1 del trigger `tg_vigilar_update_no_admin`:
 * para todo rol que no sea ADMIN, un UPDATE **solo** puede cambiar `status`. Con
 * `service_role` ese trigger se rinde, asi que esta funcion es la unica que
 * queda de pie.
 *
 * Y la segunda condicion, que no viene del trigger sino del negocio: una fila
 * con `id_ticket` es el renglon de dinero de una VENTA. Su descripcion la
 * escribio el motor de ventas con el folio dentro; reescribirla a mano rompe la
 * correspondencia entre lo que dice el ledger y lo que dice el comprobante que
 * ya se le mando al cliente. Para eso esta anular y recapturar.
 */
export function puedeEditarDescripcion(
  actor: ActorDelBot,
  fila: { id_ticket: string | null; status: string | null }
): JuicioEdicion {
  if (!esAdminDelBot(actor)) {
    return {
      ok: false,
      motivo: 'eso no se edita desde tu alta: lo anulo y lo recapturamos'
    }
  }
  if (fila.id_ticket) {
    return {
      ok: false,
      motivo:
        'esa fila es de una venta y su concepto lleva el folio dentro. ' +
        'Eso no se edita: se anula la venta y se vuelve a capturar'
    }
  }
  if ((fila.status ?? '') === 'ANULADO') {
    return { ok: false, motivo: 'esa fila ya esta anulada' }
  }
  return { ok: true }
}

export interface DescripcionNormalizada {
  ok: true
  texto: string
  /** El texto tal como se dicto, cuando el filtro fiscal lo cambio. */
  original: string
  avisos: string[]
}

export interface DescripcionFallida {
  ok: false
  error: string
}

/**
 * La descripcion nueva, **pasada obligatoriamente por el filtro fiscal**.
 *
 * `desactivarTextoFiscal` es la misma funcion que usa la captura de un gasto
 * (`lib/bot-gastos.ts`), no una copia: si algun dia se le agrega un disparador,
 * se le agrega a las dos a la vez.
 */
export function normalizarDescripcionNueva(
  dicha: unknown
): DescripcionNormalizada | DescripcionFallida {
  const crudo = String(dicha ?? '').trim()
  if (crudo === '') return { ok: false, error: 'No me dijiste el concepto nuevo.' }
  if (crudo.length > TOPE_DESCRIPCION) {
    return { ok: false, error: `Ese concepto es larguisimo (tope ${TOPE_DESCRIPCION}).` }
  }
  const texto = desactivarTextoFiscal(crudo)
  const avisos: string[] = []
  if (texto !== crudo) {
    avisos.push(
      'El concepto traia una frase que el ERP lee como pago de impuesto. ' +
        'La guardo desactivada para no mover el pasivo fiscal.'
    )
  }
  return { ok: true, texto, original: crudo, avisos }
}

// ============================================================================
// 6. LOS MENSAJES DE CONFIRMACION
// ============================================================================

export function mensajeDeAnulacion(
  movimiento: MovimientoAnulable,
  alcance: AlcanceCascada
): string {
  const partes = ['Voy a ANULAR:', '', movimiento.detalle]
  const aviso = avisoDeCascada(alcance)
  if (aviso) partes.push('', aviso)
  partes.push('', 'Va?')
  return partes.join('\n')
}

/**
 * El antes y el despues, que es lo que D6 pide ensenar.
 *
 * **Las dos filas se ven juntas**, porque "lo anulo y lo vuelvo a escribir" es
 * una frase que suena inofensiva hasta que se ve que la fila nueva lleva la
 * fecha de HOY y no la del movimiento original. Quien lo lee tiene que poder
 * cazar eso antes del "va", no despues.
 */
export function mensajeDeRecaptura(
  movimiento: MovimientoAnulable,
  nueva: PayloadGasto,
  alcance: AlcanceCascada
): string {
  const partes = [
    'Lo anulo y lo vuelvo a escribir con el cambio.',
    '',
    'ANTES:  ' + movimiento.detalle,
    'DESPUES: ' +
      `${pesos(nueva.monto)} — ${nueva.tipo_movimiento}` +
      (nueva.categoria ? ` (${nueva.categoria})` : '') +
      (nueva.descripcion ? `: ${recortar(nueva.descripcion, 60)}` : '') +
      ` — ${String(nueva.fecha_movimiento ?? '').slice(0, 10)}`
  ]
  const aviso = avisoDeCascada(alcance)
  if (aviso) {
    partes.push(
      '',
      aviso,
      'Una venta NO se recaptura como gasto: esto solo lo puedo hacer con filas sueltas.'
    )
  }
  partes.push('', 'Va?')
  return partes.join('\n')
}

export function mensajeDeEdicion(
  movimiento: MovimientoAnulable,
  antes: string | null,
  despues: string,
  avisos: readonly string[]
): string {
  const partes = [
    'Le cambio SOLO el concepto. Ni el monto ni la fecha se mueven.',
    '',
    'ANTES:  ' + (antes?.trim() || '(sin concepto)'),
    'DESPUES: ' + despues,
    '',
    movimiento.detalle
  ]
  if (avisos.length) partes.push('', ...avisos)
  partes.push('', 'Va?')
  return partes.join('\n')
}
