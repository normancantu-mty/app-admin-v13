/**
 * AG-06 FASE 5 — DAR DE ALTA UN DISTRIBUIDOR O UN LOCAL. La logica pura.
 *
 * Aqui no hay base de datos: son listas cerradas, aritmetica de comisiones,
 * texto y el sello. Por eso se prueba entero en el proyecto `puras`. Las
 * escrituras y el permiso viven en `lib/entidad-servidor.ts`, que es la misma
 * frontera que separa `lib/bot-anulacion.ts` de `lib/bot-anulables.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAS COMISIONES: NO ES UNA, SON CUATRO, Y TRES MUEVEN PRECIO (D10)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   `comision_base` ......... del DST, cuando vende EL.
 *   `comision_hijo_local` ... del DST, cuando vende SU LOCAL (comision de red).
 *   `comision_base_local` ... del LOC, siempre que el local vende.
 *   `comision_logistica` .... **no la lee nadie.** Ver `COLUMNA_MUERTA`.
 *
 * Los cinco DST de produccion tienen `comision_base` **y** `comision_hijo_local`
 * distintas de cero (verificado contra produccion el 2026-09-19: 0.20 en los
 * cinco, y 0.15/0.10 respectivamente). Un alta que pregunte una sola deja la
 * otra en 0 sin avisar, y eso es dinero mal repartido desde la primera venta —
 * no un campo vacio que alguien note al entrar a la pantalla.
 *
 * ─── Y TRES TRAMPAS DE CONVERSION QUE MUERDEN EN SILENCIO ───────────────────
 *
 * El normalizador de la app (`normalizeCommission`, `app/actions/distribuidores.ts`)
 * tiene las tres. Esta version las arregla, y por eso NO es un traslado byte a
 * byte como el de la anulacion — la diferencia esta declarada y probada:
 *
 *  1. **La convencion de la base es FRACCION.** 20% se guarda `0.20`. Lo de
 *     dividir entre 100 todo lo mayor que 1 salva a quien dicta "veinte", y se
 *     conserva tal cual.
 *
 *  2. **`1` significa 100%, no 1%.** Y `1` no es mayor que 1, asi que el
 *     normalizador viejo lo deja pasar entero: comision del cien por ciento, el
 *     producto sale gratis. Aqui `1` **no se adivina** — se devuelve `ambigua`
 *     y quien llama pregunta con dos botones. Un default silencioso en este
 *     numero es de los que se descubren cuadrando un mes.
 *
 *  3. **La columna es `numeric(5,2)`: solo caben porcentajes ENTEROS.** Un
 *     12.5% se guarda como `0.13`, o sea 13%. **En este ERP no existe la
 *     comision de medio punto.** El normalizador viejo redondeaba a CUATRO
 *     decimales y por eso nunca se enteraba: quien redondea de verdad es
 *     Postgres, despues, y sin decir nada. Aqui se redondea a los dos que la
 *     columna guarda y se reporta si el numero dictado sobrevivio.
 */

import { sellar, selloEmpata } from '@/lib/bot-sello'

// ============================================================================
// 1. LAS LISTAS CERRADAS (D9)
// ============================================================================

/**
 * `zona` decide **todo el precio del cliente**: no hay lista de precios por
 * entidad, la lista es la tupla `(producto, zona)`. Y el texto tiene que ser
 * exactamente uno de estos dos, sin acento, porque asi esta escrito en
 * `listas_precios` y en `ZONA_PRECIO_CALLE`. Un "Foráneo" transcrito de una
 * nota de voz no encuentra ningun precio.
 *
 * Por eso va **por boton y nunca por transcripcion** (D9).
 */
export const ZONAS = ['Zacatecas', 'Foraneo'] as const
export type Zona = (typeof ZONAS)[number]

/** Los dos unicos roles que se dan de alta por chat. `SOCIO` y `SUB-ADMIN` son
 * de solo lectura y `ADMIN` es la matriz: ninguno se crea hablando. */
export const ROLES_DE_ALTA = ['DST', 'LOC'] as const
export type RolDeAlta = (typeof ROLES_DE_ALTA)[number]

export function esZonaValida(v: unknown): v is Zona {
  return ZONAS.includes(v as Zona)
}

export function esRolDeAlta(v: unknown): v is RolDeAlta {
  return ROLES_DE_ALTA.includes(v as RolDeAlta)
}

export function nombreDelRol(rol: RolDeAlta): string {
  return rol === 'DST' ? 'distribuidor' : 'local'
}

/**
 * `comision_logistica` se escribe y **no la lee nadie**: no entra en
 * `lib/pricing-waterfall.ts`, no entra en `procesarVentaPOS` y no aparece en
 * ninguna regla comercial; solo se muestra en el directorio. Vale 0.00 en las
 * 16 entidades de produccion.
 *
 * Preguntarla por chat seria cobrarle a Norman un turno de conversacion por un
 * numero que no cambia ningun precio. Se escribe 0 y queda anotada en el
 * informe como **candidata a retiro** — que no es lo mismo que borrarla.
 */
export const COLUMNA_MUERTA = 'comision_logistica'

// ============================================================================
// 2. LA COMISION
// ============================================================================

/** La caja con la que se le ensena una comision a una persona. */
export const CAJA_DE_MUESTRA = 600

/** Los decimales que `numeric(5,2)` guarda de verdad. Dos, no cuatro. */
export const DECIMALES_EN_LA_BASE = 2

export interface ComisionNormalizada {
  ok: true
  /** La fraccion que se va a escribir, ya redondeada como la guarda Postgres. */
  fraccion: number
  /** Lo que se entendio ANTES de redondear, para poder decir si cambio. */
  fraccionDicha: number
  /** `false` si el redondeo de `numeric(5,2)` movio el numero. */
  sobreviveElRedondeo: boolean
}

export interface ComisionAmbigua {
  ok: false
  motivo: 'ambigua'
  /** Las dos lecturas posibles, en fraccion, para ofrecerlas como botones. */
  opciones: [number, number]
}

export interface ComisionInvalida {
  ok: false
  motivo: 'invalida'
  error: string
}

export type JuicioDeComision = ComisionNormalizada | ComisionAmbigua | ComisionInvalida

/**
 * El numero dictado, convertido a la fraccion que va a la base.
 *
 * Devuelve `ambigua` en vez de adivinar cuando la lectura no es unica. Ver la
 * trampa 2 del encabezado: un `1` puede ser 1% o 100%, y la diferencia entre
 * esas dos lecturas es que el producto se regale.
 */
export function normalizarComision(valor: unknown): JuicioDeComision {
  const crudo = typeof valor === 'number' ? valor : Number(String(valor ?? '').trim().replace('%', ''))
  if (!Number.isFinite(crudo) || crudo < 0) {
    return { ok: false, motivo: 'invalida', error: 'No lo lei como un porcentaje.' }
  }
  if (crudo > 100) {
    return { ok: false, motivo: 'invalida', error: 'Una comision no puede pasar del 100%.' }
  }

  // TRAMPA 2. El unico numero que se puede leer de dos maneras razonables.
  // El 0 no es ambiguo (es "sin comision") y el 2 tampoco: nadie dice "dos"
  // queriendo decir 200%, y ademas 200% ya lo rechaza la linea de arriba.
  if (crudo === 1) {
    return { ok: false, motivo: 'ambigua', opciones: [0.01, 1] }
  }

  // TRAMPA 1. La convencion de la base es fraccion; "20" se salva dividiendo.
  const dicha = crudo > 1 ? crudo / 100 : crudo

  // TRAMPA 3. `numeric(5,2)` redondea a dos decimales, y quien lo hace es
  // Postgres — despues, y sin avisar. Se hace aqui para que lo que se ensena
  // antes del "va" sea lo que de verdad se va a guardar.
  const fraccion = Math.min(1, Math.max(0, Math.round(dicha * 100) / 100))

  return {
    ok: true,
    fraccion,
    fraccionDicha: dicha,
    sobreviveElRedondeo: Math.abs(fraccion - dicha) < 1e-9
  }
}

/** `0.2` → `"20%"`. **Nunca se le ensena una fraccion a nadie.** */
export function enPorcentaje(fraccion: number): string {
  return `${Math.round(fraccion * 100)}%`
}

/** `0.2` → `"$120.00"` sobre la caja de muestra. */
export function enPesos(fraccion: number, caja: number = CAJA_DE_MUESTRA): string {
  return (
    '$' +
    (fraccion * caja).toLocaleString('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  )
}

/**
 * Como se le ensena una comision a una persona, **siempre**.
 *
 *   *"Su comision cuando vende el: 20% — de una caja de $600.00 se lleva $120.00"*
 *
 * En porcentaje Y en pesos, nunca en fraccion. `0.20` no significa nada para
 * quien va a decir "va", y es justo el numero con el que es facil equivocarse
 * por un factor de cien — que es la trampa 2 vista desde el otro lado.
 */
export function explicarComision(
  etiqueta: string,
  fraccion: number,
  caja: number = CAJA_DE_MUESTRA
): string {
  return (
    `${etiqueta}: ${enPorcentaje(fraccion)} — de una caja de ` +
    `${enPesos(1, caja)} se lleva ${enPesos(fraccion, caja)}`
  )
}

/**
 * El porcentaje TAL COMO SE DIJO, sin redondear: `0.125` → `"12.5%"`.
 *
 * `enPorcentaje` redondea a entero, que es lo correcto para ensenar lo que se
 * va a GUARDAR —la columna es `numeric(5,2)` y no admite otra cosa—, pero por
 * eso mismo no sirve para el aviso de la trampa 3: con el, el aviso decia
 * *"13% no cabe, asi que quedaria 13%"*, que es un aviso que se contradice
 * solo y que en una lectura rapida parece un error del bot, no de la columna.
 */
export function enPorcentajeDicho(fraccion: number): string {
  const porciento = Math.round(fraccion * 10000) / 100
  return `${porciento.toLocaleString('es-MX', { maximumFractionDigits: 2 })}%`
}

/** El aviso de la trampa 3, cuando el numero dictado no sobrevive la columna. */
export function avisoDeRedondeo(juicio: ComisionNormalizada): string | null {
  if (juicio.sobreviveElRedondeo) return null
  return (
    `⚠ ${enPorcentajeDicho(juicio.fraccionDicha)} no cabe: la columna solo guarda ` +
    `porcentajes enteros, asi que quedaria ${enPorcentaje(juicio.fraccion)}.`
  )
}

/** La pregunta con la que se desambigua un `1` (trampa 2). */
export function preguntaDeAmbiguedad(etiqueta: string): string {
  return (
    `Dijiste "1" para ${etiqueta.toLowerCase()} y eso lo puedo leer de dos ` +
    `maneras. Cual es?\n\n` +
    `· 1% — de una caja de ${enPesos(1)} se lleva ${enPesos(0.01)}\n` +
    `· 100% — se lleva la caja entera, ${enPesos(1)}`
  )
}

/**
 * La comision dicha, convertida a fraccion **con el criterio del chat**.
 *
 * ─── LA DEUDA QUE CIERRA (D17/D18/D20, 2026-09-19) ──────────────────────────
 *
 * Habia DOS verdades para la misma operacion. `normalizeCommission`, la de la
 * pantalla, traia tres trampas que la del chat ya no tenia:
 *
 * | | por el chat | por la pantalla, hasta hoy |
 * |---|---|---|
 * | un `1` | pregunta 1% o 100% | lo guardaba como **100%**, callado |
 * | un 12.5% | avisa que quedaria 13% **antes** del "va" | lo guardaba **0.13**, callado |
 * | algo invalido | revienta | se volvia **0**, callado |
 *
 * Las tres **se detienen en vez de adivinar**, y esa es la diferencia entera.
 * Un 12.5% no cabe en `numeric(5,2)`: el error DICE el numero que quedaria, que
 * es la unica forma de que quien lo escribio pueda decidir.
 *
 * **Vive aqui y no dentro del Server Action a proposito.** Mientras estuvo
 * dentro de `registrarEntidadAction`, ejercitarla exigia montar una sesion de
 * Next -- o sea, no se ejercitaba nunca. Es la misma enfermedad del defecto 1:
 * codigo correcto que ninguna prueba toca. Aqui la corre `bot-entidad-100.spec.ts`.
 */
export function comisionValidada(crudo: number | undefined | null, etiqueta: string): number {
  if (crudo === undefined || crudo === null) return 0
  const juicio = normalizarComision(crudo)
  if (!juicio.ok) {
    if (juicio.motivo === 'ambigua') {
      throw new Error(
        etiqueta +
          ': "1" lo puedo leer como 1% o como 100%, y la diferencia es que el producto ' +
          'se regale. Escribelo como 0.01 o como 100.'
      )
    }
    throw new Error(etiqueta + ': ' + juicio.error)
  }
  const aviso = avisoDeRedondeo(juicio)
  if (aviso) throw new Error(etiqueta + ': ' + aviso.replace('\u26a0 ', ''))
  return juicio.fraccion
}

/**
 * Las dos salidas del `1` ambiguo. **Estan aqui y no dentro de la ruta a
 * proposito (D11, 2026-09-19):** mientras el par vivio como literal dentro de
 * `entidad/proponer/route.ts`, **ninguna prueba podia tocarlo** -- y el de
 * "100%" mandaba de vuelta el mismo `'1'` que disparo la ambiguedad, asi que
 * `normalizarComision` lo volvia a declarar ambiguo y quien quisiera 100%
 * recibia la misma pregunta para siempre. Un bucle sin salida.
 *
 * La invariante que esto hace comprobable, y que `tests/bot-entidad-100.spec.ts`
 * ejercita fila por fila: **ningun valor de un boton puede volver a salir
 * `ambigua`.** Un boton que reabre la pregunta que venia a cerrar no es un
 * boton.
 */
export const OPCIONES_DE_AMBIGUEDAD: ReadonlyArray<{ valor: string; etiqueta: string }> = [
  { valor: '0.01', etiqueta: '1%' },
  // `'100'`, NO `'1'`. `Number('100')` = 100: no pasa de 100, no es 1, y sale
  // por el camino normal como fraccion 1. **La que estaba mal era la opcion, no
  // la funcion** -- por eso `normalizarComision` no se toca.
  { valor: '100', etiqueta: '100%' }
]

export interface ComisionPedida {
  columna: 'comision_base' | 'comision_hijo_local' | 'comision_base_local'
  etiqueta: string
  pregunta: string
}

/**
 * Que comisiones se preguntan, segun el rol (D10).
 *
 * Es una funcion y no un `if` suelto dentro del flujo del bot porque la misma
 * lista la necesita el alta **y** la correccion de una entidad que ya existe, y
 * porque asi se puede probar contra las columnas reales sin arrancar el bot.
 */
export function comisionesQueSePreguntan(rol: RolDeAlta): ComisionPedida[] {
  if (rol === 'DST') {
    return [
      {
        columna: 'comision_base',
        etiqueta: 'Su comision cuando vende el',
        pregunta: 'Que comision se lleva el distribuidor cuando vende el? (el numero, en porciento)'
      },
      {
        columna: 'comision_hijo_local',
        etiqueta: 'Su comision cuando vende su local',
        pregunta: 'Y cuanto se lleva cuando vende un local suyo? (el numero, en porciento)'
      }
    ]
  }
  return [
    {
      columna: 'comision_base_local',
      etiqueta: 'Su comision',
      pregunta: 'Que comision se lleva el local? (el numero, en porciento)'
    }
  ]
}

// ============================================================================
// 3. EL BORRADOR DEL ALTA Y SU SELLO
// ============================================================================

export interface PayloadAlta {
  nombre: string
  rol: RolDeAlta
  zona: Zona
  email: string | null
  telefono: string | null
  id_nodo_padre: string | null
  comision_base: number
  comision_base_local: number
  comision_hijo_local: number
}

/**
 * Ordenadas. `jsonb` reordena las llaves de un objeto al guardarlo, asi que el
 * sello se calcula sobre esta lista y no sobre `Object.keys()`.
 *
 * **La contrasena no esta aqui, y es a proposito.** No se genera en la
 * propuesta: se genera en el `confirmar`, cuando de verdad se crea la cuenta.
 * Meterla en el payload la dejaria escrita en claro en `bot_borradores.payload`
 * —una credencial guardada en una tabla de borradores— a cambio de nada: no es
 * un dato del negocio que haya que congelar entre el mensaje y el "va".
 */
export const LLAVES_ALTA = [
  'comision_base',
  'comision_base_local',
  'comision_hijo_local',
  'email',
  'id_nodo_padre',
  'nombre',
  'rol',
  'telefono',
  'zona'
] as const

export function sellarAlta(payload: PayloadAlta): string {
  return sellar(payload, LLAVES_ALTA)
}

export function selloAltaCoincide(payload: PayloadAlta, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_ALTA, sello)
}

// ============================================================================
// 4. EL MENSAJE DE ANTES DEL "VA"
// ============================================================================

export interface ContextoDeAlta {
  /** Nombre de la entidad padre, ya resuelto. Solo para LOC. */
  nombrePadre: string | null
  /** Los avisos de redondeo de la trampa 3, si alguno no sobrevivio. */
  avisos: readonly string[]
  /** Entidades con nombre parecido (D12), si se decidio seguir de todos modos. */
  parecidas: readonly string[]
}

/**
 * Lo que se ensena antes del "va". Todas las comisiones del rol, cada una en
 * porcentaje y en pesos sobre una caja.
 */
export function mensajeDeAlta(payload: PayloadAlta, ctx: ContextoDeAlta): string {
  const lineas: string[] = []
  lineas.push(`Voy a dar de alta un ${nombreDelRol(payload.rol)}:`)
  lineas.push('')
  lineas.push(`· Nombre: ${payload.nombre}`)
  lineas.push(`· Zona: ${payload.zona}`)
  if (payload.email) lineas.push(`· Correo de acceso: ${payload.email}`)
  if (payload.telefono) lineas.push(`· Telefono: ${payload.telefono}`)
  if (ctx.nombrePadre) lineas.push(`· Cuelga de: ${ctx.nombrePadre}`)

  lineas.push('')
  for (const pedida of comisionesQueSePreguntan(payload.rol)) {
    lineas.push('· ' + explicarComision(pedida.etiqueta, payload[pedida.columna]))
  }

  lineas.push('')
  lineas.push(`Y le abro su cuenta de efectivo: Efectivo (${payload.nombre}).`)

  if (payload.rol === 'DST') {
    // Se anuncia aqui para que nadie se lleve la sorpresa de una credencial
    // apareciendo en el chat sin contexto. Ver D11 y `generarPassword`.
    lineas.push('Le genero su contrasena y te la enseno UNA vez cuando digas va.')
  }

  if (ctx.parecidas.length) {
    lineas.push('')
    lineas.push(`⚠ Ya hay alguien con nombre parecido: ${ctx.parecidas.join(', ')}.`)
  }
  for (const aviso of ctx.avisos) lineas.push(aviso)

  return lineas.join('\n')
}

/** La pregunta de D12 cuando el nombre se parece a uno que ya existe. */
export function preguntaDeDuplicado(nombre: string, parecidas: readonly string[]): string {
  return (
    `Antes de crearlo: "${nombre}" se parece a ${parecidas.join(', ')}, que ya ` +
    `existe${parecidas.length > 1 ? 'n' : ''}. **No hay nada que impida dos ` +
    `entidades con el mismo nombre**, y cuando pasa nadie se entera hasta que se ` +
    `le abona al equivocado. Lo creo de todos modos?`
  )
}

/**
 * El mensaje de despues del "va". La contrasena va **sola y al final**, para que
 * se pueda copiar de un jalon en un celular.
 */
export function mensajeDeAltaHecha(
  payload: PayloadAlta,
  password: string | null
): string {
  const lineas = [
    `✅ Listo. ${payload.nombre} queda dado de alta como ` +
      `${nombreDelRol(payload.rol)} en ${payload.zona}, con su cuenta ` +
      `Efectivo (${payload.nombre}).`
  ]
  if (password && payload.email) {
    lineas.push('')
    lineas.push('🔑 Sus datos de acceso. **Esto no lo vuelvo a enseñar**:')
    lineas.push('')
    lineas.push(payload.email)
    lineas.push(password)
  }
  return lineas.join('\n')
}
