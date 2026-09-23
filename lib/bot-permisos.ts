/**
 * FASE 9 (D96) — LA TABLA DE PERMISOS DEL BOT, EN UN SOLO LUGAR.
 *
 * Aprobada por Norman en el chat el 2026-09-23 (la tabla completa vive en
 * `Fresnillo/ERP_Fresnillo/DESDE_SOCIO_prompt_ejecutor_fase9_2026-09-23.md`,
 * Bloque C). **Se aplica en las rutas, no en el bot:** un candado que vive en el
 * proceso del bot lo salta cualquiera que le hable al endpoint.
 *
 * Quien es quien:
 *   · Norman  = identidad de una entidad ADMIN, sin `requiere_aprobacion`.
 *   · Kevin   = identidad de la Matriz (ADMIN) **con** `requiere_aprobacion`:
 *               propone y consulta todo lo que Norman, pero su VA espera el
 *               Aprobar de Norman (D98). No hay rol nuevo en `entidades`.
 *   · DST/LOC = el rol de la entidad a la que apunta la identidad.
 *
 * Lo que la tabla NO dice se decide CERRADO (regla del prompt de la fase) y va
 * como pregunta en el informe: convertir cotizacion en venta, alta de cliente y
 * entrada de insumo para un DST; todo para un LOC.
 *
 * Todo aqui es PURO (`tests/bot-fase9-permisos.spec.ts`).
 */

export type AccionBot =
  | 'venta'
  | 'abono'
  | 'cotizacion'
  | 'gasto'
  | 'lote'
  | 'entrada_insumo'
  | 'convertir'
  | 'entidad'
  | 'registrar'

/**
 * - `si`: escribe con su propio VA.
 * - `aprobacion`: propone y da VA, pero escribe el Aprobar de Norman (D98).
 * - `no`: 403, aunque el bot lo mande.
 */
export type Veredicto = 'si' | 'aprobacion' | 'no'

export interface ActorBot {
  rol: string
  requiereAprobacion: boolean
}

/** Norman: ADMIN sin marca. Es el unico que aprueba y el unico que registra. */
export function esAprobador(actor: ActorBot): boolean {
  return actor.rol === 'ADMIN' && !actor.requiereAprobacion
}

const DE_LA_MATRIZ: readonly AccionBot[] = [
  'venta',
  'abono',
  'cotizacion',
  'gasto',
  'lote',
  'entrada_insumo',
  'convertir',
  'entidad'
]

/** Lo que un DST hace a su nombre (la tabla: venta, abono, cotizacion). */
const DEL_DISTRIBUIDOR: readonly AccionBot[] = ['venta', 'abono', 'cotizacion']

export function permisoDeAccion(actor: ActorBot, accion: AccionBot): Veredicto {
  if (accion === 'registrar') return esAprobador(actor) ? 'si' : 'no'
  if (actor.rol === 'ADMIN') {
    if (!DE_LA_MATRIZ.includes(accion)) return 'no'
    return actor.requiereAprobacion ? 'aprobacion' : 'si'
  }
  if (actor.rol === 'DST') {
    // El abono de un DST tambien es `si`: lo que lo deja PENDIENTE no es el
    // permiso sino la categoria (`ABONO_PENDIENTE`, D97), igual que en la app.
    return DEL_DISTRIBUIDOR.includes(accion) ? 'si' : 'no'
  }
  return 'no'
}

export const MENSAJE_NO_PERMITIDO: Record<AccionBot, string> = {
  venta: 'Registrar ventas por aqui no te toca con tu alta.',
  abono: 'Registrar abonos por aqui no te toca con tu alta.',
  cotizacion: 'Hacer cotizaciones por aqui no te toca con tu alta.',
  gasto: 'Los gastos los apuntan Norman y Kevin; tu alta no alcanza.',
  lote: 'Los lotes y el envasado los apuntan Norman y Kevin; tu alta no alcanza.',
  entrada_insumo: 'El inventario de la matriz lo mueven Norman y Kevin; tu alta no alcanza.',
  convertir: 'Convertir una cotizacion en venta por aqui no te toca con tu alta.',
  entidad: 'Dar de alta clientes por aqui no te toca con tu alta.',
  registrar: 'Registrar quien es quien lo hace solo Norman.'
}

// ─── LAS CONSULTAS ──────────────────────────────────────────────────────────

export type ConsultaBot = 'inventario' | 'deuda' | 'precios' | 'ventas' | 'produccion'

/**
 * - `todo`: todas las entidades.
 * - `red`: la propia y sus locales (`mis_entidades()`).
 * - `propio`: solo la propia.
 */
export type Alcance = 'todo' | 'red' | 'propio'

export type PermisoDeConsulta =
  | { ok: true; alcance: Alcance; privado: boolean }
  | { ok: false }

/**
 * `privado`: en un grupo, la respuesta va al chat privado de quien pregunto y
 * en el grupo solo se dice "Te lo mande por privado". En privado no cambia nada.
 */
export function permisoDeConsulta(actor: ActorBot, consulta: ConsultaBot): PermisoDeConsulta {
  if (actor.rol === 'ADMIN') {
    // Norman y Kevin igual: Kevin "consulta todo lo que consulta Norman".
    const privado = consulta === 'deuda' || consulta === 'ventas' || consulta === 'produccion'
    return { ok: true, alcance: 'todo', privado }
  }
  if (consulta === 'ventas' || consulta === 'produccion') return { ok: false }
  if (actor.rol === 'DST') return { ok: true, alcance: 'red', privado: false }
  if (actor.rol === 'LOC') return { ok: true, alcance: 'propio', privado: false }
  return { ok: false }
}

/** ¿El mensaje llego de un grupo? En privado, chat == persona (Telegram). */
export function esGrupo(chatId: unknown, telegramId: number): boolean {
  const chat = Number(chatId)
  return Number.isSafeInteger(chat) && chat !== 0 && chat !== telegramId
}

/** El `chat_id` que se guarda en el borrador: el que vino, o la persona. */
export function chatDelBorrador(chatId: unknown, telegramId: number): number {
  const chat = Number(chatId)
  return Number.isSafeInteger(chat) && chat !== 0 ? chat : telegramId
}

/** Las entidades que un actor alcanza: la propia, o la propia y sus hijos. */
export function entidadesAlcanzables(
  alcance: Alcance,
  idPropia: string,
  entidades: readonly { id: string; id_padre: string | null; id_nodo_padre: string | null }[]
): Set<string> | null {
  if (alcance === 'todo') return null
  const ids = new Set([idPropia])
  if (alcance === 'red') {
    // Las dos columnas, como `mis_entidades()` (20260902145858:35-41).
    for (const e of entidades) {
      if (e.id_padre === idPropia || e.id_nodo_padre === idPropia) ids.add(e.id)
    }
  }
  return ids
}
