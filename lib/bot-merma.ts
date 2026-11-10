/**
 * MERMA DESDE EL BOT — el lado puro (2026-11-07).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web,
 * Fase 3). Sin red ni base: se prueba en `tests/bot-merma.spec.ts`.
 *
 * "Se rompieron 2 botellas de 750" -> salen 2 piezas de "Destilado Plata 750ml"
 * del inventario de quien lo dice, con la MISMA escritura que el boton "Reportar
 * merma" de la web (`escribirSalidaCascada`, `lib/salida-cascada.ts`).
 *
 * **Sin modelo y sin adivinar.** El producto sale de una palabra o numero que
 * solo UN producto del catalogo tiene ("750", "pasta"); la cantidad, del unico
 * numero que queda. Si hay dos productos posibles, ninguno, o dos cantidades,
 * no se propone nada: se pregunta UNA cosa.
 */

import { sellar, selloEmpata } from '@/lib/bot-sello'
import type { AccionBot } from '@/lib/bot-permisos'

/**
 * La merma sale del inventario de quien la dice (la matriz): mismo permiso que
 * registrar un lote (ADMIN; el trabajador, con Aprobar). Se reusa en vez de
 * agregar una accion a `lib/bot-permisos.ts`, que hoy tambien edita la rama de
 * permisos del equipo. Si se quiere separar, es una linea alla.
 */
export const PERMISO_MERMA: AccionBot = 'lote'
export const MENSAJE_MERMA_NO_PERMITIDA = 'Registrar merma por aqui no te toca con tu alta.'

export interface ProductoDeMerma {
  id: string
  nombre: string
}

export interface PayloadMerma {
  id_entidad: string
  id_producto: string
  cantidad: number
  tipo_movimiento: 'MERMA'
  usuario_creador: string
  notas: string
}

export const LLAVES_MERMA = ['id_entidad', 'id_producto', 'cantidad', 'tipo_movimiento', 'usuario_creador', 'notas'] as const

export function sellarMerma(p: PayloadMerma): string {
  return sellar(p, LLAVES_MERMA)
}

export function selloMermaCoincide(p: PayloadMerma, sello: unknown): boolean {
  return selloEmpata(p, LLAVES_MERMA, sello)
}

function normalizar(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/** Palabras y numeros de un texto; "750ml" -> "750", "ml". */
function fichas(texto: string): string[] {
  return normalizar(texto)
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const UNIDADES = new Set(['ml', 'kg', 'g', 'gr', 'l', 'lt', 'lts', 'pz', 'pza', 'pzas'])

/**
 * Las fichas que distinguen a cada producto: las que NINGUN otro producto
 * tiene. Numeros de 2+ cifras ("750", "250", "50") y palabras de 4+ letras.
 * Un "2" de "2kg" no cuenta: "se rompieron 2 de 750" no es pasta. **Pura.**
 */
export function fichasDistintivas(productos: readonly ProductoDeMerma[]): Map<string, string[]> {
  const cuantos = new Map<string, number>()
  const porProducto = new Map<string, Set<string>>()
  for (const p of productos) {
    const propias = new Set(
      fichas(p.nombre).filter((f) => !UNIDADES.has(f) && (/^\d{2,}$/.test(f) || /^[a-z]{4,}$/.test(f)))
    )
    porProducto.set(p.id, propias)
    for (const f of propias) cuantos.set(f, (cuantos.get(f) ?? 0) + 1)
  }
  const salida = new Map<string, string[]>()
  for (const [id, propias] of porProducto) salida.set(id, [...propias].filter((f) => cuantos.get(f) === 1))
  return salida
}

const PALABRAS_NUMERO: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12
}

export type LecturaMerma =
  | { ok: true; producto: ProductoDeMerma; cantidad: number }
  | { ok: false; falta: 'producto'; opciones: ProductoDeMerma[] }
  | { ok: false; falta: 'cantidad'; producto: ProductoDeMerma }

/** Que producto y cuantas piezas dijo. **Pura.** */
export function leerMerma(texto: string, productos: readonly ProductoDeMerma[]): LecturaMerma {
  const dichas = fichas(texto)
  const presentes = new Set(dichas)
  const distintivas = fichasDistintivas(productos)
  const candidatos = productos.filter((p) => (distintivas.get(p.id) ?? []).some((f) => presentes.has(f)))
  // `opciones` vacia = no nombro ningun producto: quien llama decide que no es merma.
  if (candidatos.length !== 1) return { ok: false, falta: 'producto', opciones: candidatos }
  const producto = candidatos[0]
  const delProducto = new Set(fichas(producto.nombre))
  const numeros = dichas
    .filter((f) => !delProducto.has(f))
    .map((f) => (/^\d+$/.test(f) ? Number(f) : PALABRAS_NUMERO[f]))
    .filter((n): n is number => Number.isInteger(n) && n > 0)
  const distintos = [...new Set(numeros)]
  if (distintos.length !== 1) return { ok: false, falta: 'cantidad', producto }
  return { ok: true, producto, cantidad: distintos[0] }
}

/**
 * ¿El texto HABLA de merma? Lo usa el bot antes de gastar una llamada al
 * modelo. Sin una de estas palabras no se intenta (un "se rompio la llanta,
 * 300 del taller" si entra, y lo frena que la llanta no es un producto).
 */
export const PATRON_MERMA =
  /\b(merma|mermas|mermo|se\s+(?:me\s+|nos\s+|le\s+|les\s+)?(?:rompi\w*|quebr\w*|cay\w*|derram\w*|estrell\w*)|rot[ao]s?|quebrad[ao]s?|estrellad[ao]s?)\b/

export function hablaDeMerma(texto: string): boolean {
  return PATRON_MERMA.test(normalizar(texto))
}

export function payloadDeMerma(
  l: Extract<LecturaMerma, { ok: true }>,
  idEntidad: string,
  usuarioCreador: string,
  texto: string
): PayloadMerma {
  return {
    id_entidad: idEntidad,
    id_producto: l.producto.id,
    cantidad: l.cantidad,
    tipo_movimiento: 'MERMA',
    usuario_creador: usuarioCreador,
    notas: `Merma dictada al bot: ${String(texto ?? '').trim().slice(0, 200)}`
  }
}

export function piezasTexto(n: number): string {
  return `${n} ${n === 1 ? 'pieza' : 'piezas'}`
}

/** De que cubeta sale (misma regla que `calcularDeduccionCascada`), sin lanzar. **Pura.** */
export function planDeCascada(cantidad: number, pagado: number, consignado: number) {
  const dePagado = Math.min(cantidad, pagado)
  const deConsignado = Math.min(cantidad - dePagado, consignado)
  return { dePagado, deConsignado, alcanza: dePagado + deConsignado === cantidad }
}

export function mensajeDeMerma(
  p: PayloadMerma,
  producto: string,
  entidad: string,
  stock: { pagado: number; consignado: number }
): string {
  const plan = planDeCascada(p.cantidad, stock.pagado, stock.consignado)
  const salen = [
    plan.dePagado > 0 ? `${piezasTexto(plan.dePagado)} de lo PAGADO` : '',
    plan.deConsignado > 0 ? `${piezasTexto(plan.deConsignado)} de lo CONSIGNADO` : ''
  ].filter(Boolean)
  return (
    'MERMA: sale del inventario y NO toca dinero\n\n' +
    `PRODUCTO:   ${producto}\n` +
    `CANTIDAD:   ${piezasTexto(p.cantidad)}\n` +
    `DE:         ${entidad}\n` +
    `SALE DE:    ${salen.join(' y ')}\n` +
    `HAY HOY:    ${piezasTexto(stock.pagado)} pagadas, ${piezasTexto(stock.consignado)} consignadas\n` +
    `NOTA:       ${p.notas}\n\n` +
    'Es la misma escritura que "Reportar merma" de la web.\n' +
    'Contesta VA para escribirlo, o dime que cambio.'
  )
}

export function preguntaDeMerma(l: Exclude<LecturaMerma, { ok: true }>): string {
  if (l.falta === 'cantidad') {
    return `Merma de ${l.producto.nombre}: ¿cuantas piezas? Dimelo con el producto, p. ej. "merma de 2 ${l.producto.nombre}".`
  }
  return `¿Merma de que producto? Dimelo con su tamano o nombre: ${l.opciones.map((p) => p.nombre).join(', ')}.`
}
