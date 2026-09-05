/**
 * ERP-59 — La cola de avisos de captura.
 *
 * Aqui vive todo lo que se puede decidir SIN base de datos: el catalogo de
 * avisos, su severidad, el orden de la cola, el resumen del dia y el default de
 * la cuenta de origen. Todo es puro a proposito — es lo unico que `npm test`
 * puede vigilar de verdad (ver CLAUDE.md: la suite no es red de seguridad para
 * la aritmetica del dinero, pero si lo es para una tabla de constantes).
 *
 * El principio que ordena el archivo: **un aviso nunca detiene una escritura.**
 * La fila entra y queda marcada. Lo que no se vale es perder el dato porque
 * faltaba un campo.
 */

// ============================================================================
// 1. VOCABULARIO
// ============================================================================

export type SeveridadAviso = 'INFO' | 'REVISAR'
export type EstadoAviso = 'ABIERTO' | 'RESUELTO' | 'IGNORADO'

/**
 * Los tipos catalogados. La numeracion viene de
 * `docs/CLASIFICACION_validaciones_ERP-59.md` y se conserva aunque haya huecos
 * (W2, W5, W6, W7 y W8 salieron de la lista por la frontera de los dos
 * ledgers, prompt 18-bis §3): renumerar romperia la trazabilidad con el
 * documento que Norman reviso.
 */
export type TipoAviso =
  | 'W1'   // sobregiro fisico en un corte
  | 'W1b'  // corte que cierra sin diferencias positivas
  | 'W3'   // produccion sin receta (BOM)
  | 'W4'   // venta en concesion sin comprador identificado
  | 'W9'   // receta con lineas de insumo invalidas
  | 'W10'  // fecha de pago ilegible
  | 'W11'  // fecha de pago futura
  | 'W12'  // metodo de pago no reconocido
  | 'W13'  // cuenta de origen ausente
  | 'W14'  // gasto sin categoria

export interface DefinicionAviso {
  severidad: SeveridadAviso
  titulo: string
  /** Que quedo sin hacer, para que la cola se lea sin abrir el codigo. */
  consecuencia: string
  /**
   * `true` solo en W4: el aviso NO se puede cerrar (ni resolver ni ignorar)
   * mientras el ticket siga apuntando a la entidad centinela. Resolver =
   * asignar comprador. El candado de verdad esta en el trigger
   * `tg_avisos_vigilar_cierre` de Postgres, porque la app no es el unico camino
   * a la base; esto es su espejo para que la pantalla no ofrezca un boton que
   * la base va a rechazar.
   */
  exigeAsignacion?: true
}

/**
 * EL CATALOGO. Diez avisos, once puntos de codigo.
 *
 * Solo dos son `INFO`, y no por gusto: los otros ocho significan dinero o
 * inventario sin cuadrar. Una cola donde todo es urgente es una cola que nadie
 * abre, pero bajarle la severidad a algo que descuadra el inventario es
 * mentirle al que la lee.
 */
export const CATALOGO_AVISOS: Record<TipoAviso, DefinicionAviso> = {
  W1: {
    severidad: 'REVISAR',
    titulo: 'Sobregiro fisico en el corte',
    consecuencia:
      'Se contaron mas botellas de las esperadas. Las diferencias positivas se ' +
      'procesaron normal; la linea sobregirada NO genero movimiento (nunca stock ' +
      'negativo, regla 3) y quedo aqui con el conteo capturado.'
  },
  W1b: {
    severidad: 'INFO',
    titulo: 'Corte sin diferencias positivas',
    consecuencia:
      'El corte cerro en cero: no hubo nada que cobrar. No se escribio ninguna ' +
      'fila. Antes esto tiraba el corte entero con un error.'
  },
  W3: {
    severidad: 'REVISAR',
    titulo: 'Produccion sin receta (BOM)',
    consecuencia:
      'Las botellas existen y se registraron. Los insumos NO se descontaron: el ' +
      'inventario de insumo se lee mas alto de lo real hasta que se cargue la receta.'
  },
  W4: {
    severidad: 'REVISAR',
    titulo: 'Concesion sin comprador identificado',
    consecuencia:
      'La botella salio del almacen y quedo a nombre de "PENDIENTE DE ASIGNAR". ' +
      'Esa consignacion no tiene dueno: nadie la debe todavia.',
    exigeAsignacion: true
  },
  W9: {
    severidad: 'REVISAR',
    titulo: 'Receta con lineas invalidas',
    consecuencia:
      'La produccion se registro y se descontaron las lineas de receta validas. ' +
      'Las lineas rotas (sin insumo o con cantidad <= 0) se saltaron y van nombradas aqui.'
  },
  W10: {
    severidad: 'INFO',
    titulo: 'Fecha de pago ilegible',
    consecuencia:
      'El abono entro con la fecha de hoy. La fecha que se capturo quedo guardada aqui.'
  },
  W11: {
    severidad: 'REVISAR',
    titulo: 'Fecha de pago futura',
    consecuencia:
      'El abono se anclo a hoy. Guardarlo en el futuro lo hubiera hecho ' +
      'desaparecer de todo filtro "hasta hoy" — un pago que existe y no se ve en ningun lado.'
  },
  W12: {
    severidad: 'INFO',
    titulo: 'Metodo de pago no reconocido',
    consecuencia:
      'El abono entro sin metodo de pago. El texto capturado quedo guardado aqui.'
  },
  W13: {
    severidad: 'REVISAR',
    titulo: 'Cuenta de origen ausente',
    consecuencia:
      'El movimiento entro contra la cuenta propia de la entidad. NUNCA contra ' +
      'una cuenta ADMIN ni contra la cuenta fiscal: eso inventaria pasivo fiscal ' +
      'donde no lo hay y filtraria efectivo hacia los totales de la Matriz.'
  },
  W14: {
    severidad: 'REVISAR',
    titulo: 'Gasto sin categoria',
    consecuencia:
      'El egreso entro completo, con categoria SIN_CATEGORIZAR. Antes se perdia ' +
      'entero: es la causa mecanica de los $0.00 de gasto capturado desde el 1 de julio.'
  }
}

/** La severidad no se teclea en cada llamada: sale del catalogo. */
export function severidadDeAviso(tipo: TipoAviso): SeveridadAviso {
  return CATALOGO_AVISOS[tipo].severidad
}

/** ¿Este aviso exige asignar antes de poder cerrarse? Hoy solo W4. */
export function exigeAsignacion(tipo: TipoAviso): boolean {
  return CATALOGO_AVISOS[tipo].exigeAsignacion === true
}

/**
 * La entidad centinela de W4. **Duplicada a proposito** en
 * `supabase/migrations/20260905120000_cola_de_avisos_de_captura.sql`
 * (funcion `entidad_pendiente_de_asignar()`), por la misma razon que la ventana
 * de 12 h de `lib/constants.ts`: Postgres no lee una constante de TypeScript ni
 * al reves. Si cambias una, cambia la otra — `tests/avisos.spec.ts` compara las
 * dos y falla si divergen.
 */
export const ENTIDAD_PENDIENTE_DE_ASIGNAR = '11111111-1111-1111-1111-111111111111'

/**
 * ¿Se puede elegir a mano esta entidad como comprador? **El centinela no.**
 *
 * ERP-80. El centinela nace con `rol = 'LOC'` para comportarse como cualquier
 * comprador en los candados de fiscalidad, y eso lo metia derechito en el
 * desplegable del POS, que para un ADMIN ofrece *todos* los `DST` y `LOC`
 * (`app/pos/page.tsx`). Elegirlo a mano dejaba el ticket apuntando al centinela
 * **sin aviso W4**: exactamente la fila que la cola existe para no perder, y en
 * silencio.
 *
 * El filtro de la pantalla usa esta funcion; el servidor no confia en el y
 * decide aparte (`resolverCompradorDeVenta`). Las dos mitades hacen falta: la
 * pantalla para que no se pueda elegir, el servidor porque
 * `procesarVentaPOS` se puede llamar sin pasar por la pantalla.
 */
export function esCompradorSeleccionable(entidad: { id: string }): boolean {
  return entidad.id !== ENTIDAD_PENDIENTE_DE_ASIGNAR
}

export type ResolucionComprador =
  | { ok: true; idComprador: string | null; avisoW4: boolean }
  | { ok: false; error: string }

/**
 * Quien es el comprador de una venta, y si hay que abrir un W4.
 *
 * **La pregunta correcta no es "¿vino vacio el comprador?" sino "¿el ticket va
 * a quedar apuntando al centinela?"** (ERP-80). Da igual si llego vacio o si
 * alguien lo eligio del desplegable: el resultado en la base es el mismo — una
 * consignacion que nadie debe — y por lo tanto el aviso tiene que ser el mismo.
 *
 * En CONTADO el centinela **se rechaza**, no se avisa. No es una captura
 * incompleta: es un valor que vino y esta mal (familia C de la clasificacion).
 * Una venta de contado sin comprador identificado ya tiene su forma legitima y
 * soportada desde siempre — dejar el comprador vacio, "Publico en General" —,
 * asi que el centinela ahi no significa nada y no cobra ninguna deuda a nadie.
 */
export function resolverCompradorDeVenta(
  condicionPago: 'CONTADO' | 'CONCESION',
  idCompradorCapturado: string | null | undefined
): ResolucionComprador {
  const capturado = String(idCompradorCapturado ?? '').trim() || null
  const esCentinela = capturado === ENTIDAD_PENDIENTE_DE_ASIGNAR

  if (condicionPago === 'CONCESION') {
    // Vacio o centinela: el mismo destino y el mismo aviso.
    if (!capturado || esCentinela) {
      return { ok: true, idComprador: ENTIDAD_PENDIENTE_DE_ASIGNAR, avisoW4: true }
    }
    return { ok: true, idComprador: capturado, avisoW4: false }
  }

  if (esCentinela) {
    return {
      ok: false,
      error:
        '"PENDIENTE DE ASIGNAR" no es un comprador: es el marcador de las ' +
        'consignaciones sin dueno. En una venta de contado deja el comprador ' +
        'vacio (Publico en General).'
    }
  }

  return { ok: true, idComprador: capturado, avisoW4: false }
}

/**
 * La categoria que grita. **Nunca `NULL`**: un valor explicito se revisa, un
 * `NULL` se pierde entre los legitimos (hoy hay 1 fila con `categoria` nula en
 * `finanzas_ledger`, y nadie sabe cual es).
 */
export const CATEGORIA_SIN_CATEGORIZAR = 'SIN_CATEGORIZAR'

/** Devuelve la categoria capturada, o el centinela. Jamas vacio, jamas null. */
export function normalizarCategoriaGasto(categoria: string | null | undefined): string {
  const limpia = String(categoria ?? '').trim()
  return limpia === '' ? CATEGORIA_SIN_CATEGORIZAR : limpia
}

// ============================================================================
// 2. LA COLA: ORDEN Y RESUMEN
// ============================================================================

export interface AvisoEnCola {
  id: string
  tipo: TipoAviso | string
  severidad: SeveridadAviso
  mensaje: string
  estado: EstadoAviso
  creado_en: string
  id_entidad: string
  tabla: string | null
  id_registro: string | null
  datos_capturados?: unknown
}

/** REVISAR pesa mas que INFO. Un solo lugar donde se decide. */
const PESO_SEVERIDAD: Record<SeveridadAviso, number> = { REVISAR: 0, INFO: 1 }

/**
 * El orden de la cola: primero lo urgente, y dentro de cada severidad, primero
 * lo viejo. Lo viejo primero y no al reves porque un aviso que lleva tres
 * semanas abierto es justo el que ya nadie va a poder reconstruir de memoria.
 *
 * No muta el arreglo que recibe.
 */
export function ordenarColaAvisos<T extends Pick<AvisoEnCola, 'severidad' | 'creado_en'>>(
  avisos: readonly T[]
): T[] {
  return [...avisos].sort((a, b) => {
    const porSeveridad = PESO_SEVERIDAD[a.severidad] - PESO_SEVERIDAD[b.severidad]
    if (porSeveridad !== 0) return porSeveridad
    return a.creado_en.localeCompare(b.creado_en)
  })
}

export interface ResumenDiarioAvisos {
  total: number
  revisar: number
  info: number
  /** Los 5 mas viejos, ya ordenados por la cola. */
  masViejos: AvisoEnCola[]
  /** Dias que lleva abierto el mas viejo de todos. 0 si no hay ninguno. */
  diasDelMasViejo: number
  /** Una linea lista para mandar por Telegram. Incluye el latido. */
  texto: string
}

const MS_POR_DIA = 24 * 60 * 60 * 1000

/**
 * El resumen del dia, para el bot de Telegram (AG-01).
 *
 * **Es una funcion, no un cron.** Hoy no hay canal: el bot no existe todavia.
 * Montar aqui correo, cron o notificaciones del navegador seria construir para
 * un futuro que no existe [Filtro: DOC02 — YAGNI]. Cuando el bot exista, la
 * llama y ya.
 *
 * `ahora` se recibe y no se lee de `Date.now()` para que la funcion sea pura y
 * la prueba no dependa del reloj.
 *
 * **Siempre devuelve texto, incluso con la cola vacia**: es el latido. "No hay
 * nada pendiente" y "llevo tres dias sin correr" no se pueden ver igual.
 */
export function resumenDiarioAvisos(
  avisos: readonly AvisoEnCola[],
  ahora: Date
): ResumenDiarioAvisos {
  const abiertos = avisos.filter((aviso) => aviso.estado === 'ABIERTO')
  const ordenados = ordenarColaAvisos(abiertos)

  const revisar = abiertos.filter((aviso) => aviso.severidad === 'REVISAR').length
  const info = abiertos.length - revisar

  // El mas viejo de TODOS los abiertos, sin importar severidad: la antiguedad
  // no se mide dentro de su carril.
  const masViejoDeTodos = abiertos.reduce<AvisoEnCola | null>((viejo, aviso) => {
    if (!viejo) return aviso
    return aviso.creado_en < viejo.creado_en ? aviso : viejo
  }, null)

  const diasDelMasViejo = masViejoDeTodos
    ? Math.max(0, Math.floor((ahora.getTime() - new Date(masViejoDeTodos.creado_en).getTime()) / MS_POR_DIA))
    : 0

  const texto =
    abiertos.length === 0
      ? 'Cola de captura: 0 avisos abiertos. Nada pendiente.'
      : `Cola de captura: ${abiertos.length} abierto(s) — ${revisar} por revisar, ` +
        `${info} informativo(s). El mas viejo lleva ${diasDelMasViejo} dia(s).`

  return {
    total: abiertos.length,
    revisar,
    info,
    masViejos: ordenados.slice(0, 5),
    diasDelMasViejo,
    texto
  }
}

// ============================================================================
// 3. W13 — EL DEFAULT DE LA CUENTA DE ORIGEN
// ============================================================================

export interface CuentaCandidata {
  id: string
  nombre: string
  id_entidad: string | null
  /** Rol de la entidad DUENA de la cuenta, no el de quien captura. */
  rol_entidad: string | null
  tipo_fiscalidad: string | null
}

export type ResolucionCuentaOrigen =
  | { ok: true; idCuenta: string }
  | { ok: false; motivo: string }

/**
 * **El unico default admisible es una cuenta de la propia entidad.**
 *
 * Los tres vetos, y por que cada uno (prompt 18-bis §2):
 *
 *   1. **Jamas una cuenta de una entidad ADMIN.** El Account_Firewall (regla 1)
 *      decide que entra a los KPI de la Matriz mirando justamente si la cuenta
 *      es de un ADMIN. Un default que caiga ahi mete efectivo de un DST en los
 *      totales de la Matriz sin que nadie lo haya tecleado.
 *   2. **Jamas `FULL_TAX`.** Es la unica fiscalidad que dispara el motor de
 *      impuesto inverso (regla 2). Un default ahi INVENTA IVA e IEPS donde no
 *      los hay.
 *   3. **Jamas una cuenta cuyo nombre contenga "fresnillo".** Redundante con
 *      (2) hoy, y a proposito: la fiscalidad se decide en `pos.ts` por
 *      coincidencia textual del nombre, no por la columna. Mientras esa regla
 *      siga siendo textual, el veto tambien tiene que serlo, o los dos caminos
 *      pueden divergir. (`Cuenta Fresnillo` tiene 0 movimientos y es la unica
 *      FULL_TAX — comprobado 2026-09-05.)
 *
 * Si nada sobrevive a los vetos **no hay default y la validacion sigue
 * bloqueando**. Eso incluye el caso de que quien captura sea el propio ADMIN:
 * ahi no existe cuenta de origen "obvia" y adivinarla es exactamente el error
 * caro. Mejor un rechazo que un asiento en la cuenta equivocada.
 */
export function resolverCuentaOrigenPorDefecto(
  idEntidad: string,
  cuentas: readonly CuentaCandidata[]
): ResolucionCuentaOrigen {
  const propias = cuentas.filter((cuenta) => cuenta.id_entidad === idEntidad)

  if (propias.length === 0) {
    return { ok: false, motivo: 'La entidad no tiene ninguna cuenta financiera propia.' }
  }

  const admisibles = propias.filter((cuenta) => !cuentaVetadaComoDefault(cuenta))

  if (admisibles.length === 0) {
    return {
      ok: false,
      motivo:
        'Ninguna cuenta de la entidad puede usarse como default: todas son de un ' +
        'ADMIN o son la cuenta fiscal. Hay que capturar la cuenta de origen a mano.'
    }
  }

  // Desempate determinista por nombre: con dos cuentas admisibles, el default
  // tiene que ser siempre el mismo o deja de ser un default.
  const elegida = [...admisibles].sort((a, b) => a.nombre.localeCompare(b.nombre))[0]
  return { ok: true, idCuenta: elegida.id }
}

/**
 * Los tres vetos, sueltos, para que la prueba pueda apuntarles uno por uno.
 * Exportada a proposito: `tests/avisos.spec.ts` la usa para verificar que una
 * cuenta ADMIN o fiscal no puede pasar por ningun camino.
 */
export function cuentaVetadaComoDefault(cuenta: CuentaCandidata): boolean {
  if (cuenta.rol_entidad === 'ADMIN') return true
  if (cuenta.tipo_fiscalidad === 'FULL_TAX') return true
  if (String(cuenta.nombre ?? '').toLowerCase().includes('fresnillo')) return true
  return false
}
