/**
 * AG-01 — La identidad de servicio del bot, y su puerta de entrada.
 *
 * **No lleva `'use server'` a proposito** (misma razon que `lib/server-session.ts`
 * y `lib/avisos-server.ts`): en un archivo `'use server'` toda exportacion se
 * vuelve un endpoint invocable desde el navegador. Esto no lo debe poder
 * llamar nadie desde fuera.
 *
 * POR QUE `service_role` Y NO UNA SESION: un `telegram_id` no trae ni correo de
 * sesion ni `auth_id`, y `mi_entidad_id()` resuelve SOLO por `auth_id` desde el
 * 20260903043244. El bot no puede tener sesion de usuario sin inventarle una
 * cuenta de auth a cada persona de planta, que es exactamente el rol nuevo que
 * AG-02 prohibe. Entra con identidad de servicio y la autorizacion la hace este
 * archivo, fila por fila, contra `bot_identidades`.
 *
 * El trigger `tg_forzar_autor` respeta `usuario_creador` cuando no hay JWT de
 * sesion (verificado en la migracion 20260903043105, linea 167: sin email de
 * sesion hace `COALESCE(NULLIF(BTRIM(NEW.usuario_creador),''), 'sistema')`).
 * **Por eso el bot SI puede marcar `telegram:<quien>` y que sobreviva.**
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { CATALOGO_SEMILLA, type CategoriaDelCatalogo } from '@/lib/bot-gastos'
import { aCentavos, aPesos, netearAbonosSinPedido } from '@/lib/abonos'
import type { TicketAbierto } from '@/lib/bot-abonos'
import type { CompradorDeVenta, ProductoConPrecios } from '@/lib/bot-venta'
import type { FormatoDeBotella, InsumoDelCatalogo } from '@/lib/bot-lotes'
import { esCompradorSeleccionable } from '@/lib/avisos'
import { fetchTodasLasFilas } from '@/lib/paginacion'

/** Un pedido a concesion tal como sale del ledger, antes de netear. Ver ERP-25. */
interface TicketAbiertoRow {
  id: string
  fecha_transaccion: string | null
  total_cobrado_real: number | null
  condicion_pago: string | null
  status: string | null
}

export type ClienteServicio = SupabaseClient<Database>

export function clienteDeServicio(): ClienteServicio {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Falta NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

/**
 * El secreto compartido entre el proceso del bot y la app. Es lo unico que
 * separa estos endpoints de internet, asi que se compara **completo y en
 * tiempo constante-ish**: nunca con `startsWith`, nunca por prefijo.
 *
 * Si `BOT_API_TOKEN` no esta definido, la puerta queda **cerrada**, no abierta.
 * Un secreto ausente no es "modo desarrollo": es la unica configuracion en la
 * que un olvido se convierte en un endpoint publico de escritura al ledger.
 */
export function tokenValido(request: Request): boolean {
  const esperado = process.env.BOT_API_TOKEN
  if (!esperado || esperado.length < 24) return false
  const recibido = request.headers.get('x-bot-token') ?? ''
  if (recibido.length !== esperado.length) return false
  let diferencia = 0
  for (let i = 0; i < esperado.length; i++) {
    diferencia |= esperado.charCodeAt(i) ^ recibido.charCodeAt(i)
  }
  return diferencia === 0
}

export interface CuentaDelBot {
  id: string
  nombre: string
}

export interface IdentidadBot {
  idEntidad: string
  /**
   * La cuenta contra la que se asienta. **Una sola, y su significado depende
   * del tipo de movimiento**: destino en un gasto, origen en una compra de
   * insumos. Lo decide `formaDeFila()`, nunca el LLM.
   */
  idCuenta: string
  etiqueta: string
  nombreEntidad: string
  /**
   * El rol de la entidad (`ADMIN`, `DST`, `LOC`). **Solo lo usa la Fase 3**,
   * y decide el ALCANCE de una consulta: `ADMIN` ve todo, cualquier otro ve
   * solo lo suyo. Se trae aqui, con la identidad, para que ningun endpoint
   * tenga que volver a preguntarlo — un alcance que se recalcula en dos
   * lugares es un alcance que algun dia discrepa.
   */
  rolEntidad: string
  nombreCuenta: string
  /**
   * Las OTRAS cuentas de la misma entidad que el bot puede usar. Es una lista
   * cerrada calculada en el servidor: el boton "cambiar cuenta" elige de aqui
   * por indice, asi que ni el modelo ni el proceso del bot pueden nombrar una
   * cuenta que este vetada o que sea de otra entidad.
   *
   * Existe porque el default no puede ser correcto: medido el 2026-09-12, los
   * gastos activos se reparten 10/10 entre Cuenta personal y Efectivo. Un
   * default fijo estaria mal la mitad de las veces, y una confirmacion que hay
   * que cancelar la mitad de las veces se vuelve reflejo (automation bias).
   */
  cuentas: CuentaDelBot[]
}

/**
 * Los mismos tres vetos que `cuentaVetadaComoDefault` (lib/avisos.ts) y que el
 * trigger `tg_bot_vetar_cuenta_fiscal`, aplicados aqui porque esta lista es lo
 * que se le ofrece a la persona. Repetido a proposito en las tres capas: el
 * veto barato se paga tres veces, la fuga fiscal una sola y no se deshace.
 */
export function cuentaUsableporElBot(c: { nombre: string | null; tipo_fiscalidad: string | null }): boolean {
  const nombre = (c.nombre ?? '').toLowerCase()
  if (nombre.includes('fresnillo')) return false
  if ((c.tipo_fiscalidad ?? '').toUpperCase() === 'FULL_TAX') return false
  return true
}

/**
 * Resuelve un `telegram_id` a una entidad del ERP. **`null` si no esta dado de
 * alta, y eso significa que no escribe nada.** No hay auto-registro: el alta la
 * hace Norman a mano, 15 filas en total (Q-14). Que sea manual es una ventaja
 * de seguridad — nadie se auto-asigna una entidad.
 */
export async function resolverIdentidad(
  supabase: ClienteServicio,
  telegramId: number
): Promise<IdentidadBot | null> {
  const { data, error } = await supabase
    .from('bot_identidades')
    .select('etiqueta, id_entidad, id_cuenta_destino, activo')
    .eq('telegram_id', telegramId)
    .eq('activo', true)
    .maybeSingle()

  if (error || !data) return null

  const [entidad, cuentas] = await Promise.all([
    supabase.from('entidades').select('nombre, rol').eq('id', data.id_entidad).maybeSingle(),
    supabase
      .from('cuentas_financieras')
      .select('id, nombre, tipo_fiscalidad')
      .eq('id_entidad', data.id_entidad)
  ])

  const usables = (cuentas.data ?? []).filter(cuentaUsableporElBot)
  const nombreCuenta = usables.find((c) => c.id === data.id_cuenta_destino)?.nombre ?? '(cuenta)'

  return {
    idEntidad: data.id_entidad,
    idCuenta: data.id_cuenta_destino,
    etiqueta: data.etiqueta,
    nombreEntidad: entidad.data?.nombre ?? '(entidad)',
    // Si la lectura fallo, el rol por defecto es el MAS restrictivo. Un
    // default permisivo convierte un error de red en una fuga de datos.
    rolEntidad: entidad.data?.rol ?? 'DESCONOCIDO',
    nombreCuenta,
    cuentas: usables.map((c) => ({ id: c.id, nombre: c.nombre ?? '(cuenta)' }))
  }
}

/**
 * El catalogo VIVO de categorias. Si la base no contesta, devuelve la semilla
 * en vez de una lista vacia: una lista vacia mandaria **todo** a
 * `SIN_CATEGORIZAR` en silencio, que es peor que trabajar con seis categorias.
 */
export async function leerCatalogo(
  supabase: ClienteServicio
): Promise<CategoriaDelCatalogo[]> {
  const { data, error } = await supabase
    .from('bot_categorias')
    .select('nombre, ayuda, tipo_movimiento, columna')
    .eq('activa', true)
    .order('nombre')

  if (error || !data || data.length === 0) {
    if (error) console.error('[bot] no pude leer bot_categorias, uso la semilla:', error)
    return CATALOGO_SEMILLA
  }
  return data.map((c) => ({
    nombre: c.nombre,
    ayuda: c.ayuda ?? '',
    tipo_movimiento: c.tipo_movimiento as 'GASTO_OPERATIVO' | 'COMPRA_INSUMOS',
    columna: c.columna as 'origen' | 'destino'
  }))
}


// ============================================================================
// AG-02 Fase 2 — las dos lecturas que comparten proponer y confirmar
// ============================================================================

export interface CuentaDelDeudor {
  ok: true
  idCuenta: string
  nombre: string
}

export interface CuentaDelDeudorFallida {
  ok: false
  motivo: string
}

/**
 * La cuenta propia del deudor: la que va en `id_cuenta_origen` de un abono.
 *
 * La regla que reproduce (`app/actions/abonos.ts`): en un `ABONO_DEUDA` la
 * cuenta que NO es de ADMIN tiene que pertenecer a la entidad del movimiento.
 * Verificado contra las 36 filas historicas del formulario: origen es siempre
 * `Efectivo (<deudor>)` y destino la cuenta ADMIN de CEO Admin.
 *
 * **Si no hay exactamente una, NO se adivina.** Medido el 2026-09-12, los 9
 * deudores con saldo tienen una sola cuenta cada uno, asi que la ambiguedad no
 * existe hoy; construir un selector para un caso que no ocurre es lo que la
 * puerta ofensiva mata [Filtro: DOC02 - YAGNI]. El dia que ocurra, esto se
 * detiene con un mensaje que nombra las cuentas en vez de escribir en una.
 */
export async function leerCuentaDelDeudor(
  supabase: ClienteServicio,
  idEntidad: string
): Promise<CuentaDelDeudor | CuentaDelDeudorFallida> {
  const { data, error } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre, tipo_fiscalidad')
    .eq('id_entidad', idEntidad)

  if (error) return { ok: false, motivo: 'no pude leer sus cuentas: ' + error.message }

  const usables = (data ?? []).filter(cuentaUsableporElBot)
  if (usables.length === 0) {
    return {
      ok: false,
      motivo:
        (data ?? []).length === 0
          ? 'no tiene ninguna cuenta dada de alta, y el abono necesita de donde sale el dinero'
          : 'sus cuentas estan vetadas por la regla fiscal'
    }
  }
  if (usables.length > 1) {
    const nombres = usables.map((c) => '"' + (c.nombre ?? '(sin nombre)') + '"').join(', ')
    return {
      ok: false,
      motivo: 'tiene mas de una cuenta (' + nombres + ') y no voy a adivinar cual. Captúralo en la pantalla'
    }
  }
  return { ok: true, idCuenta: usables[0].id, nombre: usables[0].nombre ?? '(cuenta)' }
}

/**
 * Los pedidos en concesion con saldo, del mas antiguo al mas nuevo.
 *
 * Replica `cargarTicketsPendientes` de `app/actions/abonos.ts` — que no se puede
 * llamar desde aqui porque vive en un archivo `'use server'` que exige sesion de
 * operador. **Mismo criterio, a proposito**: `total_cobrado_real` menos lo ya
 * aplicado, contando los `ABONO_DEUDA` no anulados **incluidos los pendientes de
 * aprobacion** (un abono pendiente ya reclamo ese pedido; sin contarlo, dos
 * capturas seguidas propondrian pagar dos veces el mismo ticket).
 *
 * ⚠️ DISCREPANCIA CONOCIDA, medida el 2026-09-12 y DOCUMENTADA, no parchada:
 * `v_cartera` usa `monto_base_ingreso` para los DST y `total_cobrado_real` para
 * los LOC; esto usa `total_cobrado_real` siempre, igual que la accion original.
 * Hoy las dos columnas dan el MISMO numero en los 9 deudores con saldo, asi que
 * no muerde. El dia que difieran, la propuesta por pedido y el total de la
 * cartera van a discrepar — y el lugar de arreglarlo es la accion original, no
 * una copia del bot que se desvie de ella.
 */
export async function leerTicketsAbiertos(
  supabase: ClienteServicio,
  idEntidad: string
): Promise<TicketAbierto[]> {
  // ERP-25: las tres lecturas van paginadas, igual que su gemela
  // `cargarTicketsPendientes` en `app/actions/abonos.ts`. Un bot que propone
  // cobrar sobre un ledger truncado ofrece pedidos ya pagados.
  const tickets = await fetchTodasLasFilas<TicketAbiertoRow>(
    () =>
      supabase
        .from('transacciones_tickets')
        .select('id, fecha_transaccion, total_cobrado_real, condicion_pago, status')
        .eq('id_comprador', idEntidad)
        .eq('condicion_pago', 'CONCESION')
        .in('status', ['ACTIVO', 'APPROVED'])
        .order('fecha_transaccion', { ascending: true }),
    'No se pudieron leer los pedidos'
  )

  if (!tickets.length) return []

  const aplicadosRaw = await fetchTodasLasFilas<{ id_ticket: string | null; monto: number | null }>(
    () =>
      supabase
        .from('finanzas_ledger')
        .select('id_ticket, monto')
        .in('id_ticket', tickets.map((t) => t.id))
        .eq('tipo_movimiento', 'ABONO_DEUDA')
        .in('status', ['ACTIVO', 'APPROVED']),
    'No se pudo leer lo ya aplicado'
  )

  // ── El dinero que se cobro SIN decir de que pedido era ───────────────────
  // Sin esto el reparto cree que hay pedidos abiertos que la cartera ya da por
  // cobrados: 7 de 9 deudores el 2026-09-12, y en Delirio 85 la diferencia era
  // de $60,716 (E-246). Va a los mas viejos por decision de Norman.
  const aCuentaRaw = await fetchTodasLasFilas<{ monto: number | null }>(
    () =>
      supabase
        .from('finanzas_ledger')
        .select('monto')
        .eq('id_entidad_relacionada', idEntidad)
        .eq('tipo_movimiento', 'ABONO_DEUDA')
        .in('status', ['ACTIVO', 'APPROVED'])
        .is('id_ticket', null),
    'No se pudo leer lo abonado a cuenta'
  )

  const aCuentaCentavos = aCuentaRaw.reduce(
    (total, fila) => total + aCentavos(Number(fila.monto) || 0),
    0
  )

  const aplicado = new Map<string, number>()
  for (const fila of aplicadosRaw) {
    if (!fila.id_ticket) continue
    aplicado.set(fila.id_ticket, (aplicado.get(fila.id_ticket) ?? 0) + aCentavos(Number(fila.monto) || 0))
  }

  // Los saldos CRUDOS, ya en el orden del mas viejo al mas nuevo, y luego el
  // neteo de lo cobrado a cuenta contra los primeros de esa lista.
  const crudos = tickets.map((t) => ({
    id_ticket: t.id,
    saldo_centavos: aCentavos(Number(t.total_cobrado_real) || 0) - (aplicado.get(t.id) ?? 0)
  }))
  const neteados = new Map(
    netearAbonosSinPedido(crudos, aCuentaCentavos).map((t) => [t.id_ticket, t.saldo_centavos])
  )

  const abiertos: TicketAbierto[] = []
  for (const ticket of tickets) {
    const saldoCentavos = neteados.get(ticket.id) ?? 0
    if (saldoCentavos <= 0) continue
    abiertos.push({
      id_ticket: ticket.id,
      fecha: ticket.fecha_transaccion,
      saldo: aPesos(saldoCentavos)
    })
  }
  return abiertos
}

/**
 * El catalogo de TERMINADO con sus precios por zona.
 *
 * **Misma consulta que `app/pos/page.tsx`**, incluido el filtro `tipo` =
 * `'TERMINADO'`: la pasta y los insumos no se venden por el POS y tampoco por
 * chat. Se trae la lista entera —hoy son pocas filas— porque el empate por
 * nombre necesita ver a TODOS los candidatos para poder decir "me da mas de
 * uno"; filtrar en SQL por el nombre dicho convertiria una ambiguedad en un
 * acierto falso.
 */
export async function leerCatalogoDeVenta(
  supabase: ClienteServicio
): Promise<ProductoConPrecios[]> {
  const { data, error } = await supabase
    .from('catalogo_productos')
    .select('id, sku, nombre, ml_por_unidad, listas_precios (zona, precio_final)')
    .eq('tipo', 'TERMINADO')
    .order('nombre', { ascending: true })

  if (error || !data) {
    console.error('[bot] no se pudo leer el catalogo de venta:', error)
    return []
  }

  return data.map((p) => ({
    id: p.id,
    sku: p.sku,
    nombre: p.nombre ?? '(sin nombre)',
    // El tamano viaja desde aqui (D37, 2026-09-19). La columna ya existia y
    // solo la usaba el envasado de lotes; sin ella `750 ml` no empata con
    // `Destilado Plata 750ml` y el bot contesta que no encuentra el producto.
    ml_por_unidad: p.ml_por_unidad === null ? null : Number(p.ml_por_unidad) || null,
    precios: (p.listas_precios ?? []).map((l) => ({
      zona: l.zona ?? '',
      precio_final: Number(l.precio_final) || 0
    }))
  }))
}

/**
 * Los compradores posibles: la red entera menos el centinela.
 *
 * `esCompradorSeleccionable` es la MISMA funcion que usa el desplegable de la
 * pantalla (`lib/avisos.ts`): "PENDIENTE DE ASIGNAR" no es un comprador, es el
 * marcador de las consignaciones sin dueno, y ofrecerlo por chat seria darle a
 * un empate por nombre la oportunidad de elegirlo.
 *
 * Se traen las columnas de la cascada (`comision_base`, `comision_base_local`,
 * `aplica_redondeo_costo`) porque el precio de un DST o un LOC sale de ahi. Sin
 * ellas `calculateWaterfall` devolveria el costo de un distribuidor con comision
 * cero, o sea el precio de publico — mas caro, y en silencio.
 */
export async function leerCompradoresDeVenta(
  supabase: ClienteServicio
): Promise<CompradorDeVenta[]> {
  const { data, error } = await supabase
    .from('entidades')
    .select('id, nombre, rol, zona, comision_base, comision_base_local, aplica_redondeo_costo')
    .order('nombre', { ascending: true })

  if (error || !data) {
    console.error('[bot] no se pudieron leer los compradores:', error)
    return []
  }

  return data.filter(esCompradorSeleccionable).map((e) => ({
    id: e.id,
    nombre: e.nombre ?? '(sin nombre)',
    rol: e.rol ?? '',
    zona: e.zona,
    comision_base: e.comision_base,
    comision_base_local: e.comision_base_local,
    aplica_redondeo_costo: e.aplica_redondeo_costo
  }))
}

/**
 * La cuenta destino, con su `tipo_fiscalidad`.
 *
 * `IdentidadBot.cuentas` no la trae —ahi solo hace falta el nombre para el
 * boton—, y `normalizarVenta` la necesita para ensenar el desglose de impuestos
 * con la misma funcion que `registrarVenta` va a usar al escribir. Devuelve
 * `null` si la cuenta no existe: el endpoint ya comprobo que este en la lista
 * cerrada de la identidad, asi que un `null` aqui es una cuenta borrada entre
 * las dos lecturas y se trata como error, no como LIBRE.
 */
export async function leerCuentaDeVenta(
  supabase: ClienteServicio,
  idCuenta: string
): Promise<{ id: string; nombre: string; tipo_fiscalidad: string } | null> {
  const { data, error } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre, tipo_fiscalidad')
    .eq('id', idCuenta)
    .maybeSingle()

  if (error || !data) return null
  return {
    id: data.id,
    nombre: data.nombre ?? '(cuenta)',
    tipo_fiscalidad: data.tipo_fiscalidad ?? ''
  }
}

/**
 * Los insumos del catalogo, con su unidad.
 *
 * Se trae la lista entera por la misma razon que el catalogo de venta: el
 * empate por nombre necesita ver a todos los candidatos para poder decir "me da
 * mas de uno". La unidad viene porque es lo que se ensena en la confirmacion —
 * "8 kilogramos de Chile Guajillo" se revisa; "8 de Chile Guajillo" no.
 */
export async function leerInsumosDeLote(
  supabase: ClienteServicio
): Promise<InsumoDelCatalogo[]> {
  const { data, error } = await supabase
    .from('catalogo_productos')
    .select('id, sku, nombre, unidad_medida')
    .eq('tipo', 'INSUMO')
    .order('nombre', { ascending: true })

  if (error || !data) {
    console.error('[bot] no se pudieron leer los insumos:', error)
    return []
  }
  return data.map((i) => ({
    id: i.id,
    sku: i.sku,
    nombre: i.nombre ?? '(sin nombre)',
    unidad_medida: i.unidad_medida ?? 'PIEZAS'
  }))
}

/**
 * Los formatos de botella: los TERMINADO que declaran `ml_por_unidad`.
 *
 * El filtro por `ml_por_unidad` no es cosmetico. `lote_envasado` liga litros
 * producidos con botellas, y la vista convierte con esa columna (ERP-84b); un
 * producto sin ml —la pasta, por ejemplo— no se puede envasar desde un lote de
 * destilado, y ofrecerlo seria ofrecer una fila que descuadra el rendimiento.
 */
export async function leerFormatosDeBotella(
  supabase: ClienteServicio
): Promise<FormatoDeBotella[]> {
  const { data, error } = await supabase
    .from('catalogo_productos')
    .select('id, sku, nombre, ml_por_unidad')
    .eq('tipo', 'TERMINADO')
    .not('ml_por_unidad', 'is', null)
    .order('ml_por_unidad', { ascending: false })

  if (error || !data) {
    console.error('[bot] no se pudieron leer los formatos:', error)
    return []
  }
  return data
    .map((p) => ({
      id: p.id,
      sku: p.sku,
      nombre: p.nombre ?? '(sin nombre)',
      ml_por_unidad: Number(p.ml_por_unidad) || 0
    }))
    .filter((f) => f.ml_por_unidad > 0)
}

/**
 * Los codigos de lote que ya existen.
 *
 * Sirve para dos cosas y las dos importan: proponer el siguiente
 * (`codigoSugerido`) y **rechazar por nombre un codigo repetido antes de
 * escribir**. `lotes.codigo_lote` es `unique`, asi que sin esto el choque
 * llegaria como un error de Postgres a mitad de la escritura, cuando la fila
 * del lote ya existe y hay que deshacerla.
 */
export async function leerCodigosDeLote(supabase: ClienteServicio): Promise<string[]> {
  const { data, error } = await supabase.from('lotes').select('codigo_lote')
  if (error || !data) {
    console.error('[bot] no se pudieron leer los codigos de lote:', error)
    return []
  }
  return data.map((l) => l.codigo_lote).filter((c): c is string => typeof c === 'string')
}
