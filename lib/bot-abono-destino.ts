/**
 * Lo que el bot lee de la base para decidir A QUE CUENTA entra un abono
 * (2026-11-26, MAPA n7). La decision NO vive aqui: vive en
 * `lib/abono-cuentas.ts`, la misma funcion que usa la web. Esto solo le junta
 * los hechos: el DST padre del deudor, las cuentas que el bot puede usar de una
 * entidad, y el dueno (y su rol) de cada cuenta.
 *
 * Dos lecturas sueltas y no un `select` incrustado: asi tambien las sigue el
 * PostgREST simulado de `tests/bot-rutas-permisos.spec.ts`.
 */
import { cuentaUsableporElBot, type ClienteServicio } from '@/lib/bot-servidor'
import type { CuentaDelAbono } from '@/lib/abono-cuentas'

export interface DstDelLocal {
  id: string
  nombre: string
}

/**
 * El DST del que cuelga un LOC (por `id_nodo_padre` o `id_padre`, la misma regla
 * que `mis_entidades()`), o `null` si el deudor no es un LOC de un DST. Un LOC
 * sin padre le debe a la matriz: ahi no hay nada que avisar.
 */
export async function leerDstDelLocal(
  supabase: ClienteServicio,
  idEntidad: string
): Promise<DstDelLocal | null> {
  const { data: loc } = await supabase
    .from('entidades')
    .select('id, rol, id_padre, id_nodo_padre')
    .eq('id', idEntidad)
    .maybeSingle()
  if (!loc || String(loc.rol ?? '').toUpperCase() !== 'LOC') return null
  const padres = [loc.id_nodo_padre, loc.id_padre].filter((p): p is string => Boolean(p))
  if (padres.length === 0) return null
  const { data } = await supabase.from('entidades').select('id, nombre, rol').in('id', padres)
  for (const idPadre of padres) {
    const padre = (data ?? []).find((e) => e.id === idPadre)
    if (padre && String(padre.rol ?? '').toUpperCase() === 'DST') {
      return { id: padre.id, nombre: padre.nombre ?? '(distribuidor)' }
    }
  }
  return null
}

/** Las cuentas de una entidad que el bot puede usar (sin FULL_TAX ni la de Fresnillo). */
export async function leerCuentasUsablesDe(
  supabase: ClienteServicio,
  idEntidad: string
): Promise<{ id: string; nombre: string }[]> {
  const { data } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre, tipo_fiscalidad')
    .eq('id_entidad', idEntidad)
  return (data ?? [])
    .filter(cuentaUsableporElBot)
    .map((c) => ({ id: c.id, nombre: c.nombre ?? '(cuenta)' }))
}

/** Cada cuenta con su dueno y el rol del dueno, en la forma que pide `reglaDeCuentasDelAbono`. */
export async function leerCuentasConDueno(
  supabase: ClienteServicio,
  ids: readonly string[]
): Promise<Map<string, CuentaDelAbono>> {
  const salida = new Map<string, CuentaDelAbono>()
  const { data: cuentas } = await supabase
    .from('cuentas_financieras')
    .select('id, id_entidad')
    .in('id', [...ids])
  const duenos = [...new Set((cuentas ?? []).map((c) => c.id_entidad).filter((d): d is string => Boolean(d)))]
  const { data: entidades } =
    duenos.length > 0
      ? await supabase.from('entidades').select('id, rol').in('id', duenos)
      : { data: [] as { id: string; rol: string | null }[] }
  for (const c of cuentas ?? []) {
    const dueno = (entidades ?? []).find((e) => e.id === c.id_entidad)
    salida.set(c.id, {
      id: c.id,
      id_entidad: c.id_entidad,
      rol: dueno?.rol ? String(dueno.rol).toUpperCase() : null
    })
  }
  return salida
}
