/**
 * Modo privado — el "ojito" de la barra de arriba.
 *
 * PARA QUE ES: Norman enseña el ERP (demos, entrevistas, portafolio) y no
 * quiere que se vean las cifras reales de la empresa. Un clic las tapa todas,
 * otro las devuelve.
 *
 * LO QUE **NO** ES, Y ES LA LINEA QUE IMPORTA
 * -------------------------------------------
 * Esto es PRESENTACION, no autorizacion. Los numeros siguen llegando al
 * navegador; solo se pintan tapados. Quien abra las DevTools o la pestaña de
 * red los ve enteros. **No sirve para esconderle datos a un usuario del
 * sistema** — para eso estan el RLS y los roles, y son otra pieza.
 * Es la misma distincion que `PROMPT_ClaudeCode_09_cartera.md:97` ya habia
 * fijado: *"No basta con esconder el enlace"*.
 *
 * QUE TAPA, Y POR QUE NO MAS
 * --------------------------
 * Tapa **dinero**: lo que lleva `$` delante o `pesos`/`MXN` detras. No tapa
 * fechas, folios, porcentajes, ni conteos de piezas, y es deliberado:
 *   - un enmascarado agresivo destruye la pantalla y la demo se ve rota, que
 *     era justo lo que se queria evitar;
 *   - las fechas y los folios no son la informacion sensible de esta empresa;
 *   - `2026-09-14` y `ERP-21` tienen digitos y taparlos deja la pantalla
 *     ilegible sin proteger nada.
 * Si algun dia hace falta tapar tambien las piezas, es `PATRONES` y una linea.
 *
 * COMO TAPA: cambia cada digito por `•` y deja el resto. `$12,480.00` queda
 * `$••,•••.••`. Se conserva el ANCHO, asi que la tabla no se desacomoda y la
 * pantalla se ve deliberada en vez de rota.
 */

export const ATRIBUTO = 'data-privado'
export const LLAVE_ALMACEN = 'erp_modo_privado'

/** El caracter que sustituye a cada digito. */
const TAPA = '•' // bullet

/**
 * Lo que cuenta como dinero. Cada patron se prueba en `privacidad.spec.ts`,
 * con los controles negativos al lado — una expresion regular sin caso que
 * NO deba casar es una que nadie ha probado de verdad.
 */
const PATRONES: RegExp[] = [
  // $1,234.56 · $ 1234 · -$1,234.56 · $1,234.56 MXN
  /-?\$\s?\d[\d,.\s]*/g,
  // 1,234.56 pesos · 1234 pesos · 11,484 MXN
  /\d[\d,.]*\s?(?=\s?(?:pesos|MXN|mxn)\b)/g,
]

/** Devuelve el texto con los digitos del dinero tapados. Funcion pura. */
export function enmascararTexto(texto: string): string {
  let salida = texto
  for (const patron of PATRONES) {
    salida = salida.replace(patron, (coincidencia) =>
      coincidencia.replace(/\d/g, TAPA)
    )
  }
  return salida
}

/** True si el texto trae algo que este modo taparia. Sirve para no tocar
 *  nodos que no lo necesitan: la mayoria del DOM no tiene una cifra. */
export function tieneCifra(texto: string): boolean {
  return texto.includes('$') || /\d[\d,.]*\s?(?:pesos|MXN|mxn)\b/.test(texto)
}

/** Lee el estado guardado. Nunca lanza: si el almacen no esta (navegador en
 *  privado, permisos), el modo arranca APAGADO, que es el estado seguro —
 *  quedarse tapado sin poder destapar seria peor. */
export function leerEstadoGuardado(): boolean {
  try {
    return window.localStorage.getItem(LLAVE_ALMACEN) === '1'
  } catch {
    return false
  }
}

export function guardarEstado(activo: boolean): void {
  try {
    window.localStorage.setItem(LLAVE_ALMACEN, activo ? '1' : '0')
  } catch {
    /* sin almacen, el modo vale solo para esta pestaña. Suficiente. */
  }
}
