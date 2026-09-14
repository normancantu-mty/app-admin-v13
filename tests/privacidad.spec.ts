import { test, expect } from '@playwright/test'
import { enmascararTexto, tieneCifra } from '../lib/privacidad'

/**
 * El modo privado tapa dinero y NADA MAS. Los controles negativos de abajo son
 * la mitad que importa: una expresion regular sin un caso que NO deba casar es
 * una que nadie ha probado. Si esto solo probara que `$100` se tapa, pasaria
 * igual con una regla que tapara la pantalla entera.
 */

test.describe('modo privado: que se tapa', () => {
  const debenTaparse: [string, string][] = [
    ['$12,480.00', '$••,•••.••'],
    ['$1234', '$••••'],
    ['$ 350.50', '$ •••.••'],
    ['-$1,200.00', '-$•,•••.••'],
    ['Total: $460,000', 'Total: $•••,•••'],
    ['Gasto de $1,000 en Insumos', 'Gasto de $•,••• en Insumos'],
    // El dinero incrustado en una frase del servidor (lib/feed-utils.ts:255).
    [
      'Delirio abono $11,484.00 el martes',
      'Delirio abono $••,•••.•• el martes',
    ],
    // Sin simbolo, pero con la palabra detras.
    ['11,484 pesos', '••,••• pesos'],
    ['2400 MXN', '•••• MXN'],
  ]

  for (const [entrada, esperado] of debenTaparse) {
    test(`tapa ${JSON.stringify(entrada)}`, () => {
      expect(enmascararTexto(entrada)).toBe(esperado)
    })
  }
})

test.describe('modo privado: CONTROLES NEGATIVOS — lo que NO se debe tocar', () => {
  /**
   * Cada uno de estos aparece en el ERP y taparlo dejaria la pantalla
   * ilegible sin proteger absolutamente nada.
   */
  const debenQuedarIntactos = [
    '2026-09-14', // fechas del ledger
    '14/09/2026',
    'ERP-21', // ids del backlog
    'ERP-73',
    '29%', // la tasa de anulacion del tablero
    '15 de 17 SKU', // conteos
    '602 botellas en 6 locales',
    'Ticket #1042', // folios
    'RFC: ABC010203XYZ',
    'Cuenta personal', // nombres
    'IVA_ONLY',
    '3 pedidos cubiertos',
    'v1.2.3',
    'Telefono 477 123 4567',
  ]

  for (const entrada of debenQuedarIntactos) {
    test(`NO toca ${JSON.stringify(entrada)}`, () => {
      expect(enmascararTexto(entrada)).toBe(entrada)
    })
  }
})

test.describe('modo privado: tieneCifra es el filtro barato', () => {
  test('dice que si cuando hay dinero', () => {
    expect(tieneCifra('Total $1,200.00')).toBe(true)
    expect(tieneCifra('1,200 pesos')).toBe(true)
  })

  test('dice que no cuando no lo hay', () => {
    expect(tieneCifra('Distribuidores')).toBe(false)
    expect(tieneCifra('2026-09-14')).toBe(false)
    expect(tieneCifra('ERP-21')).toBe(false)
  })

  test('NUNCA dice que no sobre algo que enmascararTexto si cambiaria', () => {
    // El invariante real: `tieneCifra` existe solo para saltarse nodos, asi
    // que un falso negativo suyo deja una cifra a la vista. Esa es la unica
    // forma en que este filtro puede hacer daño, y aqui se prueba.
    const muestras = [
      '$12,480.00',
      'Gasto de $1,000 en Insumos',
      '11,484 pesos',
      '2400 MXN',
      '-$1,200.00',
      '2026-09-14',
      'ERP-21',
      'Distribuidores',
      '29%',
    ]
    for (const m of muestras) {
      if (enmascararTexto(m) !== m) {
        expect(tieneCifra(m), `tieneCifra fallo en ${JSON.stringify(m)}`).toBe(true)
      }
    }
  })
})
