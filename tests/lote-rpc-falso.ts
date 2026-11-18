/**
 * Las dos LECTURAS de la migracion 20261118192907 para los dobles de Supabase
 * de las pruebas de rutas del bot (2026-11-18, agente Cuartel). Misma regla que
 * Postgres: `resolver_lote` = el lote por nombre actual o alias (sin mayusculas
 * ni espacios); `siguiente_codigo_lote` = el consecutivo. No escriben: el doble
 * no las cuenta como `rpc` de escritura.
 */

import { normalizarNombreLote, siguienteCodigoNumerico } from '@/lib/lote-alias'

type Fila = Record<string, unknown>

/** La respuesta de la rpc de lectura, o `undefined` si no es una de estas dos. */
export function rpcDeLoteFalsa(tabla: string, args: Fila, tablas: Record<string, Fila[]>): unknown {
  const lotes = tablas.lotes ?? []
  const alias = tablas.lote_alias ?? []
  if (tabla === 'rpc/resolver_lote') {
    const n = normalizarNombreLote(String(args.p_nombre ?? ''))
    return lotes.filter(
      (l) =>
        normalizarNombreLote(String(l.codigo_lote)) === n ||
        alias.some((a) => a.id_lote === l.id && normalizarNombreLote(String(a.alias)) === n)
    )
  }
  if (tabla === 'rpc/siguiente_codigo_lote') {
    return siguienteCodigoNumerico([...lotes.map((l) => String(l.codigo_lote)), ...alias.map((a) => String(a.alias))])
  }
  return undefined
}
