/**
 * Cobranza v2 — en la página completa `/panel/cobranza` el slot de modales queda
 * vacío (mismo motivo que `@modal/red/page.tsx`: sin esto, al volver a la página
 * por navegación suave el último modal seguiría abierto). 2026-10-30, ejecutor del Socio.
 */
export default function SinModalEnCobranza() {
  return null
}
