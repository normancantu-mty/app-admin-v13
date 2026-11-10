/**
 * FASE 9 (D92) — "LLEGARON 500 BOTELLAS DE 750": LA ENTRADA DE EMPAQUE QUE
 * DESBLOQUEA UN ENVASADO.
 *
 * Cuando envasar dejaria un insumo en negativo, el bot no escribe y pregunta
 * que paso (`mensajeFaltaEmpaque`, `lib/bot-envasado.ts`). La respuesta de
 * Norman llega aqui, se lee SIN modelo (como el monto o el codigo de lote: un
 * dato contestado a una pregunta concreta no se vuelve a extraer), y sale una
 * propuesta de ENTRADA de inventario con su VA. Al confirmarla, el bot vuelve a
 * proponer el envasado que estaba esperando.
 *
 * ─── EL TIPO DE MOVIMIENTO: `ENTRADA_COMPRA`, Y POR QUE ─────────────────────
 * La unica pantalla que mete insumos al inventario es
 * `/dashboard/inventario/compra` (`registrarCompraInsumosAction`,
 * app/actions/compras.ts:229-236), y usa `ENTRADA_COMPRA` con destino la
 * entidad que compra. No hay pantalla de conteo ni tipo de ajuste. Se usa ese
 * tipo, sin inventar uno. **Solo el renglon de inventario**: el dinero de esa
 * compra no se sabe desde aqui (ni cuanto costo, ni de que cuenta salio), y
 * escribir dinero sin haberlo visto es justo lo que el bot no hace. Se dice en
 * la propuesta.
 *
 * ─── DOS MANERAS DE DECIRLO ─────────────────────────────────────────────────
 *   · "llegaron 500 botellas"  -> ENTRAN 500 (modo `llego`).
 *   · "tengo 300 corchos"      -> HAY 300 en total: entran 300 menos las que
 *                                 ya estaban registradas (modo `hay`).
 * La diferencia se ensena en la propuesta con el antes y el despues.
 *
 * Todo aqui es PURO (`tests/bot-fase9-entrada-insumo.spec.ts`).
 */

import { sellar, selloEmpata } from '@/lib/bot-sello'

/** Un insumo que el envasado pendiente mueve: el unico universo de la lectura. */
export interface CandidatoEntrada {
  id: string
  nombre: string
  /** Lo registrado hoy en la matriz. */
  hay: number
  /** Lo que le falta al envasado pendiente (0 si alcanza). */
  falta: number
}

export interface RenglonEntrada {
  id_insumo: string
  nombre: string
  /** Lo que ENTRA (lo que se escribe). */
  cantidad: number
  /** Lo que la persona dijo, tal cual. */
  dicho: number
  modo: 'llego' | 'hay'
  hay_antes: number
}

export type LecturaEntrada =
  | { ok: true; renglones: RenglonEntrada[]; avisos: string[] }
  | { ok: false; error: string }

/** Arriba de esto no es una entrada dictada: va en la pantalla. */
export const TOPE_ENTRADA = 100000

const PALABRAS_HAY = /\b(tengo|tenemos|tienes|hay|quedan|queda|son|conte|contamos|contaron|contadas|en total)\b/
const PALABRAS_LLEGO = /\b(llegaron|llego|llegan|compre|compramos|compraron|entraron|entro|trajeron)\b/
export const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'ml', 'vacia', 'vacias', 'y', 'con'])

export function limpiar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d),(\d{3})\b/g, '$1$2') // 1,000 -> 1000
    .replace(/(\d)\.(\d)/g, '$1_$2') // decimales: se protegen del punto
    .replace(/[^a-z0-9_ ]/g, ' ')
    .replace(/_/g, '.')
    .replace(/(\d)([a-z])/g, '$1 $2') // 750ml -> 750 ml
    .replace(/\s+/g, ' ')
    .trim()
}

export function singular(palabra: string): string {
  if (palabra.length > 4 && palabra.endsWith('ces')) return palabra.slice(0, -3) + 'z' // luces
  if (palabra.length > 3 && palabra.endsWith('s')) return palabra.slice(0, -1)
  return palabra
}

export function claves(nombre: string): { palabras: Set<string>; numeros: Set<string> } {
  const palabras = new Set<string>()
  const numeros = new Set<string>()
  for (const t of limpiar(nombre).split(' ')) {
    if (t === '') continue
    if (/^\d+(\.\d+)?$/.test(t)) numeros.add(t)
    else if (!VACIAS.has(t)) palabras.add(singular(t))
  }
  return { palabras, numeros }
}

function redondear(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * Lee "llegaron 500 botellas de 750 y 300 corchos" contra los insumos del
 * envasado pendiente. **Pura.**
 *
 * - Se parte por comas, punto y coma, renglones e "y".
 * - En cada pedazo, el PRIMER numero es la cantidad; los demas son medidas
 *   ("de 750") y sirven para escoger entre dos insumos con el mismo nombre.
 * - Un pedazo empata con un insumo si comparte una palabra de su nombre
 *   (singularizada) y, si dijo medida y el insumo la tiene, la misma medida.
 * - Dos insumos posibles -> se PREGUNTA cual, no se escoge.
 */
export function leerEntradasDichas(
  texto: unknown,
  candidatos: readonly CandidatoEntrada[]
): LecturaEntrada {
  const crudo = String(texto ?? '')
  const todo = limpiar(crudo)
  if (todo === '') return { ok: false, error: 'No oi cuanto hay.' }
  const modoGlobal: 'llego' | 'hay' = PALABRAS_HAY.test(todo) ? 'hay' : 'llego'

  const pedazos = crudo
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .split(/[,;\n]|\by\b/i)
    .map(limpiar)
    .filter((p) => p !== '')

  const indice = candidatos.map((c) => ({ c, k: claves(c.nombre) }))
  const suma = new Map<string, { c: CandidatoEntrada; dicho: number; modo: 'llego' | 'hay' }>()

  for (const pedazo of pedazos) {
    const tokens = pedazo.split(' ')
    const numeros = tokens.filter((t) => /^\d+(\.\d+)?$/.test(t))
    if (numeros.length === 0) continue
    const cantidad = Number(numeros[0])
    const medidas = new Set(numeros.slice(1))
    const palabras = new Set(
      tokens.filter((t) => !/^\d/.test(t) && !VACIAS.has(t)).map(singular)
    )
    const modo: 'llego' | 'hay' = PALABRAS_HAY.test(pedazo)
      ? 'hay'
      : PALABRAS_LLEGO.test(pedazo)
        ? 'llego'
        : modoGlobal

    const empatan = indice.filter(({ k }) => {
      if (![...k.palabras].some((p) => palabras.has(p))) return false
      if (medidas.size > 0 && k.numeros.size > 0) {
        return [...medidas].some((m) => k.numeros.has(m))
      }
      return true
    })
    if (empatan.length === 0) {
      return {
        ok: false,
        error:
          `No se a cual insumo va "${pedazo}". Me faltan: ` +
          candidatos.filter((c) => c.falta > 0).map((c) => c.nombre).join(', ') +
          '. Dimelo con el nombre, por ejemplo "llegaron 500 botellas de 750".'
      }
    }
    if (empatan.length > 1) {
      return {
        ok: false,
        error: `"${pedazo}" me da mas de uno: ${empatan.map((e) => e.c.nombre).join(' o ')}. Cual?`
      }
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0 || cantidad > TOPE_ENTRADA) {
      return { ok: false, error: `La cantidad de ${empatan[0].c.nombre} no se puede usar: ${numeros[0]}.` }
    }
    const previo = suma.get(empatan[0].c.id)
    suma.set(empatan[0].c.id, {
      c: empatan[0].c,
      dicho: redondear((previo?.dicho ?? 0) + cantidad),
      modo
    })
  }

  if (suma.size === 0) {
    return {
      ok: false,
      error: 'No oi cuanto hay. Dimelo asi: "llegaron 500 botellas de 750" o "tengo 300 corchos".'
    }
  }

  const renglones: RenglonEntrada[] = []
  const avisos: string[] = []
  for (const { c, dicho, modo } of suma.values()) {
    const cantidad = modo === 'hay' ? redondear(dicho - c.hay) : dicho
    if (cantidad <= 0) {
      avisos.push(`${c.nombre}: dices que hay ${dicho} y ya tengo ${c.hay} registradas; no entra nada.`)
      continue
    }
    renglones.push({ id_insumo: c.id, nombre: c.nombre, cantidad, dicho, modo, hay_antes: c.hay })
  }
  for (const c of candidatos) {
    if (c.falta <= 0) continue
    const entra = renglones.find((r) => r.id_insumo === c.id)?.cantidad ?? 0
    const sigue = redondear(c.falta - entra)
    if (sigue > 0) {
      avisos.push(`Con esto todavia me faltarian ${sigue} de ${c.nombre} para el envasado.`)
    }
  }
  if (renglones.length === 0) {
    return { ok: false, error: avisos.join(' ') || 'No entra nada.' }
  }
  return { ok: true, renglones, avisos }
}

// ─── EL BORRADOR Y SU SELLO ─────────────────────────────────────────────────

export interface PayloadEntradaInsumo {
  id_entidad_destino: string
  usuario_creador: string
  renglones: { id_insumo: string; cantidad: number; nota: string }[]
}

export const LLAVES_ENTRADA = ['id_entidad_destino', 'renglones', 'usuario_creador'] as const

export function sellarEntrada(payload: PayloadEntradaInsumo): string {
  return sellar(payload, LLAVES_ENTRADA)
}

export function selloEntradaCoincide(payload: PayloadEntradaInsumo, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_ENTRADA, sello)
}

export function payloadDeEntrada(
  renglones: readonly RenglonEntrada[],
  idAdmin: string,
  usuarioCreador: string
): PayloadEntradaInsumo {
  return {
    id_entidad_destino: idAdmin,
    usuario_creador: usuarioCreador,
    renglones: renglones.map((r) => ({
      id_insumo: r.id_insumo,
      cantidad: r.cantidad,
      nota:
        r.modo === 'hay'
          ? `Conteo dictado al bot: hay ${r.dicho}, registradas ${r.hay_antes}`
          : `Entrada dictada al bot: llegaron ${r.dicho}`
    }))
  }
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)))
}

export function mensajeDeEntrada(renglones: readonly RenglonEntrada[], avisos: readonly string[]): string {
  const lineas = [
    'Esto es lo que voy a escribir. Revisalo:',
    '',
    'ENTRA AL INVENTARIO DE LA MATRIZ:'
  ]
  for (const r of renglones) {
    const porque = r.modo === 'hay' ? `dices que hay ${num(r.dicho)}` : 'llegaron'
    lineas.push(
      `   +${num(r.cantidad)} ${r.nombre}   (${porque}; tenia ${num(r.hay_antes)} -> ` +
        `${num(r.hay_antes + r.cantidad)})`
    )
  }
  lineas.push(
    '',
    'Solo inventario: no registra dinero. Si fue una compra y quieres el gasto, dictamelo aparte.'
  )
  for (const a of avisos) lineas.push('', `OJO: ${a}`)
  lineas.push('', 'Contesta VA para escribirlo. Despues te vuelvo a proponer el envasado.')
  return lineas.join('\n')
}
