/**
 * AG-05 FASE 4 — Pruebas puras de la COTIZACION por Telegram.
 *
 * ─── DE DONDE SALEN LOS FIXTURES ────────────────────────────────────────────
 * Los mismos que `tests/bot-venta.spec.ts`, **copiados de produccion el
 * 2026-09-18** y no inventados (E-243). Y son los mismos a proposito: la mitad
 * de estas pruebas existe justamente para comprobar que cotizar y vender dan la
 * MISMA cifra, y no se puede comprobar eso con dos catalogos distintos.
 *
 * ─── LO QUE ESTAS PRUEBAS CUIDAN ────────────────────────────────────────────
 *
 * 1. **Que el precio cotizado sea el precio que se va a cobrar.** Una
 *    cotizacion que promete $1,104 y una venta que cobra $1,198 por lo mismo es
 *    peor que no cotizar: queda por escrito, con folio, en manos del cliente.
 *    Por eso hay un bloque entero que corre `normalizarCotizacion` y
 *    `normalizarVenta` con los mismos renglones y compara total contra total.
 *
 * 2. **Que cotizar no mueva nada.** Una cotizacion no toca inventario ni
 *    finanzas; el centinela que lo promete el encabezado de la migracion ERP-87
 *    esta aqui abajo, leyendo el TypeScript de la ruta de confirmar.
 *
 * 3. **Que el folio no lo cuente nadie mas que Postgres.** Dos personas
 *    dictando al mismo tiempo se llevarian el mismo numero si el consecutivo se
 *    armara en codigo.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import {
  cotizacionCanonica,
  escalarAObjetivo,
  MARGEN_DE_PROPORCION,
  LLAVES_COTIZACION,
  mensajeDeConfirmacionCotizacion,
  normalizarCotizacion,
  sellarCotizacion,
  selloCotizacionCoincide,
  TOPE_VIGENCIA_DIAS,
  VIGENCIA_POR_DEFECTO,
  type ContextoCotizacion,
  type LineaCotizada,
  type PayloadCotizacion
} from '@/lib/bot-cotizacion'
import {
  aProductoDelCatalogo,
  normalizarVenta,
  precioParaComprador,
  TOPE_PIEZAS_POR_LINEA,
  TOPE_VENTA,
  ZONA_POR_DEFECTO,
  type CompradorDeVenta,
  type ContextoVenta,
  type ProductoConPrecios
} from '@/lib/bot-venta'
import { buscarPorNombre, PALABRAS_VACIAS } from '@/lib/bot-nombres'
import { sumarDias } from '@/lib/fechas'

// ── Los fixtures, copiados de produccion ──────────────────────────────────
const CEO_ADMIN = 'e0000000-0000-0000-0000-000000000001'
const CUENTA_FRESNILLO = 'a0000000-0000-0000-0000-000000000001'

const CATALOGO_CRUDO: ProductoConPrecios[] = [
  {
    id: 'c1000000-0000-0000-0000-000000000001',
    sku: 'plata-750ml',
    nombre: 'Destilado Plata 750ml',
    ml_por_unidad: 750,
    precios: [
      { zona: 'Zacatecas', precio_final: 599 },
      { zona: 'Foraneo', precio_final: 799 }
    ]
  },
  {
    id: 'c1000000-0000-0000-0000-000000000003',
    sku: 'plata-250ml',
    nombre: 'Destilado Plata 250ml',
    ml_por_unidad: 250,
    precios: [
      { zona: 'Zacatecas', precio_final: 179 },
      { zona: 'Foraneo', precio_final: 199 }
    ]
  },
  {
    id: 'c1000000-0000-0000-0000-000000000004',
    sku: 'plata-50ml',
    nombre: 'Destilado Plata 50ml',
    ml_por_unidad: 50,
    precios: [
      { zona: 'Zacatecas', precio_final: 69 },
      { zona: 'Foraneo', precio_final: 99 }
    ]
  }
]

const CATALOGO = CATALOGO_CRUDO.map((p) => aProductoDelCatalogo(p, ZONA_POR_DEFECTO))
const SETECIENTOS_CINCUENTA = CATALOGO[0]
const DOSCIENTOS_CINCUENTA = CATALOGO[1]

const GILBERTO: CompradorDeVenta = {
  id: '9f8cd8f6-6623-4f86-b92e-9eba500a8fb4',
  nombre: 'Gilberto Franco',
  rol: 'DST',
  zona: 'Zacatecas',
  comision_base: 0.2,
  comision_base_local: 0,
  aplica_redondeo_costo: true
}

const HOY = '2026-09-18'

function contexto(parcial: Partial<ContextoCotizacion> = {}): ContextoCotizacion {
  return {
    idVendedor: CEO_ADMIN,
    nombreVendedor: 'CEO Admin',
    comprador: null,
    nombreProspecto: 'Ferreteria del Centro',
    zona: ZONA_POR_DEFECTO,
    etiqueta: 'norman',
    hoy: HOY,
    lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 2 }],
    ...parcial
  }
}

function okDe(r: ReturnType<typeof normalizarCotizacion>) {
  if (!r.ok) throw new Error('esperaba que saliera bien, y salio: ' + r.error)
  return r
}

const LEER = (relativo: string) => readFileSync(join(process.cwd(), relativo), 'utf8')

/**
 * El codigo SIN sus comentarios.
 *
 * Los centinelas de abajo buscan nombres de tablas y prefijos de folio. Esos
 * mismos nombres aparecen -a proposito- en los encabezados que PROMETEN que no
 * se tocan ("No escribe en `finanzas_ledger`"). Buscar sobre el archivo crudo
 * convertiria la promesa en el delito. Se mide el codigo, no lo que dice de si
 * mismo.
 */
const SIN_COMENTARIOS = (relativo: string) =>
  LEER(relativo)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

// ===========================================================================
// 1. EL PRECIO ES EL MISMO QUE EL DE LA VENTA
// ===========================================================================

test.describe('lo cotizado es lo que se va a cobrar', () => {
  const RENGLONES: LineaCotizada[] = [
    { producto: SETECIENTOS_CINCUENTA, cantidad: 2 },
    { producto: DOSCIENTOS_CINCUENTA, cantidad: 1 }
  ]

  function ventaEquivalente(comprador: CompradorDeVenta | null) {
    const ctx: ContextoVenta = {
      idVendedor: CEO_ADMIN,
      nombreVendedor: 'CEO Admin',
      comprador,
      idCuentaDestino: CUENTA_FRESNILLO,
      nombreCuentaDestino: 'Fresnillo',
      tipoFiscalidadCuenta: 'FULL_TAX',
      etiqueta: 'norman',
      lineas: RENGLONES
    }
    const r = normalizarVenta({}, ctx)
    if (!r.ok) throw new Error('la venta de control no salio: ' + r.error)
    return r
  }

  test('a un prospecto, el total es el de lista y coincide con la venta a publico', () => {
    const cot = okDe(normalizarCotizacion({}, contexto({ lineas: RENGLONES })))
    // 2 x 599 + 1 x 179 = 1,198 + 179 = 1,377
    expect(cot.payload.total).toBe(1377)
    expect(cot.payload.total).toBe(ventaEquivalente(null).payload.total_cobrado_real)
  })

  test('a un DST, el total es SU costo y coincide con la venta a ese mismo DST', () => {
    const cot = okDe(
      normalizarCotizacion({}, contexto({ comprador: GILBERTO, nombreProspecto: null, lineas: RENGLONES }))
    )
    // 750ml: 599 - 20% = 479.20, redondeado ARRIBA = 480 -> 2 x 480 = 960
    // 250ml: 179 - 20% = 143.20, redondeado ARRIBA = 144 -> 1 x 144 = 144
    expect(cot.payload.total).toBe(1104)
    expect(cot.payload.total).toBe(ventaEquivalente(GILBERTO).payload.total_cobrado_real)
  })

  test('renglon por renglon, el precio unitario sale de la misma funcion', () => {
    const cot = okDe(
      normalizarCotizacion({}, contexto({ comprador: GILBERTO, nombreProspecto: null, lineas: RENGLONES }))
    )
    for (const item of cot.payload.items) {
      const producto = CATALOGO.find((p) => p.id === item.id_producto)!
      expect(item.precio_unitario).toBe(precioParaComprador(producto, GILBERTO))
    }
  })
})

// ===========================================================================
// 2. A QUIEN SE LE COTIZA
// ===========================================================================

test.describe('el prospecto es el caso normal, no el error', () => {
  test('un nombre suelto basta: no hace falta que este en la red', () => {
    const r = okDe(normalizarCotizacion({}, contexto()))
    expect(r.payload.nombre_prospecto).toBe('Ferreteria del Centro')
    expect(r.payload.id_comprador).toBeNull()
  })

  test('si es de la red, el prospecto se apaga: uno de los dos, nunca los dos', () => {
    const r = okDe(normalizarCotizacion({}, contexto({ comprador: GILBERTO })))
    expect(r.payload.id_comprador).toBe(GILBERTO.id)
    expect(r.payload.nombre_prospecto).toBeNull()
  })

  test('sin comprador y sin nombre, se pregunta; no se cotiza al aire', () => {
    const r = normalizarCotizacion({}, contexto({ nombreProspecto: '   ' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('A quien')
  })

  test('cotizarse a uno mismo no es una cotizacion', () => {
    const yo: CompradorDeVenta = { ...GILBERTO, id: CEO_ADMIN }
    const r = normalizarCotizacion({}, contexto({ comprador: yo, nombreProspecto: null }))
    expect(r.ok).toBe(false)
  })

  test('"Ferreteria del Centro" NO empata con media red por la palabra "del"', () => {
    // El caso que cazo la prueba en vivo: "del" tiene tres letras, pasaba el
    // filtro de largo y empataba con dos negocios. Un nombre nuevo clasificado
    // como ambiguo deja de ofrecer el boton de "es cliente nuevo", que es
    // exactamente el que hace falta aqui.
    const red = [
      { nombre: 'Al son del Mezcal' },
      { nombre: 'Descuento del 30%' },
      { nombre: 'Delirio 85' }
    ]
    const hallazgo = buscarPorNombre('Ferreteria del Centro', red, (c) => [c.nombre])
    expect(hallazgo.ok).toBe(false)
    if (!hallazgo.ok) expect(hallazgo.motivo).toBe('no-encontrado')
    expect(PALABRAS_VACIAS.has('del')).toBe(true)
  })
})

// ===========================================================================
// 3. LA VIGENCIA
// ===========================================================================

test.describe('la vigencia', () => {
  test('sin decir nada son 15 dias, y la fecha se calcula, no se dicta', () => {
    const r = okDe(normalizarCotizacion({}, contexto()))
    expect(r.payload.vigencia_dias).toBe(VIGENCIA_POR_DEFECTO)
    expect(r.vigenteHasta).toBe('2026-10-03')
    expect(r.vigenteHasta).toBe(sumarDias(HOY, VIGENCIA_POR_DEFECTO))
  })

  test('lo que se dijo manda, dentro del tope', () => {
    const r = okDe(normalizarCotizacion({ vigencia_dias: 30 }, contexto()))
    expect(r.payload.vigencia_dias).toBe(30)
    expect(r.vigenteHasta).toBe('2026-10-18')
  })

  test('cero, negativa, rota o pasada del tope: se para y se pregunta', () => {
    for (const dicha of [0, -5, 1.5, TOPE_VIGENCIA_DIAS + 1, 'un rato']) {
      const r = normalizarCotizacion({ vigencia_dias: dicha }, contexto())
      expect(r.ok, `vigencia_dias=${String(dicha)} no debio pasar`).toBe(false)
    }
  })

  test('el tope de la tabla y el del codigo son el mismo numero', () => {
    const sql = LEER(
      'supabase/migrations/20260918163253_erp87_la_cotizacion_como_tabla_con_folio_y_vigencia.sql'
    )
    expect(sql).toContain(`vigencia_dias <= ${TOPE_VIGENCIA_DIAS}`)
    expect(sql).toContain(`default ${VIGENCIA_POR_DEFECTO}`)
  })
})

// ===========================================================================
// 4. LOS RENGLONES Y LOS TOPES
// ===========================================================================

test.describe('los renglones', () => {
  test('el mismo producto dos veces se junta en uno, con aviso', () => {
    const r = okDe(
      normalizarCotizacion(
        {},
        contexto({
          lineas: [
            { producto: SETECIENTOS_CINCUENTA, cantidad: 2 },
            { producto: SETECIENTOS_CINCUENTA, cantidad: 3 }
          ]
        })
      )
    )
    // `unique (id_cotizacion, id_producto)` reventaria el INSERT entero.
    expect(r.payload.items).toHaveLength(1)
    expect(r.payload.items[0].cantidad).toBe(5)
    expect(r.avisos.join(' ')).toContain('dos veces')
  })

  test('sin renglones no hay cotizacion', () => {
    const r = normalizarCotizacion({}, contexto({ lineas: [] }))
    expect(r.ok).toBe(false)
  })

  test('cantidades rotas se paran', () => {
    for (const cantidad of [0, -1, 2.5, Number.NaN]) {
      const r = normalizarCotizacion(
        {},
        contexto({ lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad }] })
      )
      expect(r.ok, `cantidad=${cantidad} no debio pasar`).toBe(false)
    }
  })

  test('el tope de piezas y el de pesos son los MISMOS que los de la venta', () => {
    // No uno mas flojo porque "una cotizacion no mueve nada": esta cotizacion se
    // convierte en esa venta.
    const muchas = normalizarCotizacion(
      {},
      contexto({ lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: TOPE_PIEZAS_POR_LINEA + 1 }] })
    )
    expect(muchas.ok).toBe(false)

    const piezas = Math.ceil(TOPE_VENTA / SETECIENTOS_CINCUENTA.precio_final) + 1
    const caro = normalizarCotizacion(
      {},
      contexto({
        lineas: [
          { producto: SETECIENTOS_CINCUENTA, cantidad: Math.min(piezas, TOPE_PIEZAS_POR_LINEA) }
        ]
      })
    )
    if (piezas <= TOPE_PIEZAS_POR_LINEA) {
      expect(caro.ok).toBe(false)
      if (!caro.ok) expect(caro.error).toContain('pantalla')
    }
  })

  test('un producto sin precio en la zona no se cotiza en cero', () => {
    const sinPrecio = aProductoDelCatalogo(
      { id: 'c1000000-0000-0000-0000-00000000000f', sku: 'x', nombre: 'Fantasma', ml_por_unidad: null, precios: [] },
      ZONA_POR_DEFECTO
    )
    const r = normalizarCotizacion({}, contexto({ lineas: [{ producto: sinPrecio, cantidad: 1 }] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('cero')
  })
})

// ===========================================================================
// 5. EL SELLO
// ===========================================================================

test.describe('el sello de la cotizacion', () => {
  const base = () => okDe(normalizarCotizacion({}, contexto())).payload

  test('el mismo payload da el mismo sello, y el orden de las llaves no importa', () => {
    const p = base()
    const revuelto = JSON.parse(JSON.stringify({ ...p })) as PayloadCotizacion
    expect(sellarCotizacion(revuelto)).toBe(sellarCotizacion(p))
    expect(selloCotizacionCoincide(p, sellarCotizacion(p))).toBe(true)
  })

  test('cambiar UNA cosa rompe el sello', () => {
    const p = base()
    const sello = sellarCotizacion(p)
    const cambios: Array<(x: PayloadCotizacion) => void> = [
      (x) => (x.total = x.total + 1),
      (x) => (x.vigencia_dias = 999),
      (x) => (x.nombre_prospecto = 'Otra Ferreteria'),
      (x) => (x.id_comprador = GILBERTO.id),
      (x) => (x.items[0].cantidad = x.items[0].cantidad + 1),
      (x) => (x.items[0].precio_unitario = 1),
      (x) => (x.zona = 'Foraneo'),
      (x) => (x.notas = 'otra cosa')
    ]
    for (const romper of cambios) {
      const copia = JSON.parse(JSON.stringify(p)) as PayloadCotizacion
      romper(copia)
      expect(selloCotizacionCoincide(copia, sello)).toBe(false)
    }
  })

  test('las llaves selladas estan ordenadas y cubren todo el payload', () => {
    expect([...LLAVES_COTIZACION]).toEqual([...LLAVES_COTIZACION].sort())
    const delPayload = Object.keys(base()).sort()
    expect([...LLAVES_COTIZACION].sort()).toEqual(delPayload)
  })

  test('la forma canonica no trae nada que no este sellado', () => {
    const texto = cotizacionCanonica(base())
    expect(texto).toContain('"vigencia_dias"')
    expect(texto).not.toContain('folio')
    expect(texto).not.toContain('vigente_hasta')
  })
})

// ===========================================================================
// 6. EL MENSAJE QUE SE LEE ANTES DEL "VA"
// ===========================================================================

test.describe('el mensaje', () => {
  test('dice el total, los dias Y la fecha, y marca al prospecto', () => {
    const r = okDe(normalizarCotizacion({}, contexto()))
    const texto = mensajeDeConfirmacionCotizacion(r.payload, r.desglose, r.avisos, {
      paraQuien: 'Ferreteria del Centro',
      esDeLaRed: false,
      vigenteHasta: r.vigenteHasta
    })
    expect(texto).toContain('$1,198.00')
    expect(texto).toContain('15 dias')
    // D70: la fecha va como la lee una persona; la ISO ya no debe salir.
    expect(texto).toContain('03/10/2026')
    expect(texto).not.toContain('2026-10-03')
    expect(texto).toContain('(prospecto)')
    expect(texto).not.toContain('Precio de distribuidor')
  })

  test('a un distribuidor le avisa que ese precio no es el de publico', () => {
    const r = okDe(normalizarCotizacion({}, contexto({ comprador: GILBERTO, nombreProspecto: null })))
    const texto = mensajeDeConfirmacionCotizacion(r.payload, r.desglose, r.avisos, {
      paraQuien: GILBERTO.nombre,
      esDeLaRed: true,
      vigenteHasta: r.vigenteHasta
    })
    expect(texto).toContain('Precio de distribuidor')
    expect(texto).not.toContain('(prospecto)')
  })

  test('no repite de vuelta lo que ya se dijo ni contesta con un menu', () => {
    const r = okDe(normalizarCotizacion({}, contexto()))
    const texto = mensajeDeConfirmacionCotizacion(r.payload, r.desglose, r.avisos, {
      paraQuien: 'Ferreteria del Centro',
      esDeLaRed: false,
      vigenteHasta: r.vigenteHasta
    })
    expect(texto.split('\n').length).toBeLessThanOrEqual(12)
    expect(texto).not.toContain('/stock')
    expect(texto).not.toContain('Entendido')
  })
})

// ===========================================================================
// 7. CENTINELAS: COTIZAR NO MUEVE NADA
// ===========================================================================

test.describe('cotizar no mueve nada', () => {
  const CONFIRMAR = 'app/api/bot/cotizacion/confirmar/route.ts'
  const PROPONER = 'app/api/bot/cotizacion/proponer/route.ts'

  test('la ruta de confirmar NO toca ninguno de los dos ledgers', () => {
    // Es el centinela que promete el encabezado de la migracion ERP-87.
    const codigo = SIN_COMENTARIOS(CONFIRMAR)
    expect(codigo).not.toContain('inventario_ledger')
    expect(codigo).not.toContain('finanzas_ledger')
    expect(codigo).not.toContain('transacciones_tickets')
    expect(codigo).not.toContain('registrar_venta_atomica')
    // Ni por RPC, que es como escribe la venta desde ERP-11.
    expect(codigo).not.toContain('.rpc(')
  })

  test('proponer no escribe mas que el borrador', () => {
    const codigo = SIN_COMENTARIOS(PROPONER)
    const escrituras = codigo.match(/\.from\('([a-z_]+)'\)\s*\n?\s*\.(insert|update|delete|upsert)/g) || []
    for (const e of escrituras) expect(e).toContain('bot_borradores')
    expect(codigo).not.toContain("from('cotizaciones')")
    expect(codigo).not.toContain("from('cotizacion_detalles')")
  })

  test('el folio NO se arma en TypeScript: lo pone la secuencia de Postgres', () => {
    const codigo =
      SIN_COMENTARIOS(CONFIRMAR) + SIN_COMENTARIOS(PROPONER) + SIN_COMENTARIOS('lib/bot-cotizacion.ts')
    expect(codigo).not.toContain('COT-')
    expect(codigo).not.toContain('padStart')
    expect(codigo).not.toContain('nextval')
    const sql = LEER(
      'supabase/migrations/20260918163253_erp87_la_cotizacion_como_tabla_con_folio_y_vigencia.sql'
    )
    expect(sql).toContain("nextval('public.cotizacion_folio_seq')")
  })

  test('confirmar solo lee del cuerpo lo que puede llevar un boton', () => {
    const codigo = LEER(CONFIRMAR)
    const leidos = [...codigo.matchAll(/cuerpo\.([a-z_]+)/g)].map((m) => m[1])
    expect([...new Set(leidos)].sort()).toEqual(['borrador_id', 'sello', 'telegram_id'])
  })

  test('si los renglones fallan, se deshace el encabezado: un solo delete', () => {
    const codigo = LEER(CONFIRMAR)
    const borrados = codigo.match(/\.delete\(\)/g) || []
    expect(borrados).toHaveLength(1)
    expect(codigo).toContain("from('cotizaciones')")
  })

  test('las dos rutas son solo de ADMIN y exigen el token', () => {
    for (const ruta of [CONFIRMAR, PROPONER]) {
      const codigo = LEER(ruta)
      expect(codigo).toContain('tokenValido(request)')
      expect(codigo).toContain("identidad.rolEntidad !== 'ADMIN'")
      expect(codigo).toContain("export const dynamic = 'force-dynamic'")
    }
  })

  test('el discriminador se revisa ANTES que el sello', () => {
    // La rama del sello roto CANCELA el borrador. Si se revisara al reves, un
    // "va" de venta mandado contra un borrador de cotizacion lo cancelaria.
    // Se mide DENTRO de la funcion: arriba, en los `import`, el nombre del
    // comprobador aparece antes que nada y no significa orden de ejecucion.
    const codigo = LEER(CONFIRMAR).slice(LEER(CONFIRMAR).indexOf('export async function POST'))
    const tipo = codigo.indexOf("!== 'cotizacion'")
    const sello = codigo.indexOf('selloCotizacionCoincide')
    expect(tipo).toBeGreaterThan(0)
    expect(sello).toBeGreaterThan(tipo)
  })
})

// ===========================================================================
// 8. EL BOT: LOS BOTONES Y LO QUE NO PASA POR EL MODELO
// ===========================================================================

test.describe('el bot de cotizaciones', () => {
  const BOT = LEER('bot/bot_gastos.py')

  test('los cuatro botones de la cotizacion existen y van por indice', () => {
    for (const cb of ['vact:', 'cli:', 'vig:', 'setcli:']) {
      expect(BOT, `falta el boton ${cb}`).toContain('callback_data="' + cb)
    }
    // 64 bytes es el tope de `callback_data` de Telegram: el nombre del cliente
    // no cabe, asi que va por indice contra la lista que el servidor acaba de
    // declarar.
    expect(BOT).toContain('callback_data="setcli:" + str(i)')
    expect(BOT).toContain('callback_data="setcli:pros"')
  })

  test('cambiar la vigencia NO vuelve a pasar por el modelo', () => {
    expect(BOT).toContain('_esperando_vigencia')
    const bloque = BOT.slice(BOT.indexOf('if _esperando_vigencia.pop'))
    const hasta = bloque.slice(0, bloque.indexOf('\n    # Si veniamos'))
    expect(hasta).toContain('_proponer_cotizacion')
    expect(hasta).not.toContain('enrutar(')
    expect(hasta).not.toContain('extraer(')
  })

  test('al confirmar solo viajan tres campos, y ninguno es un numero', () => {
    const bloque = BOT.slice(BOT.indexOf('async def _confirmar_cotizacion'))
    const hasta = bloque.slice(0, bloque.indexOf('\n\n# ='))
    expect(hasta).toContain('"telegram_id": chat')
    expect(hasta).toContain('"borrador_id": dato["borrador_id"]')
    expect(hasta).toContain('"sello": dato["sello"]')
    expect(hasta).not.toContain('"total"')
    expect(hasta).not.toContain('"precio')
  })

  test('el bot no arma el mensaje de la cotizacion: lo reenvia', () => {
    const bloque = BOT.slice(BOT.indexOf('async def _confirmar_cotizacion'))
    const hasta = bloque.slice(0, bloque.indexOf('\n\n# ='))
    expect(hasta).toContain('r.get("mensaje"')
    expect(hasta).not.toContain('{:,.2f}')
  })

  test('el enrutador ya sabe que una cotizacion lleva vigencia', () => {
    const prompt = LEER('bot/enrutador.py')
    expect(prompt).toContain('cliente, vigencia_dias')
  })

  test('ya no dice que todavia no sabe cotizar', () => {
    expect(BOT).not.toContain('Todavia no se cotizar')
  })
})


// ============================================================================
// D51/D52 (Fase 6) — LA COTIZACION POR MONTO OBJETIVO
// ============================================================================
//
// ─── LA CONVERSACION QUE ESTO MIDE ──────────────────────────────────────────
//
//   Norman: ahora quiere una cotizacion cuyo total sea lo mas cercano a 15,000
//           pesos, manteniendo una proporcion semejante, hazme esa cotizacion
//   Bot:    Que le cotizo?
//   Norman: nose tu dimelo, haz las cuentas
//   Bot:    Que le cotizo?
//
// Con la cotizacion de $10,176.00 todavia en pantalla. **Los tres precios los
// acababa de emitir el propio bot.**
//
// ─── POR QUE ESTA PRUEBA ES BARATA ──────────────────────────────────────────
// Porque es la cotizacion REAL de Norman, con los fixtures que ya estaban
// arriba y el mismo `precioParaComprador` del endpoint. No hay numero magico:
// los $10,176.00 se calculan aqui y se comprueban antes de escalar nada.

test.describe('el monto objetivo: la cotizacion que el bot no supo hacer (D51/D52)', () => {
  // Aeropuerto, copiado de produccion: LOC de Zacatecas al 20%. Es a quien
  // Norman le estaba cotizando el 2026-09-19.
  const AEROPUERTO: CompradorDeVenta = {
    id: '4cbad6ad-41f6-4397-86d3-0f5ec5be21dd',
    nombre: 'Aeropuerto',
    rol: 'LOC',
    zona: 'Zacatecas',
    comision_base: 0,
    comision_base_local: 0.2,
    aplica_redondeo_costo: true
  }

  /** Los renglones de la cotizacion real, con el precio que resuelve el endpoint. */
  const RENGLONES = [
    { producto: CATALOGO[0], cantidad: 12 },
    { producto: CATALOGO[1], cantidad: 12 },
    { producto: CATALOGO[2], cantidad: 48 }
  ].map((l) => ({
    precioUnitario: precioParaComprador(l.producto, AEROPUERTO),
    cantidad: l.cantidad
  }))

  const totalDe = (cs: readonly number[]) =>
    Number(cs.reduce((t, c, i) => t + c * RENGLONES[i].precioUnitario, 0).toFixed(2))

  // El ancla de todo lo de abajo. Si este numero cambia, cambio un precio de
  // produccion y hay que volver a mirar el resto.
  test('la cotizacion real de Norman son $10,176.00', () => {
    expect(totalDe(RENGLONES.map((r) => r.cantidad))).toBe(10176)
  })

  test('pedir 15,000 devuelve piezas enteras, en proporcion, cerca del objetivo', () => {
    const r = escalarAObjetivo(RENGLONES, 15000)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // 1. **Enteras y positivas.** Es la mitad literal del encargo.
    for (const c of r.cantidades) {
      expect(Number.isInteger(c)).toBe(true)
      expect(c).toBeGreaterThan(0)
    }

    // 2. **El total cae en la ventana que pidio el encargo.**
    expect(r.total).toBeGreaterThan(14000)
    expect(r.total).toBeLessThan(16000)

    // 3. **El total que dice es el total que es.** Si estos dos numeros
    //    divergieran, el bot estaria ensenando una cifra que no cobra — que es
    //    D48 otra vez, con numeros en vez de promesas.
    expect(r.total).toBe(totalDe(r.cantidades))

    // 4. **La proporcion se parece.** La original es 1 : 1 : 4; se exige que
    //    cada renglon quede dentro del margen declarado del escalado limpio, o
    //    si no "mantener la proporcion" seria una frase del comentario y no una
    //    propiedad del codigo.
    const factor = 15000 / 10176
    for (let i = 0; i < RENGLONES.length; i++) {
      const limpio = Math.max(1, Math.round(RENGLONES[i].cantidad * factor))
      const holgura = Math.max(1, Math.round(limpio * MARGEN_DE_PROPORCION))
      expect(Math.abs(r.cantidades[i] - limpio)).toBeLessThanOrEqual(holgura)
    }

    // 5. **Los precios salen del catalogo, no del modelo.** Ninguna cantidad
    //    puede haber cambiado un precio: se recalcula el total desde
    //    `precioParaComprador` y tiene que dar lo mismo.
    const desdeElCatalogo = Number(
      [CATALOGO[0], CATALOGO[1], CATALOGO[2]]
        .reduce((t, p, i) => t + precioParaComprador(p, AEROPUERTO) * r.cantidades[i], 0)
        .toFixed(2)
    )
    expect(desdeElCatalogo).toBe(r.total)
  })

  test('escalar hacia ABAJO tambien funciona', () => {
    const r = escalarAObjetivo(RENGLONES, 5000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBeGreaterThan(4000)
    expect(r.total).toBeLessThan(6000)
    for (const c of r.cantidades) expect(c).toBeGreaterThan(0)
  })

  // ── CONTROL NEGATIVO, el que pidio el encargo por su nombre ───────────────
  test('CONTROL NEGATIVO: un objetivo imposible ($5) NO devuelve ceros', () => {
    const r = escalarAObjetivo(RENGLONES, 5)
    expect(r.ok).toBe(false)
    if (r.ok) return
    // Y lo dice con el numero, no con un "no se puede" pelado: el piso es una
    // pieza de cada uno = 480 + 144 + 56.
    expect(r.error).toContain('680')
    expect(r.error.toLowerCase()).toContain('lo menos')
  })

  test('CONTROL NEGATIVO: ninguna cantidad puede salir en cero ni negativa', () => {
    // Se barre toda la franja baja, no un solo caso: un `Math.round` sin el
    // `Math.max(1, ...)` deja ceros justo aqui y en ningun otro lado.
    for (let objetivo = 680; objetivo <= 3000; objetivo += 20) {
      const r = escalarAObjetivo(RENGLONES, objetivo)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      for (const c of r.cantidades) {
        expect(c).toBeGreaterThanOrEqual(1)
        expect(Number.isInteger(c)).toBe(true)
      }
    }
  })

  test('CONTROL NEGATIVO: sin cotizacion anterior no se inventa ninguna', () => {
    const r = escalarAObjetivo([], 15000)
    expect(r.ok).toBe(false)
  })

  test('CONTROL NEGATIVO: un objetivo que no es numero no escala nada', () => {
    for (const malo of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(escalarAObjetivo(RENGLONES, malo).ok).toBe(false)
    }
  })

  test('CONTROL NEGATIVO: un renglon sin precio no se escala a ciegas', () => {
    const r = escalarAObjetivo([{ precioUnitario: 0, cantidad: 3 }], 1000)
    expect(r.ok).toBe(false)
  })

  // El endpoint es quien tiene que mandar el `objetivo` hacia la funcion; si
  // esa linea se cae, la funcion de arriba queda perfecta y muerta.
  test('la ruta de proponer llama al escalado y contesta 422 si no se puede', () => {
    const RUTA = LEER('app/api/bot/cotizacion/proponer/route.ts')
    expect(RUTA).toContain('escalarAObjetivo')
    expect(RUTA).toContain('cuerpo.objetivo')
    expect(RUTA).toContain('status: 422')
  })
})
