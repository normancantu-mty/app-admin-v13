/**
 * EMPATAR UN NOMBRE DICHO CONTRA UNA LISTA CERRADA. Un solo criterio.
 *
 * ─── POR QUE ESTE ARCHIVO ───────────────────────────────────────────────────
 *
 * El algoritmo nacio en `lib/bot-abonos.ts` (`buscarDeudor`) para empatar al
 * deudor contra la cartera viva. La Fase 3 necesita exactamente lo mismo para
 * dos cosas mas: el COMPRADOR de una venta contra las entidades de la red, y el
 * PRODUCTO contra el catalogo. La alternativa era copiarlo dos veces.
 *
 * **Tres copias del criterio son tres lugares donde puede divergir**, y la
 * divergencia se veria como "a veces pregunta y a veces adivina", que es
 * justamente lo que hace desconfiar de un bot que escribe dinero. Asi que el
 * criterio se extrajo tal cual — `buscarDeudor` sigue existiendo y ahora delega
 * aqui, con el mismo comportamiento byte por byte (`tests/bot-abonos.spec.ts`
 * no se toco y sigue en verde).
 *
 * ─── LA REGLA, Y ES LA PARTE IMPORTANTE ─────────────────────────────────────
 *
 * Tres pasadas, de la mas estricta a la mas laxa, y **si una pasada devuelve mas
 * de un candidato se para ahi y se pregunta**. Nunca se escoge "el mas
 * parecido": escribir una venta a nombre de la entidad equivocada no se corrige
 * solo — hay que anular el ticket y recapturar. Preguntar cuesta un boton.
 */

/** minusculas, sin acentos, sin puntuacion, un espacio entre palabras. */
export function normalizarNombre(texto: unknown): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Tres caracteres. **Lo pide porque una prueba lo cazo**: con dos, `"el"`
 * empataba por subcadena con "Delirio 85", "Dulceria el Eden" y "Al son del
 * Mezcal" a la vez, y el bot contestaba "me da mas de uno, cual es?" ofreciendo
 * tres negocios que no tienen nada que ver. No escribia nada malo —para eso
 * esta la pregunta— pero el mensaje mentia sobre por que no habia entendido,
 * que es la clase de error que hace desconfiar del resto.
 */
export const LARGO_MINIMO_TOKEN = 3

/**
 * Palabras que NO cuentan como "palabra en comun" en la tercera pasada.
 *
 * **Lo pide una prueba en vivo, igual que `LARGO_MINIMO_TOKEN`.** Cotizar a
 * "Ferreteria del Centro" -un nombre que no existe en la red- contestaba
 * "me da mas de uno" ofreciendo "Al son del Mezcal" y "Descuento del 30%": lo
 * unico que tenian en comun era **"del"**. Tiene tres letras, asi que pasaba el
 * filtro de largo, y empata media lista de negocios en espanol.
 *
 * El dano no era escribir algo malo -para eso esta la pregunta- sino peor para
 * una cotizacion: un nombre nuevo clasificado como ambiguo **deja de ofrecer el
 * boton de "es cliente nuevo"**, que es justo el caso normal de cotizar.
 *
 * Solo entran preposiciones y articulos. Nada que pueda ser el nombre de un
 * negocio por si solo.
 */
export const PALABRAS_VACIAS = new Set([
  'del',
  'las',
  'los',
  'con',
  'por',
  'para',
  'que',
  'una',
  'uno',
  'sin',
  'sus',
  'esa',
  'ese'
])

export type FalloNombre = 'sin-nombre' | 'no-encontrado' | 'ambiguo'

export type ResultadoNombre<T> =
  | { ok: true; elegido: T }
  | { ok: false; motivo: FalloNombre; candidatos: T[] }

/**
 * Empata `dicho` contra `candidatos`, leyendo de cada uno los nombres que
 * devuelve `nombresDe` — plural a proposito: un producto se puede nombrar por
 * su nombre o por su SKU, y las dos formas valen lo mismo.
 */
export function buscarPorNombre<T>(
  dicho: unknown,
  candidatos: readonly T[],
  nombresDe: (item: T) => string[]
): ResultadoNombre<T> {
  const q = normalizarNombre(dicho)
  const todos = [...candidatos]
  if (q === '') return { ok: false, motivo: 'sin-nombre', candidatos: todos }

  const decidir = (encontrados: T[]): ResultadoNombre<T> | null => {
    if (encontrados.length === 1) return { ok: true, elegido: encontrados[0] }
    if (encontrados.length > 1) return { ok: false, motivo: 'ambiguo', candidatos: encontrados }
    return null
  }

  const nombresNormalizados = (item: T): string[] =>
    nombresDe(item)
      .map(normalizarNombre)
      .filter((n) => n !== '')

  // 1. El nombre completo, igualito.
  const exactos = todos.filter((item) => nombresNormalizados(item).some((n) => n === q))
  const porExacto = decidir(exactos)
  if (porExacto) return porExacto

  // 2. Uno contiene al otro: "gilberto franco" vs "franco", "delirio" vs "delirio 85".
  const contenidos =
    q.length >= LARGO_MINIMO_TOKEN
      ? todos.filter((item) =>
          nombresNormalizados(item).some((n) => n.includes(q) || q.includes(n))
        )
      : []
  const porContenido = decidir(contenidos)
  if (porContenido) return porContenido

  // 3. Alguna palabra de verdad en comun. No cuentan las de una o dos letras
  //    ("el" empataria "Dulceria el Eden" con cualquier cosa) ni las vacias
  //    ("del" empata medio directorio). Si de lo dicho no queda ninguna palabra
  //    util, esta pasada no empata con nada y se cae a "no encontrado", que es
  //    la respuesta correcta: no hay con que compararlo.
  const util = (t: string) => t.length >= LARGO_MINIMO_TOKEN && !PALABRAS_VACIAS.has(t)
  const tokensQ = q.split(' ').filter(util)
  const porPalabra =
    tokensQ.length === 0
      ? []
      : todos.filter((item) =>
          nombresNormalizados(item).some((n) =>
            n.split(' ').filter(util).some((t) => tokensQ.includes(t))
          )
        )
  const porToken = decidir(porPalabra)
  if (porToken) return porToken

  return { ok: false, motivo: 'no-encontrado', candidatos: todos }
}
