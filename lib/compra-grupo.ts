/**
 * 2026-11-08 — LA LIGA DE UNA COMPRA DE VARIAS LINEAS (foto de factura/cotizacion).
 *
 * Escrito el 2026-11-08 por el ejecutor del Socio (bot: compra desde foto, multilinea).
 *
 * Una compra leida de un documento escribe N entradas al almacen
 * (`inventario_ledger`, ENTRADA_COMPRA) y M filas de dinero (`finanzas_ledger`:
 * una COMPRA_INSUMOS por insumo y, si hubo flete, un GASTO_OPERATIVO). Sueltas
 * descuadran: anular el dinero de una linea y dejar su entrada es material
 * gratis; anular una entrada y dejar su dinero es dinero sin material.
 *
 * ─── LA LIGA ────────────────────────────────────────────────────────────────
 * `compra:<uuid>:<entradas>:<filas_de_dinero>`, en `notas` de cada entrada y al
 * final de `descripcion` de cada fila de dinero (entre corchetes). Mismo molde
 * que la pareja de traspasos (`lib/traspaso-pareja.ts`), con dos diferencias:
 *   · el tamano del grupo VIAJA en la marca: la anulacion sabe cuantas filas
 *     tiene que encontrar y, si encuentra otra cantidad, no anula nada;
 *   · va en `descripcion` y no en `subcategoria`, porque en este grupo la
 *     subcategoria ya tiene dueno (el flete lleva `Fletes`). Si alguien borra la
 *     marca de una descripcion, el grupo queda incompleto y la anulacion se
 *     niega en voz alta: mas vale un error en la cara que medio grupo anulado.
 * Sin migracion: las dos columnas ya existen y no tienen CHECK.
 *
 * **Pura.**
 */

export const PREFIJO_MARCA_COMPRA = 'compra:'

const PATRON_MARCA = /compra:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,3}):(\d{1,3})/i

export interface MarcaDeCompra {
  marca: string
  uuid: string
  entradas: number
  dinero: number
}

export const MENSAJE_GRUPO_INCOMPLETO =
  'Esa fila es parte de una compra de varias lineas y el grupo no esta completo (o ya hay ' +
  'filas anuladas). No anulo una parte sola, porque descuadraria el almacen o el dinero. ' +
  'Hay que revisarlo a mano.'

export function marcaDeCompra(uuid: string, entradas: number, dinero: number): string {
  return `${PREFIJO_MARCA_COMPRA}${uuid}:${entradas}:${dinero}`
}

/** La marca de grupo que trae un texto (`notas` o `descripcion`), o null. */
export function leerMarcaDeCompra(texto: unknown): MarcaDeCompra | null {
  const m = PATRON_MARCA.exec(String(texto ?? ''))
  if (!m) return null
  const entradas = Number(m[2])
  const dinero = Number(m[3])
  if (!(entradas >= 1) || !(dinero >= 1)) return null
  return { marca: m[0].toLowerCase(), uuid: m[1].toLowerCase(), entradas, dinero }
}

export interface FilaDeGrupo {
  id: string
  status: string | null
}

export type JuicioDeGrupo =
  | { ok: true; idsEntradas: string[]; idsDinero: string[] }
  | { ok: false; error: string }

/**
 * Exactamente las filas que la marca declara, y todas activas. **Pura.**
 * Cualquier otra cosa no se anula.
 */
export function juzgarGrupo(
  marca: MarcaDeCompra,
  entradas: readonly FilaDeGrupo[],
  dinero: readonly FilaDeGrupo[]
): JuicioDeGrupo {
  if (entradas.length !== marca.entradas || dinero.length !== marca.dinero) {
    return { ok: false, error: MENSAJE_GRUPO_INCOMPLETO }
  }
  if ([...entradas, ...dinero].some((f) => f.status !== 'ACTIVO')) {
    return { ok: false, error: MENSAJE_GRUPO_INCOMPLETO }
  }
  return { ok: true, idsEntradas: entradas.map((f) => f.id), idsDinero: dinero.map((f) => f.id) }
}
