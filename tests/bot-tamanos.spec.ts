import { expect, test } from '@playwright/test'
import { buscarProducto, type ProductoDelCatalogo } from '@/lib/bot-venta'
import { candidatosPorTamano, mlDicho, preguntaDeProducto } from '@/lib/bot-tamanos'

/**
 * LA COTIZACION DE LAS 10:55 — defecto 6 (D35-D40), 2026-09-19.
 *
 * ─── LA CONVERSACION QUE ESTO REPRODUCE ─────────────────────────────────────
 *
 * El 2026-09-19 a las 10:55:44 el log del bot dice `enrutado como cotizacion
 * (confianza alta)`. El enrutador clasifico bien. **Y Norman no pudo cotizar:**
 * el bot le contesto *"No encontre 750 ml en el catalogo"* sobre un producto
 * que se llama `Destilado Plata 750ml`.
 *
 * **Fallo por un espacio.** Clasificar la intencion es la capa 1; resolver las
 * palabras contra las filas de la base es la capa 2, y ahi se moria. Una linea
 * de log con `confianza alta` no mide si al usuario le sirvio.
 *
 * ─── POR QUE ESTA PRUEBA CORRE EL CODIGO Y NO LO LEE ────────────────────────
 *
 * Los cuatro archivos de prueba que miraban al bot hacian `readFileSync` y
 * comparaban cadenas. Habrian seguido verdes con este defecto dentro: el
 * comparador de nombres existia, estaba escrito y era correcto -- **no cubria
 * el caso**. Aqui se llama a `buscarProducto` de verdad, con el catalogo real.
 *
 * ─── EL CATALOGO ES EL DE PRODUCCION, MEDIDO, NO INVENTADO ──────────────────
 *
 * Cuatro filas `TERMINADO` con precios, consultadas el 2026-09-19. **Son
 * cuatro, no tres:** `Pasta-Guajillo-2kg` tambien es TERMINADO y tambien sale
 * en `leerCatalogoDeVenta`. Importa porque es el unico sin `ml_por_unidad`, y
 * una logica de tamanos que no lo excluya lo acabaria ofreciendo como si fuera
 * una botella.
 */

const CATALOGO: ProductoDelCatalogo[] = [
  {
    id: 'c1000000-0000-0000-0000-000000000001',
    sku: 'plata-750ml',
    nombre: 'Destilado Plata 750ml',
    ml_por_unidad: 750,
    precio_final: 599
  },
  {
    id: 'c1000000-0000-0000-0000-000000000003',
    sku: 'plata-250ml',
    nombre: 'Destilado Plata 250ml',
    ml_por_unidad: 250,
    precio_final: 179
  },
  {
    id: 'c1000000-0000-0000-0000-000000000004',
    sku: 'plata-50ml',
    nombre: 'Destilado Plata 50ml',
    ml_por_unidad: 50,
    precio_final: 69
  },
  {
    id: '9f310b3c-9924-4b63-b08b-a50a88795347',
    sku: 'B-MVP-Pasta2kg',
    nombre: 'Pasta-Guajillo-2kg',
    ml_por_unidad: null,
    precio_final: 250
  }
]

/** El sku del producto elegido, o el motivo del fallo. Para leer los rojos. */
function elegido(dicho: string): string {
  const r = buscarProducto(dicho, CATALOGO)
  return r.ok ? (r.elegido.sku ?? r.elegido.nombre) : `NO: ${r.motivo}`
}

test.describe('la frase de Norman encuentra la botella (D37/D38)', () => {
  // La linea exacta de las 10:55, partida como la extrae el modelo. Las tres
  // tienen que resolverse SIN UNA SOLA PREGUNTA: es el criterio de cierre.
  const LA_COTIZACION: Array<[string, string]> = [
    ['750 ml', 'plata-750ml'],
    ['250 ml', 'plata-250ml'],
    ['50ml', 'plata-50ml']
  ]

  for (const [dicho, sku] of LA_COTIZACION) {
    test(`"${dicho}" -> ${sku}, sin preguntar`, () => {
      expect(elegido(dicho)).toBe(sku)
    })
  }

  // Las formas en que la misma botella se dice de verdad. El espacio era el
  // que rompia; los demas nunca habian empatado con nada.
  const FORMAS: Array<[string, string]> = [
    ['750ml', 'plata-750ml'],
    ['750 ml', 'plata-750ml'],
    ['750', 'plata-750ml'],
    ['.750', 'plata-750ml'],
    // D54 (Fase 6): las dos escrituras del encargo que faltaban en esta lista.
    // No son hipoteticas -- `0.750` es como se escribe en una etiqueta y
    // `750 mililitros` es como sale de una nota de voz transcrita.
    ['0.750', 'plata-750ml'],
    ['750 mililitros', 'plata-750ml'],
    ['3/4', 'plata-750ml'],
    ['la grande', 'plata-750ml'],
    ['grandes', 'plata-750ml'],
    ['250', 'plata-250ml'],
    ['mediana', 'plata-250ml'],
    ['50', 'plata-50ml'],
    ['50 ml', 'plata-50ml'],
    ['mini', 'plata-50ml'],
    // Y las que SI empataban por nombre tienen que seguir empatando: la cuarta
    // pasada entra despues, no en lugar de las tres de nombre.
    ['Destilado Plata 750ml', 'plata-750ml'],
    ['plata-250ml', 'plata-250ml']
  ]

  for (const [dicho, sku] of FORMAS) {
    test(`"${dicho}" -> ${sku}`, () => {
      expect(elegido(dicho)).toBe(sku)
    })
  }
})

test.describe('el vocabulario que Norman desempato en persona (D53)', () => {
  // ─── LO QUE DECIA ESTA PRUEBA AYER ────────────────────────────────────────
  // Hasta el 2026-09-19 aqui se exigia lo CONTRARIO: que "chicas" ofreciera las
  // dos y preguntara. Era correcto -- "chicas" cabia en dos lugares y adivinar
  // habria sido cobrar de mas o de menos en silencio.
  //
  // Lo que cambio no es el codigo: **lo desempato Norman, textual, el mismo
  // dia** -- «La de 50 ml es la mini» -- y en la conversacion viva uso los tres
  // juntos: «35 grandes, 43 chicas y 25 mini». Ya no es ambiguo, asi que
  // preguntar dejo de ser prudencia y paso a ser no escuchar.
  //
  // La prueba no se borra, se DA VUELTA: sigue siendo la misma frontera, medida
  // al otro lado. Una prueba que desaparece es una prueba que fallaba.
  const CADA_UNA: ReadonlyArray<[string, string]> = [
    ['grandes', 'plata-750ml'],
    ['chicas', 'plata-250ml'],
    ['mini', 'plata-50ml']
  ]

  for (const [dicho, sku] of CADA_UNA) {
    test(`"${dicho}" resuelve directo a ${sku}, sin preguntar`, () => {
      const r = buscarProducto(dicho, CATALOGO)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.elegido.sku).toBe(sku)
    })
  }

  // La frase entera de Norman, los tres adjetivos en un solo mensaje. Es la
  // prueba de que los tres apuntan a TRES productos distintos y no a dos.
  test('«35 grandes, 43 chicas y 25 mini» son tres productos distintos', () => {
    const elegidos = CADA_UNA.map(([dicho]) => {
      const r = buscarProducto(dicho, CATALOGO)
      return r.ok ? r.elegido.sku : `NO-RESOLVIO(${dicho})`
    })
    expect(elegidos).toEqual(['plata-750ml', 'plata-250ml', 'plata-50ml'])
    expect(new Set(elegidos).size).toBe(3)
  })

  // CONTROL NEGATIVO: que los adjetivos resuelvan NO afloja la lista cerrada.
  // Siguen empatando contra una fila real, asi que una palabra de tamano no
  // puede ofrecer algo que no tiene `ml_por_unidad`.
  test('CONTROL NEGATIVO: ningun adjetivo alcanza la Pasta-Guajillo-2kg', () => {
    for (const dicho of ['grandes', 'chicas', 'mini', 'mediana', 'chiquita']) {
      const r = buscarProducto(dicho, CATALOGO)
      if (r.ok) {
        expect(r.elegido.nombre).not.toContain('Pasta')
        expect(typeof r.elegido.ml_por_unidad).toBe('number')
      } else {
        expect(r.candidatos.map((p) => p.nombre).join(' ')).not.toContain('Pasta')
      }
    }
  })

  // Y la mitad que se conserva de D39: cuando de verdad NO se resuelve, la
  // pregunta sigue nombrando tamanos y no uuids.
  test('cuando no resuelve, la pregunta sigue nombrando tamanos y no uuids', () => {
    const pregunta = preguntaDeProducto('500 ml', CATALOGO, 'cotizar')
    expect(pregunta).toContain('750 ml')
    expect(pregunta).toContain('250 ml')
    expect(pregunta).toContain('50 ml')
    expect(pregunta).not.toContain('c1000000')
  })
})

test.describe('CONTROLES NEGATIVOS — sin esto lo de arriba no mide nada', () => {
  // EL control negativo obligatorio del encargo. Si "20 de cerveza" empatara,
  // el arreglo seria peor que el defecto: en vez de no cotizar, cotizaria mal.
  test('"20 de cerveza" sigue sin empatar', () => {
    const r = buscarProducto('20 de cerveza', CATALOGO)
    expect(r.ok).toBe(false)
  })

  test('"cerveza" a secas tampoco', () => {
    expect(buscarProducto('cerveza', CATALOGO).ok).toBe(false)
  })

  // Un numero que no es ningun tamano del catalogo no puede caer en el mas
  // cercano. "500 ml" no existe: se pregunta o se falla, no se redondea.
  test('"500 ml" no se parece a la de 750 ni a la de 250', () => {
    expect(buscarProducto('500 ml', CATALOGO).ok).toBe(false)
  })

  // La pasta no tiene mililitros. Ninguna palabra de tamano puede ofrecerla.
  test('la pasta nunca entra por la puerta de los tamanos', () => {
    for (const dicho of ['grandes', 'chicas', 'mini', '2', '750', 'la grande']) {
      const porTamano = candidatosPorTamano(dicho, CATALOGO)
      expect(porTamano.map((p) => p.sku)).not.toContain('B-MVP-Pasta2kg')
    }
  })

  test('...pero la pasta SI se encuentra por su nombre', () => {
    expect(elegido('Pasta-Guajillo-2kg')).toBe('B-MVP-Pasta2kg')
  })

  // El medidor tiene que saber decir "aqui no hay tamano". Si `mlDicho`
  // devolviera un numero para cualquier cosa, todo el resto es ruido.
  test('mlDicho no inventa mililitros donde no los hay', () => {
    expect(mlDicho('cerveza')).toBeNull()
    expect(mlDicho('')).toBeNull()
    expect(mlDicho('la de siempre')).toBeNull()
  })

  test('mlDicho lee las unidades que se dicen', () => {
    expect(mlDicho('750 ml')).toBe(750)
    expect(mlDicho('750ml')).toBe(750)
    expect(mlDicho('3/4')).toBe(750)
    expect(mlDicho('.750')).toBe(750)
    expect(mlDicho('1 litro')).toBe(1000)
    expect(mlDicho('50')).toBe(50)
  })

  // Y el gemelo del anterior: un catalogo VACIO no puede producir un elegido.
  test('con el catalogo vacio no se elige nada', () => {
    expect(buscarProducto('750 ml', []).ok).toBe(false)
    expect(candidatosPorTamano('750 ml', [])).toEqual([])
  })
})
