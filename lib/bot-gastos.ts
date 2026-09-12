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
 * ─── POR QUE `Insumos` NO ESTA, contra lo que decia PROMPT 21 ───────────────
 *
 * D-E32 decidio "la categoria es `Insumos`, `Compra_Insumos` queda muerta". Esa
 * decision se tomo creyendo que las dos eran categorias de `GASTO_OPERATIVO`.
 * **No lo son, y se midio:**
 *
 *   - `COMPRA_INSUMOS | Insumos` — 18 filas, y escriben `id_cuenta_origen`
 *     (con `id_cuenta_destino` NULL).
 *   - `GASTO_OPERATIVO | Compra_Insumos` — 1 fila, y escribe
 *     `id_cuenta_destino` (con `id_cuenta_origen` NULL).
 *
 * Son **dos tipos de movimiento con forma distinta**, no dos nombres de lo
 * mismo. El bot escribe `GASTO_OPERATIVO`, o sea `id_cuenta_destino`: por ese
 * camino `Insumos` es inalcanzable sin cambiar que columna se llena. Comprar
 * insumos por chat es otra fase, no un renglon de esta lista.
 *
 * `Ajuste_Caja` tampoco entra: su unica fila esta ANULADA y es un ajuste
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
  'Gastos_Personales_Socio'
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
  Gastos_Personales_Socio: 'retiros y gastos personales de un socio'
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
export function normalizarCategoriaBot(sugerida: unknown): string {
  const limpia = String(sugerida ?? '').trim()
  const encontrada = CATEGORIAS_GASTO_BOT.find((c) => c === limpia)
  return encontrada ?? CATEGORIA_SIN_CATEGORIZAR_BOT
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
  'monto',
  'status',
  'tipo_movimiento',
  'usuario_creador'
] as const

export interface PayloadGasto {
  tipo_movimiento: 'GASTO_OPERATIVO'
  categoria: string
  categoria_gasto: null
  descripcion: string
  monto: number
  fecha_movimiento: string
  id_cuenta_destino: string
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
  identidad: { idCuentaDestino: string; etiqueta: string },
  ahora: Date
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

  const categoria = normalizarCategoriaBot(propuesta.categoria)
  const faltaCategoria = categoria === CATEGORIA_SIN_CATEGORIZAR_BOT
  if (faltaCategoria) {
    avisos.push(
      'No pude ubicar la categoria, asi que entra como SIN_CATEGORIZAR ' +
        'y queda en la cola para clasificarla. El gasto SI se registra.'
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
    avisos,
    payload: {
      tipo_movimiento: 'GASTO_OPERATIVO',
      categoria,
      // NUNCA la descripcion aqui. `app/api/finanzas/nuevo/route.ts:155` si lo
      // hace (`categoria_gasto: descripcion ?? subcategoria`) y es la mitad del
      // agujero fiscal; el bot no hereda esa ambiguedad.
      categoria_gasto: null,
      descripcion,
      monto: montoRedondeado,
      fecha_movimiento: fecha.toISOString(),
      id_cuenta_destino: identidad.idCuentaDestino,
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

  const lineas = [
    'Esto es lo que voy a escribir. Revisalo:',
    '',
    `MONTO:      $${monto}`,
    `CATEGORIA:  ${payload.categoria}`,
    `CONCEPTO:   ${payload.descripcion}`,
    `FECHA:      ${dia}`,
    '',
    `(fijo, no lo elegi yo: sale de ${contexto.nombreEntidad}, cuenta ${contexto.nombreCuenta})`
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
