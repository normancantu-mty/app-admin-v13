/**
 * `/panel/correcciones` — correcciones del ADMIN por movimiento de ajuste.
 * Escrito el 2026-11-03 por el agente de la ruta admin. Ruta ESCONDIDA: ningun
 * menu la enlaza. 404 para todo rol que no sea ADMIN (puerta abajo, antes de leer).
 *
 * Solo dos cosas: (a) el stock de un producto YA registrado en una cubeta de una
 * entidad; (b) el saldo de una cuenta financiera existente. No crea productos ni
 * cuentas, no borra ni edita filas: escribe un ajuste por la diferencia.
 *
 * GRANULARIDAD DEL STOCK: entidad x producto x cubeta (PAGADO/CONSIGNADO), la de
 * `v_stock_por_cubeta`, leida de `stock_ajustable()` — la misma regla con la que
 * la RPC recalcula antes de escribir. La pantalla de Inventario muestra el stock
 * de la matriz sumando sus dos cubetas; aqui se separan porque el ajuste se
 * aplica a UNA cubeta.
 */

import { getServerSupabaseClient } from '@/lib/server-session'
import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Correcciones, type FilaCuenta, type FilaStock } from './Correcciones'

export const dynamic = 'force-dynamic'

export default async function PaginaCorrecciones() {
  // Solo ADMIN (SOCIO incluido fuera): 404, la ruta "no existe".
  const usuario = await exigirSesionV2()
  if (usuario.rol !== 'ADMIN') notFound()
  const supabase = await getServerSupabaseClient()

  let stock: FilaStock[] = []
  let cuentas: FilaCuenta[] = []
  let error: string | null = null
  try {
    const [s, c, e] = await Promise.all([
      supabase.rpc('stock_ajustable'),
      supabase.from('cuentas_financieras').select('id, nombre, clase, id_entidad').order('nombre'),
      supabase.from('entidades').select('id, nombre, rol')
    ])
    if (s.error) throw new Error(`stock_ajustable: ${s.error.message}`)
    if (c.error) throw new Error(`cuentas_financieras: ${c.error.message}`)
    if (e.error) throw new Error(`entidades: ${e.error.message}`)
    stock = (s.data ?? []).map((f) => ({ ...f, stock: Number(f.stock) }))
    const entidad = new Map((e.data ?? []).map((x) => [x.id, x]))
    const saldos = await Promise.all(
      (c.data ?? []).map(async (cta) => {
        const r = await supabase.rpc('saldo_cuenta', { p_id_cuenta: cta.id })
        if (r.error) throw new Error(`saldo_cuenta(${cta.nombre}): ${r.error.message}`)
        return Number(r.data)
      })
    )
    cuentas = (c.data ?? []).map((cta, i) => {
      const ent = cta.id_entidad ? entidad.get(cta.id_entidad) : undefined
      return { id: cta.id, nombre: cta.nombre, clase: cta.clase, entidad: ent?.nombre ?? '—', rol: ent?.rol ?? '', saldo: saldos[i] }
    })
    cuentas.sort((a, b) => Number(b.rol === 'ADMIN') - Number(a.rol === 'ADMIN') || a.entidad.localeCompare(b.entidad) || a.nombre.localeCompare(b.nombre))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <>
      <EncabezadoPagina
        titulo="Correcciones (ADMIN)"
        sub="Corrige stock y saldos con un movimiento de ajuste auditado. No edita ni borra filas."
      />
      {error ? <div className="msg mal">No se pudieron leer los datos: {error}</div> : <Correcciones stock={stock} cuentas={cuentas} />}
    </>
  )
}
