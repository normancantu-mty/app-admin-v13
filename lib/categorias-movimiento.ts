/**
 * Alta de categoria / subcategoria en `categorias_movimiento` (la lista cerrada
 * de la v2). Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP equipo).
 *
 * Una sola regla para los dos caminos: la pantalla `/panel/m/categorias` y el
 * bot ("agrega la subcategoria X en Y", que espera el clic de Norman).
 *
 *   · La tabla exige subcategoria (NOT NULL): una categoria nueva nace con su
 *     primera subcategoria.
 *   · Si la categoria ya existe (sin importar mayusculas ni acentos) se usa su
 *     nombre tal cual esta escrito: "logistica y envios" -> "Logística y envíos".
 *   · Una categoria NUEVA no puede traer un disparador fiscal: `categoria` es la
 *     columna que `v_pasivo_fiscal` lee para dar por pagado un impuesto (D-175).
 *     Las existentes (p. ej. "Impuestos y regulatorio") se respetan.
 *
 * PURO (`tests/categorias-movimiento.spec.ts`).
 */

import { disparadoresFiscalesEn } from '@/lib/bot-gastos'
import { sellar, selloEmpata } from '@/lib/bot-sello'

export type TipoCategoria = 'EGRESO' | 'INGRESO'

export interface FilaCategoria {
  tipo: string
  categoria: string
  subcategoria: string
  orden?: number | null
}

export const TOPE_NOMBRE = 60

/** "Logística y Envíos " -> "logistica y envios". */
export function llaveDeNombre(x: unknown): string {
  return String(x ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function limpio(x: unknown): string {
  return String(x ?? '').replace(/\s+/g, ' ').trim()
}

export type JuicioAlta =
  | {
      ok: true
      tipo: TipoCategoria
      categoria: string
      subcategoria: string
      categoriaNueva: boolean
      orden: number
    }
  | { ok: false; motivo: string }

export function validarAltaCategoria(
  pedida: { tipo?: unknown; categoria?: unknown; subcategoria?: unknown },
  existentes: readonly FilaCategoria[]
): JuicioAlta {
  const tipo = String(pedida.tipo ?? 'EGRESO').toUpperCase()
  if (tipo !== 'EGRESO' && tipo !== 'INGRESO') return { ok: false, motivo: 'el tipo es EGRESO o INGRESO' }
  const categoriaDicha = limpio(pedida.categoria)
  const subcategoria = limpio(pedida.subcategoria)
  if (categoriaDicha === '') return { ok: false, motivo: 'falta la categoria' }
  if (subcategoria === '') return { ok: false, motivo: 'falta la subcategoria (la tabla no acepta una categoria sin al menos una)' }
  if (categoriaDicha.length > TOPE_NOMBRE || subcategoria.length > TOPE_NOMBRE) {
    return { ok: false, motivo: `los nombres van de 1 a ${TOPE_NOMBRE} caracteres` }
  }
  if (/[<>{}\\]/.test(categoriaDicha + subcategoria)) return { ok: false, motivo: 'el nombre trae caracteres no permitidos' }

  const delTipo = existentes.filter((f) => f.tipo === tipo)
  const yaCategoria = delTipo.find((f) => llaveDeNombre(f.categoria) === llaveDeNombre(categoriaDicha))
  const categoria = yaCategoria ? yaCategoria.categoria : categoriaDicha
  if (!yaCategoria) {
    const fiscal = disparadoresFiscalesEn(`${categoria} ${categoria.replace(/_/g, ' ')}`)
    if (fiscal.length > 0) {
      return { ok: false, motivo: 'ese nombre de categoria es justo lo que el ERP lee para dar por pagado un impuesto' }
    }
  }
  const repetida = delTipo.find(
    (f) => llaveDeNombre(f.categoria) === llaveDeNombre(categoria) && llaveDeNombre(f.subcategoria) === llaveDeNombre(subcategoria)
  )
  if (repetida) return { ok: false, motivo: `ya existe: ${repetida.categoria} / ${repetida.subcategoria}` }

  const ordenes = existentes.map((f) => Number(f.orden ?? 0)).filter((n) => Number.isFinite(n))
  const orden = (ordenes.length ? Math.max(...ordenes) : 0) + 1
  return { ok: true, tipo: tipo as TipoCategoria, categoria, subcategoria, categoriaNueva: !yaCategoria, orden }
}

// ─── EL SELLO DEL BOT (mismo patron que el alta de miembro) ─────────────────

export interface PayloadAltaCategoria {
  tipo: TipoCategoria
  categoria: string
  subcategoria: string
  orden: number
  creado_por: string
}

export const LLAVES_CATEGORIA = ['categoria', 'creado_por', 'orden', 'subcategoria', 'tipo'] as const

export function sellarCategoria(p: PayloadAltaCategoria): string {
  return sellar(p, LLAVES_CATEGORIA)
}

export function selloCategoriaCoincide(p: PayloadAltaCategoria, sello: unknown): boolean {
  return selloEmpata(p, LLAVES_CATEGORIA, sello)
}

export function mensajeDeAltaCategoria(j: { tipo: string; categoria: string; subcategoria: string; categoriaNueva: boolean }): string {
  const lineas = ['Esto es lo que voy a agregar a la lista de categorias. Revisalo:', '']
  lineas.push(`   ${j.categoria}  /  ${j.subcategoria}   (${j.tipo === 'INGRESO' ? 'ingreso' : 'gasto'})`)
  lineas.push('', j.categoriaNueva ? 'La categoria es NUEVA y nace con esta subcategoria.' : 'La categoria ya existe; agrego la subcategoria.')
  lineas.push('', 'Contesta VA para agregarla.')
  return lineas.join('\n')
}
