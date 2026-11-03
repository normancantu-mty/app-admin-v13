/** v2 — modal «Categorías»: ver la lista cerrada y agregar categoría/subcategoría. Escrito el 2026-11-03 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { getServerSupabaseClient } from '@/lib/server-session'
import { Modal } from '@/components/v2/modal/Modal'
import Categorias from '@/components/v2/finanzas/Categorias'

export default async function ModalCategorias() {
  const usuario = await exigirSesionV2()
  if (!puedeCapturarMatriz(usuario.rol)) notFound()
  const supabase = await getServerSupabaseClient()
  const { data } = await supabase
    .from('categorias_movimiento')
    .select('tipo, categoria, subcategoria, activa')
    .order('orden', { ascending: true })
  return (
    <Modal titulo="Categorías" sub="Lista cerrada de categorías y subcategorías · agregar" tam="md">
      <div className="v1">
        <Categorias filas={(data ?? []) as { tipo: string; categoria: string; subcategoria: string; activa: boolean }[]} />
      </div>
    </Modal>
  )
}
