import { expect, test } from '@playwright/test'
import {
  comisionValidada,
  normalizarComision,
  OPCIONES_DE_AMBIGUEDAD
} from '@/lib/bot-entidad'

/**
 * EL BOTON "100%" Y LA COMISION DE LA PANTALLA — defectos 2 y 4 (D10/D11, D16-D20).
 *
 * ─── DOS DEFECTOS, LA MISMA ENFERMEDAD ──────────────────────────────────────
 *
 * **El boton (D10).** `normalizarComision` declara ambiguo el `1` -- un 1 puede
 * ser 1% o 100%, y la diferencia es que el producto se regale-- y pregunta con
 * dos botones. El de "100%" mandaba de vuelta **el mismo `'1'`**, asi que
 * volvia a salir ambiguo y quien quisiera 100% recibia la misma pregunta para
 * siempre. Un bucle sin salida. El de "1%" funcionaba, y por eso nadie lo vio.
 *
 * **La comision de la pantalla (D17/D18/D20).** El alta por pantalla tenia su
 * propia `normalizeCommission` con tres trampas que la del chat ya no tenia: el
 * `1` se guardaba como 100% callado, un 12.5% se guardaba 0.13 callado, y un
 * valor invalido se volvia 0 callado.
 *
 * La enfermedad comun: **codigo correcto que ninguna prueba podia tocar.** El
 * par de botones era un literal dentro de un `route.ts`; el validador de la
 * pantalla vivia dentro de un Server Action que exige una sesion de Next. Los
 * dos se mudaron a `lib/bot-entidad.ts` para que esto exista.
 *
 * Esto NO lee los archivos: llama a las funciones.
 */

test.describe('el boton que cierra la pregunta no puede reabrirla (D10/D11)', () => {
  // LA INVARIANTE. Se recorre la lista entera, no los dos casos que conozco:
  // el dia que alguien agregue una tercera opcion, esta prueba la juzga sola.
  for (const opcion of OPCIONES_DE_AMBIGUEDAD) {
    test(`el boton "${opcion.etiqueta}" (${opcion.valor}) NO vuelve a salir ambiguo`, () => {
      const juicio = normalizarComision(Number(opcion.valor))
      expect(juicio.ok).toBe(true)
      if (juicio.ok) return
      expect(juicio.motivo).not.toBe('ambigua')
    })
  }

  test('y cada boton da la fraccion que promete su etiqueta', () => {
    const porEtiqueta = new Map(OPCIONES_DE_AMBIGUEDAD.map((o) => [o.etiqueta, o.valor]))
    expect(comisionValidada(Number(porEtiqueta.get('1%')), 'Comision base')).toBeCloseTo(0.01, 9)
    expect(comisionValidada(Number(porEtiqueta.get('100%')), 'Comision base')).toBeCloseTo(1, 9)
  })

  // CONTROL NEGATIVO, y es el que da valor: el `1` pelado TIENE que seguir
  // siendo ambiguo. Si esto diera verde, la pregunta no existiria y el arreglo
  // habria sido "dejar de preguntar", que es peor que el bucle.
  test('CONTROL NEGATIVO: el "1" pelado sigue siendo ambiguo', () => {
    const juicio = normalizarComision(1)
    expect(juicio.ok).toBe(false)
    if (juicio.ok) return
    expect(juicio.motivo).toBe('ambigua')
  })

  // Y el gemelo estructural: ninguna opcion puede volver a ser el `1`.
  test('CONTROL NEGATIVO: ninguna opcion vale "1"', () => {
    expect(OPCIONES_DE_AMBIGUEDAD.map((o) => o.valor)).not.toContain('1')
  })
})

test.describe('la pantalla usa el criterio del chat (D17/D18/D20)', () => {
  // EL CASO DEL ENCARGO: 12.5% por pantalla no puede guardarse 0.13 callado.
  test('12.5% NO se guarda: falla diciendo el numero que quedaria', () => {
    let mensaje = ''
    try {
      comisionValidada(12.5, 'Comision base')
    } catch (e) {
      mensaje = (e as Error).message
    }
    expect(mensaje).not.toBe('')
    // El numero real tiene que estar EN el mensaje: sin eso, quien lo escribio
    // no puede decidir si le sirve 13% o prefiere otra cosa.
    expect(mensaje).toContain('13')
    expect(mensaje).toContain('Comision base')
    // Y no puede salir un simbolo de adorno en la cara del usuario.
    expect(mensaje).not.toContain('⚠')
  })

  test('el "1" ambiguo se detiene en vez de leerse como 100%', () => {
    expect(() => comisionValidada(1, 'Comision base')).toThrow(/1%|100%/)
  })

  test('un valor invalido revienta en vez de volverse un 0 callado', () => {
    expect(() => comisionValidada(-5, 'Comision base')).toThrow()
    expect(() => comisionValidada(150, 'Comision base')).toThrow()
    expect(() => comisionValidada(Number.NaN, 'Comision base')).toThrow()
  })

  // CONTROLES NEGATIVOS: lo que SI debe pasar tiene que seguir pasando. Un
  // validador que rechaza todo es tan inutil como uno que acepta todo.
  test('CONTROL NEGATIVO: lo que cabe, pasa, y por las dos convenciones', () => {
    expect(comisionValidada(15, 'Comision base')).toBeCloseTo(0.15, 9)
    expect(comisionValidada(0.15, 'Comision base')).toBeCloseTo(0.15, 9)
    expect(comisionValidada(0, 'Comision base')).toBe(0)
    expect(comisionValidada(100, 'Comision base')).toBeCloseTo(1, 9)
  })

  test('CONTROL NEGATIVO: sin comision dicha, cero, sin reventar', () => {
    expect(comisionValidada(undefined, 'Comision base')).toBe(0)
    expect(comisionValidada(null, 'Comision base')).toBe(0)
  })

  // Las dos puertas dan el MISMO numero. Era el defecto entero: dos verdades
  // para la misma operacion. Si alguien reabre una de las dos, esto lo caza.
  test('la pantalla y el chat coinciden en todo lo que cabe', () => {
    for (const crudo of [0, 0.05, 5, 12, 0.5, 50, 100]) {
      const porElChat = normalizarComision(crudo)
      expect(porElChat.ok).toBe(true)
      if (!porElChat.ok) continue
      expect(comisionValidada(crudo, 'Comision base')).toBeCloseTo(porElChat.fraccion, 9)
    }
  })
})
