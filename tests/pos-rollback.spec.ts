import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  componerErrorDeVenta,
  evaluarRollbackPOS,
  folioCorto,
  type BorradoDeRollback
} from '../lib/pos-rollback'

/**
 * ERP-66 — LA COMPENSACION DEL POS, Y POR QUE FALLABA CALLADA.
 *
 * `registrarVenta` escribe en cuatro tablas sin transaccion. Si un insert
 * intermedio falla, borra lo ya escrito. Hasta hoy ese borrado era
 * `await supabase.from(...).delete().eq(...)` y su resultado se tiraba: con
 * DELETE restringido a ADMIN, la venta fallida de un vendedor no-ADMIN tenia los
 * tres borrados denegados y el usuario leia solo "Error al guardar detalles",
 * mientras el ledger conservaba una venta que nunca ocurrio.
 *
 * Y el detalle que decide el diseno: **RLS no devuelve error en un DELETE
 * denegado** — filtra las filas y responde con cero. Mirar solo `error` no habria
 * cazado el caso. Por eso el encabezado se borra con `.select('id')` y aqui se
 * exige que haya devuelto su fila.
 *
 * Puras: sin navegador, sin base, sin sesion.
 *
 * **El problema, con su nombre: compensating transaction failure.**
 */

const TICKET = 'a1b2c3d4-0000-4000-8000-000000000001'

const limpio = (): BorradoDeRollback[] => [
  { nombreTabla: 'finanzas_ledger', error: null, filasBorradas: null, exigeFilas: false },
  { nombreTabla: 'ticket_detalles', error: null, filasBorradas: null, exigeFilas: false },
  { nombreTabla: 'transacciones_tickets', error: null, filasBorradas: 1, exigeFilas: true }
]

test.describe('ERP-66 · el rollback se mira, no se supone', () => {
  test('cuando los tres borrados limpian, no hay ruido', () => {
    const resultado = evaluarRollbackPOS(TICKET, limpio())

    expect(resultado.ok).toBe(true)
    expect(resultado.restos).toEqual([])
    expect(resultado.aviso).toBeNull()
  })

  test('ESTE ES EL CASO DEL TICKET: RLS deniega y devuelve CERO filas, sin error', () => {
    // El vendedor no es ADMIN, la politica de DELETE lo bloquea, PostgREST
    // responde 200 con cero filas. `error` es null: si solo se mirara `error`,
    // esto seguiria pasando por rollback exitoso.
    const borrados = limpio()
    borrados[2] = { nombreTabla: 'transacciones_tickets', error: null, filasBorradas: 0, exigeFilas: true }

    const resultado = evaluarRollbackPOS(TICKET, borrados)

    expect(resultado.ok).toBe(false)
    expect(resultado.restos).toEqual([
      'transacciones_tickets: el borrado no afecto ninguna fila (permiso denegado)'
    ])
    expect(resultado.aviso).toContain('A1B2C3D4')
    expect(resultado.aviso).toContain('NO repitas la venta')
  })

  test('un error explicito de PostgREST tambien cuenta, y dice cual tabla', () => {
    const borrados = limpio()
    borrados[0] = {
      nombreTabla: 'finanzas_ledger',
      error: { message: 'permission denied for table finanzas_ledger' },
      filasBorradas: null,
      exigeFilas: false
    }

    const resultado = evaluarRollbackPOS(TICKET, borrados)

    expect(resultado.ok).toBe(false)
    expect(resultado.restos).toEqual([
      'finanzas_ledger: permission denied for table finanzas_ledger'
    ])
  })

  test('los tres fallando se reportan los tres, no el primero', () => {
    const resultado = evaluarRollbackPOS(TICKET, [
      { nombreTabla: 'finanzas_ledger', error: { message: 'denied' }, filasBorradas: null, exigeFilas: false },
      { nombreTabla: 'ticket_detalles', error: { message: 'denied' }, filasBorradas: null, exigeFilas: false },
      { nombreTabla: 'transacciones_tickets', error: null, filasBorradas: 0, exigeFilas: true }
    ])

    expect(resultado.restos).toHaveLength(3)
  })

  test('cero filas NO es fallo donde no se exige: puede no haber nada que borrar', () => {
    // El rollback que corre antes de insertar finanzas encuentra esa tabla
    // vacia para ese ticket. Cero filas ahi es lo correcto, no un resto.
    const borrados = limpio()
    borrados[0] = { nombreTabla: 'finanzas_ledger', error: null, filasBorradas: 0, exigeFilas: false }

    expect(evaluarRollbackPOS(TICKET, borrados).ok).toBe(true)
  })

  test('el folio corto es el mismo que ya usan las categorias del ledger', () => {
    expect(folioCorto(TICKET)).toBe('A1B2C3D4')
  })
})

test.describe('ERP-66 · lo que ve el vendedor', () => {
  test('si el rollback limpio, el mensaje es EXACTAMENTE el de antes', () => {
    const rollback = evaluarRollbackPOS(TICKET, limpio())
    expect(componerErrorDeVenta('Error al guardar detalles: x', rollback)).toBe(
      'Error al guardar detalles: x'
    )
  })

  test('si quedaron restos, el mensaje lo dice y trae el folio', () => {
    const borrados = limpio()
    borrados[2] = { nombreTabla: 'transacciones_tickets', error: null, filasBorradas: 0, exigeFilas: true }
    const rollback = evaluarRollbackPOS(TICKET, borrados)

    const mensaje = componerErrorDeVenta('Error al guardar detalles: x', rollback)

    expect(mensaje).toContain('Error al guardar detalles: x')
    expect(mensaje).toContain('A1B2C3D4')
    expect(mensaje.length).toBeGreaterThan('Error al guardar detalles: x'.length)
  })
})

/**
 * La otra mitad: que `app/actions/pos.ts` siga MIRANDO el resultado.
 *
 * Las pruebas de arriba solo juzgan al juez. No pueden ver que alguien vuelva a
 * escribir `await rollbackTicket(...)` tirando lo que devuelve — que es
 * literalmente el defecto que trae ERP-66. Esto lee el codigo fuente, como
 * `tests/arquitectura.spec.ts`.
 */
test.describe('ERP-66 · ninguna llamada tira el resultado del rollback', () => {
  const RUTA_POS = path.resolve(__dirname, '..', 'app', 'actions', 'pos.ts')

  test('todo `rollbackTicket(...)` que se llama, se lee', () => {
    const fuente = readFileSync(RUTA_POS, 'utf8')
    const lineas = fuente.split('\n')
    const descartadas: string[] = []

    lineas.forEach((linea, indice) => {
      // `await rollbackTicket(` sin nada a la izquierda que reciba el valor.
      if (/^\s*await\s+rollbackTicket\s*\(/.test(linea)) {
        descartadas.push(`app/actions/pos.ts:${indice + 1}: ${linea.trim()}`)
      }
    })

    expect(
      descartadas,
      'Una llamada a rollbackTicket que descarta su resultado es el defecto de ERP-66: ' +
        'la compensacion falla, nadie se entera y el ticket queda vivo en el ledger.'
    ).toEqual([])
  })

  test('CONTROL POSITIVO: y de verdad se llama, no es que el archivo cambio de nombre', () => {
    const fuente = readFileSync(RUTA_POS, 'utf8')

    expect(fuente).toContain('const rollbackTicket = async')
    expect((fuente.match(/await rollbackTicket\(ticketData\.id\)/g) ?? []).length).toBe(5)
    expect(fuente).toContain('componerErrorDeVenta')
  })

  test('CONTROL NEGATIVO: el detector reconoce una llamada descartada', () => {
    const patron = /^\s*await\s+rollbackTicket\s*\(/
    expect(patron.test('      await rollbackTicket(ticketData.id)')).toBe(true)
    expect(patron.test('      const rollback = await rollbackTicket(ticketData.id)')).toBe(false)
  })
})
