/**
 * Como se dibuja un renglon del menu lateral — icono y texto, por separado.
 *
 * POR QUE VIVE EN `lib/` Y NO DENTRO DEL COMPONENTE. Estaban las dos funciones
 * privadas dentro de `components/ui/DashboardSidebar.tsx`, y por eso el defecto
 * del 2026-09-14 (el emoji dibujado dos veces en cada renglon) no tenia como
 * probarse sin levantar un navegador: la unica forma de comprobarlo era mirar
 * la pantalla. Aqui son TypeScript puro -sin React, sin JSX, sin `next/link`-,
 * asi que `tests/menu-lateral.spec.ts` las corre en el proyecto `puras`, en
 * milisegundos y en cada push. Una prueba que necesita navegador y sesion es
 * una prueba que se salta.
 *
 * LA REGLA DE ORO DE ESTE ARCHIVO: el icono y el texto son EXCLUYENTES. Si el
 * emoji se pinto como icono, no vuelve a aparecer en el texto. Quien dibuje un
 * renglon usa `filaDeMenu`, que devuelve las dos mitades ya repartidas.
 */

/** El emoji de un renglon: el que trae la etiqueta, o uno derivado del nombre. */
export function iconoDeEtiqueta(label: string): string {
  const trimmed = label.trim()
  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  if (firstToken && /\p{Extended_Pictographic}/u.test(firstToken)) {
    return firstToken
  }
  if (/finanzas/i.test(label)) return '💰'
  if (/inventario/i.test(label)) return '📦'
  if (/distribuidor|directorio|red|locales/i.test(label)) return '👥'
  if (/estado de cuenta/i.test(label)) return '📊'
  if (/catálogo|catalogo|precios/i.test(label)) return '🏷️'
  if (/cola de captura|avisos/i.test(label)) return '⚠️'
  if (/dashboard general/i.test(label)) return '👁️'
  return '•'
}

/**
 * La etiqueta sin el emoji de adelante.
 *
 * EL DETALLE QUE COSTO, y que no se ve en pantalla: la clase de caracteres NO
 * es solo `\p{Extended_Pictographic}`. `👁️`, `🏷️` y `⚠️` son DOS puntos de
 * codigo -el pictograma y un VARIATION SELECTOR-16 (U+FE0F)-, y U+FE0F no es
 * `Extended_Pictographic` ni es espacio en blanco, asi que `trim()` tampoco lo
 * quita. Con la clase corta, 3 de las 9 etiquetas reales del menu quedaban con
 * un U+FE0F invisible pegado al principio del texto y del `title`. Es el mismo
 * modo de fallo del `callback_data` del bot: revienta con el catalogo REAL, no
 * con un nombre inventado. Por eso la clase incluye U+FE0F y el ZWJ (U+200D),
 * que es lo que une las secuencias de emoji compuestas.
 */
export function etiquetaSinEmojiInicial(label: string): string {
  return label.replace(/^(?:[\p{Extended_Pictographic}️‍]+\s*)+/u, '').trim() || label
}

/** Las dos mitades de un renglon, ya repartidas. Nadie las calcula por su cuenta. */
export function filaDeMenu(label: string): { icono: string; texto: string } {
  return { icono: iconoDeEtiqueta(label), texto: etiquetaSinEmojiInicial(label) }
}
