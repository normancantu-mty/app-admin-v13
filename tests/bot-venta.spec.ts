/**
 * AG-05 Fase 3 — Pruebas puras de la VENTA por Telegram.
 *
 * ─── DE DONDE SALEN LOS FIXTURES ────────────────────────────────────────────
 * **Los numeros de aqui se COPIARON de produccion el 2026-09-18**, no se
 * inventaron. Es la regla que nacio de E-243: una prueba escrita suponiendo la
 * escala de un campo pasa en verde mientras el bot miente.
 *
 * Catalogo real (`catalogo_productos` tipo TERMINADO, con `listas_precios`):
 *   · Destilado Plata 750ml (plata-750ml)  Zacatecas $599  Foraneo $799
 *   · Destilado Plata 250ml (plata-250ml)  Zacatecas $179  Foraneo $199
 *   · Destilado Plata 50ml  (plata-50ml)   Zacatecas  $69  Foraneo  $99
 *   · Pasta-Guajillo-2kg (B-MVP-Pasta2kg)  Zacatecas $130  Foraneo $130
 *
 * Entidades reales: CEO Admin (ADMIN) · Gilberto Franco (DST, comision_base
 * 0.20, redondeo si) · Delirio 85 (LOC, comision_base_local 0.20) · Dulceria el
 * Eden (LOC, 0.15) · PENDIENTE DE ASIGNAR, el centinela.
 *
 * ─── LA ARITMETICA QUE SE COMPRUEBA, A MANO ─────────────────────────────────
 * Un 750ml a un DST del 20%, con `aplica_redondeo_costo`:
 *   base = 599 (LIBRE no separa impuestos) · ganancia = 599 x 0.20 = 119.80
 *   costo crudo = 599 - 119.80 = 479.20 · redondeado hacia ARRIBA = **480**
 * Ese 480 es el precio unitario que se escribe, y 599 el de lista que se
 * ensena al lado. Las dos cifras juntas son lo unico que deja cachar un precio
 * de distribuidor mal aplicado sin abrir la pantalla.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import {
  aProductoDelCatalogo,
  buscarProducto,
  LLAVES_VENTA,
  mensajeDeConfirmacionVenta,
  normalizarCondicionPago,
  normalizarVenta,
  pideTriangulacion,
  precioParaComprador,
  RECHAZO_CUENTA_FISCAL,
  RECHAZO_TRIANGULACION,
  sellarVenta,
  selloVentaCoincide,
  tipoFiscalidadDeCuenta,
  TOLERANCIA_MONTO_DICHO,
  TOPE_PIEZAS_POR_LINEA,
  TOPE_VENTA,
  ventaCanonica,
  ZONA_POR_DEFECTO,
  type CompradorDeVenta,
  type ContextoVenta,
  type ProductoConPrecios,
  type ProductoDelCatalogo
} from '@/lib/bot-venta'
import { calculateReverseTaxes } from '@/lib/finance-utils'
import { sellar } from '@/lib/bot-sello'

// ── Los fixtures, copiados de produccion ──────────────────────────────────
const CEO_ADMIN = 'e0000000-0000-0000-0000-000000000001'

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
  },
  {
    id: '9f310b3c-9924-4b63-b08b-a50a88795347',
    sku: 'B-MVP-Pasta2kg',
    nombre: 'Pasta-Guajillo-2kg',
    ml_por_unidad: null,
    precios: [
      { zona: 'Zacatecas', precio_final: 130 },
      { zona: 'Foraneo', precio_final: 130 }
    ]
  }
]

const CATALOGO = CATALOGO_CRUDO.map((p) => aProductoDelCatalogo(p, ZONA_POR_DEFECTO))
const SETECIENTOS_CINCUENTA = CATALOGO[0]

const GILBERTO: CompradorDeVenta = {
  id: '9f8cd8f6-6623-4f86-b92e-9eba500a8fb4',
  nombre: 'Gilberto Franco',
  rol: 'DST',
  zona: 'Zacatecas',
  comision_base: 0.2,
  comision_base_local: 0,
  aplica_redondeo_costo: true
}

const DELIRIO: CompradorDeVenta = {
  id: '08f06156-c6ba-40bd-ac7a-7981738f9358',
  nombre: 'Delirio 85',
  rol: 'LOC',
  zona: 'Zacatecas',
  comision_base: 0,
  comision_base_local: 0.2,
  aplica_redondeo_costo: true
}

const EDEN: CompradorDeVenta = {
  id: '1f1b7ad9-2fab-4763-a258-c75bb65c31f5',
  nombre: 'Dulceria el Eden',
  rol: 'LOC',
  zona: 'Zacatecas',
  comision_base: 0,
  comision_base_local: 0.15,
  aplica_redondeo_costo: true
}

function contexto(parcial: Partial<ContextoVenta> = {}): ContextoVenta {
  return {
    idVendedor: CEO_ADMIN,
    nombreVendedor: 'CEO Admin',
    comprador: null,
    idCuentaDestino: 'cta-0000',
    nombreCuentaDestino: 'Efectivo (CEO Admin)',
    tipoFiscalidadCuenta: 'LIBRE',
    etiqueta: 'norman',
    lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 1 }],
    ...parcial
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. EL ALCANCE: lo que el bot rechaza por nombre
// ═══════════════════════════════════════════════════════════════════════════

test.describe('el alcance declarado', () => {
  test('no decir nada de origen NO es triangular: sale del inventario propio', () => {
    expect(pideTriangulacion(undefined, CEO_ADMIN)).toBe(false)
    expect(pideTriangulacion('', CEO_ADMIN)).toBe(false)
    expect(pideTriangulacion('   ', CEO_ADMIN)).toBe(false)
    expect(pideTriangulacion(CEO_ADMIN, CEO_ADMIN)).toBe(false)
  })

  test('pedir el inventario de otro SI es triangular, y se rechaza', () => {
    expect(pideTriangulacion(GILBERTO.id, CEO_ADMIN)).toBe(true)
  })

  test('los dos rechazos dicen a donde ir, no solo que no', () => {
    // Un "no puedo" sin salida deja a la persona sin saber que hacer con una
    // venta que ya ocurrio en el mundo real.
    expect(RECHAZO_TRIANGULACION).toContain('en la pantalla')
    expect(RECHAZO_CUENTA_FISCAL).toContain('en la pantalla')
  })

  test('el regimen fiscal sale de la columna, y lo raro se detiene (ERP-21)', () => {
    expect(tipoFiscalidadDeCuenta('LIBRE')).toBe('LIBRE')
    expect(tipoFiscalidadDeCuenta('full_tax')).toBe('FULL_TAX')
    expect(tipoFiscalidadDeCuenta('IVA_ONLY')).toBe('IVA_ONLY')
    // Lo que no se reconoce NO se supone LIBRE: eso dejaria de separar
    // impuestos sin que nadie se entere.
    expect(tipoFiscalidadDeCuenta('')).toBeNull()
    expect(tipoFiscalidadDeCuenta(null)).toBeNull()
    expect(tipoFiscalidadDeCuenta('Cuenta Fresnillo')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. EL PRODUCTO
// ═══════════════════════════════════════════════════════════════════════════

test.describe('empatar el producto', () => {
  test('por nombre completo', () => {
    const r = buscarProducto('Destilado Plata 750ml', CATALOGO)
    expect(r.ok && r.elegido.sku).toBe('plata-750ml')
  })

  test('por SKU, que vale exactamente igual que el nombre', () => {
    const r = buscarProducto('plata-250ml', CATALOGO)
    expect(r.ok && r.elegido.nombre).toBe('Destilado Plata 250ml')
  })

  test('por un pedazo: "guajillo" es la pasta y nada mas', () => {
    const r = buscarProducto('guajillo', CATALOGO)
    expect(r.ok && r.elegido.sku).toBe('B-MVP-Pasta2kg')
  })

  test('"plata" casa con tres y NO se adivina: se pregunta con los tres', () => {
    const r = buscarProducto('plata', CATALOGO)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.motivo).toBe('ambiguo')
      expect(r.candidatos.length).toBe(3)
    }
  })

  test('lo que no existe no se acerca al mas parecido', () => {
    const r = buscarProducto('tequila', CATALOGO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('no-encontrado')
  })
})

test.describe('el precio por zona', () => {
  test('Zacatecas y Foraneo son precios distintos del mismo producto', () => {
    expect(aProductoDelCatalogo(CATALOGO_CRUDO[0], 'Zacatecas').precio_final).toBe(599)
    expect(aProductoDelCatalogo(CATALOGO_CRUDO[0], 'Foraneo').precio_final).toBe(799)
  })

  test('una zona sin lista da cero, y cero lo rechaza la normalizacion', () => {
    const sinLista = aProductoDelCatalogo(CATALOGO_CRUDO[0], 'Yucatan')
    expect(sinLista.precio_final).toBe(0)

    const r = normalizarVenta({}, contexto({ lineas: [{ producto: sinLista, cantidad: 2 }] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('no tiene precio de lista')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. EL PRECIO: la cifra que nadie dicto
// ═══════════════════════════════════════════════════════════════════════════

test.describe('el precio para cada comprador', () => {
  test('sin comprador (publico en general) es el precio de lista, tal cual', () => {
    expect(precioParaComprador(SETECIENTOS_CINCUENTA, null)).toBe(599)
  })

  test('a un DST del 20% con redondeo: 599 -> 480, no 479.20', () => {
    // 599 x 0.80 = 479.20, y `aplica_redondeo_costo` sube al entero. La ley del
    // redondeo (regla 7 de CLAUDE.md): el pedazo del nodo NUNCA se infla a favor
    // del nodo.
    expect(precioParaComprador(SETECIENTOS_CINCUENTA, GILBERTO)).toBe(480)
  })

  test('a un LOC del 20% sale igual que al DST del 20%: el rol no cambia la resta', () => {
    expect(precioParaComprador(SETECIENTOS_CINCUENTA, DELIRIO)).toBe(480)
  })

  test('a un LOC del 15% sale mas caro: 599 x 0.85 = 509.15 -> 510', () => {
    expect(precioParaComprador(SETECIENTOS_CINCUENTA, EDEN)).toBe(510)
  })

  test('un rol que no es DST ni LOC paga lista, aunque traiga comision', () => {
    const raro: CompradorDeVenta = { ...GILBERTO, rol: 'SUB-ADMIN' }
    expect(precioParaComprador(SETECIENTOS_CINCUENTA, raro)).toBe(599)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. LA CONDICION DE PAGO
// ═══════════════════════════════════════════════════════════════════════════

test.describe('contado o concesion', () => {
  test('el default es CONTADO, que es el que no le carga deuda a nadie', () => {
    expect(normalizarCondicionPago(undefined)).toBe('CONTADO')
    expect(normalizarCondicionPago('')).toBe('CONTADO')
    expect(normalizarCondicionPago('me pago en efectivo')).toBe('CONTADO')
  })

  test('las palabras que Norman usa de verdad para fiar', () => {
    for (const dicho of [
      'CONCESION',
      'a concesion',
      'se la deje a consignacion',
      'a credito',
      'se la fie',
      'me paga despues',
      'queda debiendo'
    ]) {
      expect(normalizarCondicionPago(dicho)).toBe('CONCESION')
    }
  })

  test('los acentos no cambian la decision', () => {
    expect(normalizarCondicionPago('a concesión')).toBe('CONCESION')
    expect(normalizarCondicionPago('a crédito')).toBe('CONCESION')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. LA NORMALIZACION: lo que se va a escribir
// ═══════════════════════════════════════════════════════════════════════════

test.describe('normalizar la venta', () => {
  test('el caso de todos los dias: 10 de 750 al publico, de contado', () => {
    const r = normalizarVenta(
      {},
      contexto({ lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 10 }] })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.payload.condicion_pago).toBe('CONTADO')
    expect(r.payload.id_comprador).toBeNull()
    expect(r.payload.id_vendedor).toBe(CEO_ADMIN)
    expect(r.payload.items).toEqual([
      {
        id_producto: SETECIENTOS_CINCUENTA.id,
        cantidad: 10,
        precio_unitario: 599,
        subtotal_linea: 5990
      }
    ])
    // Los dos totales son el mismo numero, igual que en la pantalla: el bot no
    // aplica descuentos porque no hay campo donde dictarlos.
    expect(r.payload.subtotal_catalogo).toBe(5990)
    expect(r.payload.total_cobrado_real).toBe(5990)
    expect(r.payload.usuario_creador).toBe('telegram:norman')
  })

  test('la misma venta a Gilberto cuesta 4800, y el desglose ensena los dos precios', () => {
    const r = normalizarVenta(
      {},
      contexto({
        comprador: GILBERTO,
        lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 10 }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.payload.total_cobrado_real).toBe(4800)
    expect(r.payload.id_comprador).toBe(GILBERTO.id)
    expect(r.desglose[0].precioLista).toBe(599)
    expect(r.desglose[0].precioUnitario).toBe(480)
  })

  test('dos renglones del mismo producto se juntan, y se avisa', () => {
    // "10 de 750 y otras 5 de 750" son 15, no dos renglones. Un ticket con el
    // mismo producto dos veces es un documento que se lee mal.
    const r = normalizarVenta(
      {},
      contexto({
        lineas: [
          { producto: SETECIENTOS_CINCUENTA, cantidad: 10 },
          { producto: SETECIENTOS_CINCUENTA, cantidad: 5 }
        ]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.payload.items.length).toBe(1)
    expect(r.payload.items[0].cantidad).toBe(15)
    expect(r.avisos.join(' ')).toContain('15 piezas')
  })

  test('productos distintos son renglones distintos, en el orden dictado', () => {
    const r = normalizarVenta(
      {},
      contexto({
        lineas: [
          { producto: CATALOGO[1], cantidad: 2 },
          { producto: SETECIENTOS_CINCUENTA, cantidad: 1 }
        ]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.items.map((i) => i.cantidad)).toEqual([2, 1])
    expect(r.payload.total_cobrado_real).toBe(179 * 2 + 599)
  })

  test('media botella no existe: las piezas son enteras', () => {
    const r = normalizarVenta(
      {},
      contexto({ lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 2.5 }] })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('piezas enteras')
  })

  test('cero o negativo no es una venta', () => {
    for (const cantidad of [0, -3]) {
      const r = normalizarVenta(
        {},
        contexto({ lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad }] })
      )
      expect(r.ok).toBe(false)
    }
  })

  test('sin renglones no hay nada que proponer', () => {
    const r = normalizarVenta({}, contexto({ lineas: [] }))
    expect(r.ok).toBe(false)
  })

  test('un "2000" que se oyo por "20" se detiene en el tope por renglon', () => {
    const r = normalizarVenta(
      {},
      contexto({
        lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: TOPE_PIEZAS_POR_LINEA + 1 }]
      })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('en la pantalla')
  })

  test('el tope de la venta entera manda aunque cada renglon quepa', () => {
    // 1000 x 599 = 599,000, arriba del tope, con un solo renglon legal.
    const r = normalizarVenta(
      {},
      contexto({
        lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: TOPE_PIEZAS_POR_LINEA }]
      })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(String(TOPE_VENTA))
  })

  test('una concesion sin comprador se PREGUNTA, no se manda al centinela', () => {
    const r = normalizarVenta({ condicion_pago: 'a concesion' }, contexto({ comprador: null }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Quien')
  })

  test('venderse a uno mismo no se escribe', () => {
    const yo: CompradorDeVenta = { ...GILBERTO, id: CEO_ADMIN }
    const r = normalizarVenta({}, contexto({ comprador: yo }))
    expect(r.ok).toBe(false)
  })
})

test.describe('el monto que dijo la persona', () => {
  test('no entra a la fila: manda el de lista', () => {
    const r = normalizarVenta(
      { monto: 3000 },
      contexto({ lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 10 }] })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.total_cobrado_real).toBe(5990)
  })

  test('pero la diferencia se ensena, con los dos numeros', () => {
    const r = normalizarVenta(
      { monto: 3000 },
      contexto({ lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 10 }] })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const aviso = r.avisos.join(' ')
    expect(aviso).toContain('3000.00')
    expect(aviso).toContain('5990.00')
  })

  test('un peso de diferencia es redondeo y no dice nada', () => {
    const r = normalizarVenta(
      { monto: 599 + TOLERANCIA_MONTO_DICHO },
      contexto({ lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 1 }] })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.avisos.join(' ')).not.toContain('de lista me salen')
  })

  test('no decir monto no avisa nada', () => {
    const r = normalizarVenta({}, contexto())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.avisos).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. LOS IMPUESTOS: que el mensaje y la fila digan lo mismo
// ═══════════════════════════════════════════════════════════════════════════

test.describe('el desglose fiscal del mensaje', () => {
  test('LIBRE no separa nada, y no aparece ningun aviso de impuestos', () => {
    const r = normalizarVenta({}, contexto())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fiscal).toEqual({ montoBase: 599, iva: 0, ieps: 0 })
    expect(r.avisos.join(' ')).not.toContain('IVA')
  })

  test('es la MISMA funcion y el MISMO total que usa el motor al escribir', () => {
    // La cabecera de `lib/bot-venta.ts` promete que los impuestos que se ensenan
    // son los que se van a escribir. Esta es esa promesa, comprobada: el mensaje
    // llama a `calculateReverseTaxes` sobre el total cobrado, igual que
    // `registrarVenta`. Si algun dia difieren, manda la fila — y esto se pone
    // rojo antes.
    const r = normalizarVenta(
      {},
      contexto({
        tipoFiscalidadCuenta: 'IVA_ONLY',
        lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 10 }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const delMotor = calculateReverseTaxes(r.payload.total_cobrado_real, 'IVA_ONLY')
    expect(r.fiscal).toEqual({
      montoBase: delMotor.montoBase,
      iva: delMotor.iva,
      ieps: delMotor.ieps
    })
    expect(r.avisos.join(' ')).toContain('IVA')
  })

  test('LA OTRA MITAD: el motor calcula sobre el total cobrado, no sobre otra cosa', () => {
    // Centinela de forma. La prueba de arriba compara dos llamadas a la misma
    // funcion; sola, seguiria verde si `registrarVenta` empezara a calcular los
    // impuestos sobre el subtotal de catalogo o sobre la base ya neteada.
    const fuente = readFileSync(join(__dirname, '..', 'lib', 'venta-servidor.ts'), 'utf8')
    expect(fuente).toContain('calculateReverseTaxes(payload.totalCobradoReal, tipoFiscalidadCuenta)')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. EL SELLO
// ═══════════════════════════════════════════════════════════════════════════

test.describe('el sello de la venta', () => {
  const base = () => {
    const r = normalizarVenta(
      {},
      contexto({ comprador: GILBERTO, lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 10 }] })
    )
    if (!r.ok) throw new Error('el fixture tiene que normalizar')
    return r.payload
  }

  test('las llaves estan ordenadas y son todas las del payload', () => {
    // El orden ES el sello: `canonizar` recorre esta lista. Una llave nueva sin
    // agregar aqui quedaria FUERA del hash, o sea, se podria cambiar sin romperlo.
    expect([...LLAVES_VENTA]).toEqual([...LLAVES_VENTA].sort())
    expect([...LLAVES_VENTA].sort()).toEqual(Object.keys(base()).sort())
  })

  test('el mismo payload sella igual aunque venga con las llaves revueltas', () => {
    // `jsonb` de Postgres reordena las llaves. Sin canonizacion recursiva, el
    // sello se romperia solo al pasar por la base.
    const p = base()
    const revuelto = {
      usuario_creador: p.usuario_creador,
      items: p.items,
      total_cobrado_real: p.total_cobrado_real,
      id_vendedor: p.id_vendedor,
      condicion_pago: p.condicion_pago,
      subtotal_catalogo: p.subtotal_catalogo,
      id_cuenta_destino: p.id_cuenta_destino,
      id_comprador: p.id_comprador
    }
    expect(sellarVenta(revuelto as typeof p)).toBe(sellarVenta(p))
    expect(ventaCanonica(revuelto as typeof p)).toBe(ventaCanonica(p))
  })

  test('cambiar UN peso del total rompe el sello', () => {
    const p = base()
    const tocado = { ...p, total_cobrado_real: p.total_cobrado_real + 1 }
    expect(selloVentaCoincide(tocado, sellarVenta(p))).toBe(false)
  })

  test('cambiar el comprador rompe el sello', () => {
    const p = base()
    expect(selloVentaCoincide({ ...p, id_comprador: DELIRIO.id }, sellarVenta(p))).toBe(false)
  })

  test('cambiar una cantidad DENTRO de un renglon rompe el sello', () => {
    // Lo mas facil de que se cuele: el hash tiene que entrar a los objetos de
    // `items`, no quedarse en la referencia del arreglo.
    const p = base()
    const tocado = {
      ...p,
      items: p.items.map((i) => ({ ...i, cantidad: i.cantidad + 1 }))
    }
    expect(selloVentaCoincide(tocado, sellarVenta(p))).toBe(false)
  })

  test('un sello vacio, nulo o de otra forma no empata', () => {
    const p = base()
    expect(selloVentaCoincide(p, '')).toBe(false)
    expect(selloVentaCoincide(p, null)).toBe(false)
    expect(selloVentaCoincide(p, 'a'.repeat(64))).toBe(false)
  })

  test('el hash de una venta NUNCA es el de un abono con los mismos datos', () => {
    // Es la razon por la que `confirmar` comprueba `tipo` ANTES del sello: un
    // borrador de otro tipo fallaria aqui, y la rama del sello roto CANCELA.
    const p = base()
    expect(sellar(p, ['id_entidad', 'monto'])).not.toBe(sellarVenta(p))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. EL MENSAJE QUE SE LEE ANTES DE DECIR "VA"
// ═══════════════════════════════════════════════════════════════════════════

test.describe('el mensaje de confirmacion', () => {
  function armar(comprador: CompradorDeVenta | null, condicion?: string) {
    const r = normalizarVenta(
      { condicion_pago: condicion },
      contexto({ comprador, lineas: [{ producto: SETECIENTOS_CINCUENTA, cantidad: 10 }] })
    )
    if (!r.ok) throw new Error(r.error)
    return mensajeDeConfirmacionVenta(
      r.payload,
      {
        nombreVendedor: 'CEO Admin',
        nombreComprador: comprador?.nombre ?? 'Publico en General',
        nombreCuentaDestino: 'Efectivo (CEO Admin)',
        desglose: r.desglose
      },
      r.avisos
    )
  }

  test('trae el total, las piezas y a donde entra el dinero', () => {
    const m = armar(null)
    expect(m).toContain('VENTA CONTADO')
    expect(m).toContain('Publico en General')
    expect(m).toContain('$5,990.00')
    expect(m).toContain('10 piezas')
    expect(m).toContain('Efectivo (CEO Admin)')
    expect(m).toContain('VA')
  })

  test('a un DST ensena el precio de lista AL LADO del cobrado', () => {
    // Lo unico que deja cachar un precio de distribuidor mal aplicado sin abrir
    // la pantalla. La cantidad la dijo la persona; el precio no lo dicto nadie.
    const m = armar(GILBERTO)
    expect(m).toContain('$480.00')
    expect(m).toContain('lista $599.00')
    expect(m).toContain('$4,800.00')
  })

  test('al publico NO repite el precio de lista: es el mismo numero dos veces', () => {
    expect(armar(null)).not.toContain('lista')
  })

  test('una concesion dice que NO entra dinero, y cuanto queda a deber', () => {
    const m = armar(GILBERTO, 'a concesion')
    expect(m).toContain('VENTA CONCESION')
    expect(m).toContain('No entra dinero')
    expect(m).toContain('$4,800.00')
    expect(m).toContain('a su deuda')
    expect(m).not.toContain('queda a deber')
    expect(m).not.toContain('El dinero entra')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. CENTINELAS DE FORMA: donde vive el dinero
// ═══════════════════════════════════════════════════════════════════════════

test.describe('las rutas del bot no son un segundo motor de venta', () => {
  const ruta = (...p: string[]) => join(__dirname, '..', 'app', 'api', 'bot', 'venta', ...p)
  const sinComentarios = (texto: string) =>
    texto
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
      })
      .join('\n')

  test('confirmar DELEGA en registrarVenta y no escribe ninguna tabla por su cuenta', () => {
    // La propiedad por la que se extrajo la venta de la sesion en el PASO 3.1.
    // Si esta prueba se pone roja, alguien esta copiando la regla del dinero a
    // un segundo lugar y el dia que cambie una, la otra seguira cobrando viejo.
    const codigo = sinComentarios(readFileSync(ruta('confirmar', 'route.ts'), 'utf8'))
    expect(codigo).toContain('registrarVenta(')
    for (const tabla of [
      'transacciones_tickets',
      'ticket_detalles',
      'finanzas_ledger',
      'inventario_ledger'
    ]) {
      expect(codigo).not.toContain(tabla)
    }
    expect(codigo).not.toContain('.rpc(')
  })

  test('proponer no escribe NADA mas que el borrador', () => {
    const codigo = sinComentarios(readFileSync(ruta('proponer', 'route.ts'), 'utf8'))
    expect(codigo).toContain("from('bot_borradores')")
    for (const tabla of [
      'transacciones_tickets',
      'ticket_detalles',
      'finanzas_ledger',
      'inventario_ledger'
    ]) {
      expect(codigo).not.toContain(tabla)
    }
    expect(codigo).not.toContain('registrarVenta(')
  })

  test('confirmar comprueba el TIPO del borrador antes que el sello', () => {
    // Sin esa linea, un borrador de gasto caeria en la rama del sello roto, que
    // CANCELA: una ruta equivocada del bot borraria una captura buena.
    const codigo = readFileSync(ruta('confirmar', 'route.ts'), 'utf8')
    const posTipo = codigo.indexOf("!== 'venta'")
    const posSello = codigo.indexOf('selloVentaCoincide(')
    expect(posTipo).toBeGreaterThan(-1)
    expect(posSello).toBeGreaterThan(-1)
    expect(posTipo).toBeLessThan(posSello)
  })

  test('confirmar recibe SOLO tres campos: ninguna fila viaja en el "va"', () => {
    const codigo = sinComentarios(readFileSync(ruta('confirmar', 'route.ts'), 'utf8'))
    // Lo que se lee del cuerpo de la peticion, y nada mas.
    for (const campo of ['telegram_id', 'borrador_id', 'sello']) {
      expect(codigo).toContain(`cuerpo.${campo}`)
    }
    for (const prohibido of ['cuerpo.items', 'cuerpo.total', 'cuerpo.precio', 'cuerpo.productos']) {
      expect(codigo).not.toContain(prohibido)
    }
  })

  test('confirmar NO manda origenInventarioId: la triangulacion queda por omision', () => {
    const codigo = sinComentarios(readFileSync(ruta('confirmar', 'route.ts'), 'utf8'))
    expect(codigo).not.toContain('origenInventarioId')
  })
})
