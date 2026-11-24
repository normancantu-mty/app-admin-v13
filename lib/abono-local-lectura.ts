/**
 * Los abonos vivos por surtir a locales, para corregir el "saldo por pagar" de
 * los dos directorios (`saldoPorPagarSinAbonoLocal`, `lib/abono-local.ts`).
 *
 * Con el cliente de la SESION, igual que `leerSaldosEntidad`: el RLS recorta las
 * mismas filas que suma la vista, asi que las dos cifras hablan de lo mismo.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import { CATEGORIA_ABONO_LOCAL, TIPO_ABONO_LOCAL, type FilaAbonoLocal } from '@/lib/abono-local'

export async function leerAbonosPorSurtirLocal(client: SupabaseClient<Database>): Promise<FilaAbonoLocal[]> {
  return fetchTodasLasFilas<FilaAbonoLocal>(
    () =>
      client
        .from('finanzas_ledger')
        .select('id_entidad_relacionada, tipo_movimiento, categoria, monto, status')
        .eq('tipo_movimiento', TIPO_ABONO_LOCAL)
        .eq('categoria', CATEGORIA_ABONO_LOCAL)
        .in('status', ['ACTIVO', 'APPROVED'])
        .order('id', { ascending: true }),
    'abonos por surtir a locales'
  )
}
