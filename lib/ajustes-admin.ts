/**
 * Correcciones del ADMIN (ruta escondida `/panel/correcciones`). Escrito el
 * 2026-11-03 por el agente de la ruta admin.
 *
 * PURO: sin red, sin base, sin React. Lo usan el formulario (cliente), la server
 * action (servidor) y `tests/ajustes-admin.spec.ts` (proyecto `puras`).
 *
 * La correccion NO edita filas: escribe un movimiento de ajuste por la
 * diferencia (`nuevo - actual`). Ver la migracion 20261103120000.
 *
 * LA DOBLE CONFIRMACION:
 *   1. `revisar`: el modal muestra actual -> nuevo y la diferencia, con el motivo.
 *   2. `confirmar`: hay que TECLEAR el valor nuevo otra vez; tiene que ser el
 *      mismo numero. El servidor vuelve a comprobar las dos cosas
 *      (`validarSolicitudAjuste`): sin `paso1` y sin el tecleo que casa, no escribe.
 */

/** Decimales que guarda cada ledger: `cantidad numeric(10,4)` y `monto numeric(12,2)`. */
export const DECIMALES_INVENTARIO = 4
export const DECIMALES_SALDO = 2
export const MOTIVO_MINIMO = 5

export type ClaseAjuste = 'inventario' | 'saldo'

export function decimalesDe(clase: ClaseAjuste): number {
  return clase === 'inventario' ? DECIMALES_INVENTARIO : DECIMALES_SALDO
}

export function redondearA(n: number, decimales: number): number {
  const f = 10 ** decimales
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f
}

/**
 * Texto -> numero. Acepta `1234.5`, `1,234.50`, `$ 1,234.50`, `-20`. Rechaza
 * vacio, letras, dos puntos y la coma decimal (`12,5` es ambiguo: no se adivina).
 */
export function leerNumero(texto: string): number | null {
  const limpio = String(texto ?? '').replace(/[\s$]/g, '')
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(limpio)) return null
  const n = Number(limpio.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export interface Diferencia {
  actual: number
  nuevo: number
  diferencia: number
  /** `sube`, `baja` o `igual` */
  sentido: 'sube' | 'baja' | 'igual'
}

export function calcularDiferencia(actual: number, nuevo: number, clase: ClaseAjuste): Diferencia {
  const d = decimalesDe(clase)
  const a = redondearA(actual, d)
  const n = redondearA(nuevo, d)
  const diferencia = redondearA(n - a, d)
  return { actual: a, nuevo: n, diferencia, sentido: diferencia > 0 ? 'sube' : diferencia < 0 ? 'baja' : 'igual' }
}

/** Error del primer paso (o `null` si se puede pasar a la revision). */
export function errorDePaso1(args: {
  clase: ClaseAjuste
  actual: number
  nuevoTexto: string
  motivo: string
}): string | null {
  const nuevo = leerNumero(args.nuevoTexto)
  if (nuevo === null) return 'Escribe un número válido (punto decimal, sin letras).'
  if (args.clase === 'inventario' && nuevo < 0) return 'El stock no puede quedar negativo.'
  if (calcularDiferencia(args.actual, nuevo, args.clase).sentido === 'igual') return 'El valor nuevo es igual al actual: no hay nada que corregir.'
  if (args.motivo.trim().length < MOTIVO_MINIMO) return `El motivo es obligatorio (mínimo ${MOTIVO_MINIMO} caracteres).`
  return null
}

/** ¿El tecleo del segundo paso es EXACTAMENTE el valor nuevo? */
export function confirmacionCasa(tecleado: string, nuevo: number, clase: ClaseAjuste): boolean {
  const n = leerNumero(tecleado)
  if (n === null) return false
  const d = decimalesDe(clase)
  return redondearA(n, d) === redondearA(nuevo, d)
}

/** Lo que el formulario manda a la server action. */
export interface SolicitudAjuste {
  clase: ClaseAjuste
  /** Inventario: id_entidad|id_producto|cubeta. Saldo: id_cuenta. */
  clave: string
  /** El valor que el usuario VIO (el servidor rechaza si cambio). */
  visto: number
  nuevo: number
  motivo: string
  /** Primera confirmacion (modal de revision aceptado). */
  paso1: boolean
  /** Segunda confirmacion: el valor nuevo tecleado otra vez. */
  confirmacion: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ClaveInventario = { idEntidad: string; idProducto: string; cubeta: 'PAGADO' | 'CONSIGNADO' }

export function claveInventario(c: ClaveInventario): string {
  return `${c.idEntidad}|${c.idProducto}|${c.cubeta}`
}

export function leerClaveInventario(clave: string): ClaveInventario | null {
  const [idEntidad, idProducto, cubeta, ...resto] = String(clave ?? '').split('|')
  if (resto.length || !UUID.test(idEntidad ?? '') || !UUID.test(idProducto ?? '')) return null
  if (cubeta !== 'PAGADO' && cubeta !== 'CONSIGNADO') return null
  return { idEntidad, idProducto, cubeta }
}

/**
 * La puerta de la server action: las DOS confirmaciones, el motivo y los
 * numeros. Devuelve el error o `null`. El rol ADMIN se valida aparte (sesion).
 */
export function validarSolicitudAjuste(s: SolicitudAjuste): string | null {
  if (s.clase !== 'inventario' && s.clase !== 'saldo') return 'Tipo de corrección inválido.'
  if (s.clase === 'inventario' ? !leerClaveInventario(s.clave) : !UUID.test(String(s.clave ?? ''))) return 'Registro inválido.'
  if (!Number.isFinite(s.visto) || !Number.isFinite(s.nuevo)) return 'Valores inválidos.'
  if (s.paso1 !== true) return 'Falta la primera confirmación.'
  if (!confirmacionCasa(String(s.confirmacion ?? ''), s.nuevo, s.clase)) return 'La segunda confirmación no coincide con el valor nuevo.'
  if (String(s.motivo ?? '').trim().length < MOTIVO_MINIMO) return `El motivo es obligatorio (mínimo ${MOTIVO_MINIMO} caracteres).`
  if (s.clase === 'inventario' && s.nuevo < 0) return 'El stock no puede quedar negativo.'
  if (calcularDiferencia(s.visto, s.nuevo, s.clase).sentido === 'igual') return 'No hay diferencia que registrar.'
  return null
}

/** Mensaje legible para los errores de la RPC. */
export function mensajeDeErrorRpc(mensaje: string): string {
  if (mensaje.includes('CAMBIO_CONCURRENTE')) {
    return `${mensaje.replace(/^.*CAMBIO_CONCURRENTE:\s*/, '')} (se capturó algo mientras revisabas; no se escribió nada)`
  }
  if (mensaje.includes('SIN_CAMBIO')) return mensaje.replace(/^.*SIN_CAMBIO:\s*/, 'Sin cambio: ')
  return mensaje
}
