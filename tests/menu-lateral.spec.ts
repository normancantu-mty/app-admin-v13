import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { etiquetaSinEmojiInicial, filaDeMenu, iconoDeEtiqueta } from '../lib/nav-menu'

/**
 * CENTINELA DEL MENU LATERAL — el defecto del 2026-09-14.
 *
 * QUE PASO. Norman: "la columna izquierda donde vienen cada pagina tiene dobles
 * emojis, menos finanzas inventario y distribuidores". `DashboardSidebar`
 * pintaba el emoji como icono y despues dibujaba `item.label` COMPLETO al lado,
 * o sea el mismo emoji otra vez. Las tres excepciones no eran excepciones: son
 * las unicas tres etiquetas del bloque ADMIN que no empiezan con emoji. En el
 * rol SOCIO estaban dobles las seis.
 *
 * Nada en verde se puso rojo por eso: `tsc`, `lint`, las 242 puras y el build
 * pasaban. El unico instrumento era el ojo de Norman. Esta prueba es el
 * instrumento que faltaba.
 *
 * POR QUE LEE `app/dashboard/layout.tsx` EN LUGAR DE TRAER SUS PROPIAS
 * ETIQUETAS. Es la leccion del `callback_data` del bot, del mismo dia: aquel
 * defecto -3 de 8 botones que reventaban el tope de 64 bytes- solo aparecia con
 * el catalogo REAL; con nombres inventados todo pasaba. Una prueba que se
 * escribe sus propios datos de entrada se esta calificando con su propio
 * examen. Asi que las 24 etiquetas salen del archivo que las declara, y el dia
 * que alguien agregue una pagina al menu esta prueba la cubre sin que nadie se
 * acuerde de venir aqui.
 *
 * Es del proyecto `puras`: sin navegador, sin sesion, sin base. Corre en cada
 * push y en CI.
 */

const RAIZ = path.resolve(__dirname, '..')
const LAYOUT = path.join(RAIZ, 'app', 'dashboard', 'layout.tsx')
const SIDEBAR = path.join(RAIZ, 'components', 'ui', 'DashboardSidebar.tsx')

/**
 * Un emoji como lo VE el usuario, no como lo guarda el archivo: el pictograma
 * con su variation selector y sus secuencias unidas por ZWJ. Contar puntos de
 * codigo sueltos aqui daria falsos positivos en `👁️`.
 */
const RE_EMOJI = /\p{Extended_Pictographic}(?:️)?(?:‍\p{Extended_Pictographic}(?:️)?)*/gu

/**
 * La MISMA expresion sin la bandera `g`, para preguntar "¿empieza con emoji?".
 * Un regex con `/g` guarda `lastIndex` entre llamadas a `.test()`: preguntado
 * dos veces por la misma cadena contesta `true` y luego `false`. Ese es el
 * unico motivo de que haya dos constantes y no una.
 */
const RE_EMPIEZA_CON_EMOJI = /^\p{Extended_Pictographic}/u

/** ¿La etiqueta trae su propio emoji al frente? */
function empiezaConEmoji(etiqueta: string): boolean {
  return RE_EMPIEZA_CON_EMOJI.test(etiqueta.trim())
}

/** Las etiquetas REALES del menu, de los cuatro roles, leidas del fuente. */
function etiquetasDelMenu(): string[] {
  const fuente = readFileSync(LAYOUT, 'utf8')
  return [...fuente.matchAll(/label:\s*'([^']*)'/g)].map((m) => m[1])
}

/**
 * Los emojis que aparecen mas de una vez en un renglon ya dibujado.
 * El U+FE0F se normaliza: `👁️` y `👁` son el mismo emoji para el ojo humano.
 */
function emojisRepetidos(renglonDibujado: string): string[] {
  const conteo = new Map<string, number>()
  for (const [secuencia] of renglonDibujado.matchAll(RE_EMOJI)) {
    const clave = secuencia.replace(/️/g, '')
    conteo.set(clave, (conteo.get(clave) ?? 0) + 1)
  }
  return [...conteo.entries()].filter(([, n]) => n > 1).map(([emoji]) => emoji)
}

const ETIQUETAS = etiquetasDelMenu()

test.describe('el menu lateral se lee del fuente, no se inventa', () => {
  /**
   * La guardia contra el modo de fallo silencioso de esta prueba: si alguien
   * cambia las comillas o mueve `getNavItems`, el regex devuelve `[]` y las
   * cuatro pruebas de abajo pasarian en verde sobre CERO etiquetas. Un
   * instrumento roto y una medicion limpia se ven igual.
   */
  test('encuentra las 24 etiquetas de los cuatro roles', () => {
    expect(ETIQUETAS.length).toBeGreaterThanOrEqual(24)
    expect(ETIQUETAS).toContain('👁️ Dashboard General')
    expect(ETIQUETAS).toContain('Finanzas')
    expect(ETIQUETAS).toContain('⚠️ Cola de captura')
  })
})

test.describe('ningun renglon dibuja el mismo emoji dos veces', () => {
  for (const etiqueta of [...new Set(ETIQUETAS)]) {
    test(`"${etiqueta}"`, () => {
      const { icono, texto } = filaDeMenu(etiqueta)
      expect(emojisRepetidos(`${icono} ${texto}`)).toEqual([])
    })
  }
})

test.describe('CONTROL NEGATIVO 1 — el arreglo no vacio el menu', () => {
  /**
   * Quitar el emoji del texto tiene una forma trivial de "pasar": borrar el
   * renglon entero, o dejar a todos con el icono generico. Sin esta prueba, un
   * `texto = ''` daria verde arriba.
   */
  test('toda etiqueta conserva texto visible', () => {
    for (const etiqueta of ETIQUETAS) {
      const { texto } = filaDeMenu(etiqueta)
      expect(texto.trim().length, `"${etiqueta}" se quedo sin texto`).toBeGreaterThan(0)
    }
  })

  test('las etiquetas SIN emoji conservan su nombre entero y reciben icono derivado', () => {
    const sinEmoji = ETIQUETAS.filter((e) => !empiezaConEmoji(e))
    // Finanzas, Inventario, Distribuidores, Mi Estado de Cuenta, Directorio...
    expect(sinEmoji.length).toBeGreaterThanOrEqual(3)

    for (const etiqueta of sinEmoji) {
      expect(etiquetaSinEmojiInicial(etiqueta)).toBe(etiqueta)
      // Un icono de verdad, no el punto de relleno: si `iconoDeEtiqueta`
      // dejara de derivarlo, estas paginas se quedarian sin simbolo y NADIE
      // se quejaria, porque el texto se ve bien.
      expect(iconoDeEtiqueta(etiqueta), `"${etiqueta}" cayo al icono generico`).not.toBe('•')
    }
  })

  test('ningun texto arrastra el VARIATION SELECTOR del emoji que se le quito', () => {
    // El defecto invisible que destapo este centinela: U+FE0F no es
    // `Extended_Pictographic` y `trim()` no lo quita, asi que con la clase de
    // caracteres corta 3 de 9 etiquetas quedaban con un U+FE0F pegado delante
    // del texto Y del `title`. No se ve en pantalla; se ve aqui.
    for (const etiqueta of ETIQUETAS) {
      const { texto } = filaDeMenu(etiqueta)
      expect(texto, `"${etiqueta}" arrastra U+FE0F o U+200D`).not.toMatch(/[️‍]/)
    }
  })
})

test.describe('CONTROL NEGATIVO 2 — la prueba SI distingue', () => {
  /**
   * El control que de verdad importa. Reproduce el renderizador VIEJO -icono +
   * `item.label` completo- y exige que FALLE. Sin esto, una prueba que nunca
   * puede ponerse roja daria el mismo verde que una que funciona: es la
   * diferencia entre "el trigger discrimina" y "el instrumento marca todo
   * bien".
   */
  test('el renderizador viejo (icono + item.label) repite emoji en toda etiqueta que empieza con uno', () => {
    const conEmoji = ETIQUETAS.filter((e) => empiezaConEmoji(e))
    expect(conEmoji.length).toBeGreaterThanOrEqual(6)

    const rotas = conEmoji.filter((etiqueta) => {
      const renglonViejo = `${iconoDeEtiqueta(etiqueta)} ${etiqueta}`
      return emojisRepetidos(renglonViejo).length > 0
    })

    expect(rotas.length, 'el control negativo no reprodujo el defecto').toBe(conEmoji.length)
  })
})

test.describe('CONTROL NEGATIVO 3 — que no vuelva por el mismo camino', () => {
  /**
   * Las dos de arriba prueban `lib/nav-menu.ts`. Ninguna ve el JSX: el defecto
   * era que el COMPONENTE dibujaba `item.label`, y podria volver a hacerlo con
   * la libreria intacta. Esto lee el fuente, como `tests/arquitectura.spec.ts`.
   */
  test('DashboardSidebar no dibuja item.label, y saca las mitades de lib/nav-menu', () => {
    const fuente = readFileSync(SIDEBAR, 'utf8')
    expect(fuente).toContain("from '@/lib/nav-menu'")
    expect(fuente).toContain('filaDeMenu(item.label)')
    expect(
      fuente,
      'volvio `{item.label}` al JSX: ese es el emoji doble del 2026-09-14'
    ).not.toMatch(/\{\s*item\.label\s*\}/)
  })
})
