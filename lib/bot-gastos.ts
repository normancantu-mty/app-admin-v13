/**
 * AG-01 Fase 1 — La logica pura del bot de gastos.
 *
 * Aqui vive todo lo que se decide SIN base de datos: la lista cerrada de
 * categorias, el sellado del borrador, el raspado del texto que mueve el
 * pasivo fiscal y la deteccion de duplicados. Puro a proposito: es lo unico
 * que `npm test` puede vigilar de verdad.
 *
 * EL PRINCIPIO QUE ORDENA EL ARCHIVO, y que sale de D-E30 paso 5:
 * **el LLM propone un objeto; de aqui en adelante nadie lo vuelve a generar.**
 * Se normaliza contra listas cerradas, se sella, se ensena, y lo que se
 * escribe es ese objeto exacto.
 */

import { createHash } from 'node:crypto'

// ============================================================================
// 1. LA LISTA CERRADA
// ============================================================================

/**
 * Las categorias que el bot puede escribir. **Medidas contra produccion el
 * 2026-09-12**, no copiadas de un `.md`.
 *
 * ─── `Insumos` SI ESTA, Y ESCRIBE OTRA COLUMNA ──────────────────────────────
 *
 * Norman, 2026-09-12: *"Solamente dejalo como insumos, no hay por que
 * duplicarlo."* Cierra D-E32 **con el hallazgo medido encima**, que era lo que
 * faltaba:
 *
 *   - `COMPRA_INSUMOS | Insumos` — 18 filas, escriben `id_cuenta_origen`
 *     (13 de 14 activas salen de Efectivo).
 *   - `GASTO_OPERATIVO | Compra_Insumos` — 1 fila suelta, escribe
 *     `id_cuenta_destino`.
 *
 * No son dos nombres de lo mismo: son **dos formas de fila**. La decision es
 * que el nombre unico es `Insumos`, y que el bot lo escribe con SU forma —
 * `COMPRA_INSUMOS` y la cuenta en `id_cuenta_origen`, porque el dinero SALE.
 * `Compra_Insumos` no se ofrece ni se acepta como entrada. La fila historica
 * no se toca: su forma es real y reescribirle la etiqueta seria mentir sobre
 * lo que fue.
 *
 * `Ajuste_Caja` sigue fuera: su unica fila esta ANULADA y es un ajuste
 * contable, no un gasto que alguien captura desde la planta.
 *
 * Lo que no mapea **no se adivina**: entra como `SIN_CATEGORIZAR` con aviso
 * W14 y lo clasifica un humano despues. Perder la etiqueta es barato; perder
 * el gasto es lo que lleva costando desde el 2026-06-09.
 */
export const CATEGORIAS_GASTO_BOT = [
  'Marketing_y_Relaciones',
  'Servicios_Basicos',
  'Logistica_Envios',
  'Nomina_y_Honorarios',
  'Gastos_Personales_Socio',
  'Insumos'
] as const

export type CategoriaGastoBot = (typeof CATEGORIAS_GASTO_BOT)[number]

export const CATEGORIA_SIN_CATEGORIZAR_BOT = 'SIN_CATEGORIZAR'

/**
 * Que le decimos a la persona que significa cada categoria. El LLM recibe esta
 * misma tabla como vocabulario: elige de aqui o no elige.
 */
export const AYUDA_CATEGORIAS: Record<CategoriaGastoBot, string> = {
  Marketing_y_Relaciones: 'publicidad, redes, disenio, muestras, atenciones',
  Servicios_Basicos: 'luz, agua, internet, telefono, renta, software',
  Logistica_Envios: 'gasolina, casetas, paqueteria, fletes, viaticos de ruta',
  Nomina_y_Honorarios: 'sueldos, honorarios, pagos a terceros por trabajo',
  Gastos_Personales_Socio: 'retiros y gastos personales de un socio',
  Insumos: 'materia prima, agave, botella, corcho, etiqueta, todo lo que entra al producto'
}

/**
 * La FORMA DE FILA de cada categoria. **No se infiere del nombre** — ese fue
 * exactamente el error de D-E32 (E-237): se dedujo el tipo de movimiento de
 * como se llamaba la categoria, en vez de medir que columna escribe.
 *
 * `columna` dice donde va la cuenta de la identidad: `destino` cuando el
 * dinero entra al concepto de gasto, `origen` cuando SALE de la cuenta para
 * comprar algo. Una sola cuenta en la identidad, dos significados segun el
 * tipo, y la confirmacion se lo dice a la persona en palabras.
 */
export const FORMA_DE_FILA: Record<
  string,
  { tipo: 'GASTO_OPERATIVO' | 'COMPRA_INSUMOS'; columna: 'origen' | 'destino' }
> = {
  Insumos: { tipo: 'COMPRA_INSUMOS', columna: 'origen' }
}

export const FORMA_POR_DEFECTO = {
  tipo: 'GASTO_OPERATIVO' as const,
  columna: 'destino' as const
}

export function formaDeFila(
  categoria: string,
  catalogo?: readonly { nombre: string; tipo_movimiento: 'GASTO_OPERATIVO' | 'COMPRA_INSUMOS'; columna: 'origen' | 'destino' }[]
) {
  const delCatalogo = catalogo?.find((c) => c.nombre === categoria)
  if (delCatalogo) return { tipo: delCatalogo.tipo_movimiento, columna: delCatalogo.columna }
  return FORMA_DE_FILA[categoria] ?? FORMA_POR_DEFECTO
}

/**
 * Normaliza lo que propuso el LLM contra la lista cerrada.
 *
 * **Empata exacto y nada mas.** Nada de "se parece a", nada de distancia de
 * edicion: si el modelo devuelve algo que no esta en la lista, la respuesta
 * correcta es el centinela, no el vecino mas cercano. Adivinar la categoria es
 * exactamente lo que produce las 20 variantes de texto libre que ya tiene
 * `categoria_gasto` en produccion (`gas`/`Gas`, `publicidad`/`Publicidad`...).
 */
export interface CategoriaDelCatalogo {
  nombre: string
  ayuda?: string
  tipo_movimiento: 'GASTO_OPERATIVO' | 'COMPRA_INSUMOS'
  columna: 'origen' | 'destino'
}

/**
 * El catalogo semilla, derivado de las constantes de arriba. **Es el respaldo,
 * no la autoridad**: la lista viva esta en la tabla `bot_categorias` y crece
 * con el uso (Norman, 2026-09-12: *"va a tener que salir con la marcha"*). Si
 * la base no contesta, el bot sigue trabajando con estas seis en vez de
 * quedarse mudo.
 */
export const CATALOGO_SEMILLA: CategoriaDelCatalogo[] = CATEGORIAS_GASTO_BOT.map((nombre) => {
  const forma = FORMA_DE_FILA[nombre] ?? FORMA_POR_DEFECTO
  return {
    nombre: nombre as string,
    ayuda: AYUDA_CATEGORIAS[nombre],
    tipo_movimiento: forma.tipo,
    columna: forma.columna
  }
})

export function normalizarCategoriaBot(
  sugerida: unknown,
  catalogo: readonly CategoriaDelCatalogo[] = CATALOGO_SEMILLA
): string {
  const limpia = String(sugerida ?? '').trim()
  const encontrada = catalogo.find((c) => c.nombre === limpia)
  return encontrada?.nombre ?? CATEGORIA_SIN_CATEGORIZAR_BOT
}

export const TOPE_NOMBRE_CATEGORIA = 40
const FORMA_NOMBRE_CATEGORIA = /^[A-Za-z][A-Za-z0-9_]{2,39}$/

/**
 * Compara nombres ignorando mayusculas y guiones bajos. `Comidas_Y_Viajes` y
 * `comidasyviajes` son **la misma categoria** para efectos de duplicado: si se
 * dejaran convivir, el tablero tendria dos renglones para una sola cosa, que es
 * exactamente el desorden que ya tiene `categoria_gasto` en produccion
 * (`gas`/`Gas`, `publicidad`/`Publicidad`, `Envio Fresnillo`/`envio fresnillo`).
 */
function llaveDeCategoria(nombre: string): string {
  return nombre.toLowerCase().replace(/_/g, '')
}

/**
 * ─── LA PUERTA DE LA CATEGORIA NUEVA ────────────────────────────────────────
 *
 * Que el catalogo crezca solo NO puede significar que el LLM escriba lo que
 * quiera en `categoria`, y la razon es medible, no de principio:
 * **`v_pasivo_fiscal` arma su texto como
 * `categoria || ' ' || categoria_gasto || ' ' || descripcion`**, asi que la
 * columna `categoria` **alimenta al clasificador fiscal**. Una categoria nueva
 * llamada `Pago_IVA_Proveedores` inventaria un pago de impuesto que nadie hizo.
 *
 * Por eso el nombre pasa por aqui **y ademas por un CHECK en la base**: la
 * defensa que solo vive en la aplicacion se salta escribiendo por otro camino.
 */
export function validarCategoriaNueva(
  sugerida: unknown,
  catalogo: readonly CategoriaDelCatalogo[]
): { ok: true; nombre: string } | { ok: false; motivo: string } {
  const nombre = String(sugerida ?? '').trim()
  if (nombre === '') return { ok: false, motivo: 'vacia' }
  if (!FORMA_NOMBRE_CATEGORIA.test(nombre)) {
    return {
      ok: false,
      motivo:
        'el nombre tiene que empezar con letra y usar solo letras, numeros y guion bajo ' +
        `(3 a ${TOPE_NOMBRE_CATEGORIA} caracteres)`
    }
  }
  if (llaveDeCategoria(nombre) === llaveDeCategoria(CATEGORIA_SIN_CATEGORIZAR_BOT)) {
    return { ok: false, motivo: 'ese nombre esta reservado' }
  }
  // El disparador fiscal se busca sobre el TEXTO QUE VA A VER LA VISTA, no
  // sobre el nombre pelado: es la unica comprobacion que mide lo que importa.
  const textoQueVeriaLaVista = `${nombre} ${nombre.replace(/_/g, ' ')}`
  if (disparadoresFiscalesEn(textoQueVeriaLaVista).length > 0) {
    return {
      ok: false,
      motivo: 'ese nombre es justo lo que el ERP lee para dar por pagado un impuesto'
    }
  }
  const yaEsta = catalogo.find((c) => llaveDeCategoria(c.nombre) === llaveDeCategoria(nombre))
  if (yaEsta) return { ok: false, motivo: `ya existe como "${yaEsta.nombre}"` }
  return { ok: true, nombre }
}

// ============================================================================
// 2. EL TEXTO QUE MUEVE EL PASIVO FISCAL
// ============================================================================

/**
 * Las SEIS cadenas exactas que `v_pasivo_fiscal` busca por subcadena sobre
 * `categoria || ' ' || categoria_gasto || ' ' || descripcion` en mayusculas
 * (migracion `20260902223147_vistas_canonicas.sql`, y su gemelo en TypeScript
 * `esPagoImpuestoIva` / `esPagoImpuestoIeps` de `lib/finance-utils.ts`).
 *
 * ─── UNA CORRECCION MEDIDA A PROMPT 21 ──────────────────────────────────────
 * PROMPT 21 decia que un gasto descrito como *"pago del IVA de agosto"* entra
 * al calculo. **No entra**: la subcadena literal es `PAGO IVA`, y
 * `'PAGO DEL IVA DE AGOSTO'` no la contiene. El riesgo es real pero mas
 * estrecho de lo que estaba escrito, y por eso la prueba tiene que usar las
 * frases que SI disparan —"pago IVA de agosto"— y no una que suene parecida.
 * Una prueba con la frase equivocada pasa en verde sin probar nada.
 */
export const DISPARADORES_FISCALES = [
  'FUGA_FISCAL_IVA',
  'FUGA FISCAL IVA',
  'PAGO IVA',
  'FUGA_FISCAL_IEPS',
  'FUGA FISCAL IEPS',
  'PAGO IEPS'
] as const

/** Las que aparecen en este texto. Vacio = el texto es inocuo. */
export function disparadoresFiscalesEn(texto: string): string[] {
  const mayus = String(texto ?? '').toUpperCase()
  return DISPARADORES_FISCALES.filter((d) => mayus.includes(d))
}

/**
 * Deja el texto sin poder mover `v_pasivo_fiscal`, **sin perderlo**.
 *
 * Las tres salidas posibles ante un texto que dispara, y por que esta:
 *
 *   (a) **Rechazar la captura** — pierde el gasto por una palabra. Es
 *       exactamente el error que ERP-59 vino a cerrar: el sistema quedaba
 *       limpio a base de quedarse vacio.
 *   (b) **Dejarlo pasar** — un gasto redactado por un LLM decide un pago de
 *       impuesto que nadie autorizo. Inaceptable.
 *   (c) **Escribirlo desactivado y ensenar que se desactivo.** Es esta.
 *
 * Se parte la cadena con un punto en medio (`PAGO I.V.A.`): sigue siendo
 * legible para un humano y deja de casar con la subcadena. **El texto original
 * NO se tira**: viaja en `datos_capturados` del aviso, y el cambio se le ensena
 * a la persona ANTES de que confirme. Alterar en silencio lo que alguien
 * escribio seria peor que las dos opciones que descartamos.
 */
export function desactivarTextoFiscal(texto: string): string {
  let salida = String(texto ?? '')
  const reemplazos: Array<[string, string]> = [
    ['IEPS', 'I.E.P.S.'],
    ['IVA', 'I.V.A.']
  ]
  for (const [sigla, neutral] of reemplazos) {
    let i = salida.toUpperCase().indexOf(sigla)
    while (i !== -1) {
      salida = salida.slice(0, i) + neutral + salida.slice(i + sigla.length)
      i = salida.toUpperCase().indexOf(sigla, i + neutral.length)
    }
  }
  return salida
}

// ============================================================================
// 3. EL SELLO — idempotency key aplicada a un borrador
// ============================================================================

/**
 * Las llaves del payload que se escriben, EN ESTE ORDEN. El orden es parte del
 * sello: un objeto con las mismas llaves en otro orden tiene que dar el mismo
 * hash, o el sello vigilaria el formato en vez del contenido.
 */
export const LLAVES_PAYLOAD = [
  'categoria',
  'categoria_gasto',
  'descripcion',
  'fecha_movimiento',
  'id_cuenta_destino',
  'id_cuenta_origen',
  'monto',
  'status',
  'tipo_movimiento',
  'usuario_creador'
] as const

export interface PayloadGasto {
  tipo_movimiento: 'GASTO_OPERATIVO' | 'COMPRA_INSUMOS'
  categoria: string
  categoria_gasto: null
  descripcion: string
  monto: number
  fecha_movimiento: string
  // Exactamente UNA de las dos lleva cuenta; la otra va en null. Cual, lo
  // decide `formaDeFila(categoria)` y nunca el LLM. Las dos entran al sello:
  // si no, mover el dinero de columna no cambiaria el hash.
  id_cuenta_destino: string | null
  id_cuenta_origen: string | null
  usuario_creador: string
  status: 'ACTIVO'
}

/**
 * JSON canonico: llaves en el orden fijo de arriba, sin espacios. Es lo unico
 * que se hashea.
 */
export function payloadCanonico(payload: PayloadGasto): string {
  const orden: Record<string, unknown> = {}
  for (const llave of LLAVES_PAYLOAD) {
    orden[llave] = (payload as unknown as Record<string, unknown>)[llave]
  }
  return JSON.stringify(orden)
}

/**
 * El sello. **Se calcula sobre el objeto que se le ensena a la persona**, no
 * sobre el texto que ella escribio ni sobre lo que devolvio el modelo.
 *
 * Es una **idempotency key** aplicada a un borrador — el patron de Stripe. En
 * la literatura de agentes el sellado del payload no tiene nombre propio; se
 * dice asi para no inventar uno.
 */
export function sellarPayload(payload: PayloadGasto): string {
  return createHash('sha256').update(payloadCanonico(payload), 'utf8').digest('hex')
}

/** El sello empata. Si no, no se escribe: se vuelve a proponer. */
export function selloCoincide(payload: PayloadGasto, sello: string): boolean {
  return sellarPayload(payload) === String(sello ?? '').trim().toLowerCase()
}

// ============================================================================
// 4. DUPLICADOS — va en la Fase 1, no despues
// ============================================================================

/**
 * Tres personas habilitadas para capturar el mismo gasto: dos lo van a
 * capturar. Es un cuando, no un si (Q-14 segunda parte).
 */
export const VENTANA_DUPLICADO_HORAS = 6
export const TOLERANCIA_MONTO = 0.05

export interface MovimientoReciente {
  id: string
  monto: number
  categoria: string | null
  descripcion: string | null
  fecha_movimiento: string
  usuario_creador: string | null
}

/**
 * El parecido reciente, si lo hay. Mismo monto +-5%, misma categoria, dentro de
 * la ventana. **Avisa, no bloquea**: dos gastos iguales el mismo dia son
 * perfectamente posibles (dos cargas de gasolina), y bloquearlos ensenaria a la
 * gente a pelearse con el bot.
 */
export function buscarDuplicado(
  candidato: { monto: number; categoria: string },
  recientes: readonly MovimientoReciente[],
  ahora: Date
): MovimientoReciente | null {
  const limite = ahora.getTime() - VENTANA_DUPLICADO_HORAS * 60 * 60 * 1000
  const piso = candidato.monto * (1 - TOLERANCIA_MONTO)
  const techo = candidato.monto * (1 + TOLERANCIA_MONTO)

  const parecidos = recientes.filter((m) => {
    if (m.categoria !== candidato.categoria) return false
    if (Number(m.monto) < piso || Number(m.monto) > techo) return false
    return new Date(m.fecha_movimiento).getTime() >= limite
  })

  if (parecidos.length === 0) return null
  // El mas reciente: es el que la persona puede reconocer.
  return parecidos.reduce((a, b) =>
    new Date(a.fecha_movimiento) > new Date(b.fecha_movimiento) ? a : b
  )
}

// ============================================================================
// 5. LA PUERTA: lo que devuelve el LLM se normaliza aqui y en ningun otro lado
// ============================================================================

export interface PropuestaLLM {
  monto?: unknown
  categoria?: unknown
  descripcion?: unknown
  fecha?: unknown
}

export interface ResultadoNormalizacion {
  ok: true
  payload: PayloadGasto
  /** Lo que hubo que tocar, para ensenarselo a la persona ANTES del "va". */
  avisos: string[]
  /** El texto tal cual lo dijo la persona. Viaja al aviso, no a la fila. */
  descripcionOriginal: string
  faltaCategoria: boolean
  /**
   * El nombre de la categoria que NO existia y que se creara si la persona dice
   * "va". `null` cuando la categoria ya estaba en el catalogo. Viaja fuera del
   * payload a proposito: la fila es la misma se cree o no la categoria, y el
   * confirmar decide mirando el catalogo, no creyendole a esta bandera.
   */
  categoriaNueva: string | null
}
export interface NormalizacionFallida {
  ok: false
  error: string
}

export const TOPE_DESCRIPCION = 300
export const TOPE_MONTO = 500000

/**
 * Convierte lo que devolvio el modelo en la fila exacta que se va a escribir.
 *
 * **Nada de lo que el LLM manda llega crudo a la base.** El monto se re-parsea a
 * numero, la categoria se empata contra la lista cerrada, la descripcion se
 * acota y se desactiva fiscalmente, y los tres campos que decide el sistema
 * —cuenta, autor, status— **ni siquiera se leen de la propuesta**: entran por
 * parametro desde la identidad. Es el patron que en el ecosistema ruso llaman
 * **AI-Gateway**: el modelo elige CUAL, nunca COMO se escribe.
 */
export function normalizarPropuesta(
  propuesta: PropuestaLLM,
  identidad: { idCuenta: string; etiqueta: string },
  ahora: Date,
  catalogo: readonly CategoriaDelCatalogo[] = CATALOGO_SEMILLA
): ResultadoNormalizacion | NormalizacionFallida {
  const avisos: string[] = []

  const monto = Number(propuesta.monto)
  if (!Number.isFinite(monto) || monto <= 0) {
    return { ok: false, error: 'No entendi de cuanto fue el gasto.' }
  }
  if (monto > TOPE_MONTO) {
    return {
      ok: false,
      error:
        `Un gasto de ${monto} pesos por chat no: el tope es ${TOPE_MONTO}. ` +
        'Si es correcto, se captura en la pantalla.'
    }
  }
  // Dos decimales, siempre. Un monto con mas decimales se sella distinto cada
  // vez que alguien lo re-imprime y el sello dejaria de empatar consigo mismo.
  const montoRedondeado = Math.round(monto * 100) / 100

  // ── LA CATEGORIA, EN DOS PASOS ──────────────────────────────────────────
  // 1) empata exacto contra el catalogo vivo. 2) SOLO si no empato, se mira si
  // el modelo propuso una categoria NUEVA, y esa pasa por su propia puerta.
  // El orden importa: una categoria nueva jamas puede pisar a una existente.
  let categoria = normalizarCategoriaBot(propuesta.categoria, catalogo)
  let categoriaNueva: string | null = null

  if (categoria === CATEGORIA_SIN_CATEGORIZAR_BOT) {
    const propuestaNueva = (propuesta as Record<string, unknown>).categoria_nueva
    if (propuestaNueva != null && String(propuestaNueva).trim() !== '') {
      const juicio = validarCategoriaNueva(propuestaNueva, catalogo)
      if (juicio.ok) {
        categoria = juicio.nombre
        categoriaNueva = juicio.nombre
      } else {
        avisos.push(
          `El modelo propuso la categoria "${String(propuestaNueva).trim()}" y no la acepto: ` +
            `${juicio.motivo}. Entra como SIN_CATEGORIZAR.`
        )
      }
    }
  }

  const forma = formaDeFila(categoria, catalogo)
  const faltaCategoria = categoria === CATEGORIA_SIN_CATEGORIZAR_BOT
  if (faltaCategoria) {
    avisos.push(
      'No pude ubicar la categoria, asi que entra como SIN_CATEGORIZAR ' +
        'y queda en la cola para clasificarla. El gasto SI se registra.'
    )
  }
  if (categoriaNueva) {
    avisos.push(
      `"${categoriaNueva}" es una categoria NUEVA: hoy no existe. Si das VA, ` +
        'queda creada y desde entonces el bot la puede usar sola.'
    )
  }

  const descripcionOriginal = String(propuesta.descripcion ?? '').trim().slice(0, TOPE_DESCRIPCION)
  if (descripcionOriginal === '') {
    return { ok: false, error: 'No entendi en que fue el gasto.' }
  }

  let descripcion = descripcionOriginal
  const disparadores = disparadoresFiscalesEn(descripcionOriginal)
  if (disparadores.length > 0) {
    descripcion = desactivarTextoFiscal(descripcionOriginal)
    avisos.push(
      `Tu texto trae "${disparadores.join('", "')}", que es justo lo que el ERP lee ` +
        `para dar por pagado un impuesto. Lo voy a guardar como "${descripcion}" para que ` +
        'no mueva el pasivo fiscal. Tu texto original queda completo en la cola de avisos.'
    )
  }

  // La fecha: si el modelo no la resuelve, hoy. Nunca en el futuro — un gasto
  // con fecha futura desaparece de todo filtro "hasta hoy" (mismo razonamiento
  // que el aviso W11).
  let fecha = ahora
  const propuestaFecha = String(propuesta.fecha ?? '').trim()
  if (propuestaFecha !== '') {
    const parseada = new Date(propuestaFecha)
    if (!Number.isNaN(parseada.getTime())) {
      fecha = parseada > ahora ? ahora : parseada
      if (parseada > ahora) avisos.push('La fecha que entendi es futura; la anclo a hoy.')
    }
  }

  return {
    ok: true,
    descripcionOriginal,
    faltaCategoria,
    categoriaNueva,
    avisos,
    payload: {
      tipo_movimiento: forma.tipo,
      categoria,
      // NUNCA la descripcion aqui. `app/api/finanzas/nuevo/route.ts:155` si lo
      // hace (`categoria_gasto: descripcion ?? subcategoria`) y es la mitad del
      // agujero fiscal; el bot no hereda esa ambiguedad.
      categoria_gasto: null,
      descripcion,
      monto: montoRedondeado,
      fecha_movimiento: fecha.toISOString(),
      id_cuenta_destino: forma.columna === 'destino' ? identidad.idCuenta : null,
      id_cuenta_origen: forma.columna === 'origen' ? identidad.idCuenta : null,
      usuario_creador: `telegram:${identidad.etiqueta}`,
      status: 'ACTIVO'
    }
  }
}

// ============================================================================
// 6. EL MENSAJE DE CONFIRMACION
// ============================================================================

/**
 * Lo que lee la persona antes de decir "va".
 *
 * ─── POR QUE REPITE LOS VALORES Y NO LOS RESUME ─────────────────────────────
 * **Automation bias.** Un boton de confirmar sin friccion se vuelve reflejo: en
 * un estudio con radiologos la precision cae de 82% a 45% cuando confian en una
 * sugerencia de IA incorrecta (arXiv 2502.10036). Un mensaje tipo *"listo para
 * registrar tu gasto de gasolina?"* se aprueba reconociendo el patron, sin
 * leer. Repetir el monto, la categoria y la fecha en texto plano obliga a
 * LEER, que es lo unico que hace de la confirmacion una revision.
 *
 * Se muestran **solo los campos inferidos** (D-E30 paso 3). La cuenta y el
 * autor van como contexto fijo y marcados como tales: no son campos que el
 * modelo haya elegido, salen de la identidad — y por eso pueden ir ahi sin
 * quitarle revision a nadie.
 */
export function mensajeDeConfirmacion(
  payload: PayloadGasto,
  contexto: { nombreCuenta: string; nombreEntidad: string },
  avisos: readonly string[],
  duplicado: MovimientoReciente | null
): string {
  const fecha = new Date(payload.fecha_movimiento)
  const dia = `${String(fecha.getDate()).padStart(2, '0')}/${String(fecha.getMonth() + 1).padStart(2, '0')}/${fecha.getFullYear()}`
  const monto = payload.monto.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  // La direccion del dinero, en palabras. Un `COMPRA_INSUMOS` descuenta de la
  // cuenta y un `GASTO_OPERATIVO` se asienta contra ella: son columnas
  // distintas del ledger, y quien confirma tiene que poder ver cual de las dos
  // va a moverse sin saber que existe una columna.
  const flecha =
    payload.tipo_movimiento === 'COMPRA_INSUMOS' ? '(el dinero SALE de aqui)' : '(se asienta aqui)'

  const lineas = [
    'Esto es lo que voy a escribir. Revisalo:',
    '',
    `MONTO:      $${monto}`,
    `CATEGORIA:  ${payload.categoria}`,
    `CONCEPTO:   ${payload.descripcion}`,
    `FECHA:      ${dia}`,
    `CUENTA:     ${contexto.nombreCuenta} ${flecha}`,
    '',
    `(la cuenta no la elige el modelo: sale de tu alta en ${contexto.nombreEntidad}, y si esta mal la cambias con el boton)`
  ]

  if (duplicado) {
    const cuando = new Date(duplicado.fecha_movimiento)
    const hace = Math.max(1, Math.round((Date.now() - cuando.getTime()) / 60000))
    const quien = (duplicado.usuario_creador ?? 'alguien').replace('telegram:', '')
    lineas.push(
      '',
      `OJO: hace ${hace} minuto(s) ${quien} registro $${Number(duplicado.monto).toLocaleString('es-MX', { minimumFractionDigits: 2 })} ` +
        `en ${duplicado.categoria}. Es el mismo o es otro?`
    )
  }

  for (const aviso of avisos) lineas.push('', `OJO: ${aviso}`)

  lineas.push('', 'Contesta VA para escribirlo, o dime que cambio.')
  return lineas.join('\n')
}
