import { randomUUID } from 'node:crypto'
import type { TablesInsert } from '@/types/database'
import type { ClienteServicio, IdentidadBot } from '@/lib/bot-servidor'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import { sellar, selloEmpata } from '@/lib/bot-sello'
import { fechaParaPersona, instanteDeFechaDictada } from '@/lib/fechas'
import { CATEGORIA_TRASPASO, marcaDeTraspaso } from '@/lib/traspaso-pareja'

/**
 * 2026-11-05 — TRASPASO ENTRE CUENTAS PROPIAS DESDE EL BOT.
 *
 * "Transferencia de la cuenta de Gilberto a la Spin $25,000 pesos." No es gasto
 * ni abono: no entra ni sale dinero de la empresa, solo cambia de cuenta. Mismo
 * molde que el gasto: `proponer` sella un borrador, el VA lo confirma.
 *
 * ─── EL PERMISO, Y POR QUE NO ES `permisoDeAccion` ──────────────────────────
 * Solo Norman, por su `telegram_id`. El equivalente web es un ADMIN con sesion y
 * en el bot no hay accion "traspaso": `gasto` alcanza al TRABAJADOR, y esta
 * propuesta le enseñaria el saldo de dos cuentas. Abrirlo es decision de Norman.
 *
 * ─── EL DOBLE CLIC ──────────────────────────────────────────────────────────
 * `reclamarAprobacion` solo actua en modo `aprobar`, asi que en `directo` no hay
 * reclamo que frene dos VA a la vez. Aqui lo frena la llave primaria: los dos ids
 * nacen al PROPONER y van sellados. El segundo INSERT choca (23505) y, como es un
 * solo statement, no escribe ninguna de las dos.
 */

export const MENSAJE_SOLO_NORMAN = 'Los traspasos entre cuentas, por ahora, solo los registra Norman.'
export const MENSAJE_SIN_SALDO = 'No pude leer los saldos de esas cuentas. No propongo a ciegas: intenta otra vez.'

/** `numeric(14,2)` aguanta mas; esto es para cazar un monto mal oido, no la columna. */
const MONTO_MAXIMO = 100_000_000

export interface FilaTraspaso {
  id_egreso: string
  id_ingreso: string
  marca: string
  id_cuenta_origen: string
  id_cuenta_destino: string
  monto: number
  concepto: string
  fecha_movimiento: string
  usuario_creador: string
}

export interface MetaTraspaso {
  nombre_origen: string
  nombre_destino: string
}

export interface PayloadTraspaso {
  tipo: 'traspaso'
  fila: FilaTraspaso
  meta: MetaTraspaso
}

const LLAVES_TRASPASO = [
  'id_egreso',
  'id_ingreso',
  'marca',
  'id_cuenta_origen',
  'id_cuenta_destino',
  'monto',
  'concepto',
  'fecha_movimiento',
  'usuario_creador'
] as const

export function sellarTraspaso(fila: FilaTraspaso): string {
  return sellar(fila, LLAVES_TRASPASO)
}

export function selloTraspasoCoincide(fila: FilaTraspaso, sello: unknown): boolean {
  return selloEmpata(fila, LLAVES_TRASPASO, sello)
}

export function puedeTraspasar(
  identidad: Pick<IdentidadBot, 'telegramId' | 'rolEntidad' | 'requiereAprobacion'>
): boolean {
  return (
    identidad.telegramId === NORMAN_TELEGRAM_ID &&
    identidad.rolEntidad === 'ADMIN' &&
    !identidad.requiereAprobacion
  )
}

export interface CuentaDeTraspaso {
  id: string
  nombre: string
  solo_egresos: boolean
}

/**
 * La lista cerrada: las cuentas del alta (`identidad.cuentas`, que ya deja fuera
 * lo fiscal y lo de otra entidad), con `solo_egresos` de la BASE. El bot trae su
 * propia copia de ese dato en Python; aqui no se le cree.
 */
export async function leerCuentasDeTraspaso(
  supabase: ClienteServicio,
  identidad: Pick<IdentidadBot, 'cuentas'>
): Promise<CuentaDeTraspaso[] | null> {
  const ids = identidad.cuentas.map((c) => c.id)
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre, solo_egresos')
    .in('id', ids)
  if (error || !data) return null
  return data.map((c) => ({ id: c.id, nombre: String(c.nombre ?? ''), solo_egresos: Boolean(c.solo_egresos) }))
}

/** El saldo oficial (`public.saldo_cuenta`). `null` si no se pudo leer. */
export async function leerSaldo(supabase: ClienteServicio, idCuenta: string): Promise<number | null> {
  const { data, error } = await supabase.rpc('saldo_cuenta', { p_id_cuenta: idCuenta })
  if (error || data === null || data === undefined) return null
  const saldo = Number(data)
  return Number.isFinite(saldo) ? saldo : null
}

export interface PropuestaTraspaso {
  monto?: unknown
  origen_id?: unknown
  destino_id?: unknown
  concepto?: unknown
  fecha?: unknown
}

export type TraspasoNormalizado =
  | { ok: true; fila: FilaTraspaso; meta: MetaTraspaso; avisos: string[] }
  | { ok: false; error: string }

function listaDeNombres(cuentas: readonly CuentaDeTraspaso[]): string {
  return cuentas.map((c) => c.nombre).join(', ')
}

function redondear(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Lo que dijo la persona, contra la lista cerrada. **Pura salvo el reloj y los
 * uuid.** Nunca completa una cuenta: lo que no empata por id se devuelve como
 * pregunta o rechazo.
 */
export function normalizarTraspaso(
  propuesta: PropuestaTraspaso,
  cuentas: readonly CuentaDeTraspaso[],
  etiqueta: string,
  ahora: Date = new Date()
): TraspasoNormalizado {
  const monto = redondear(Number(propuesta.monto))
  if (!Number.isFinite(monto) || monto <= 0) {
    return { ok: false, error: 'El monto del traspaso tiene que ser mayor a cero. De cuanto fue?' }
  }
  if (monto > MONTO_MAXIMO) {
    return { ok: false, error: 'Ese monto se ve fuera de escala. Dimelo otra vez.' }
  }

  const idOrigen = String(propuesta.origen_id ?? '').trim()
  const idDestino = String(propuesta.destino_id ?? '').trim()
  const origen = cuentas.find((c) => c.id === idOrigen)
  const destino = cuentas.find((c) => c.id === idDestino)
  if (!idOrigen) return { ok: false, error: `De cual cuenta sale? Tengo: ${listaDeNombres(cuentas)}.` }
  if (!idDestino) return { ok: false, error: `A cual cuenta entra? Tengo: ${listaDeNombres(cuentas)}.` }
  if (!origen || !destino) {
    return {
      ok: false,
      error:
        `Esa cuenta no la puedo mover desde aqui. Las que tengo: ${listaDeNombres(cuentas)}. ` +
        'Otra cuenta o entidad va por la web.'
    }
  }
  if (origen.id === destino.id) {
    return { ok: false, error: `El origen y el destino son la misma cuenta (${origen.nombre}). De cual a cual?` }
  }
  if (destino.solo_egresos) {
    return {
      ok: false,
      error: `${destino.nombre} solo registra salidas: no puede recibir un traspaso. A cual otra cuenta entra?`
    }
  }

  const avisos: string[] = []
  const dictada = instanteDeFechaDictada(propuesta.fecha, ahora)
  if (dictada?.futura) avisos.push('La fecha que entendi es futura; la anclo a hoy.')
  const dicho = typeof propuesta.concepto === 'string' ? propuesta.concepto.trim().slice(0, 120) : ''

  return {
    ok: true,
    fila: {
      id_egreso: randomUUID(),
      id_ingreso: randomUUID(),
      marca: marcaDeTraspaso(randomUUID()),
      id_cuenta_origen: origen.id,
      id_cuenta_destino: destino.id,
      monto,
      concepto: dicho || `Traspaso de ${origen.nombre} a ${destino.nombre}`,
      fecha_movimiento: (dictada?.instante ?? ahora).toISOString(),
      usuario_creador: `telegram:${etiqueta}`
    },
    meta: { nombre_origen: origen.nombre, nombre_destino: destino.nombre },
    avisos
  }
}

/**
 * Las dos filas, con la forma que `saldo_cuenta` espera (la de
 * `app/api/finanzas/nuevo/route.ts`): la cuenta afectada va en
 * `id_cuenta_destino` en las dos y `id_cuenta_origen` se queda vacio.
 */
export function filasDeTraspaso(fila: FilaTraspaso): TablesInsert<'finanzas_ledger'>[] {
  const comun = {
    categoria: CATEGORIA_TRASPASO,
    subcategoria: fila.marca,
    categoria_gasto: fila.concepto,
    descripcion: fila.concepto,
    monto: fila.monto,
    fecha_movimiento: fila.fecha_movimiento,
    usuario_creador: fila.usuario_creador,
    status: 'ACTIVO'
  }
  return [
    { ...comun, id: fila.id_egreso, tipo_movimiento: 'EGRESO_TRASPASO', id_cuenta_destino: fila.id_cuenta_origen },
    { ...comun, id: fila.id_ingreso, tipo_movimiento: 'INGRESO_TRASPASO', id_cuenta_destino: fila.id_cuenta_destino }
  ]
}

export function pesos(n: number): string {
  const texto = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? '-' : ''}$${texto}`
}

export interface SaldosDelTraspaso {
  origen: number
  destino: number
}

export function saldosDespues(saldos: SaldosDelTraspaso, monto: number): SaldosDelTraspaso {
  return { origen: redondear(saldos.origen - monto), destino: redondear(saldos.destino + monto) }
}

/**
 * "Transferencias" lleva la cuenta de lo pendiente de convertir, y un traspaso a mano
 * se salta la conversion. Salir no lo descuenta; entrar lo SUBE sin dinero nuevo:
 * `v_transferencias_resumen` cuenta INGRESO_TRASPASO como recibida. Se avisa, no se frena.
 */
function avisosDeConversion(nombreOrigen: string, nombreDestino: string): string[] {
  const avisos: string[] = []
  if (/transferencias/i.test(nombreOrigen)) {
    avisos.push('OJO: esto NO es una conversion de transferencias: no descuenta lo pendiente de convertir ni cobra comision.')
  }
  if (/transferencias/i.test(nombreDestino)) {
    avisos.push('OJO: Transferencias lo va a contar como recibido: sube lo pendiente de convertir sin que haya entrado dinero nuevo.')
  }
  return avisos
}

export function mensajeDeTraspaso(
  fila: FilaTraspaso,
  meta: MetaTraspaso,
  saldos: SaldosDelTraspaso,
  avisos: readonly string[] = []
): string {
  const despues = saldosDespues(saldos, fila.monto)
  const partes = [
    'Esto es lo que voy a escribir. Revisalo:',
    '',
    'TRASPASO ENTRE CUENTAS',
    `MONTO:      ${pesos(fila.monto)}`,
    `DE:         ${meta.nombre_origen}`,
    `A:          ${meta.nombre_destino}`,
    `FECHA:      ${fechaParaPersona(fila.fecha_movimiento)}`,
    '',
    `${meta.nombre_origen}: ${pesos(saldos.origen)} -> ${pesos(despues.origen)}`,
    `${meta.nombre_destino}: ${pesos(saldos.destino)} -> ${pesos(despues.destino)}`
  ]
  if (despues.origen < 0) {
    partes.push(
      '',
      `OJO: ${meta.nombre_origen} queda en NEGATIVO (${pesos(despues.origen)}). ` +
        'Tu decides: VA lo escribe asi, Cancelar no escribe nada.'
    )
  }
  for (const aviso of [...avisos, ...avisosDeConversion(meta.nombre_origen, meta.nombre_destino)]) {
    partes.push('', aviso)
  }
  partes.push('', 'No es gasto ni ingreso: solo cambia de cuenta.', '', 'Contesta VA para escribirlo, o dime que cambio.')
  return partes.join('\n')
}

export function mensajeFinalDeTraspaso(fila: FilaTraspaso, meta: MetaTraspaso, saldos: SaldosDelTraspaso | null): string {
  const base = `Listo. Pasó ${pesos(fila.monto)} de ${meta.nombre_origen} a ${meta.nombre_destino}.`
  if (!saldos) return `${base} No pude releer los saldos: revisalos en el tablero.`
  return `${base} Saldos: ${meta.nombre_origen} ${pesos(saldos.origen)}, ${meta.nombre_destino} ${pesos(saldos.destino)}.`
}
