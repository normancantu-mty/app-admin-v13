/**
 * FASE 11 (D112) — LA ENTREGA DE EFECTIVO DEL DISTRIBUIDOR.
 *
 * Un DST que vende de contado se queda con el efectivo: la venta escribe
 * `DEUDA_A_MATRIZ` (lo que es de la matriz, `lib/venta-servidor.ts`). Cuando lo
 * entrega, hasta hoy se capturaba como un abono cualquiera (`ABONO_DEUDA` /
 * `ABONO_REAL`) y le bajaba la deuda de CONCESION, que es otra cosa. Aqui la
 * entrega es un `ABONO_DEUDA` con `es_entrega_efectivo = true`: ingreso y fiscal
 * igual que un abono, pero la deuda de concesion no lo resta
 * (`supabase/migraciones_propuestas/d112_entrega_de_efectivo_del_distribuidor.sql`).
 *
 * Quien la registra (la regla del prompt de la fase, "un DST solo registra su
 * entrega; Kevin propone y alguien aprueba"):
 *   · Norman: la de cualquier DST/LOC, directo.
 *   · Kevin: la de cualquier DST/LOC; espera el Aprobar de Norman (D98, la puerta).
 *   · DST: SOLO la suya, y SIEMPRE espera el Aprobar de Norman o Kevin — es la
 *     matriz la que dice "si, lo recibi".
 *   · LOC y cualquier otro: no.
 *
 * Todo aqui es PURO (`tests/entrega-efectivo.spec.ts`).
 */

import { sellar, selloEmpata } from '@/lib/bot-sello'
import { CATEGORIA_ABONO_REAL } from '@/lib/finance-utils'

export interface PayloadEntrega {
  /** El DST/LOC que entrega. Sale de la identidad (DST) o de la lista (ADMIN), nunca del modelo. */
  id_entidad: string
  monto: number
  /** La cuenta propia del DST: de donde sale el efectivo. */
  id_cuenta_origen: string
  /** La cuenta de la matriz: a donde entra. */
  id_cuenta_destino: string
  fecha_movimiento: string
  usuario_creador: string
  nota: string
}

const LLAVES_ENTREGA = [
  'id_entidad',
  'monto',
  'id_cuenta_origen',
  'id_cuenta_destino',
  'fecha_movimiento',
  'usuario_creador',
  'nota'
] as const

export function sellarEntrega(payload: PayloadEntrega): string {
  return sellar(payload, LLAVES_ENTREGA)
}

export function selloEntregaCoincide(payload: PayloadEntrega, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_ENTREGA, sello)
}

/** Tope de cordura: una entrega mayor casi seguro es un dedo de mas. */
export const TOPE_ENTREGA = 500_000

export function normalizarMonto(valor: unknown): { ok: true; monto: number } | { ok: false; error: string } {
  const n = typeof valor === 'number' ? valor : Number(String(valor ?? '').replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Dime cuanto entregaste: un monto mayor a cero.' }
  if (n > TOPE_ENTREGA) {
    return { ok: false, error: `Eso es mas de $${TOPE_ENTREGA.toLocaleString('en-US')}. Si es correcto, capturalo en la pantalla.` }
  }
  return { ok: true, monto: Math.round(n * 100) / 100 }
}

export interface ActorEntrega {
  rol: string
  idEntidad: string
}

export type DecisionEntrega =
  | { ok: true; siempreEspera: boolean }
  | { ok: false; error: string }

export const MENSAJE_SOLO_LA_TUYA = 'Solo registras tu propia entrega de efectivo, no la de otro distribuidor.'

/**
 * Quien puede registrar la entrega de quien. `siempreEspera`: el VA no escribe,
 * espera el Aprobar (el DST, siempre). Kevin espera por la puerta (D98), no por esto.
 */
export function decidirEntrega(actor: ActorEntrega, objetivo: { id: string; rol: string }): DecisionEntrega {
  if (objetivo.rol !== 'DST' && objetivo.rol !== 'LOC') {
    return { ok: false, error: 'La entrega de efectivo es de un distribuidor o un local.' }
  }
  if (actor.rol === 'ADMIN') return { ok: true, siempreEspera: false }
  if (actor.rol === 'DST') {
    if (objetivo.id !== actor.idEntidad) return { ok: false, error: MENSAJE_SOLO_LA_TUYA }
    return { ok: true, siempreEspera: true }
  }
  return { ok: false, error: 'Registrar entregas de efectivo no te toca con tu alta.' }
}

export const REFERENCIA_ENTREGA = 'Entrega de efectivo a matriz'

/**
 * La MISMA regla en la web (`app/actions/abonos.ts` registrarAbonoAction con
 * `esEntregaEfectivo`). La sesion web no distingue a Kevin: ADMIN escribe
 * directo, DST solo la suya (y su fila entra `ABONO_PENDIENTE`, como cualquier
 * abono suyo en la web). Ademas: una entrega es SIEMPRE distribuidor -> matriz.
 */
export function reglaDeEntregaWeb(
  sesion: { rol: string; entidadId: string },
  objetivo: { id: string; rol: string | null },
  tipoMovimiento: string
): { ok: true } | { ok: false; error: string } {
  if (tipoMovimiento !== 'ABONO_DEUDA') {
    return { ok: false, error: 'Una entrega de efectivo va de la cuenta del distribuidor a la de la matriz.' }
  }
  const d = decidirEntrega(
    { rol: String(sesion.rol ?? '').toUpperCase(), idEntidad: sesion.entidadId },
    { id: objetivo.id, rol: String(objetivo.rol ?? '').toUpperCase() }
  )
  return d.ok ? { ok: true } : { ok: false, error: d.error }
}

/**
 * La fila exacta. Siempre `ABONO_REAL`: por el bot solo se escribe con el VA de
 * Norman o con el Aprobar (la espera vive en el borrador, no en la fila).
 */
export function filaDeEntrega(payload: PayloadEntrega) {
  return {
    tipo_movimiento: 'ABONO_DEUDA' as const,
    es_entrega_efectivo: true,
    id_cuenta_origen: payload.id_cuenta_origen,
    id_cuenta_destino: payload.id_cuenta_destino,
    id_entidad_relacionada: payload.id_entidad,
    categoria: CATEGORIA_ABONO_REAL,
    categoria_gasto: REFERENCIA_ENTREGA,
    descripcion: payload.nota || null,
    metodo_pago: 'EFECTIVO',
    fecha_movimiento: payload.fecha_movimiento,
    usuario_creador: payload.usuario_creador,
    status: 'ACTIVO' as const,
    monto: payload.monto,
    id_ticket: null
  }
}

function pesos(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Lo que la persona lee antes del VA. */
export function mensajeDeConfirmacionEntrega(
  payload: PayloadEntrega,
  meta: { nombre: string; cuentaOrigen: string; cuentaDestino: string; espera: boolean }
): string {
  const lineas = [
    `ENTREGA DE EFECTIVO — ${meta.nombre}`,
    `Monto: ${pesos(payload.monto)}`,
    `De: ${meta.cuentaOrigen}  ->  A: ${meta.cuentaDestino}`,
    'Es efectivo que cobro de contado. NO es abono de concesion: no le baja la deuda de concesion.'
  ]
  if (payload.nota) lineas.push(`Nota: ${payload.nota}`)
  if (meta.espera) lineas.push('', 'No cuenta hasta que Norman o Kevin confirmen que lo recibieron.')
  return lineas.join('\n')
}

// ─── LA LECTURA: "efectivo por entregar" en /cartera ────────────────────────

export interface FilaEfectivo {
  id_entidad: string
  nombre: string
  rol: string
  cobrado_de_contado: number
  entregado: number
  entregas_por_aprobar: number
  por_entregar: number
  desde: string
}

/**
 * El bloque de /cartera. Sale con `desde` SIEMPRE: lo de antes no se puede
 * separar y no se inventa. Negativo = entrego efectivo cobrado antes de `desde`.
 */
export function textoEfectivoPorEntregar(filas: readonly FilaEfectivo[]): string {
  if (filas.length === 0) return ''
  const desde = filas[0].desde
  const lineas = [`EFECTIVO POR ENTREGAR (cuenta desde ${desde}; lo anterior no se puede separar)`]
  const ordenadas = [...filas].sort((a, b) => Number(b.por_entregar) - Number(a.por_entregar))
  for (const f of ordenadas) {
    const por = Number(f.por_entregar) || 0
    let linea = `${f.nombre} — ${pesos(por)} por entregar (cobro ${pesos(Number(f.cobrado_de_contado) || 0)}, entrego ${pesos(Number(f.entregado) || 0)})`
    if (Number(f.entregas_por_aprobar) > 0) linea += ` · ${pesos(Number(f.entregas_por_aprobar))} esperando confirmacion`
    if (por < -0.005) linea += ' · entrego de mas: efectivo de antes de ' + desde
    lineas.push(linea)
  }
  return lineas.join('\n')
}
