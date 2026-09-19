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
 *
 * ACTUALIZACION 2026-09-17 (ERP-11). El POS ya no compensa: las cinco
 * escrituras se volvieron una sola llamada a `registrar_venta_atomica`, y
 * dentro de esa funcion las cuatro tablas caen en la MISMA transaccion. Una
 * compensacion que no existe no puede fallar. **`lib/pos-rollback.ts` NO se
 * borro** y las pruebas de este archivo que lo juzgan siguen valiendo: es el
 * juicio correcto para cualquier otro sitio que borre a mano. Lo que se
 * invirtio es el centinela de abajo.
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
 * La otra mitad, invertida por ERP-11.
 *
 * Antes esto exigia que `app/actions/pos.ts` MIRARA el resultado de cada
 * compensacion. Hoy exige que no haya compensacion que mirar: el camino de la
 * venta escribe UNA vez, y esa vez es la funcion de Postgres. Lee el codigo
 * fuente como texto, igual que `tests/arquitectura.spec.ts`.
 *
 * Por que una prueba de texto y no una de comportamiento: lo que se defiende no
 * es un resultado, es una FORMA. Un segundo `.insert()` en el camino de la venta
 * volveria a partir la escritura en dos transacciones y ninguna prueba funcional
 * lo notaria mientras las dos tengan exito. El defecto solo aparece cuando una
 * falla, que es justo el caso que nadie corre.
 *
 * **El problema, con su nombre: atomic write path.**
 */
/**
 * ── POR QUE ESTO MIRA AHORA `lib/venta-servidor.ts` ────────────────────────
 * El invariante es **el camino de la venta escribe UNA vez**, no "pos.ts
 * escribe una vez". El 2026-09-18 el camino se extrajo de la sesion y se mudo
 * entero a `lib/venta-servidor.ts`; el `.rpc('registrar_venta_atomica')` es el
 * mismo, la funcion de Postgres es la misma, y la transaccion sigue siendo una.
 * `app/actions/pos.ts` quedo como envoltura: resuelve la sesion y delega.
 *
 * Y el invariante se volvio mas fuerte: ese mismo camino lo usa ahora el bot de
 * Telegram, asi que una escritura suelta reintroducida partiria en dos la venta
 * de la pantalla **y** la del bot.
 *
 * La mitad que falta la cubre el bloque `LA ENVOLTURA` de mas abajo: apuntar el
 * centinela al archivo nuevo y dejar de mirar el viejo permitiria reintroducir
 * la escritura suelta justo donde ya no hay nadie mirando.
 */
test.describe('ERP-11 · la venta se escribe de una sola vez', () => {
  const RUTA_POS = path.resolve(__dirname, '..', 'lib', 'venta-servidor.ts')
  const fuentePOS = () => readFileSync(RUTA_POS, 'utf8')

  const TABLAS_DE_LA_VENTA = [
    'transacciones_tickets',
    'ticket_detalles',
    'finanzas_ledger',
    'inventario_ledger'
  ]

  test('ninguna de las cuatro tablas se escribe suelta', () => {
    const fuente = fuentePOS()
    const lineas = fuente.split('\n')
    const sueltas: string[] = []

    lineas.forEach((linea, indice) => {
      TABLAS_DE_LA_VENTA.forEach((tabla) => {
        if (linea.includes(`from('${tabla}')`) && /\.(insert|upsert|update|delete)\s*\(/.test(linea)) {
          sueltas.push(`lib/venta-servidor.ts:${indice + 1}: ${linea.trim()}`)
        }
      })
    })

    expect(
      sueltas,
      'Cada escritura suelta a estas tablas abre su propia transaccion en PostgREST. ' +
        'Dos transacciones donde debe haber una es exactamente el defecto que ERP-11 cerro: ' +
        'si la segunda falla, la primera ya quedo committeada y hay que borrarla a mano.'
    ).toEqual([])
  })

  test('y no quedo compensacion viva en el camino de la venta', () => {
    const fuente = fuentePOS()

    // Se juzga el CODIGO, no la prosa: `pos.ts` conserva a proposito un
    // comentario que nombra a `evaluarRollbackPOS` para decir que el modulo NO
    // se borro. Lo que no puede volver es el import ni la closure.
    const sinComentarios = fuente
      .split('\n')
      .filter((linea) => !linea.trim().startsWith('//') && !linea.trim().startsWith('*'))
      .join('\n')

    expect(sinComentarios).not.toContain('rollbackTicket')
    expect(sinComentarios).not.toContain('pos-rollback')
    expect(sinComentarios).not.toContain('componerErrorDeVenta')
  })

  test('CONTROL POSITIVO: la escritura existe, y es una sola', () => {
    const fuente = fuentePOS()

    // Si alguien renombra la funcion o borra la llamada, esto se cae antes de
    // que la prueba de arriba pase por vacia.
    expect((fuente.match(/\.rpc\(\s*'registrar_venta_atomica'/g) ?? []).length).toBe(1)

    // El uuid se genera en el servidor ANTES de escribir: es lo que permite que
    // las notas de inventario y las categorias de finanzas lleven el folio sin
    // haber insertado el encabezado primero.
    expect(fuente).toContain('const idTicket = crypto.randomUUID()')
    expect(fuente).toContain('id: idTicket')
  })

  test('CONTROL NEGATIVO: el detector reconoce una escritura suelta reintroducida', () => {
    const detecta = (linea: string) =>
      TABLAS_DE_LA_VENTA.some(
        (tabla) =>
          linea.includes(`from('${tabla}')`) && /\.(insert|upsert|update|delete)\s*\(/.test(linea)
      )

    expect(detecta("  await supabase.from('ticket_detalles').insert(detalles)")).toBe(true)
    expect(detecta("  const { error } = await supabase.from('finanzas_ledger').insert(x)")).toBe(true)
    // Una LECTURA no es una escritura, y no se debe acusar.
    expect(detecta("  await supabase.from('ticket_detalles').select('id')")).toBe(false)
    // Otra tabla tampoco: el invariante es sobre las cuatro de la venta.
    expect(detecta("  await supabase.from('avisos').insert(aviso)")).toBe(false)
  })

  // ── LA ENVOLTURA: la mitad que falta ───────────────────────────────────
  test('la envoltura del POS delega, y no escribe ninguna de las cuatro tablas', () => {
    const envoltura = readFileSync(
      path.resolve(__dirname, '..', 'app', 'actions', 'pos.ts'),
      'utf8'
    )
    const lineas = envoltura.split('\n')
    const sueltas: string[] = []

    lineas.forEach((linea, indice) => {
      TABLAS_DE_LA_VENTA.forEach((tabla) => {
        if (linea.includes(`from('${tabla}')`) && /\.(insert|upsert|update|delete)\s*\(/.test(linea)) {
          sueltas.push(`app/actions/pos.ts:${indice + 1}: ${linea.trim()}`)
        }
      })
    })

    expect(
      sueltas,
      'La envoltura no escribe en la venta: solo resuelve la sesion y llama a registrarVenta. ' +
        'Una escritura aqui seria una segunda transaccion fuera de la funcion atomica, y ademas ' +
        'una que el bot de Telegram NO ejecuta: dos verdades sobre el mismo dinero.'
    ).toEqual([])

    // Tampoco su propia escritura atomica: la unica vive en el motor.
    expect((envoltura.match(/\.rpc\(\s*'registrar_venta_atomica'/g) ?? []).length).toBe(0)

    // Y si delega. Sin esto, la prueba de arriba miraria un archivo que ya no
    // participa en la venta y pasaria en verde por irrelevante.
    expect(envoltura).toContain('registrarVenta(')
  })
})
