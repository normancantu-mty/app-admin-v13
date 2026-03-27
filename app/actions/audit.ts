'use server'

import { supabase } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth-utils'
import { EstadoFinanzaLedger } from '@/types/database'

export async function bulkDeleteMovements(ids: string[]) {
  const currentUser = await getCurrentUser()
  if (!currentUser || currentUser.rol !== 'ADMIN') {
    throw new Error('Solo ADMIN puede borrar movimientos.')
  }

  // Obtener los movimientos antes de borrar
  const { data: movimientos, error: fetchError } = await supabase
    .from('finanzas_ledger')
    .select('*')
    .in('id', ids)
    .eq('status', 'APPROVED')

  if (fetchError) {
    throw new Error(`Error al obtener movimientos: ${fetchError.message}`)
  }

  // Registrar en auditoria_logs
  const auditoriaInserts = movimientos.map(movimiento => ({
    accion: 'DELETE',
    json_estado_anterior: movimiento,
    usuario_id: currentUser.id,
    fecha_accion: new Date().toISOString()
  }))

  const { error: auditError } = await supabase
    .from('auditoria_logs')
    .insert(auditoriaInserts)

  if (auditError) {
    throw new Error(`Error al registrar auditoría: ${auditError.message}`)
  }

  // Borrar los movimientos
  const { error: deleteError } = await supabase
    .from('finanzas_ledger')
    .delete()
    .in('id', ids)

  if (deleteError) {
    throw new Error(`Error al borrar movimientos: ${deleteError.message}`)
  }

  return { success: true, count: ids.length }
}
