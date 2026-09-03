/**
 * Constantes transversales del ERP. Solo valores; sin dependencias.
 */

/**
 * **D-E25 — una sola ventana para editar y anular: 12 horas.**
 *
 * Antes habia tres numeros distintos para la misma pregunta ("¿ya es tarde
 * para deshacer esto?"): 24 h para DST y 15 min para WORKER en
 * `app/actions/audit.ts`, y 6 h en la ruta del perfil de distribuidor
 * (`app/actions/audit.ts`, `lib/ticket-annul-cascade.ts` y el espejo de la UI
 * en `app/dashboard/distribuidores/[id]/page.tsx`). El mismo usuario podia ver
 * el boton habilitado y recibir "ventana expirada" al pulsarlo.
 *
 * **El ADMIN no tiene ventana.** Cualquier otro rol queda acotado a estas
 * 12 horas contadas desde la fecha del movimiento (o del ticket).
 *
 * Este es el unico lugar donde vive el numero EN TypeScript. Desde el
 * 2026-09-02 tambien vive en Postgres: el trigger `tg_vigilar_update_no_admin`
 * (`supabase/migrations/20260902235000_bitacora_auditoria_y_triggers.sql`)
 * rechaza el UPDATE de un no-ADMIN pasadas las mismas 12 horas, porque la app
 * no es el unico camino a la base — con un token valido, PostgREST atiende un
 * `curl`. **Estan duplicados a proposito y no hay forma de evitarlo:** Postgres
 * no lee una constante de TypeScript ni al reves. Si cambias este numero,
 * cambia tambien el del trigger; `tests/candados-base.spec.ts` vigila que los
 * dos digan lo mismo y falla si divergen.
 */
export const VENTANA_EDICION_HORAS = 12

/** La misma ventana en milisegundos, que es como se compara contra `Date.now()`. */
export const VENTANA_EDICION_MS = VENTANA_EDICION_HORAS * 60 * 60 * 1000

/** Texto unico del error, para que las tres rutas digan exactamente lo mismo. */
export const VENTANA_EDICION_ERROR = `Ventana de anulación expirada (máximo ${VENTANA_EDICION_HORAS} horas).`
