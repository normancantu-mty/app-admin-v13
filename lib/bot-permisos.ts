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
  /** FASE 11 (D112): el DST entrega a la matriz el efectivo que cobro de contado. */
  | 'entrega_efectivo'
  /** 2026-11-03: alta de categoria/subcategoria en `categorias_movimiento`. */
  | 'categoria'

/**
 * - `si`: escribe con su propio VA.
 * - `aprobacion`: propone y da VA, pero escribe el Aprobar de Norman (D98).
 * - `no`: 403, aunque el bot lo mande.
 */
export type Veredicto = 'si' | 'aprobacion' | 'no'

export interface ActorBot {
  rol: string
  requiereAprobacion: boolean
  /** La persona. Sin ella nadie es Norman (auditoria 2026-11-03, hallazgo 1). */
  telegramId?: number
}

/**
 * El telegram_id de Norman. Auditoria de c2a04db (2026-11-03): "ADMIN sin
 * marca" no basta para ser Norman -- una segunda alta ADMIN sin marca (un
 * error de captura, o una hecha por la web) escribiria directo. Se exige
 * ademas ESTE id. Medido en `bot_identidades` el 2026-11-03: es la unica
 * identidad ADMIN sin marca. `bot/bot_gastos.py` lleva el mismo numero
 * (`NORMAN_TELEGRAM_ID`).
 */
export const NORMAN_TELEGRAM_ID = 6571822622

/**
 * Norman: ADMIN sin marca **y con su telegram_id**. Es el unico que registra
 * quien es quien y el unico cuyo VA escribe directo.
 */
export function esNorman(actor: ActorBot): boolean {
  return actor.rol === 'ADMIN' && !actor.requiereAprobacion && actor.telegramId === NORMAN_TELEGRAM_ID
}

/**
 * 2026-11-10 (Norman: "que desde matriz tambien cristian pueda"): Cristian
 * registra quien es quien, igual que Norman, pero **no** a la Matriz: gente
 * ADMIN solo la da de alta Norman (`puedeRegistrarEnLaMatriz`). Su id salio de
 * `bot_identidades` el mismo dia (etiqueta `cristian`, CEO Admin, con marca).
 * Su VA sigue esperando el Aprobar de Norman; esto solo abre el registro.
 */
export const CRISTIAN_TELEGRAM_ID = 1502214522

export function puedeRegistrar(actor: ActorBot): boolean {
  return esNorman(actor) || (actor.rol === 'ADMIN' && actor.telegramId === CRISTIAN_TELEGRAM_ID)
}

export function puedeRegistrarEnLaMatriz(actor: ActorBot): boolean {
  return esNorman(actor)
}

export const MENSAJE_MATRIZ_SOLO_NORMAN = 'A la Matriz solo registra Norman.'

/**
 * FASE 10 (D106): "Yo, Kevin" — Norman y Kevin aprueban (los dos ADMIN). Esto
 * solo dice quien PUEDE aprobar en general; que pueda aprobar ESTO lo decide
 * `puedeAprobar`, que agrega la regla que mas cierra: nadie aprueba lo suyo.
 */
export function esAprobador(actor: ActorBot): boolean {
  // 2026-11-03 (Norman: "hace lo que entendio y luego nada mas espera MI
  // click"): solo Norman aprueba. Kevin (ADMIN con marca) ya no aprueba lo de
  // terceros, como decia D106. Se revierte volviendo a `actor.rol === 'ADMIN'`.
  return esNorman(actor)
}

export interface PersonaBot extends ActorBot {
  telegramId: number
}

/**
 * Maker-checker (D106): el aprobador es ADMIN y **distinto del autor**. Y lo
 * que propone Kevin (ADMIN con marca) sigue esperando a Norman: un aprobador con
 * marca no aprueba a otro ADMIN con marca. Kevin si aprueba lo de un tercero (el
 * abono pendiente de un DST, o lo que espere de alguien con marca). **Pura.**
 */
export function puedeAprobar(aprobador: PersonaBot, autor: PersonaBot): boolean {
  if (!esAprobador(aprobador)) return false
  if (aprobador.telegramId === autor.telegramId) return false
  return true
}

const DE_LA_MATRIZ: readonly AccionBot[] = [
  'venta',
  'abono',
  'cotizacion',
  'gasto',
  'lote',
  'entrada_insumo',
  'convertir',
  'entidad',
  'entrega_efectivo',
  'categoria'
]

/**
 * Lo que un DST hace a su nombre (la tabla: venta, abono, cotizacion).
 * FASE 10 (D106), decision del planeador que Norman confirma: `convertir` SOLO
 * SUS cotizaciones (es una venta a su nombre). La propiedad la comprueban las
 * rutas `convertir/*` (`id_vendedor` = su entidad). Se revierte quitandolo de
 * aqui. `entidad` (alta de clientes) NO: "solo yo" (Norman, 2026-09-23).
 */
// FASE 11 (D112): `entrega_efectivo` SOLO la suya (lo comprueba `decidirEntrega`,
// `lib/bot-entrega.ts`) y siempre espera el Aprobar de la matriz.
const DEL_DISTRIBUIDOR: readonly AccionBot[] = ['venta', 'abono', 'cotizacion', 'convertir', 'entrega_efectivo']

/**
 * Cazador F0 (WP-6) — EL TRABAJADOR (`bot_identidades.rol_bot = 'TRABAJADOR'`).
 * Captura todo lo que pasa en la planta y **todo** espera el Aprobar de Norman
 * o Kevin (`ESPERA_APROBACION`): nunca `si`. No ve cifras agregadas (stock
 * total, cartera, ventas, rendimiento): de las consultas solo `precios`.
 * Lo que la tabla no dice queda CERRADO (regla de la Fase 9): abono, cotizacion,
 * convertir, alta de cliente, entrega de efectivo. Se abre agregandolo aqui.
 */
export const ROL_TRABAJADOR = 'TRABAJADOR'

const DEL_TRABAJADOR: readonly AccionBot[] = ['venta', 'gasto', 'lote', 'entrada_insumo']

export function permisoDeAccion(actor: ActorBot, accion: AccionBot): Veredicto {
  if (accion === 'registrar') return puedeRegistrar(actor) ? 'si' : 'no'
  if (actor.rol === ROL_TRABAJADOR) return DEL_TRABAJADOR.includes(accion) ? 'aprobacion' : 'no'
  if (actor.rol === 'ADMIN') {
    if (!DE_LA_MATRIZ.includes(accion)) return 'no'
    // Auditoria 2026-11-03: solo Norman escribe con su propio VA; cualquier
    // otro ADMIN (con o sin marca) propone y espera el Aprobar de Norman.
    return esNorman(actor) ? 'si' : 'aprobacion'
  }
  if (actor.rol === 'DST') {
    // Auditoria 2026-11-03 (hallazgo 2): el DST ya no escribe directo. Norman:
    // "hace lo que entendio y luego nada mas espera mi click". Antes era `si`.
    return DEL_DISTRIBUIDOR.includes(accion) ? 'aprobacion' : 'no'
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
  registrar: 'Registrar quien es quien lo hacen solo Norman y Cristian.',
  entrega_efectivo: 'Registrar entregas de efectivo por aqui no te toca con tu alta.',
  categoria: 'Agregar categorias por aqui no te toca con tu alta.'
}

// ─── LAS CONSULTAS ──────────────────────────────────────────────────────────

export type ConsultaBot = 'inventario' | 'deuda' | 'precios' | 'ventas' | 'produccion' | 'gastos'

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
/**
 * Auditoria 2026-11-03 (hallazgo 5): en un grupo puede haber alguien que no es
 * del equipo (el informe registro a @giaforce en "Fresnillo · ERP"). Lo mas
 * simple que cierra la fuga: **toda** respuesta con cifras (precios y stock
 * incluidos, igual que gastos) va al privado de quien pregunto. QUE ve cada
 * rol no cambia; solo DONDE se le contesta.
 */
const EN_GRUPO_VA_POR_PRIVADO = true

export function permisoDeConsulta(actor: ActorBot, consulta: ConsultaBot): PermisoDeConsulta {
  const privado = EN_GRUPO_VA_POR_PRIVADO
  if (actor.rol === 'ADMIN') {
    // Norman y Kevin igual: Kevin "consulta todo lo que consulta Norman".
    return { ok: true, alcance: 'todo', privado }
  }
  // WP-6: el trabajador pregunta precios; ninguna cifra agregada.
  if (actor.rol === ROL_TRABAJADOR) {
    return consulta === 'precios' ? { ok: true, alcance: 'propio', privado } : { ok: false }
  }
  if (consulta === 'ventas' || consulta === 'produccion' || consulta === 'gastos') return { ok: false }
  if (actor.rol === 'DST') return { ok: true, alcance: 'red', privado }
  if (actor.rol === 'LOC') return { ok: true, alcance: 'propio', privado }
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
