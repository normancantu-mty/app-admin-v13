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
      return p.tipo
    case 'alta_entidad':
      return 'alta'
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
    salida.push({ borrador_id: f.id, sello: f.sello, tipo, creado_en: f.creado_en })
  }
  return salida.sort((a, b) => a.creado_en.localeCompare(b.creado_en))
}
