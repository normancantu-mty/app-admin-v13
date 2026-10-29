/** Paridad v2 — modal «Registrar gasto» (alta manual de la v1: egreso, ingreso o transferencia). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { getServerSupabaseClient } from '@/lib/server-session'
import { Modal } from '@/components/v2/modal/Modal'
import Gasto from '@/components/v2/finanzas/Gasto'

export default async function ModalGasto() {
  const usuario = await exigirSesionV2()
  if (!puedeCapturarMatriz(usuario.rol)) notFound()
  const supabase = await getServerSupabaseClient()
  // Las mismas dos lecturas que /dashboard/finanzas/nuevo.
  const [{ data: cuentas }, { data: categorias }] = await Promise.all([
    supabase.from('cuentas_financieras').select('id, nombre, tipo:tipo_fiscalidad').eq('id_entidad', usuario.id).order('nombre', { ascending: true }),
    supabase.from('categorias_movimiento').select('categoria, subcategoria').eq('tipo', 'EGRESO').eq('activa', true).order('orden', { ascending: true })
  ])
  const categoriasEgreso: Record<string, string[]> = {}
  for (const f of (categorias ?? []) as { categoria: string; subcategoria: string }[]) {
    ;(categoriasEgreso[f.categoria] ??= []).push(f.subcategoria)
  }
  return (
    <Modal titulo="Registrar gasto" sub="Movimiento financiero manual · lista cerrada de categorías" tam="md">
      <div className="v1">
        <Gasto cuentas={(cuentas ?? []) as { id: string; nombre: string; tipo: string }[]} categoriasEgreso={categoriasEgreso} />
      </div>
    </Modal>
  )
}
