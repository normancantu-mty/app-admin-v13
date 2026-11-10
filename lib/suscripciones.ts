/**
 * Suscripciones — la parte PURA: que mes es, si toca preguntar, en que estado
 * esta el mes, cuanto suman, y la fila exacta del egreso.
 *
 * Escrito el 2026-11-09 por el Socio (ejecutor). Norman, por voz: "crea una
 * nueva categoria que se llame Suscripciones y que me pregunte cada mes si ya
 * se aprobaron, si ya se hicieron, para tener ahi todas las suscripciones bien
 * especificas de cuanto".
 *
 * Nada aqui toca la red ni la base: la ruta `app/api/bot/suscripciones` lee y
 * escribe, y le pregunta todo a estas funciones. Asi se prueban sin base
 * (`tests/suscripciones.spec.ts`).
 *
 * EL ESTADO DEL MES SE DERIVA DE LA BASE, NO DE LA RAM DEL BOT. La fila
 * `suscripcion_meses (id_suscripcion, mes)` existe o no existe; si existe, su
 * `estado` dice que paso. Un reinicio del bot no puede repetir la pregunta
 * porque la pregunta se RECLAMA con el INSERT de esa fila (gana uno).
 */

import { hoyEnMX, medianocheMXaISO, MX_TIME_ZONE } from '@/lib/date-format'
import { desactivarTextoFiscal, TOPE_MONTO } from '@/lib/bot-gastos'

export const CATEGORIA_SUSCRIPCIONES = 'Suscripciones'
export const SUBCATEGORIAS_SUSCRIPCION = ['IA', 'Software y nube', 'Marketing y mensajería', 'Otras'] as const
export type SubcategoriaSuscripcion = (typeof SUBCATEGORIAS_SUSCRIPCION)[number]
export const MONEDAS = ['MXN', 'USD'] as const
export type Moneda = (typeof MONEDAS)[number]

/** "Todavia no" vuelve a preguntar a los 3 dias (encargo de Norman). */
export const DIAS_PARA_VOLVER_A_PREGUNTAR = 3
/** Antes de esta hora (Mexico) no se pregunta: el latido corre de madrugada tambien. */
export const HORA_DE_PREGUNTA = 9
/**
 * Una PREGUNTADA sin `id_mensaje` y con mas de estas horas = el bot reclamo el
 * mes y murio antes de mandar (o de avisar que mando). Se reenvia UNA vez.
 */
export const HORAS_PARA_REENVIAR = 6

export interface Suscripcion {
  id: number
  nombre: string
  monto: number
  moneda: Moneda
  dia_cobro: number | null
  id_cuenta: string | null
  subcategoria: string
  activa: boolean
  notas?: string | null
}

export type EstadoDeLaFila = 'PREGUNTADA' | 'POSPUESTA' | 'PAGADA' | 'BAJA'
/** Por que una fila esta POSPUESTA: Norman dijo "Todavia no", o Telegram no la entrego. */
export type MotivoPospuesta = 'TODAVIA_NO' | 'ENVIO_FALLIDO'

export interface MesDeSuscripcion {
  id_suscripcion: number
  mes: string
  estado: EstadoDeLaFila
  preguntada_en?: string | null
  volver_a_preguntar: string | null
  id_movimiento: string | null
  monto_pagado: number | null
  /** message_id de Telegram de la pregunta que SI salio. */
  id_mensaje?: number | null
  reenvios?: number
  motivo_pospuesta?: MotivoPospuesta | null
}

// ─── EL CALENDARIO ──────────────────────────────────────────────────────────

/** `AAAA-MM` valido. */
export function esMes(valor: unknown): valor is string {
  return typeof valor === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(valor)
}

/** `AAAA-MM-DD` -> `AAAA-MM`. */
export function mesDe(fecha: string): string {
  return fecha.slice(0, 7)
}

/** El mes de hoy en MEXICO (no el de UTC: a las 19:00 del ultimo dia ya seria el siguiente). */
export function mesActual(ahora: Date = new Date()): string {
  return mesDe(hoyEnMX(ahora))
}

/** La hora (0-23) en Mexico. */
export function horaEnMX(ahora: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: MX_TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(ahora)
  return Number(h) % 24
}

export function diasDelMes(mes: string): number {
  const [y, m] = mes.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** El dia que toca preguntar: el de cobro (31 en febrero = el 28/29), o el 1 si no hay dia. */
export function diaEfectivo(diaCobro: number | null | undefined, mes: string): number {
  const d = Number(diaCobro)
  if (!Number.isInteger(d) || d < 1) return 1
  return Math.min(d, diasDelMes(mes))
}

/** `AAAA-MM-DD` del cobro de ese mes. */
export function fechaDeCobro(s: Pick<Suscripcion, 'dia_cobro'>, mes: string): string {
  return `${mes}-${String(diaEfectivo(s.dia_cobro, mes)).padStart(2, '0')}`
}

/**
 * `[desde, hasta)` del mes en instantes UTC, contando la medianoche de MEXICO
 * (`fecha_movimiento` es timestamptz). Para buscar egresos "de ese mes".
 */
export function rangoDelMes(mes: string): { desde: string; hasta: string } {
  const [y, m] = mes.split('-').map(Number)
  const siguiente = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return { desde: medianocheMXaISO(`${mes}-01`) as string, hasta: medianocheMXaISO(`${siguiente}-01`) as string }
}

/** El mes anterior a `mes`. */
export function mesAnterior(mes: string): string {
  const [y, m] = mes.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

// ─── ¿TOCA PREGUNTAR? ───────────────────────────────────────────────────────

export type TipoDePregunta = 'nueva' | 'reintento' | 'reenvio'
export type Debida = { preguntar: false } | { preguntar: true; tipo: TipoDePregunta }

/**
 * ¿Hay que preguntar HOY por esta suscripcion? **Pura**: `hoy` (AAAA-MM-DD,
 * Mexico), `hora` (Mexico) y `ahora` se inyectan.
 *
 * `fila` puede ser de CUALQUIER mes (ronda 2: un "Todavia no" de octubre no se
 * pierde al cruzar a noviembre). Sin fila, la pregunta es la del mes de `hoy`.
 *
 * - Inactiva: nunca. Antes de HORA_DE_PREGUNTA: todavia no.
 * - Sin fila: la primera ('nueva'), si ya llego el dia de cobro de este mes.
 * - POSPUESTA y ya paso `volver_a_preguntar`: 'reintento'.
 * - PREGUNTADA sin `id_mensaje`, de hace mas de HORAS_PARA_REENVIAR y sin
 *   reenvio previo: 'reenvio' (el bot murio entre el reclamo y el envio).
 * - Cualquier otra fila (PREGUNTADA entregada, PAGADA, BAJA): no. Una
 *   pregunta por mes; la que no se contesto se ve en /suscripciones.
 */
export function debePreguntar(
  s: Suscripcion,
  fila: MesDeSuscripcion | null | undefined,
  hoy: string,
  hora: number,
  ahora: Date
): Debida {
  if (!s.activa) return { preguntar: false }
  if (hora < HORA_DE_PREGUNTA) return { preguntar: false }
  if (!fila) {
    if (hoy < fechaDeCobro(s, mesDe(hoy))) return { preguntar: false }
    return { preguntar: true, tipo: 'nueva' }
  }
  if (fila.estado === 'POSPUESTA' && fila.volver_a_preguntar && new Date(fila.volver_a_preguntar).getTime() <= ahora.getTime()) {
    return { preguntar: true, tipo: 'reintento' }
  }
  if (
    fila.estado === 'PREGUNTADA' &&
    (fila.id_mensaje === null || fila.id_mensaje === undefined) &&
    Number(fila.reenvios ?? 0) === 0 &&
    fila.preguntada_en &&
    new Date(fila.preguntada_en).getTime() <= ahora.getTime() - HORAS_PARA_REENVIAR * 3600000
  ) {
    return { preguntar: true, tipo: 'reenvio' }
  }
  return { preguntar: false }
}

/** Antes de esto, una PREGUNTADA sin id de mensaje todavia no se reenvia. */
export function limiteDeReenvio(ahora: Date): string {
  return new Date(ahora.getTime() - HORAS_PARA_REENVIAR * 3600000).toISOString()
}

/** Cuando vuelve a preguntar un "Todavia no" dado en `ahora`. */
export function volverAPreguntarEn(ahora: Date): string {
  return new Date(ahora.getTime() + DIAS_PARA_VOLVER_A_PREGUNTAR * 86400000).toISOString()
}

// ─── EL ESTADO DEL MES ──────────────────────────────────────────────────────

export type EstadoDelMes = 'pagada' | 'pendiente' | 'por_cobrar' | 'baja' | 'inactiva'

/**
 * El estado del mes, derivado de la fila y del egreso. **Pura.**
 *
 * `egresoActivo`: si la fila PAGADA apunta a un egreso, ¿sigue ACTIVO en
 * `finanzas_ledger`? Un egreso ANULADO devuelve el mes a 'pendiente': lo que
 * manda es el ledger. Una fila PAGADA sin egreso (la marca del id fallo despues
 * de escribir) cuenta como pagada: duplicar un egreso es peor que pedir revisar.
 */
export function estadoDelMes(
  s: Suscripcion,
  fila: MesDeSuscripcion | null | undefined,
  hoy: string,
  egresoActivo: boolean
): EstadoDelMes {
  if (fila?.estado === 'PAGADA' && (fila.id_movimiento === null || egresoActivo)) return 'pagada'
  if (fila?.estado === 'BAJA') return 'baja'
  if (!s.activa) return 'inactiva'
  if (hoy < fechaDeCobro(s, mesDe(hoy))) return 'por_cobrar'
  return 'pendiente'
}

/** ¿El mes ya esta pagado de verdad? (para no escribir un segundo egreso) */
export function yaPagada(fila: MesDeSuscripcion | null | undefined, egresoActivo: boolean): boolean {
  return fila?.estado === 'PAGADA' && (fila.id_movimiento === null || egresoActivo)
}

export interface PendienteAnterior {
  s: Suscripcion
  fila: MesDeSuscripcion
}

/**
 * Los meses ANTERIORES a `mes` que siguen sin pagar: fila PREGUNTADA o
 * POSPUESTA, o PAGADA cuyo egreso se anulo. No cuentan los dados de baja ni
 * las suscripciones inactivas ("Ya no la tengo" = no me preguntes mas). Un mes
 * sin fila (el bot no pregunto nunca) no aparece: no hay de donde saberlo.
 * **Pura.** Orden: mes, luego nombre.
 */
export function pendientesAnteriores(
  subs: readonly Suscripcion[],
  filas: readonly MesDeSuscripcion[],
  egresosActivos: ReadonlySet<string>,
  mes: string
): PendienteAnterior[] {
  const porId = new Map(subs.map((s) => [s.id, s]))
  const r: PendienteAnterior[] = []
  for (const fila of filas) {
    const s = porId.get(fila.id_suscripcion)
    if (!s || !s.activa || fila.mes >= mes || fila.estado === 'BAJA') continue
    if (yaPagada(fila, fila.id_movimiento ? egresosActivos.has(fila.id_movimiento) : false)) continue
    r.push({ s, fila })
  }
  return r.sort((a, b) => (a.fila.mes === b.fila.mes ? a.s.nombre.localeCompare(b.s.nombre) : a.fila.mes < b.fila.mes ? -1 : 1))
}

// ─── EL TOTAL ───────────────────────────────────────────────────────────────

export interface TotalMensual {
  mxn: number
  usd: number
  /** MXN + el ultimo cobro EN PESOS de cada suscripcion en USD. null si ninguna en USD tiene referencia. */
  aproxMxn: number | null
  /** Las que estan en USD y nunca se han pagado en pesos: no entran a `aproxMxn`. */
  usdSinReferencia: string[]
}

/**
 * Lo que suman al mes las ACTIVAS. **No hay tipo de cambio en el sistema y no
 * se inventa uno**: lo que esta en USD se suma aparte, y la aproximacion en
 * pesos usa el ultimo monto que Norman confirmo en pesos para esa misma
 * suscripcion (`ultimoPagoMxn`), marcado como aproximado.
 */
export function totalMensual(subs: readonly Suscripcion[], ultimoPagoMxn: ReadonlyMap<number, number>): TotalMensual {
  let mxn = 0
  let usd = 0
  let aprox = 0
  let conReferencia = 0
  const usdSinReferencia: string[] = []
  for (const s of subs) {
    if (!s.activa) continue
    if (s.moneda === 'USD') {
      usd += Number(s.monto)
      const ultimo = ultimoPagoMxn.get(s.id)
      if (ultimo !== undefined) {
        aprox += ultimo
        conReferencia++
      } else {
        usdSinReferencia.push(s.nombre)
      }
    } else {
      mxn += Number(s.monto)
    }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100
  return {
    mxn: r2(mxn),
    usd: r2(usd),
    aproxMxn: conReferencia > 0 ? r2(mxn + aprox) : null,
    usdSinReferencia
  }
}

// ─── EL EGRESO ──────────────────────────────────────────────────────────────

export interface FilaEgresoSuscripcion {
  tipo_movimiento: 'GASTO_OPERATIVO'
  categoria: string
  subcategoria: string
  categoria_gasto: null
  descripcion: string
  monto: number
  fecha_movimiento: string
  id_cuenta_destino: string
  id_cuenta_origen: null
  usuario_creador: string
  status: 'ACTIVO'
  es_recurrente: true
}

/**
 * La fila EXACTA del egreso. Misma forma que un gasto del bot o un egreso de
 * la web (`GASTO_OPERATIVO`, cuenta en `id_cuenta_destino`, `categoria` +
 * `subcategoria` de `categorias_movimiento`) para que todas las pantallas lo
 * lean igual. El concepto pasa por `desactivarTextoFiscal`: un nombre como
 * "pago IVA" no debe mover el pasivo fiscal.
 *
 * El monto es SIEMPRE en pesos: `finanzas_ledger.monto` no tiene moneda. Para
 * una suscripcion en USD quien llama tiene que traer los pesos que se cobraron.
 */
export function filaDeEgreso(
  s: Suscripcion,
  datos: { mes: string; montoMxn: number; idCuenta: string; etiqueta: string; ahora: Date }
): { ok: true; fila: FilaEgresoSuscripcion } | { ok: false; error: string } {
  const monto = Number(datos.montoMxn)
  if (!Number.isFinite(monto) || monto <= 0) return { ok: false, error: 'El monto tiene que ser un numero mayor que cero.' }
  if (monto > TOPE_MONTO) return { ok: false, error: `Un egreso de mas de ${TOPE_MONTO} por chat no; capturalo en la pantalla.` }
  if (!esMes(datos.mes)) return { ok: false, error: 'Mes invalido.' }
  if (!datos.idCuenta) return { ok: false, error: 'Sin cuenta de donde sale.' }
  return {
    ok: true,
    fila: {
      tipo_movimiento: 'GASTO_OPERATIVO',
      categoria: CATEGORIA_SUSCRIPCIONES,
      subcategoria: s.subcategoria,
      categoria_gasto: null,
      descripcion: desactivarTextoFiscal(`Suscripción ${s.nombre} (${datos.mes})`).slice(0, 300),
      monto: Math.round(monto * 100) / 100,
      fecha_movimiento: datos.ahora.toISOString(),
      id_cuenta_destino: datos.idCuenta,
      id_cuenta_origen: null,
      usuario_creador: `telegram:${datos.etiqueta}`,
      status: 'ACTIVO',
      es_recurrente: true
    }
  }
}

/**
 * El patron `ilike` de PostgREST (`*` = comodin) para "la descripcion menciona
 * la suscripcion". Se quitan los caracteres que el filtro lee como sintaxis
 * (`* % _ , ( ) \\ "`): un nombre raro no debe romper ni ensanchar la busqueda.
 */
export function patronDeNombre(nombre: string): string {
  const limpio = String(nombre ?? '').replace(/[*%_,()\\"]/g, ' ').replace(/\s+/g, ' ').trim()
  return `*${limpio}*`
}

// ─── LO QUE LEE NORMAN ──────────────────────────────────────────────────────

export function pesos(n: number): string {
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function montoConMoneda(s: Pick<Suscripcion, 'monto' | 'moneda'>): string {
  return s.moneda === 'USD' ? `USD ${Number(s.monto).toFixed(2)}` : pesos(s.monto)
}

const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
export function nombreDeMes(mes: string): string {
  const [y, m] = mes.split('-').map(Number)
  return `${NOMBRE_MES[m - 1]} ${y}`
}

/** Por que sale ESTA pregunta (decide el encabezado). */
export type MotivoDePregunta = 'NUEVA' | 'TODAVIA_NO' | 'ENVIO_FALLIDO' | 'REENVIO'

/** El motivo, de lo que dijo `debePreguntar` y de la fila. */
export function motivoDePregunta(tipo: TipoDePregunta, fila: MesDeSuscripcion | null | undefined): MotivoDePregunta {
  if (tipo === 'nueva') return 'NUEVA'
  if (tipo === 'reenvio') return 'REENVIO'
  return fila?.motivo_pospuesta === 'TODAVIA_NO' ? 'TODAVIA_NO' : 'ENVIO_FALLIDO'
}

const ENCABEZADO: Record<MotivoDePregunta, string> = {
  NUEVA: 'Suscripcion del mes:',
  TODAVIA_NO: 'Te vuelvo a preguntar (me dijiste "todavia no"):',
  // Ni Norman dijo nada: lo que fallo fue Telegram (o el bot).
  ENVIO_FALLIDO: 'Suscripcion del mes (la primera vez no te llego el mensaje):',
  REENVIO: 'Suscripcion del mes (te la mando otra vez: no tengo constancia de que te haya llegado):'
}

/** La pregunta del mes. Los botones los pone el bot. */
export function textoDePregunta(s: Suscripcion, mes: string, motivo: MotivoDePregunta): string {
  const dia = s.dia_cobro ? `se cobra el dia ${s.dia_cobro}` : 'sin dia de cobro registrado'
  return [
    ENCABEZADO[motivo] ?? ENCABEZADO.NUEVA,
    '',
    `${s.nombre} — ${montoConMoneda(s)} (${dia})`,
    `¿Ya se pago la de ${nombreDeMes(mes)}?`
  ].join('\n')
}

const ROTULO: Record<EstadoDelMes, string> = {
  pagada: 'pagada',
  pendiente: 'PENDIENTE',
  por_cobrar: 'aun no toca',
  baja: 'dada de baja',
  inactiva: 'inactiva'
}

export interface RenglonDeLista {
  s: Suscripcion
  estado: EstadoDelMes
  montoPagado: number | null
}

/** El total en texto (bot y ERP). Sin tipo de cambio en el sistema: lo de USD va aparte; no se inventa uno. */
export function lineasDeTotal(t: TotalMensual): string[] {
  const l = [`Total mensual (activas): ${pesos(t.mxn)} MXN`]
  if (t.usd > 0) {
    l.push(`+ USD ${t.usd.toFixed(2)} aparte (en el sistema no hay tipo de cambio)`)
    if (t.aproxMxn !== null) l.push(`⚠️ ≈ ${pesos(t.aproxMxn)} MXN contando el ultimo cobro en pesos de cada una en USD (fuente: el propio ledger)`)
    if (t.usdSinReferencia.length > 0) l.push(`(sin cobro en pesos todavia: ${t.usdSinReferencia.join(', ')})`)
  }
  return l
}

/** El texto de /suscripciones. Solo las activas y las que cambiaron este mes, y los meses anteriores sin pagar. */
export function textoDeLista(
  renglones: readonly RenglonDeLista[],
  mes: string,
  total: TotalMensual,
  anteriores: readonly PendienteAnterior[] = []
): string {
  const vivas = renglones.filter((r) => r.s.activa || r.estado === 'pagada' || r.estado === 'baja')
  if (vivas.length === 0 && anteriores.length === 0) {
    return 'No hay suscripciones dadas de alta. Se agregan en el ERP: Finanzas > Suscripciones.'
  }
  const lineas = [`Suscripciones — ${nombreDeMes(mes)}`, '']
  for (const r of vivas) {
    const dia = r.s.dia_cobro ? `dia ${r.s.dia_cobro}` : 'sin dia'
    const pagado = r.estado === 'pagada' && r.montoPagado !== null ? ` (${pesos(r.montoPagado)})` : ''
    lineas.push(`• ${r.s.nombre}: ${montoConMoneda(r.s)} · ${dia} · ${ROTULO[r.estado]}${pagado}`)
  }
  if (anteriores.length > 0) {
    lineas.push('', 'Meses anteriores sin pagar:')
    for (const a of anteriores) {
      const rotulo = a.fila.estado === 'PAGADA' ? 'PENDIENTE (el egreso se anulo)' : 'PENDIENTE'
      lineas.push(`• ${a.s.nombre} (${nombreDeMes(a.fila.mes)}): ${montoConMoneda(a.s)} · ${rotulo}`)
    }
  }
  lineas.push('', ...lineasDeTotal(total))
  const pendientes = vivas.filter((r) => r.estado === 'pendiente').length
  if (pendientes > 0) lineas.push('', `${pendientes} pendiente(s) este mes: el boton de abajo las marca pagadas.`)
  if (anteriores.length > 0) lineas.push(`${anteriores.length} de meses anteriores: tambien tienen boton.`)
  return lineas.join('\n')
}

// ─── EL ALTA / EDICION DESDE EL ERP ─────────────────────────────────────────

export interface ValoresSuscripcion {
  nombre: string
  monto: number
  moneda: Moneda
  dia_cobro: number | null
  id_cuenta: string | null
  subcategoria: SubcategoriaSuscripcion
  activa: boolean
  notas: string | null
}

/** Una etiqueta con 12+ digitos seguidos parece numero de tarjeta o CLABE: no se guarda. */
const PARECE_CUENTA_BANCARIA = /\d[\d\s-]{11,}\d/

export function validarSuscripcion(c: Record<string, unknown>): { ok: true; valores: ValoresSuscripcion } | { ok: false; motivo: string } {
  const nombre = String(c.nombre ?? '').trim().replace(/\s+/g, ' ')
  if (nombre.length < 1 || nombre.length > 60) return { ok: false, motivo: 'el nombre va de 1 a 60 letras' }
  const monto = Number(c.monto)
  if (!Number.isFinite(monto) || monto <= 0 || monto > TOPE_MONTO) return { ok: false, motivo: 'el monto tiene que ser mayor que cero' }
  const moneda = String(c.moneda ?? 'MXN').toUpperCase()
  if (!(MONEDAS as readonly string[]).includes(moneda)) return { ok: false, motivo: 'la moneda es MXN o USD' }
  let dia: number | null = null
  if (c.dia_cobro !== null && c.dia_cobro !== undefined && String(c.dia_cobro).trim() !== '') {
    dia = Number(c.dia_cobro)
    if (!Number.isInteger(dia) || dia < 1 || dia > 31) return { ok: false, motivo: 'el dia de cobro va del 1 al 31 (o vacio)' }
  }
  const sub = String(c.subcategoria ?? 'Otras')
  if (!(SUBCATEGORIAS_SUSCRIPCION as readonly string[]).includes(sub)) return { ok: false, motivo: 'subcategoria fuera de la lista' }
  const idCuenta = c.id_cuenta ? String(c.id_cuenta) : null
  const notas = c.notas ? String(c.notas).trim().slice(0, 200) : null
  if (notas && PARECE_CUENTA_BANCARIA.test(notas)) return { ok: false, motivo: 'la nota parece un numero de tarjeta o cuenta; pon solo una etiqueta' }
  return {
    ok: true,
    valores: {
      nombre,
      monto: Math.round(monto * 100) / 100,
      moneda: moneda as Moneda,
      dia_cobro: dia,
      id_cuenta: idCuenta,
      subcategoria: sub as SubcategoriaSuscripcion,
      activa: c.activa === undefined ? true : c.activa === true,
      notas: notas || null
    }
  }
}
