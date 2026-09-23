/**
 * Sin imports a proposito: lo lee `lib/documento.ts`, que corre tambien en el
 * navegador, y lo lee `lib/bot-cotizacion.ts` en el servidor.
 */
// ─── D88 (Fase 9): EL ROTULO DICE LA VERDAD (E-360) ─────────────────────────
// Hasta la Fase 8 el papel decia "publico" a todo lo que no fuera DST, y el
// mensaje decia "distribuidor" a cualquiera de la red. Pero `precioParaComprador`
// (`lib/bot-venta.ts`) cobra la cascada a DST **y a LOC**: un LOC con 20% salia a $480 rotulado
// "precio al publico". El rotulo se decide aqui, al lado del precio, **con la
// misma condicion**: si una cambia, la otra esta a tres lineas.
export const ROTULO_PUBLICO = 'Precio al publico en general'
export const ROTULO_DISTRIBUIDOR = 'Precio de distribuidor'
/** Texto provisional: va como pregunta de una linea a Norman (informe Fase 9). */
export const ROTULO_LOCAL = 'Precio de punto de venta'

export function rotuloDePrecio(rolComprador: string | null | undefined): string {
  if (rolComprador === 'DST') return ROTULO_DISTRIBUIDOR
  if (rolComprador === 'LOC') return ROTULO_LOCAL
  return ROTULO_PUBLICO
}
