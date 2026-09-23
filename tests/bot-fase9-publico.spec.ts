/**
 * FASE 9 — Bloque A: "publico en general" y el precio dicho. Puras, sin base.
 *
 * - D87: "publico en general" (y sus sinonimos) NO se busca en la red; un
 *   nombre real sigue resolviendo y uno desconocido sigue preguntando.
 * - D89: "en 2900" se cobra como descuento visible; "a 580 cada una" con 5
 *   piezas es $2,900; mayor que la lista se queda como hoy.
 *
 * Mutaciones que ponen esto rojo (corridas, ver `_avance_fase9`):
 *   · vaciar `SINONIMOS_PUBLICO` -> D87 rojo.
 *   · en `leerMontoDicho`, devolver siempre `ninguno` -> D89 rojo.
 */
import { test, expect } from '@playwright/test'
import { esPublicoEnGeneral, leerMontoDicho, NOMBRE_PUBLICO } from '@/lib/bot-publico'
import { buscarPorNombre } from '@/lib/bot-nombres'
import { aplicarDescuento, lineasDeDescuento } from '@/lib/bot-descuento'

const RED = [
  { id: '1', nombre: 'Casa Verde' },
  { id: '2', nombre: 'Aeropuerto' },
  { id: '3', nombre: 'Delirio 85' },
  { id: '4', nombre: 'Venta mayoreo' }
]

test.describe('D87 — publico en general es publico', () => {
  for (const dicho of [
    'publico en general',
    'Público en General',
    'publico',
    'el público',
    'mostrador',
    'cliente de mostrador',
    '  PUBLICO   EN GENERAL. '
  ]) {
    test(`"${dicho}" es publico`, () => {
      expect(esPublicoEnGeneral(dicho)).toBe(true)
    })
  }

  test('CONTROL: un nombre real de la red sigue resolviendo a su entidad', () => {
    expect(esPublicoEnGeneral('Casa Verde')).toBe(false)
    const r = buscarPorNombre('Casa Verde', RED, (c) => [c.nombre])
    expect(r.ok && r.elegido.id).toBe('1')
  })

  test('CONTROL: un nombre desconocido sigue preguntando', () => {
    expect(esPublicoEnGeneral('Juan Perez')).toBe(false)
    const r = buscarPorNombre('Juan Perez', RED, (c) => [c.nombre])
    expect(r.ok).toBe(false)
  })

  test('CONTROL: no empata por subcadena ("Publico Bar" podria ser un negocio)', () => {
    expect(esPublicoEnGeneral('Publico Bar')).toBe(false)
    expect(esPublicoEnGeneral('')).toBe(false)
    expect(esPublicoEnGeneral(null)).toBe(false)
  })

  test('el prospecto de la cotizacion se llama "Publico en general"', () => {
    expect(NOMBRE_PUBLICO).toBe('Publico en general')
  })
})

test.describe('D89 — el precio dicho se cobra, a la vista', () => {
  // 5 grandes de lista: 5 x 599 = 2,995.00
  const LISTA = 2995

  test('"en 2900" (total) -> descuento con total_final 2900: lista 2,995 - 95 = 2,900', () => {
    const l = leerMontoDicho(2900, LISTA, 5, true, false)
    expect(l).toEqual({ tipo: 'descuento', totalFinal: 2900, porPieza: null, aviso: null })
    const d = aplicarDescuento(LISTA, { total_final: 2900 })
    expect(d.ok && [d.subtotal, d.importe, d.total, d.porcentaje]).toEqual([2995, 95, 2900, 3.17])
    expect(lineasDeDescuento(d as never).join('\n')).toContain('-$95.00')
  })

  test('"a 580 cada una" crudo (580 con 5 piezas) -> $580 cada una = $2,900', () => {
    const l = leerMontoDicho(580, LISTA, 5, true, false)
    expect(l.tipo).toBe('descuento')
    if (l.tipo !== 'descuento') return
    expect(l.totalFinal).toBe(2900)
    expect(l.porPieza).toBe(580)
    expect(l.aviso).toBe('Entendi $580.00 cada una = $2,900.00.')
  })

  test('por pieza SOLO con un producto: con dos productos 580 se lee como total (y el tope lo para)', () => {
    const l = leerMontoDicho(580, LISTA, 5, false, false)
    expect(l).toEqual({ tipo: 'descuento', totalFinal: 580, porPieza: null, aviso: null })
    const d = aplicarDescuento(LISTA, { total_final: 580 })
    expect(d.ok).toBe(false)
  })

  test('mayor que la lista -> se queda como hoy (aviso, se escribe la lista)', () => {
    expect(leerMontoDicho(3100, LISTA, 5, true, false)).toEqual({ tipo: 'mayor' })
  })

  test('CONTROL: sin monto dicho -> a lista, sin descuento', () => {
    expect(leerMontoDicho(undefined, LISTA, 5, true, false)).toEqual({ tipo: 'ninguno' })
    expect(leerMontoDicho(null, LISTA, 5, true, false)).toEqual({ tipo: 'ninguno' })
    expect(leerMontoDicho('', LISTA, 5, true, false)).toEqual({ tipo: 'ninguno' })
  })

  test('CONTROL: monto igual a la lista (±$1) -> sin linea de descuento', () => {
    expect(leerMontoDicho(2995, LISTA, 5, true, false)).toEqual({ tipo: 'igual' })
    expect(leerMontoDicho(2994.5, LISTA, 5, true, false)).toEqual({ tipo: 'igual' })
    // 599 x 5 dicho por pieza tambien es la lista.
    expect(leerMontoDicho(599, LISTA, 5, true, false)).toEqual({ tipo: 'igual' })
  })

  test('CONTROL: con descuento explicito manda el descuento, no el monto', () => {
    expect(leerMontoDicho(2900, LISTA, 5, true, true)).toEqual({ tipo: 'ninguno' })
  })

  test('un total bajo el tope (mas de 30%) no se reinterpreta: el 422 lo dice', () => {
    const l = leerMontoDicho(1500, LISTA, 1, true, false)
    expect(l.tipo === 'descuento' && l.totalFinal).toBe(1500)
    const d = aplicarDescuento(LISTA, { total_final: 1500 })
    expect(d.ok).toBe(false)
  })
})

// D90: el ticket (imagen) de la cotizacion de Norman, sobre el mismo armado
// puro que pinta la imagen (`datosDeCotizacion`). Cifras calculadas A MANO
// antes de correr: 30 x 599 = 17,970.00; 15% = 2,695.50; 17,970 - 2,695.50 =
// 15,274.50.
import { datosDeCotizacion, LISTA_PUBLICO } from '@/lib/documento'
import { notaDeDescuento } from '@/lib/bot-descuento'

test('D90: la cotizacion a publico con 15% -> renglon de descuento al final y rotulo publico', () => {
  const d = aplicarDescuento(17970, { porcentaje: 15 })
  expect(d.ok && [d.subtotal, d.importe, d.total]).toEqual([17970, 2695.5, 15274.5])
  const doc = datosDeCotizacion(
    {
      folio: 'COT-0099', fecha: '2026-09-23', vigente_hasta: '2026-10-08', estado_efectivo: 'VIGENTE',
      para_quien: NOMBRE_PUBLICO, total: 15274.5, notas: notaDeDescuento(d as never)
    },
    'CEO Admin',
    [{ id: 'a', nombre: 'Destilado Plata 750ml', cantidad: 30, precioUnitario: 599 }],
    null
  )
  expect(doc.listaDePrecio).toBe(LISTA_PUBLICO)
  expect(doc.descuento).toEqual({ subtotal: 17970, etiqueta: 'Descuento (15%)', importe: 2695.5 })
  expect(doc.total).toBe(15274.5)
  expect(doc.comprador).toBe('Publico en general')
})
