/**
 * FASE 9 — D92: envasar sin empaque registrado BLOQUEA y PREGUNTA; la
 * respuesta se vuelve una entrada de inventario con VA. Puras, sin base.
 *
 * Mutaciones que ponen esto rojo (corridas, ver `_avance_fase9`):
 *   · `faltantesDelEnvasado` -> siempre `[]` (la guarda de la propuesta).
 *   · `stockDesdeLedger` sin el filtro de entidad (cuenta el stock de otro).
 *   · `leerEntradasDichas` con modo `hay` tratado como `llego`.
 * La guarda de la BASE (`registrar_en_lote`) tiene su propia prueba y su
 * mutacion: `supabase/pruebas/fase9_d92_envasado_sin_negativo.sql`.
 */
import { test, expect } from '@playwright/test'
import {
  faltantesDelEnvasado,
  mensajeFaltaEmpaque,
  movimientosDeEnvasado,
  stockDesdeLedger,
  type FilaLedgerStock
} from '@/lib/bot-envasado'
import {
  leerEntradasDichas,
  mensajeDeEntrada,
  payloadDeEntrada,
  sellarEntrada,
  selloEntradaCoincide,
  type CandidatoEntrada
} from '@/lib/bot-entrada-insumo'

const ADMIN = 'admin'
const OTRO = 'dst'
const RECETA_750 = [
  { id_insumo: 'botella750', cantidad_requerida: 1 },
  { id_insumo: 'corcho', cantidad_requerida: 1 },
  { id_insumo: 'etiqueta750', cantidad_requerida: 1 },
  { id_insumo: 'lamina', cantidad_requerida: 1 },
  { id_insumo: 'led', cantidad_requerida: 1 }
]
const NOMBRES = new Map([
  ['botella750', 'Botella 750ml Vacía'],
  ['corcho', 'Corcho'],
  ['etiqueta750', 'Etiqueta 750'],
  ['lamina', 'Lámina de Plata'],
  ['led', 'Luz LED']
])

function fila(id: string, tipo: string, cantidad: number, destino: string | null, origen: string | null, status = 'ACTIVO'): FilaLedgerStock {
  return { id_producto: id, tipo_movimiento: tipo, cantidad, id_entidad_destino: destino, id_entidad_origen: origen, status }
}

// El ledger de la matriz como esta HOY (medido 2026-09-23): 456 botellas y
// corchos entraron, 450 salieron por envasados; 1000 etiquetas, 450 salieron.
const LEDGER_HOY: FilaLedgerStock[] = [
  fila('botella750', 'ENTRADA_COMPRA', 456, ADMIN, null),
  fila('botella750', 'TRASPASO', 450, null, ADMIN),
  fila('corcho', 'ENTRADA_COMPRA', 456, ADMIN, null),
  fila('corcho', 'TRASPASO', 450, null, ADMIN),
  fila('etiqueta750', 'ENTRADA_COMPRA', 1000, ADMIN, null),
  fila('etiqueta750', 'TRASPASO', 450, null, ADMIN),
  fila('lamina', 'ENTRADA_COMPRA', 100, ADMIN, null),
  fila('lamina', 'TRASPASO', 100, null, ADMIN),
  fila('led', 'ENTRADA_COMPRA', 50, ADMIN, null),
  fila('led', 'TRASPASO', 50, null, ADMIN)
]

test.describe('D92 — el stock del empaque sale del ledger', () => {
  test('la matriz de hoy: 6 botellas, 6 corchos, 550 etiquetas, 0 lamina, 0 LED', () => {
    const s = stockDesdeLedger(LEDGER_HOY, ADMIN)
    expect([s.get('botella750'), s.get('corcho'), s.get('etiqueta750'), s.get('lamina'), s.get('led')])
      .toEqual([6, 6, 550, 0, 0])
  })

  test('CONTROL: lo de OTRA entidad no cuenta, ni lo ANULADO', () => {
    const s = stockDesdeLedger(
      [...LEDGER_HOY,
        fila('lamina', 'ENTRADA_COMPRA', 999, OTRO, null),
        fila('led', 'ENTRADA_COMPRA', 999, ADMIN, null, 'ANULADO')],
      ADMIN
    )
    expect([s.get('lamina'), s.get('led')]).toEqual([0, 0])
  })
})

test.describe('D92 — sin empaque se bloquea, con la lista', () => {
  const movs = movimientosDeEnvasado('p750', 24, RECETA_750)

  test('24 de 750 con el stock de hoy: faltan botella 18, corcho 18, lamina 24, LED 24 (etiqueta alcanza)', () => {
    const f = faltantesDelEnvasado(movs, stockDesdeLedger(LEDGER_HOY, ADMIN), NOMBRES)
    expect(f.map((x) => [x.nombre, x.ocupa, x.hay, x.falta])).toEqual([
      ['Botella 750ml Vacía', 24, 6, 18],
      ['Corcho', 24, 6, 18],
      ['Lámina de Plata', 24, 0, 24],
      ['Luz LED', 24, 0, 24]
    ])
  })

  test('el mensaje dice que falta, cuanto, y PREGUNTA que paso', () => {
    const f = faltantesDelEnvasado(movs, stockDesdeLedger(LEDGER_HOY, ADMIN), NOMBRES)
    const m = mensajeFaltaEmpaque([{ nombre: 'Destilado Plata 750ml', botellas: 24 }], f)
    expect(m).toContain('Para envasar 24 de Destilado Plata 750ml')
    expect(m).toContain('Botella 750ml Vacía: ocupo 24, tengo 6 -> faltan 18')
    expect(m).toContain('Que paso: llego una compra, o ya lo tenias y no esta capturado?')
    expect(m).not.toContain('Etiqueta 750')
  })

  test('CONTROL: con empaque suficiente, nada falta (no se bloquea)', () => {
    const lleno = [...LEDGER_HOY, ...['botella750', 'corcho', 'lamina', 'led'].map((id) => fila(id, 'ENTRADA_COMPRA', 24, ADMIN, null))]
    expect(faltantesDelEnvasado(movs, stockDesdeLedger(lleno, ADMIN), NOMBRES)).toEqual([])
  })

  test('CONTROL: 0 botellas no pide empaque', () => {
    expect(faltantesDelEnvasado(movimientosDeEnvasado('p750', 0, RECETA_750), new Map(), NOMBRES)).toEqual([])
  })

  test('dos formatos que comparten lamina SUMAN lo que piden', () => {
    const dos = [
      ...movimientosDeEnvasado('p750', 10, [{ id_insumo: 'lamina', cantidad_requerida: 1 }]),
      ...movimientosDeEnvasado('p250', 30, [{ id_insumo: 'lamina', cantidad_requerida: 0.3333 }])
    ]
    const f = faltantesDelEnvasado(dos, new Map([['lamina', 15]]), NOMBRES)
    expect(f.map((x) => [x.ocupa, x.falta])).toEqual([[19.999, 4.999]])
  })
})

test.describe('D92 — la respuesta se vuelve una entrada de inventario', () => {
  const CANDIDATOS: CandidatoEntrada[] = [
    { id: 'botella750', nombre: 'Botella 750ml Vacía', hay: 6, falta: 18 },
    { id: 'corcho', nombre: 'Corcho', hay: 6, falta: 18 },
    { id: 'etiqueta750', nombre: 'Etiqueta 750', hay: 550, falta: 0 },
    { id: 'lamina', nombre: 'Lámina de Plata', hay: 0, falta: 24 },
    { id: 'led', nombre: 'Luz LED', hay: 0, falta: 24 }
  ]

  test('"llegaron 500 botellas de 750" -> entran 500 botellas 750', () => {
    const l = leerEntradasDichas('llegaron 500 botellas de 750', CANDIDATOS)
    expect(l.ok && l.renglones.map((r) => [r.id_insumo, r.cantidad, r.modo])).toEqual([['botella750', 500, 'llego']])
  })

  test('"tengo 300 corchos" es un CONTEO: entran 300 - 6 = 294', () => {
    const l = leerEntradasDichas('tengo 300 corchos', CANDIDATOS)
    expect(l.ok && l.renglones.map((r) => [r.id_insumo, r.cantidad, r.dicho, r.modo])).toEqual([['corcho', 294, 300, 'hay']])
  })

  test('varios en un mensaje, con miles y plurales raros: "llegaron 1,000 laminas, 24 luces y 24 leds"', () => {
    const l = leerEntradasDichas('llegaron 1,000 laminas, 24 luces y 24 leds', CANDIDATOS)
    expect(l.ok && l.renglones.map((r) => [r.id_insumo, r.cantidad])).toEqual([['lamina', 1000], ['led', 48]])
  })

  test('lo que todavia falta se AVISA ("llegaron 10 corchos" deja 8 sin cubrir)', () => {
    const l = leerEntradasDichas('llegaron 10 corchos', CANDIDATOS)
    expect(l.ok && l.avisos).toContain('Con esto todavia me faltarian 8 de Corcho para el envasado.')
  })

  test('conteo por debajo de lo registrado -> no entra nada, y se dice', () => {
    const l = leerEntradasDichas('tengo 3 corchos', CANDIDATOS)
    expect(l.ok).toBe(false)
    expect(!l.ok && l.error).toContain('ya tengo 6 registradas; no entra nada')
  })

  test('CONTROL: algo que no es de este envasado no se inventa', () => {
    const l = leerEntradasDichas('llegaron 50 bolsas de pasta', CANDIDATOS)
    expect(l.ok).toBe(false)
    expect(!l.ok && l.error).toContain('No se a cual insumo va')
  })

  test('CONTROL: dos insumos posibles -> PREGUNTA, no escoge', () => {
    const dosBotellas: CandidatoEntrada[] = [
      ...CANDIDATOS,
      { id: 'botella250', nombre: 'Botella 250ml Vacía', hay: 0, falta: 10 }
    ]
    const l = leerEntradasDichas('llegaron 500 botellas', dosBotellas)
    expect(!l.ok && l.error).toContain('me da mas de uno')
    const conMedida = leerEntradasDichas('llegaron 500 botellas de 250', dosBotellas)
    expect(conMedida.ok && conMedida.renglones[0].id_insumo).toBe('botella250')
  })

  test('CONTROL: sin numero no hay entrada', () => {
    expect(leerEntradasDichas('ya llegaron las botellas', CANDIDATOS).ok).toBe(false)
    expect(leerEntradasDichas('', CANDIDATOS).ok).toBe(false)
  })

  test('el borrador: sellado, con su nota, y el mensaje dice que no mueve dinero', () => {
    const l = leerEntradasDichas('llegaron 500 botellas de 750', CANDIDATOS)
    if (!l.ok) throw new Error(l.error)
    const p = payloadDeEntrada(l.renglones, ADMIN, 'telegram:Norman')
    expect(p.renglones).toEqual([{ id_insumo: 'botella750', cantidad: 500, nota: 'Entrada dictada al bot: llegaron 500' }])
    const sello = sellarEntrada(p)
    expect(selloEntradaCoincide(p, sello)).toBe(true)
    expect(selloEntradaCoincide({ ...p, renglones: [{ ...p.renglones[0], cantidad: 5000 }] }, sello)).toBe(false)
    const m = mensajeDeEntrada(l.renglones, l.avisos)
    expect(m).toContain('+500 Botella 750ml Vacía   (llegaron; tenia 6 -> 506)')
    expect(m).toContain('no registra dinero')
  })
})
