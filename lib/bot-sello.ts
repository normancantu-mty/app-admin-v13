/**
 * El sello del bot — UNA sola implementacion para las dos fases que escriben.
 *
 * Sale de `lib/bot-gastos.ts` (Fase 1) sin cambiarle un byte al resultado: la
 * Fase 2 (abonos) necesita exactamente el mismo mecanismo sobre otro objeto, y
 * la alternativa era copiarlo. Una segunda copia del hash es un segundo lugar
 * donde el criterio puede divergir, y el dia que divergen **los sellos viejos
 * dejan de empatar y no se puede confirmar nada** — el fallo se veria como "la
 * propuesta cambio desde que te la ensene", que apunta al lugar equivocado.
 *
 * QUE ES: una **idempotency key** aplicada a un borrador, el patron de Stripe.
 * En la literatura de agentes el sellado del payload no tiene nombre propio; se
 * dice asi para no inventar uno.
 *
 * LA PROPIEDAD QUE DA, y que es la razon de que exista: entre que la persona ve
 * lo que se va a escribir y el INSERT, **no hay ningun campo que el modelo
 * pueda tocar**. No por disciplina: porque al confirmar no viaja ninguna fila.
 */

import { createHash } from 'node:crypto'

/**
 * ─── 🔴 POR QUE ESTO ES RECURSIVO: `jsonb` REORDENA LAS LLAVES ──────────────
 *
 * El borrador se guarda en `bot_borradores.payload`, que es **`jsonb`**, y
 * `jsonb` **no conserva el orden de las llaves de un objeto**: las reacomoda por
 * longitud y luego alfabeticamente. Un `{"id_ticket": "...", "monto": 1.23}`
 * vuelve de la base como `{"monto": 1.23, "id_ticket": "..."}`.
 *
 * Fijar el orden del nivel de arriba no alcanza en cuanto el payload lleva un
 * objeto ANIDADO —el abono lleva un arreglo de aplicaciones por pedido—, y el
 * sintoma es cruel: el sello recalculado no empata con el guardado, el endpoint
 * concluye correctamente *"la propuesta cambio desde que te la ensene"*, cancela
 * el borrador, y **nunca se puede confirmar nada**. Apunta a un ataque que no
 * existe en vez de a un detalle de serializacion.
 *
 * La Fase 1 no lo vio porque su payload es plano: puros escalares.
 *
 * Medido el 2026-09-12 contra produccion en la primera corrida punta a punta —
 * las 24 pruebas puras pasaban en verde, porque **ninguna hace el viaje de ida
 * y vuelta por la base**. Un sello que tiene que sobrevivir a un almacen se
 * prueba contra ese almacen.
 */
function canonizarValor(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonizarValor)
  if (valor !== null && typeof valor === 'object') {
    // Alfabetico, que es el criterio de RFC 8785 (JSON Canonicalization Scheme).
    // Lo que importa no es CUAL orden, sino que sea el mismo de los dos lados.
    const entradas = Object.entries(valor as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
    const ordenado: Record<string, unknown> = {}
    for (const [k, v] of entradas) ordenado[k] = canonizarValor(v)
    return ordenado
  }
  return valor
}

/**
 * JSON canonico: las llaves de arriba en el orden que dicta `llaves`, y las de
 * cualquier objeto anidado en orden alfabetico. Sin espacios.
 *
 * **El orden es parte del sello a proposito.** Un objeto con las mismas llaves
 * en otro orden tiene que dar el MISMO hash, o el sello estaria vigilando el
 * formato del JSON en vez del contenido de la fila.
 *
 * Una llave ausente en el objeto entra como `undefined` y `JSON.stringify` la
 * omite — igual que hacia la version de `bot-gastos.ts` de la que esto salio.
 */
export function canonizar(obj: unknown, llaves: readonly string[]): string {
  const orden: Record<string, unknown> = {}
  const fuente = (obj ?? {}) as Record<string, unknown>
  for (const llave of llaves) {
    orden[llave] = canonizarValor(fuente[llave])
  }
  return JSON.stringify(orden)
}

/** SHA-256 hex del JSON canonico. 64 caracteres: lo que exige el CHECK de `bot_borradores.sello`. */
export function sellar(obj: unknown, llaves: readonly string[]): string {
  return createHash('sha256').update(canonizar(obj, llaves), 'utf8').digest('hex')
}

/**
 * Compara sin distinguir mayusculas y tolerando espacios alrededor: el sello
 * viaja por JSON entre dos procesos y no vale la pena perder una escritura por
 * eso. Lo que NO se tolera es un prefijo — se compara completo.
 */
export function selloEmpata(obj: unknown, llaves: readonly string[], sello: unknown): boolean {
  return sellar(obj, llaves) === String(sello ?? '').trim().toLowerCase()
}
