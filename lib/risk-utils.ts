import { DIAS_SEMAFORO_AMARILLO, DIAS_SEMAFORO_ROJO } from '@/lib/dashboard-utils'

/**
 * Semaforo del directorio. Las lecturas que vivian aqui (y su historia: cliente de
 * navegador, permission denied tragado, ledger sin paginar) se mudaron a
 * `lib/actividad-servidor.ts` en la ronda 2 de la auditoria (2026-10-29).
 */


// ============================================================================
// Ronda 2 (auditoria 2026-10-29, Socio ejecutor): `getMovimientosFinanzas`,
// `getMovimientosInventario` y `calcularUltimoMovimiento` se fueron. Eran la SEGUNDA
// regla de actividad del ERP (contaba filas ANULADAS de finanzas y no el corte de
// arranque) y daban otro numero que el Dashboard General para el mismo nodo el mismo
// dia. La regla unica vive en `lib/actividad.ts` y la lectura en
// `lib/actividad-servidor.ts`.
// ============================================================================

/**
 * Semaforo del directorio a partir de los dias sin actividad (`diasDesde`).
 * Mismos umbrales que el Dashboard General: 🟢 < 7, 🟡 7-14, 🔴 > 14.
 * Sin ninguna actividad registrada: ⚪.
 */
export function getSemaforoMovimiento(dias: number | null): string {
  if (dias === null) return '⚪'
  if (dias < DIAS_SEMAFORO_AMARILLO) return '🟢'
  if (dias <= DIAS_SEMAFORO_ROJO) return '🟡'
  return '🔴'
}
