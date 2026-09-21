/**
 * EL TAMANO DE LA BOTELLA, RESUELTO POR NUMERO Y NO POR CADENA.
 *
 * ─── EL DEFECTO QUE CIERRA (2026-09-19) ─────────────────────────────────────
 *
 * Norman escribio, textual:
 *
 *   «Dame una cotizacion para aeropuerto, De 12 de 750 ml, 12 de 250 ml y 48 de 50ml»
 *
 * y el bot contesto **«No encontre "750 ml" en el catalogo»** sobre un producto
 * que se llama `Destilado Plata 750ml`. **Fallo por UN ESPACIO.** En el log esa
 * conversacion aparece como `enrutado como cotizacion (confianza alta)`: el
 * enrutador acerto la intencion y la conversacion fracaso igual. Clasificar es
 * la capa 1; resolver las palabras contra las filas de la base es la capa 2.
 *
 * Las tres pasadas de `buscarPorNombre` mueren todas contra el mismo espacio:
 *   1. exacta:      `"750 ml"` != `"destilado plata 750ml"`.
 *   2. contencion:  `"destilado plata 750ml".includes("750 ml")` es `false`.
 *   3. por palabra: `LARGO_MINIMO_TOKEN = 3` descarta `"ml"`, queda el token
 *      `"750"`, y `"750ml"` **no es la palabra** `"750"`.
 *
 * ─── POR QUE ESTO VA EN TYPESCRIPT Y NO EN EL PROMPT ────────────────────────
 *
 * El arreglo grande es que el catalogo viaje al modelo y el modelo devuelva un
 * `id_producto` (D35/D36). Pero eso depende de que el modelo conteste bien, y
 * un modelo se cae. **Esto es la red que atrapa el caso aunque el modelo falle**,
 * y es deterministico: el dato ya existe en la columna `ml_por_unidad` de
 * `catalogo_productos`, solo no se usaba.
 *
 * ─── LO QUE NO HACE, Y ES DELIBERADO ────────────────────────────────────────
 *
 * No afloja la lista cerrada. Un ml que no empata EXACTAMENTE con el
 * `ml_por_unidad` de alguna fila no empata con nada: `"20 de cerveza"` sigue sin
 * encontrar producto, que es el control negativo obligatorio. Cambiar un defecto
 * visible por uno que escribe ventas equivocadas en silencio seria peor.
 */

/** minusculas y sin acentos. **Conserva `.` y `/`**, que aqui significan algo. */
function aplanar(texto: unknown): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/** Debajo de esto un numero suelto se lee como LITROS, no como mililitros. */
const TECHO_DE_LITROS = 10

/**
 * Los mililitros que dice una frase, o `null` si no dice ninguno.
 *
 * Todas estas tienen que llegar al mismo 750 (D37):
 * `750 ml` · `750ml` · `750` · `.750` · `3/4` · `750 mililitros` · `0.75 l`
 *
 * La regla de desempate, cuando el numero viene pelado: **por debajo de 10 son
 * litros, de 10 para arriba son mililitros.** No hay botella de 9 ml ni de 750
 * litros, asi que el corte no toca ningun caso real. Un `12` —la cantidad, no
 * el tamano— sale 12000 y no empata con nada, que es lo correcto.
 */
export function mlDicho(texto: unknown): number | null {
  const t = aplanar(texto)
  if (t === '') return null

  // Una fraccion es siempre de litro: "3/4", "1/2", "1/4".
  const fraccion = t.match(/(\d+)\s*\/\s*(\d+)/)
  if (fraccion) {
    const arriba = Number(fraccion[1])
    const abajo = Number(fraccion[2])
    if (abajo > 0 && arriba > 0 && arriba < abajo) {
      return Math.round((arriba / abajo) * 1000)
    }
    return null
  }

  const numero = t.match(/(\d+(?:[.,]\d+)?|[.,]\d+)/)
  if (!numero) return null
  const crudo = Number(numero[1].replace(',', '.'))
  if (!Number.isFinite(crudo) || crudo <= 0) return null

  // La unidad dicha manda sobre la heuristica del tamano.
  const resto = t.slice((numero.index ?? 0) + numero[1].length)
  if (/^\s*(ml|mls|mililitro)/.test(resto)) return Math.round(crudo)
  if (/^\s*(l|lt|lts|litro)/.test(resto)) return Math.round(crudo * 1000)

  return crudo < TECHO_DE_LITROS ? Math.round(crudo * 1000) : Math.round(crudo)
}

/** Donde cae un adjetivo de tamano dentro de la lista ordenada de mayor a menor. */
export type LugarDeTamano = 'el-mas-grande' | 'el-de-en-medio' | 'el-mas-chico'

/**
 * El vocabulario de tamano. **Ya no hay ambiguedad, y quien la deshizo fue
 * Norman en persona (D53, 2026-09-19).**
 *
 * ─── LO QUE DECIA ESTE COMENTARIO AYER, Y POR QUE CAMBIO ────────────────────
 *
 * Hasta hoy `chica` apuntaba a DOS lugares -- la de 250 y la de 50 -- y el bot
 * preguntaba *"de cual, la de 250 ml o la de 50 ml?"*. **Eso era correcto
 * mientras de verdad fuera ambiguo**, y lo era: con tres formatos, otra persona
 * podria llamarle "chica" a la de 50.
 *
 * Pero la ambiguedad no era del idioma, era de no haber preguntado. Norman,
 * textual, el 2026-09-19: **«La de 50 ml es la mini.»** Y en la conversacion
 * viva uso los tres juntos, en una sola frase, sin dudar:
 *
 *     «cotizame para el mismo cliente 35 grandes, 43 chicas y 25 mini»
 *
 * Tres adjetivos, tres formatos, uno cada uno. Preguntar *"de cual?"* despues
 * de eso ya no es prudencia: es no escuchar. **Este bot es de una sola persona
 * y esa persona ya dijo como habla.**
 *
 * ─── LO QUE NO SE AFLOJA ────────────────────────────────────────────────────
 * Que los tres adjetivos resuelvan directo NO afloja la lista cerrada: siguen
 * empatando contra `ml_por_unidad` de una fila real, asi que `500 ml`, `cerveza`
 * y `20 de cerveza` siguen sin encontrar nada, y la `Pasta-Guajillo-2kg`
 * (`ml_por_unidad = null`) sigue fuera del alcance de cualquier palabra de
 * tamano -- `conTamano` la filtra antes de que ninguna llegue a ella.
 */
const VOCABULARIO: ReadonlyArray<{ palabras: readonly string[]; lugares: readonly LugarDeTamano[] }> = [
  { palabras: ['grande', 'grandes', 'grandota', 'grandotas', 'grandototas'], lugares: ['el-mas-grande'] },
  { palabras: ['mediana', 'medianas', 'mediano', 'medianos'], lugares: ['el-de-en-medio'] },
  { palabras: ['mini', 'minis', 'miniatura', 'miniaturas'], lugares: ['el-mas-chico'] },
  {
    // D53: `chicas` = la de en medio (250 ml). Lo desempato Norman, no el codigo.
    palabras: ['chica', 'chicas', 'chico', 'chicos', 'chiquita', 'chiquitas', 'pequena', 'pequenas'],
    lugares: ['el-de-en-medio']
  }
]

/** Los lugares que nombra una frase, o `[]` si no nombra ninguno. */
export function lugaresDichos(texto: unknown): LugarDeTamano[] {
  const palabras = new Set(
    aplanar(texto)
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((p) => p !== '')
  )
  for (const entrada of VOCABULARIO) {
    if (entrada.palabras.some((p) => palabras.has(p))) return [...entrada.lugares]
  }
  return []
}

interface ConTamano {
  ml_por_unidad: number | null
}

/**
 * Los productos que declaran tamano, ordenados de mayor a menor.
 *
 * La pasta de guajillo (`ml_por_unidad = null`) queda fuera: no es una botella y
 * no tiene "grande" ni "chica". Ademas no se vende — se dona al DIF.
 */
export function conTamano<T extends ConTamano>(catalogo: readonly T[]): T[] {
  return catalogo
    .filter((p) => typeof p.ml_por_unidad === 'number' && (p.ml_por_unidad ?? 0) > 0)
    .sort((a, b) => (b.ml_por_unidad ?? 0) - (a.ml_por_unidad ?? 0))
}

/**
 * Empata `dicho` contra el catalogo **por el tamano**, no por el nombre.
 *
 * Devuelve los candidatos que quedan: uno (resuelto), varios (hay que
 * preguntar) o ninguno (esta pasada no aplica y manda la siguiente).
 */
export function candidatosPorTamano<T extends ConTamano>(
  dicho: unknown,
  catalogo: readonly T[]
): T[] {
  const ordenados = conTamano(catalogo)
  if (ordenados.length === 0) return []

  // 1. El numero, que es exacto y no depende de como se escriba.
  const ml = mlDicho(dicho)
  if (ml !== null) {
    const exactos = ordenados.filter((p) => Math.round(p.ml_por_unidad ?? 0) === ml)
    if (exactos.length > 0) return exactos
  }

  // 2. El adjetivo. Solo si el numero no resolvio nada: "la chica de 250" es
  //    primero un 250 y luego una "chica".
  const lugares = lugaresDichos(dicho)
  if (lugares.length === 0) return []

  const elegidos: T[] = []
  for (const lugar of lugares) {
    if (lugar === 'el-mas-grande') elegidos.push(ordenados[0])
    else if (lugar === 'el-mas-chico') elegidos.push(ordenados[ordenados.length - 1])
    else if (ordenados.length >= 3) elegidos.push(ordenados[Math.floor((ordenados.length - 1) / 2)])
  }
  // Sin duplicados: con dos formatos, "el de en medio" y "el mas chico" son el
  // mismo, y ofrecer dos botones iguales es peor que ofrecer uno.
  return elegidos.filter((p, i) => p !== undefined && elegidos.indexOf(p) === i)
}

interface ParaOfrecer {
  nombre: string
  ml_por_unidad: number | null
}

/** `750` → `"750 ml"`, y sin tamano el nombre pelado. */
function comoSeLlama(p: ParaOfrecer): string {
  const ml = p.ml_por_unidad
  return typeof ml === 'number' && ml > 0 ? `${Math.round(ml)} ml` : p.nombre
}

/**
 * La pregunta que se hace cuando no se resolvio. **D39.**
 *
 * *"No encontre 'grande' en el catalogo"* deja de ser una respuesta aceptable
 * cuando el catalogo tiene tres botellas: le echa al usuario la culpa de no
 * conocer el nombre interno del inventario. Lo que se ofrece son las que hay,
 * **con su tamano a la vista**, y la pregunta dice que si se entendio.
 */
export function preguntaDeProducto(
  dicho: unknown,
  ofrecidos: readonly ParaOfrecer[],
  verbo: 'cotizar' | 'vender'
): string {
  const texto = String(dicho ?? '').trim()
  const tamanos = ofrecidos.filter((p) => typeof p.ml_por_unidad === 'number' && (p.ml_por_unidad ?? 0) > 0)

  if (tamanos.length >= 2) {
    const lista = tamanos.map(comoSeLlama)
    const ultima = lista[lista.length - 1]
    const previas = lista.slice(0, -1).join(', la de ')
    const cual = `De cual, la de ${previas} o la de ${ultima}?`
    return texto === '' ? cual : `"${texto}": ${cual.charAt(0).toLowerCase() + cual.slice(1)}`
  }

  if (ofrecidos.length === 0) {
    return texto === ''
      ? `No entendi que ${verbo}.`
      : `"${texto}" no lo tengo a la venta.`
  }
  return texto === '' ? `Que ${verbo}?` : `"${texto}": cual de estos es?`
}
