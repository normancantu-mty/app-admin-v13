/**
 * FASE 11 (D112) — LA ENTREGA DE EFECTIVO DEL DISTRIBUIDOR, pruebas puras.
 *
 * Lo que se mide aqui (sin base, sin red):
 *   1. Quien registra la entrega de quien (`decidirEntrega`), con la celda "No"
 *      del DST ajeno, y la MISMA regla en la web (`reglaDeEntregaWeb`).
 *   2. La fila exacta (`filaDeEntrega`): ABONO_DEUDA marcado, sin pedido.
 *   3. LA MUTACION DEL PROMPT: la entrega NO cuenta como pago de concesion
 *      (`construirCartera`, `calcularSaldoPendienteInventarioConsignacion`),
 *      y SI cuenta como efectivo entregado (`calcularSaldoPorPagarEfectivo`).
 *   4. Los textos de /cartera (`textoEfectivoPorEntregar`, `textoQuienDebe`).
 *   5. El cableado de la web: `registrarAbonoAction` pasa por la regla y solo
 *      escribe la marca en una entrega (lectura del fuente: la accion de
 *      servidor lee cookies y no se puede importar aqui).
 *
 * Las rutas del bot (proponer/confirmar, 403 del DST ajeno, VA del DST ->
 * espera, Aprobar -> una sola fila) se miden en `tests/bot-rutas-permisos.spec.ts`
 * (seccion D112), que es donde vive el PostgREST simulado.
 *
 * Mutaciones corridas (ver `_avance_fase11_2026-09-23.md`, D112).
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decidirEntrega,
  filaDeEntrega,
  normalizarMonto,
  reglaDeEntregaWeb,
  sellarEntrega,
  selloEntregaCoincide,
  textoEfectivoPorEntregar,
  MENSAJE_SOLO_LA_TUYA,
  REFERENCIA_ENTREGA,
  type PayloadEntrega
} from '@/lib/bot-entrega'
import { construirCartera, type EntradaCartera } from '@/lib/cartera-utils'
import {
  calcularSaldoPendienteInventarioConsignacion,
  calcularSaldoPorPagarEfectivo,
  type FinanzaSaldoInput
} from '@/lib/distribuidores-saldos'
import { NOTA_EFECTIVO_NO_SEPARABLE, textoQuienDebe } from '@/lib/bot-consultas'
import { CATEGORIA_ABONO_REAL, esEntregaDeEfectivo } from '@/lib/finance-utils'

const GIL = 'dst-gil'
const MARTIN = 'dst-martin'
const LOCAL = 'loc-casa'

// ─── 1. QUIEN PUEDE ─────────────────────────────────────────────────────────
test.describe('D112 — quien registra la entrega de quien', () => {
  test('ADMIN: la de cualquier DST o LOC, sin espera propia', () => {
    expect(decidirEntrega({ rol: 'ADMIN', idEntidad: 'matriz' }, { id: GIL, rol: 'DST' })).toEqual({ ok: true, siempreEspera: false })
    expect(decidirEntrega({ rol: 'ADMIN', idEntidad: 'matriz' }, { id: LOCAL, rol: 'LOC' })).toEqual({ ok: true, siempreEspera: false })
  })

  test('DST: la suya, y SIEMPRE espera el Aprobar', () => {
    expect(decidirEntrega({ rol: 'DST', idEntidad: GIL }, { id: GIL, rol: 'DST' })).toEqual({ ok: true, siempreEspera: true })
  })

  test('celda No: un DST con la entrega de OTRO DST -> no', () => {
    expect(decidirEntrega({ rol: 'DST', idEntidad: GIL }, { id: MARTIN, rol: 'DST' })).toEqual({ ok: false, error: MENSAJE_SOLO_LA_TUYA })
  })

  test('celda No: un DST con la de su propio LOCAL -> no (solo la suya)', () => {
    expect(decidirEntrega({ rol: 'DST', idEntidad: GIL }, { id: LOCAL, rol: 'LOC' }).ok).toBe(false)
  })

  test('celda No: LOC, SOCIO o rol vacio no registran; y el objetivo tiene que ser DST/LOC', () => {
    for (const rol of ['LOC', 'SOCIO', '']) {
      expect(decidirEntrega({ rol, idEntidad: LOCAL }, { id: LOCAL, rol: 'LOC' }).ok, rol).toBe(false)
    }
    expect(decidirEntrega({ rol: 'ADMIN', idEntidad: 'matriz' }, { id: 'matriz', rol: 'ADMIN' }).ok).toBe(false)
  })

  test('web: la MISMA regla, y una entrega es siempre distribuidor -> matriz', () => {
    expect(reglaDeEntregaWeb({ rol: 'ADMIN', entidadId: 'matriz' }, { id: GIL, rol: 'DST' }, 'ABONO_DEUDA')).toEqual({ ok: true })
    expect(reglaDeEntregaWeb({ rol: 'DST', entidadId: GIL }, { id: GIL, rol: 'DST' }, 'ABONO_DEUDA')).toEqual({ ok: true })
    // Celda No en la web: el DST ajeno.
    expect(reglaDeEntregaWeb({ rol: 'DST', entidadId: GIL }, { id: MARTIN, rol: 'DST' }, 'ABONO_DEUDA')).toEqual({ ok: false, error: MENSAJE_SOLO_LA_TUYA })
    // Un cargo (matriz -> DST) no es entrega.
    expect(reglaDeEntregaWeb({ rol: 'ADMIN', entidadId: 'matriz' }, { id: GIL, rol: 'DST' }, 'CARGO_DEUDA').ok).toBe(false)
    // El rol llega en minusculas de algun lado: se normaliza, no se regala.
    expect(reglaDeEntregaWeb({ rol: 'dst', entidadId: GIL }, { id: MARTIN, rol: 'dst' }, 'ABONO_DEUDA').ok).toBe(false)
  })
})

// ─── 2. LA FILA ─────────────────────────────────────────────────────────────
const PAYLOAD: PayloadEntrega = {
  id_entidad: GIL,
  monto: 1500,
  id_cuenta_origen: 'c-gil',
  id_cuenta_destino: 'c-matriz',
  fecha_movimiento: '2026-09-24T18:00:00.000Z',
  usuario_creador: 'telegram:gil',
  nota: ''
}

test.describe('D112 — la fila exacta y el sello', () => {
  test('ABONO_DEUDA marcado, ABONO_REAL, sin pedido, efectivo', () => {
    const f = filaDeEntrega(PAYLOAD)
    expect(f).toMatchObject({
      tipo_movimiento: 'ABONO_DEUDA',
      es_entrega_efectivo: true,
      categoria: CATEGORIA_ABONO_REAL,
      categoria_gasto: REFERENCIA_ENTREGA,
      id_ticket: null,
      id_entidad_relacionada: GIL,
      id_cuenta_origen: 'c-gil',
      id_cuenta_destino: 'c-matriz',
      metodo_pago: 'EFECTIVO',
      monto: 1500,
      status: 'ACTIVO',
      descripcion: null
    })
    expect(esEntregaDeEfectivo(f)).toBe(true)
  })

  test('el sello cubre el monto y el DST', () => {
    const sello = sellarEntrega(PAYLOAD)
    expect(selloEntregaCoincide(PAYLOAD, sello)).toBe(true)
    expect(selloEntregaCoincide({ ...PAYLOAD, monto: 1501 }, sello)).toBe(false)
    expect(selloEntregaCoincide({ ...PAYLOAD, id_entidad: MARTIN }, sello)).toBe(false)
  })

  test('monto: se normaliza, cero y negativos no, y hay tope', () => {
    expect(normalizarMonto('$3,000.456')).toEqual({ ok: true, monto: 3000.46 })
    expect(normalizarMonto(0).ok).toBe(false)
    expect(normalizarMonto(-5).ok).toBe(false)
    expect(normalizarMonto('mil').ok).toBe(false)
    expect(normalizarMonto(500_001).ok).toBe(false)
  })

  test('esEntregaDeEfectivo: sin la columna (migracion sin aplicar) = no', () => {
    expect(esEntregaDeEfectivo({})).toBe(false)
    expect(esEntregaDeEfectivo({ es_entrega_efectivo: null })).toBe(false)
    expect(esEntregaDeEfectivo({ es_entrega_efectivo: false })).toBe(false)
  })
})

// ─── 3. NO ES PAGO DE CONCESION (la mutacion del prompt) ────────────────────
// Gil: 1,000 de concesion generada; paga 200 de concesion y ENTREGA 400 de
// efectivo que cobro de contado (DEUDA_A_MATRIZ 600).
const FINANZAS: (FinanzaSaldoInput & { status: string; fecha_movimiento: string })[] = [
  { tipo_movimiento: 'DEUDA_A_MATRIZ', monto: 600, id_entidad_relacionada: GIL, categoria: null, status: 'ACTIVO', fecha_movimiento: '2026-09-20T12:00:00.000Z' },
  { tipo_movimiento: 'ABONO_DEUDA', monto: 200, id_entidad_relacionada: GIL, categoria: 'ABONO_REAL', status: 'ACTIVO', fecha_movimiento: '2026-09-21T12:00:00.000Z' },
  { tipo_movimiento: 'ABONO_DEUDA', monto: 400, id_entidad_relacionada: GIL, categoria: 'ABONO_REAL', es_entrega_efectivo: true, status: 'ACTIVO', fecha_movimiento: '2026-09-22T12:00:00.000Z' }
]
const TICKETS = [
  { condicion_pago: 'CONCESION', id_comprador: GIL, monto_base_ingreso: 1000, total_cobrado_real: 1000, status: 'ACTIVO' }
]

function entrada(finanzas = FINANZAS): EntradaCartera {
  return {
    entidades: [{ id: GIL, nombre: 'Gilberto', rol: 'DST' }],
    inventario: [
      { tipo_movimiento: 'ENTRADA_CONCESION', cantidad: 10, status: 'ACTIVO', id_entidad_origen: null, id_entidad_destino: GIL, fecha_movimiento: '2026-09-01T12:00:00.000Z' }
    ],
    tickets: TICKETS,
    finanzas,
    hoy: '2026-09-24T12:00:00.000Z'
  }
}

test.describe('D112 — la entrega NO baja la deuda de concesion', () => {
  test('construirCartera: abonado 200 (no 600), deuda 800', () => {
    const [fila] = construirCartera(entrada())
    expect(fila.abonado).toBe(200)
    expect(fila.deuda).toBe(800)
  })

  test('CONTROL: la misma fila SIN la marca si baja la concesion (el estado de antes)', () => {
    const sinMarca = FINANZAS.map((f) => ({ ...f, es_entrega_efectivo: undefined }))
    const [fila] = construirCartera(entrada(sinMarca))
    expect(fila.abonado).toBe(600)
    expect(fila.deuda).toBe(400)
  })

  test('saldo de consignacion: la entrega no resta', () => {
    expect(calcularSaldoPendienteInventarioConsignacion({ id: GIL, rol: 'DST' }, TICKETS, [GIL], FINANZAS)).toBe(800)
  })

  test('efectivo por pagar: la entrega SI resta (es su lugar), el abono de concesion tambien (como hoy)', () => {
    // 600 cobrado - 200 - 400 = 0. Si la entrega se excluyera aqui, daria 400.
    expect(calcularSaldoPorPagarEfectivo(GIL, FINANZAS)).toBe(0)
  })
})

// ─── 4. LOS TEXTOS DE /cartera ──────────────────────────────────────────────
test.describe('D112 — /cartera dice el efectivo por entregar con su "desde"', () => {
  const FILAS = [
    { id_entidad: GIL, nombre: 'Gilberto', rol: 'DST', cobrado_de_contado: 600, entregado: 400, entregas_por_aprobar: 0, por_entregar: 200, desde: '2026-09-24' },
    { id_entidad: MARTIN, nombre: 'Martin', rol: 'DST', cobrado_de_contado: 0, entregado: 300, entregas_por_aprobar: 150, por_entregar: -300, desde: '2026-09-24' }
  ]

  test('una linea por DST, ordenadas, con el desde y lo que espera', () => {
    const t = textoEfectivoPorEntregar(FILAS)
    const lineas = t.split('\n')
    expect(lineas[0]).toBe('EFECTIVO POR ENTREGAR (cuenta desde 2026-09-24; lo anterior no se puede separar)')
    expect(lineas[1]).toBe('Gilberto — $200.00 por entregar (cobro $600.00, entrego $400.00)')
    expect(lineas[2]).toBe(
      'Martin — $-300.00 por entregar (cobro $0.00, entrego $300.00) · $150.00 esperando confirmacion · entrego de mas: efectivo de antes de 2026-09-24'
    )
  })

  test('sin filas no hay bloque; y sin vista queda la nota de siempre', () => {
    expect(textoEfectivoPorEntregar([])).toBe('')
    const fila = { id_entidad: GIL, nombre: 'Gilberto', rol: 'DST', deuda: 800 } as unknown as Parameters<typeof textoQuienDebe>[0][number]
    expect(textoQuienDebe([fila], null, null)).toContain(NOTA_EFECTIVO_NO_SEPARABLE)
    const conBloque = textoQuienDebe([fila], null, textoEfectivoPorEntregar(FILAS))
    expect(conBloque).toContain('EFECTIVO POR ENTREGAR')
    expect(conBloque).not.toContain(NOTA_EFECTIVO_NO_SEPARABLE)
  })
})

// ─── 5. EL CABLEADO DE LA WEB ───────────────────────────────────────────────
// Validez: lee el fuente, no ejecuta la accion (lee cookies de Next). Mide que
// la regla se llame, que la marca solo viaje en una entrega y que la entrega
// no reparta a pedidos.
test.describe('D112 — la web: registrarAbonoAction con esEntregaEfectivo', () => {
  const fuente = readFileSync(join(process.cwd(), 'app', 'actions', 'abonos.ts'), 'utf8')
  const cuerpo = fuente.slice(fuente.indexOf('export async function registrarAbonoAction'))
  const antesDelInsert = cuerpo.slice(0, cuerpo.indexOf(".from('finanzas_ledger')"))

  test('la regla corre ANTES del insert y su "no" corta', () => {
    expect(antesDelInsert).toMatch(/const regla = reglaDeEntregaWeb\(/)
    expect(antesDelInsert).toMatch(/if \(!regla\.ok\) return \{ success: false, error: regla\.error \}/)
  })

  test('la marca solo viaja si es entrega; la entrega no reparte a pedidos', () => {
    expect(antesDelInsert).toMatch(/\.\.\.\(esEntrega \? \{ es_entrega_efectivo: true \} : \{\}\)/)
    expect(antesDelInsert.match(/es_entrega_efectivo/g)?.length).toBe(1)
    expect(antesDelInsert).toMatch(/tipoMovimiento === 'ABONO_DEUDA' && !esEntrega && Array\.isArray/)
  })

  test('la pantalla manda el flag y vacia las aplicaciones', () => {
    const pagina = readFileSync(
      join(process.cwd(), 'app', 'dashboard', 'distribuidores', '[id]', 'abono', 'page.tsx'),
      'utf8'
    )
    expect(pagina).toContain('esEntregaEfectivo: entregaActiva')
    expect(pagina).toContain('aplicaciones: entregaActiva ? [] : aplicacionesList')
    expect(pagina).toContain('id="esEntregaEfectivo"')
  })
})
