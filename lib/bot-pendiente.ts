/**
 * Fase 8 (D77) — LOS BORRADORES QUE SOBREVIVEN A UN REINICIO DEL BOT.
 *
 * El proceso de Python guardaba "que esta esperando su VA" solo en RAM
 * (`_memoria`), y el vigilante lo reinicia cada vez que cambia un `.py`. Tras
 * un reinicio, el boton VA de una propuesta que Norman tenia enfrente
 * contestaba "no tengo nada pendiente" — aunque el borrador seguia en
 * `bot_borradores` con `estado = 'PENDIENTE'`.
 *
 * Esto es la parte PURA: que filas se devuelven y con que tipo. La ruta
 * (`app/api/bot/pendiente/route.ts`) solo lee; no escribe nada, nunca.
 */

/** Mas viejo que esto no se rehidrata: es el mismo `VIDA_DEL_BORRADOR` del bot. */
export const VIDA_DEL_PENDIENTE_MS = 30 * 60 * 1000

/** Los tipos con los que el bot guarda cada propuesta en su memoria. */
export type TipoPendiente =
  | 'gasto'
  | 'abono'
  | 'venta'
  | 'lote'
  | 'cotizacion'
  | 'anulacion'
  | 'alta'
  | 'conversion'
  | 'entrega_efectivo'
  | 'alta_miembro'
  | 'alta_categoria'
  | 'entrada_insumo'
  | 'lote_etapa'
  | 'traspaso'
  | 'merma'

/**
 * `payload.tipo` como lo escribe cada ruta `proponer`, al tipo del bot. El gasto
 * no lleva `tipo` (es el de la Fase 1: `{fila, meta}`), y el alta se guarda
 * como `alta_entidad`. Lo que no se reconoce devuelve `null` y NO se rehidrata:
 * un borrador que el bot no sabe confirmar no se le ofrece.
 */
export function tipoDelPayload(payload: unknown): TipoPendiente | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { tipo?: unknown; fila?: unknown }
  switch (p.tipo) {
    case 'abono':
    case 'venta':
    case 'lote':
    case 'cotizacion':
    case 'anulacion':
    case 'conversion':
    // Auditoria 2026-11-04: estos cinco se proponian y no se rehidrataban: tras un
    // reinicio su VA contestaba que no habia nada, con la fila aun PENDIENTE.
    case 'entrega_efectivo':
    case 'alta_miembro':
    case 'alta_categoria':
    case 'entrada_insumo':
    case 'lote_etapa':
    case 'traspaso':
    // 2026-11-07 (paridad con la web, Fase 3): la merma dictada al bot.
    case 'merma':
      return p.tipo
    case 'alta_entidad':
      return 'alta'
    // 2026-11-07: la compra de insumo dictada como gasto se confirma por la ruta
    // del gasto (/api/bot/gasto/confirmar la despacha a la compra).
    case 'compra_insumo':
      return 'gasto'
    // Fase 8 D81: agregar a un lote existente se confirma por la MISMA ruta
    // (`/api/bot/lote/confirmar`), asi que para el bot es un lote.
    case 'lote_agregar':
    // Lote v2, ronda 5: el envasado diario (sin lote) tambien se confirma por
    // `/api/bot/lote/confirmar`.
    case 'envasado_diario':
      return 'lote'
    case undefined:
    case null:
      return typeof p.fila === 'object' && p.fila !== null ? 'gasto' : null
    default:
      return null
  }
}

export interface FilaBorrador {
  id: string
  sello: string
  payload: unknown
  estado: string
  creado_en: string
}

export interface Pendiente {
  borrador_id: string
  sello: string
  tipo: TipoPendiente
  creado_en: string
  /** Solo gasto y abono, y solo si el borrador lo trae. Ver `ContextoBot`. */
  contexto?: ContextoBot
}

/**
 * Con que se propuso un gasto o un abono. El bot lo necesita tras un reinicio: sin
 * esto un "va" escribia la cuenta default, que nadie dijo (auditoria 2026-11-04,
 * S1). Vive en `payload.meta.contexto_bot`: **fuera del sello y sin tocar la fila**.
 * Lo que aqui se pierda solo hace que el bot vuelva a preguntar.
 */
export interface ContextoBot {
  cuenta: { id_cuenta?: string; oida?: string; solo_paga?: string }
  propuesta: Record<string, unknown>
  sugeridas: string[]
  cuentas: { id: string; nombre: string }[]
  id_cuenta: string
  id_deudor?: string
  nombre_deudor?: string
}

const TOPE_CONTEXTO = 4000

function texto(valor: unknown, tope = 200): string | undefined {
  return typeof valor === 'string' && valor !== '' ? valor.slice(0, tope) : undefined
}

/**
 * Sanea el `contexto_bot` que manda el bot y le agrega lo que solo el servidor sabe.
 * Lista blanca y tope: esto termina en una columna `jsonb`, y sale de una peticion.
 * Un cuerpo sin `contexto_bot` (un bot viejo) o demasiado grande da `null`.
 */
export function contextoDelCuerpo(
  valor: unknown,
  servidor: Pick<ContextoBot, 'cuentas' | 'id_cuenta' | 'id_deudor' | 'nombre_deudor'>
): ContextoBot | null {
  if (typeof valor !== 'object' || valor === null) return null
  const v = valor as { cuenta?: unknown; propuesta?: unknown; sugeridas?: unknown }
  if (typeof v.propuesta !== 'object' || v.propuesta === null) return null
  const cuenta = (typeof v.cuenta === 'object' && v.cuenta !== null ? v.cuenta : {}) as Record<string, unknown>
  const propuesta: Record<string, unknown> = {}
  for (const [llave, dato] of Object.entries(v.propuesta)) {
    if (dato === null || typeof dato === 'number' || typeof dato === 'boolean') propuesta[llave] = dato
    else if (typeof dato === 'string') propuesta[llave] = dato.slice(0, 1000)
  }
  const salida: ContextoBot = {
    cuenta: {
      id_cuenta: texto(cuenta.id_cuenta),
      oida: texto(cuenta.oida),
      solo_paga: texto(cuenta.solo_paga)
    },
    propuesta,
    sugeridas: Array.isArray(v.sugeridas)
      ? v.sugeridas.filter((s): s is string => typeof s === 'string').slice(0, 5)
      : [],
    cuentas: servidor.cuentas.map((c) => ({ id: c.id, nombre: c.nombre })),
    id_cuenta: servidor.id_cuenta,
    id_deudor: servidor.id_deudor,
    nombre_deudor: servidor.nombre_deudor
  }
  return JSON.stringify(salida).length <= TOPE_CONTEXTO ? salida : null
}

function contextoDelPayload(payload: unknown): ContextoBot | undefined {
  const meta = (payload as { meta?: { contexto_bot?: unknown } } | null)?.meta
  const contexto = meta?.contexto_bot
  return typeof contexto === 'object' && contexto !== null ? (contexto as ContextoBot) : undefined
}

/**
 * Los PENDIENTE vigentes, del mas viejo al mas nuevo (el ultimo es el que el
 * bot pone enfrente). `ahora` se inyecta para poder probar el borde.
 */
export function pendientesVigentes(filas: readonly FilaBorrador[], ahora: Date): Pendiente[] {
  const corte = ahora.getTime() - VIDA_DEL_PENDIENTE_MS
  const salida: Pendiente[] = []
  for (const f of filas) {
    if (f.estado !== 'PENDIENTE') continue
    const nacido = new Date(f.creado_en).getTime()
    if (!Number.isFinite(nacido) || nacido < corte) continue
    const tipo = tipoDelPayload(f.payload)
    if (!tipo) continue
    const contexto = contextoDelPayload(f.payload)
    salida.push({
      borrador_id: f.id,
      sello: f.sello,
      tipo,
      creado_en: f.creado_en,
      ...(contexto ? { contexto } : {})
    })
  }
  return salida.sort((a, b) => a.creado_en.localeCompare(b.creado_en))
}
