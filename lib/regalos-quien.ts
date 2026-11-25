/**
 * QUIEN REGALO — la lista cerrada. Escrito el 2026-11-25 por el ejecutor del
 * Socio. Puro: sin red ni base. Se prueba en `tests/regalos-nombres.spec.ts` y
 * `tests/regalos-destino.spec.ts`.
 *
 * Norman, 2026-11-25: «que solo se pueda a los nombres que ya tienes… pero que
 * tambien se pueda a los distribuidores y locales». O sea: el equipo + las
 * entidades DST y LOC del ERP (las lee `leerQuienes`, en el servidor). Un nombre
 * fuera de la lista no se guarda NI se le carga a quien dicta: se pregunta.
 *
 * COMO EMPATA (sin acentos, mayusculas ni puntuacion):
 *  1. El nombre completo de dos o mas palabras ("casa verde"): ese.
 *  2. Una parte del nombre, por palabras completas ("al son"), si es de UNO solo.
 *  3. Si es de dos o mas, se pregunta. Nunca se escoge "el mas parecido".
 *
 * LA REGLA DE GILBERTO: un nombre de una sola palabra que es de alguien del
 * equipo y que TAMBIEN trae una entidad ("Gilberto" y "Gilberto Franco") es un
 * empate: se pregunta, aunque coincida exacto con el del equipo.
 *   - "Gilberto Franco" o "Franco": la entidad.
 *   - "Gilberto del equipo" o "Gilberto (equipo)": la persona.
 *   - Si quien dicta ES Gilberto y no nombra a nadie: la persona (viene de su alta).
 * Lo mismo vale para cualquier otro ("David" a secas con dos David). Si ninguna
 * entidad trae ese nombre, no hay empate y no se pregunta nada.
 */

import { normalizarNombre } from '@/lib/bot-nombres'

export type TipoQuien = 'equipo' | 'distribuidor' | 'local'

export interface QuienPermitido {
  nombre: string
  tipo: TipoQuien
  /** Solo DST y LOC: su id en `entidades`. Dos o mas: dos entidades con el mismo nombre y tipo. */
  ids?: string[]
}

/** Una entidad del ERP a la que se le puede dar un regalo. */
export interface DestinoRegalo {
  id: string
  nombre: string
  tipo: 'distribuidor' | 'local'
}

/**
 * ¿Es un distribuidor o un local DE VERDAD? En `entidades` hay renglones con rol
 * LOC que son una regla de precio ("Descuento del 30%", "Venta mayoreo") o un
 * centinela. La base no tiene columna que los distinga: se reconocen por el
 * nombre. A esos no se les regala, no regalan y su ficha no lleva la seccion
 * Regalos. **Pura.**
 */
export function esEntidadReal(nombre: unknown): boolean {
  const crudo = String(nombre ?? '')
  const n = normalizarNombre(crudo)
  if (n === '') return false
  if (/%/.test(crudo) || /\bpor ciento\b/.test(n)) return false
  if (/^(?:con |sin )?(?:descuentos?|rebajas?|promocion(?:es)?|promos?|cortesias?|mermas?|regalos?)\b/.test(n)) return false
  const CLASE = '(?:mayoreo|menudeo|mayoristas?|minoristas?|mostrador|publico(?: en)?(?: general)?|directas?|online|en linea|generales|general)'
  if (new RegExp(`^(?:(?:ventas?|precios?|clientes?)(?: a| al| de| del| por| con| en)* )?${CLASE}$`).test(n)) return false
  if (/^ventas?$|^precios?$/.test(n)) return false
  // "Mayoreo Zacatecas", "Venta de mayoreo Fresnillo", "Precio especial", "Ajuste", "Muestras", "NO USAR".
  if (/^(?:ventas? (?:(?:a|al|de|del|por|con|en) )*)?(?:mayoreo|menudeo)\b/.test(n)) return false
  if (/^precios? especial(?:es)?\b/.test(n)) return false
  if (/^(?:ajustes?|muestras?|consumo interno)\b|\bno usar\b/.test(n)) return false
  if (/^(?:pendiente|por) (?:de )?asignar$|^sin (?:asignar|nombre|local|distribuidor)$/.test(n)) return false
  if (/^(?:prueba|test|demo|ejemplo)(?: |$)/.test(n)) return false
  return true
}

/** Los del equipo. */
export const QUIENES_CONOCIDOS = ['Norman', 'Kevin', 'Cristian', 'Gilberto', 'Luis'] as const

/** Como le dicen -> como se guarda. */
const APODOS: Readonly<Record<string, string>> = { cris: 'Cristian' }

export const EQUIPO: readonly QuienPermitido[] = QUIENES_CONOCIDOS.map((nombre) => ({ nombre, tipo: 'equipo' }))

/** ¿Es un distribuidor o un local? **Pura.** */
export function esDeLaRed(q: QuienPermitido | null | undefined): q is QuienPermitido {
  return q !== null && q !== undefined && q.tipo !== 'equipo'
}

/** "kevin" -> "Kevin"; "Cris" -> "Cristian"; lo demas, limpio y tal cual. **Pura.** */
export function normalizarQuien(texto: unknown): string {
  const limpio = String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 60).trim()
  if (limpio === '') return ''
  const plano = limpio.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  if (APODOS[plano]) return APODOS[plano]
  for (const q of QUIENES_CONOCIDOS) if (plano === q.toLowerCase()) return q
  return limpio
}

/** Las entidades que pueden RECIBIR un regalo: DST y LOC reales, una por id. **Pura.** */
export function listaDeDestinos(entidades: readonly { id: string; nombre: string; rol: string }[]): DestinoRegalo[] {
  return entidades.flatMap((e) => {
    const tipo = e.rol === 'DST' ? ('distribuidor' as const) : e.rol === 'LOC' ? ('local' as const) : null
    return tipo !== null && esEntidadReal(e.nombre) ? [{ id: e.id, nombre: String(e.nombre).replace(/\s+/g, ' ').trim(), tipo }] : []
  })
}

/** El equipo + los DST y LOC reales del ERP. Cualquier otro rol no entra. **Pura.** */
export function listaDeQuienes(entidades: readonly { id?: string; nombre: string; rol: string }[]): QuienPermitido[] {
  const lista: QuienPermitido[] = [...EQUIPO]
  const ya = new Set(lista.map((q) => normalizarNombre(q.nombre)))
  for (const e of entidades) {
    const tipo: TipoQuien | null = e.rol === 'DST' ? 'distribuidor' : e.rol === 'LOC' ? 'local' : null
    const limpio = String(e.nombre ?? '').replace(/\s+/g, ' ').trim().slice(0, 60).trim()
    if (tipo === null || !esEntidadReal(limpio)) continue
    const ids = e.id ? [e.id] : []
    // Se llama IGUAL que uno que ya esta: se distingue por lo que es. Mismo nombre y mismo tipo: la misma cuenta
    // de quien regala, pero son DOS destinos: guarda los dos ids y el bot no adivina cual.
    const igual = lista.find((q) => q.tipo === tipo && [limpio, `${limpio.slice(0, 44)} (${tipo})`].some((x) => normalizarNombre(x) === normalizarNombre(q.nombre)))
    if (igual) {
      igual.ids?.push(...ids)
      continue
    }
    const nombre = ya.has(normalizarNombre(limpio)) ? `${limpio.slice(0, 44)} (${tipo})` : limpio
    if (ya.has(normalizarNombre(nombre))) continue
    ya.add(normalizarNombre(nombre))
    lista.push(ids.length ? { nombre, tipo, ids } : { nombre, tipo })
  }
  return lista
}

/** "Gilberto (equipo)". Se puede contestar tal cual. **Pura.** */
export function etiquetaQuien(q: QuienPermitido): string {
  return normalizarNombre(q.nombre).endsWith(` ${q.tipo}`) ? q.nombre : `${q.nombre} (${q.tipo})`
}

function formas(q: QuienPermitido): string[] {
  const apodos = q.tipo === 'equipo' ? Object.keys(APODOS).filter((a) => APODOS[a] === q.nombre) : []
  return [normalizarNombre(q.nombre), ...apodos]
}

/** Para ESCRIBIR: el nombre completo (o el apodo), o nada. **Pura.** */
export function quienExacto(texto: unknown, lista: readonly QuienPermitido[]): QuienPermitido | null {
  const q = normalizarNombre(texto)
  return q === '' ? null : (lista.find((x) => formas(x).includes(q)) ?? null)
}

const VACIAS = 'a al de del la las el los lo un una unos unas y e en con por para mi mis su sus tu tus'
/**
 * Palabras que despues de "de" son la razon o el producto, no una persona: "de
 * muestra", "de la casa", "de la boda de Kevin". Solas no empatan con nadie
 * ("de la casa" no es "Casa Verde"), salvo que sean el nombre completo.
 */
export const NO_ES_PERSONA: ReadonlySet<string> = new Set(
  (
    VACIAS +
    ' muestra muestras regalo regalos obsequio obsequios cortesia cortesias promocion promociones promo promos prueba pruebas' +
    ' degustacion degustaciones cata catas navidad cumple cumpleanos aniversario boda bodas bautizo quince quinceanos graduacion' +
    ' posada posadas fiesta fiestas evento eventos feria ferias expo expos congreso conferencia junta reunion inauguracion apertura' +
    ' agradecimiento bienvenida despedida detalle detalles donacion publicidad propaganda marketing mercadotecnia compensacion' +
    ' reposicion cambio garantia patrocinio rifa rifas premio premios sorteo sorteos intercambio dinamica concurso campana descuento' +
    ' casa bodega tienda planta fabrica destileria empresa oficina inventario almacen stock lote lotes matriz cava vitrina' +
    ' ano anos fin semana mes dia dias hoy ayer antier anteayer manana tarde noche verdad corazon fe hecho paso nuevo nueva nuevos' +
    ' nuevas mas ultima ultimas ultimo gratis gratuitas pilon broma parte' +
    ' enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre' +
    ' lunes martes miercoles jueves viernes sabado domingo' +
    ' destilado destilada destilados chile chiles guajillo mezcal tequila licor licores alcohol vidrio plata botella botellas bote botes' +
    ' pieza piezas producto productos caja cajas grande grandes chica chicas chico chicos mini minis mediana medianas pequena pequenas' +
    ' ml mililitros litro litros fresnillo' +
    // Razones que se dictan pegadas a la pieza, sin "en" ni "por": no son un nombre.
    ' concierto conciertos partido partidos torneo torneos cena cenas comida comidas desayuno desayunos almuerzo almuerzos brindis brindar' +
    ' festival festivales kermes kermesse carrera carreras rodeo jaripeo palenque charreada cabalgata rally exposicion exposiciones' +
    ' seminario taller talleres curso cursos clase clases capacitacion presentacion presentaciones show shows concursos dinamicas' +
    ' aniversarios bautizos graduaciones inauguraciones reuniones juntas visita visitas viaje viajes foto fotos grabacion video videos' +
    ' podcast entrevista entrevistas influencer influencers prensa cumpleanero temporada puente vacaciones halloween muertos independencia' +
    ' revolucion amistad lealtad fidelidad preferencia apoyo ayuda favor gusto error equivocacion compra compras pedido' +
    ' pedidos volumen consumo pago pagos servicio servicios trabajo trabajos convenio acuerdo colaboracion alianza gracias celebrando' +
    ' celebracion festejo festejos motivo razon probar conocer degustar pasado pasada proximo proxima'
  ).split(' ')
)

/** 0 a 1: cuantos pares de letras comparten (Dice). */
function parecido(a: string, b: string): number {
  const pares = (t: string) => {
    const s = t.replace(/ /g, '')
    return Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2))
  }
  const pa = pares(a)
  const resto = pares(b)
  const total = pa.length + resto.length
  let comunes = 0
  for (const x of pa) {
    const i = resto.indexOf(x)
    if (i >= 0) {
      comunes++
      resto.splice(i, 1)
    }
  }
  return total === 0 ? 0 : (2 * comunes) / total
}

/** Los de la lista con que se confunde lo dicho ("casa berde"). **Pura.** */
export function seConfunde(dicho: unknown, lista: readonly QuienPermitido[]): QuienPermitido[] {
  const d = normalizarNombre(dicho)
  return d === '' ? [] : lista.filter((x) => formas(x).some((f) => parecido(d, f) >= 0.65))
}

/** ¿El texto trae, completo, el nombre de alguien de la lista? **Pura.** */
export function mencionaA(texto: unknown, lista: readonly QuienPermitido[]): boolean {
  const t = ` ${normalizarNombre(texto)} `
  return lista.some((x) => formas(x).some((f) => t.includes(` ${f} `)))
}

/** Parecidos para ofrecer, el mas parecido primero (maximo 3). **Pura.** */
export function quienesParecidos(dicho: unknown, lista: readonly QuienPermitido[]): QuienPermitido[] {
  const q = normalizarNombre(dicho)
  const util = (t: string) => t.length >= 3 && !NO_ES_PERSONA.has(t)
  const palabras = q.split(' ').filter(util)
  return lista
    .map((x) => {
      const puntos = Math.max(
        ...formas(x).map((f) => {
          const suyas = f.split(' ').filter(util)
          if (suyas.some((s) => palabras.includes(s))) return 1
          return Math.max(parecido(q, f), ...suyas.flatMap((s) => palabras.map((p) => parecido(p, s))))
        })
      )
      return { x, puntos }
    })
    .filter((r) => r.puntos >= 0.45)
    .sort((a, b) => b.puntos - a.puntos)
    .slice(0, 3)
    .map((r) => r.x)
}

export type HallazgoQuien =
  | { ok: true; quien: QuienPermitido }
  | { ok: false; motivo: 'ambiguo' | 'desconocido'; opciones: QuienPermitido[] }

/** Lo dicho contra la lista cerrada. Ver la regla arriba. **Pura.** */
export function buscarQuien(dicho: unknown, lista: readonly QuienPermitido[]): HallazgoQuien {
  const q = normalizarNombre(dicho)
  const desconocido = (): HallazgoQuien => ({ ok: false, motivo: 'desconocido', opciones: quienesParecidos(q, lista) })
  if (q === '') return { ok: false, motivo: 'desconocido', opciones: [] }
  const exactos = lista.filter((x) => formas(x).includes(q))
  const tocayos = lista.filter((x) => normalizarNombre(x.nombre) === `${q} ${x.tipo}`)
  if (exactos.length === 1 && q.includes(' ') && tocayos.length === 0) return { ok: true, quien: exactos[0] }

  // "Gilberto del equipo", "David local": lo que es, dicho al final.
  const conTipo = /^(.+?)\s+(?:(?:del?|el|la|un)\s+)*(equipo|distribuidor|local)$/.exec(q)
  if (conTipo) {
    const suyos = lista.filter((x) => x.tipo === conTipo[2])
    const exacto = quienExacto(conTipo[1], suyos)
    return exacto ? { ok: true, quien: exacto } : buscarQuien(conTipo[1], suyos)
  }

  // "el local Casa Verde": lo que es, dicho al principio.
  const tipoAntes = /^(?:(?:el|la)\s+)?(distribuidor|local)a?\s+(.+)$/.exec(q)
  if (tipoAntes && exactos.length === 0) {
    const h = buscarQuien(tipoAntes[2], lista.filter((x) => x.tipo === tipoAntes[1]))
    if (h.ok || h.motivo === 'ambiguo') return h
  }

  const sinArticulo = q.replace(/^(?:el|la|los|las|don|dona)\s+/, '')
  for (const t of new Set([q, sinArticulo])) {
    const palabras = t.split(' ')
    const pura = palabras.every((p) => NO_ES_PERSONA.has(p)) || !palabras.some((p) => /[a-z]{3}/.test(p) && !VACIAS.split(' ').includes(p))
    const hallados = lista.filter((x) =>
      formas(x).some((f) => (pura ? f === t : ` ${f} `.includes(` ${t} `)))
    )
    if (hallados.length === 1) return { ok: true, quien: hallados[0] }
    if (hallados.length > 1) return { ok: false, motivo: 'ambiguo', opciones: hallados }
  }
  return desconocido()
}

// ─── Leer un nombre dentro de lo que se dicto ───────────────────────────────

/** Donde se acaba un nombre. */
const CONECTOR = new Set(
  ('en para pa por a al con y e o que porque pues como desde durante cuando donde motivo es fue era hoy ayer antier anteayer antes' +
    ' tambien solo nomas ya se le les lo nos me mas menos casi aproximadamente exactamente otra otras otro otros esta estas este estos esa esas ese esos' +
    ' todo todos toda todas total siguiente siguientes').split(' ')
)

const aplanado = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

interface Palabra {
  texto: string
  plano: string
  ini: number
  fin: number
}

/** Las palabras seguidas (solo espacios en medio) con que empieza `t`. */
function corrida(t: string): Palabra[] {
  const out: Palabra[] = []
  const patron = /[\p{L}\d]+(?:['’-][\p{L}\d]+)*%?/gu
  for (const m of t.matchAll(patron)) {
    const ini = m.index ?? 0
    const hueco = t.slice(out.length ? out[out.length - 1].fin : 0, ini)
    if (!/^\s*(?:&\s*|\(\s*)?$/.test(hueco)) break
    out.push({ texto: m[0], plano: aplanado(m[0]), ini, fin: ini + m[0].length })
    if (out.length === 8) break
  }
  return out
}

const CAPITAL = /^\p{Lu}\p{Ll}/u
const CON_TIPO = new Set(['equipo', 'distribuidor', 'local'])

export type NombreLeido =
  | { clase: 'si'; quien: QuienPermitido; dicho: string; fin: number }
  /** `cerca`: no esta en la lista, pero se confunde con alguien que si ("casa berde", "Casa Verde Centro"). */
  | { clase: 'duda'; motivo: 'ambiguo' | 'desconocido'; opciones: QuienPermitido[]; dicho: string; fin: number; cerca?: true }

/**
 * El nombre con que EMPIEZA `t` (lo que va despues de "de"). `null`: no es un
 * nombre (la razon, el producto, un conector). Lo que no se puede distinguir
 * regresa como duda: se pregunta, no se adivina.
 *
 * `cerrado`: hay "motivo:" aparte, asi que aqui no puede venir la razon.
 * `suelto`: sin "de" delante ("regalo Kevin 2 grandes"): un articulo no abre nombre. **Pura.**
 */
export function leerNombre(
  t: string,
  lista: readonly QuienPermitido[],
  op: { producto?: ReadonlySet<string>; cerrado?: boolean; suelto?: boolean } = {}
): NombreLeido | null {
  const palabras = corrida(t)
  if (palabras.length === 0) return null
  const noPersona = (p: string) => NO_ES_PERSONA.has(p) || (op.producto?.has(p) ?? false) || /^\d/.test(p)

  // 1. El tramo mas largo que empata con la lista.
  for (let n = Math.min(6, palabras.length); n >= 1; n--) {
    const frase = t.slice(palabras[0].ini, palabras[n - 1].fin)
    const exacto = quienExacto(frase, lista) !== null
    if (!exacto) {
      if (palabras.slice(0, n).every((p) => noPersona(p.plano) && !CON_TIPO.has(p.plano))) continue
      if (VACIAS.split(' ').includes(palabras[n - 1].plano)) continue
    }
    const h = buscarQuien(frase, lista)
    if (!h.ok && h.motivo === 'desconocido') continue
    let fin = palabras[n - 1].fin
    if (t[fin] === ')') fin++
    // "Kevin Robledo", "Luis Perez": el empate dejo un apellido fuera. No se adivina.
    const sigue = palabras[n]
    const sobra =
      sigue !== undefined &&
      t[fin - 1] !== ')' &&
      !CONECTOR.has(sigue.plano) &&
      !noPersona(sigue.plano) &&
      (op.cerrado === true || CAPITAL.test(sigue.texto))
    if (sobra) {
      const largo = palabras.slice(0, 5).findIndex((p, i) => i >= n && CONECTOR.has(p.plano))
      const hasta = largo === -1 ? Math.min(5, palabras.length) : largo
      const dicho = t.slice(palabras[0].ini, palabras[hasta - 1].fin)
      return { clase: 'duda', motivo: 'desconocido', opciones: h.ok ? [h.quien] : h.opciones, dicho, fin: palabras[hasta - 1].fin, cerca: true }
    }
    if (h.ok) return { clase: 'si', quien: h.quien, dicho: frase, fin }
    return { clase: 'duda', motivo: 'ambiguo', opciones: h.opciones, dicho: frase, fin }
  }

  // 2. No esta en la lista: ¿es una razon o parece alguien?
  const articulo = /^(el|la|los|las|un|una|unos|unas|mi|mis|su|sus|tu|tus|nuestro|nuestra)$/.test(palabras[0].plano)
  if (op.suelto && articulo) return null
  if (/^(nosotros|mia)$/.test(palabras[0].plano)) return null
  const primera = articulo ? palabras[1] : palabras[0]
  if (primera === undefined) return articulo ? { clase: 'duda', motivo: 'desconocido', opciones: [], dicho: t.slice(palabras[0].ini, palabras[0].fin), fin: palabras[0].fin } : null
  if (noPersona(primera.plano) || CONECTOR.has(primera.plano)) {
    // "casa berde": empieza como una razon, pero suena a uno de la lista. Se pregunta.
    const i = palabras.indexOf(primera)
    const corte = palabras.findIndex((p, j) => j > i && CONECTOR.has(p.plano))
    const frase = CONECTOR.has(primera.plano) ? [] : palabras.slice(i, corte === -1 ? palabras.length : corte)
    const dicho = frase.length > 1 ? t.slice(frase[0].ini, frase[frase.length - 1].fin) : ''
    const suena = seConfunde(dicho, lista)
    return suena.length > 0
      ? { clase: 'duda', motivo: 'desconocido', opciones: suena.slice(0, 3), dicho, fin: frase[frase.length - 1].fin, cerca: true }
      : null
  }
  let hasta = palabras.findIndex((p, i) => i > 0 && p !== primera && CONECTOR.has(p.plano))
  if (hasta === -1) hasta = palabras.length
  hasta = Math.min(hasta, 5)
  while (hasta > 1 && VACIAS.split(' ').includes(palabras[hasta - 1].plano)) hasta--
  const dicho = t.slice(palabras[0].ini, palabras[hasta - 1].fin)
  const suena = seConfunde(dicho, lista).length > 0
  return { clase: 'duda', motivo: 'desconocido', opciones: quienesParecidos(dicho, lista), dicho, fin: palabras[hasta - 1].fin, ...(suena ? { cerca: true as const } : {}) }
}

/**
 * Lo que va despues de un nombre: ¿"y Fany", "y de Kevin"? Son dos personas.
 * "y 2 chicas" o "y en la feria" no. **Pura.**
 */
export function sigueOtraPersona(t: string, lista: readonly QuienPermitido[]): boolean {
  const m = /^[\s,]*(?:y|e)\s+(?:(?:tambien\s+)?de\s+)?/i.exec(t)
  if (!m) return false
  const otro = leerNombre(t.slice(m[0].length), lista, { suelto: true })
  if (otro === null) return false
  return otro.clase === 'si' || otro.motivo === 'ambiguo' || CAPITAL.test(otro.dicho)
}

/**
 * "regalos de Casa Verde", "cuantos le hemos dado a al son": de que distribuidor o
 * local se pregunta. `pide`: el nombre que ya se reconocio, o "". `ambiguas`: otras
 * que traen el nombre de alguien del equipo ("Gilberto" y "Gilberto Franco"), o varias
 * que empatan. No se escoge "la mas parecida". **Pura.**
 */
export function entidadesDeConsulta(
  texto: string,
  pide: string,
  lista: readonly QuienPermitido[]
): { entidades: QuienPermitido[]; deNombre: boolean; ambiguas: QuienPermitido[] } {
  const red = lista.filter(esDeLaRed)
  const base = (q: QuienPermitido) => normalizarNombre(q.nombre).replace(/ (?:distribuidor|local)$/, '')
  if (pide !== '') {
    const p = normalizarNombre(pide)
    const suyas = red.filter((q) => base(q) === p || normalizarNombre(q.nombre) === p)
    const otras = red.filter((q) => !suyas.includes(q) && ` ${base(q)} `.includes(` ${p} `))
    return { entidades: suyas, deNombre: true, ambiguas: suyas.length > 0 ? [] : otras }
  }
  const m = /\b(?:de|del|a|al|para|lleva|llevan|tiene|tienen)\s+((?:(?:el|la|los|las)\s+)?[^?.,;]+)[?.,;\s]*$/i.exec(texto)
  if (!m) return { entidades: [], deNombre: false, ambiguas: [] }
  const h = buscarQuien(m[1], red)
  // "de al son": el "al" es de su nombre, pero la captura de arriba pudo comerselo. Por palabras completas da lo mismo.
  if (h.ok) return { entidades: [h.quien], deNombre: false, ambiguas: [] }
  return { entidades: [], deNombre: false, ambiguas: h.motivo === 'ambiguo' ? h.opciones : [] }
}
