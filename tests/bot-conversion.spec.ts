/**
 * AG-06 FASE 5 · PASO 6 — CONVERTIR UNA COTIZACION EN VENTA.
 *
 * ─── LO QUE ESTAS PRUEBAS VIGILAN ───────────────────────────────────────────
 *
 *  1. **Los siete dias** (D15). Que sean SIETE y no quince, que los dos numeros
 *     sigan siendo distintos, y que se cuenten en calendario de Mexico y no
 *     restando instantes — con su control negativo, que es la unica forma de
 *     demostrar que la resta ingenua da OTRA respuesta en el borde.
 *
 *  2. **El precio de hoy se ensena SIEMPRE**, aunque sea identico al cotizado.
 *     El control negativo prueba que "igual" sale escrito, porque una columna
 *     que solo aparece cuando cambia convierte su ausencia en informacion.
 *
 *  3. **Que no se pueda cobrar dos veces** la misma cotizacion.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  comoSeMovio,
  conversionCanonica,
  diasDeCalendario,
  DIAS_PARA_CONVERTIR,
  diferenciaContraHoy,
  juzgarConversion,
  LLAVES_CONVERSION,
  mensajeDeConversion,
  mensajeDeConversionHecha,
  sellarConversion,
  selloConversionCoincide,
  type CotizacionParaConvertir,
  type LineaConvertida,
  type PayloadConversion
} from '@/lib/bot-conversion'
import { VIGENCIA_POR_DEFECTO } from '@/lib/bot-cotizacion'
import type { PayloadVenta } from '@/lib/bot-venta'

const raiz = process.cwd()
const leer = (p: string) => readFileSync(join(raiz, p), 'utf8')

/** Mediodia de Zacatecas del dia dado, para que ningun caso quede en el borde
 * del huso por accidente salvo cuando la prueba lo busque. */
function mediodiaMX(fecha: string): Date {
  return new Date(`${fecha}T18:00:00.000Z`)
}

function cotizacion(sobre: Partial<CotizacionParaConvertir> = {}): CotizacionParaConvertir {
  return {
    id: 'c1',
    folio: 'COT-0007',
    fecha: '2026-09-15',
    estado: 'VIGENTE',
    zona: 'Zacatecas',
    total: 1200,
    id_comprador: 'e-comprador',
    nombre_prospecto: null,
    vigente_hasta: '2026-09-30',
    ...sobre
  }
}

// ============================================================================
// 1. LOS SIETE DIAS (D15)
// ============================================================================

test.describe('Paso 6 · los siete dias no son los quince de la vigencia', () => {
  test('son siete', () => {
    expect(DIAS_PARA_CONVERTIR).toBe(7)
  })

  test('y son DISTINTOS de la vigencia, a proposito', () => {
    // Miden dos cosas: la vigencia es lo que se le PROMETE AL CLIENTE; los 7
    // dias son hasta cuando se cierra a ciegas por chat con precios
    // congelados. El dia que alguien los iguale, esta prueba lo obliga a leer
    // por que eran dos.
    expect(DIAS_PARA_CONVERTIR).not.toBe(VIGENCIA_POR_DEFECTO)
    expect(VIGENCIA_POR_DEFECTO).toBe(15)
  })

  test('el dia 7 exacto todavia se convierte', () => {
    const j = juzgarConversion(cotizacion({ fecha: '2026-09-12' }), 2, mediodiaMX('2026-09-19'))
    expect(j.ok).toBe(true)
    if (j.ok) expect(j.diasDesdeLaCotizacion).toBe(7)
  })

  test('CONTROL NEGATIVO: el dia 8 ya no', () => {
    const j = juzgarConversion(cotizacion({ fecha: '2026-09-11' }), 2, mediodiaMX('2026-09-19'))
    expect(j.ok).toBe(false)
    if (!j.ok) {
      expect(j.motivo).toBe('fuera-de-los-siete-dias')
      // Y no se deja a la persona en un callejon: se ofrece recotizar.
      expect(j.ofrecerRecotizar).toBe(true)
    }
  })

  test('sigue vigente para el cliente aunque ya no se cierre por chat, y se dice', () => {
    // Dia 10, vigencia de 15: la promesa de precio sigue en pie. Decirle solo
    // "no se puede" seria mentirle sobre su propia cotizacion.
    const j = juzgarConversion(
      cotizacion({ fecha: '2026-09-09', vigente_hasta: '2026-09-24' }),
      2,
      mediodiaMX('2026-09-19')
    )
    expect(j.ok).toBe(false)
    if (!j.ok) {
      expect(j.mensaje).toContain('sigue vigente')
      // D70: la fecha va como la lee una persona; la ISO ya no debe salir.
      expect(j.mensaje).toContain('24/09/2026')
      expect(j.mensaje).not.toContain('2026-09-24')
    }
  })

  test('una cotizacion fechada en el futuro no se convierte', () => {
    const j = juzgarConversion(cotizacion({ fecha: '2026-09-25' }), 2, mediodiaMX('2026-09-19'))
    expect(j.ok).toBe(false)
    if (!j.ok) expect(j.ofrecerRecotizar).toBe(false)
  })
})

test.describe('Paso 6 · los dias se cuentan en calendario, no restando instantes', () => {
  test('dias de calendario, incluido un cambio de mes', () => {
    expect(diasDeCalendario('2026-09-15', '2026-09-19')).toBe(4)
    expect(diasDeCalendario('2026-08-30', '2026-09-02')).toBe(3)
    expect(diasDeCalendario('2026-09-19', '2026-09-19')).toBe(0)
  })

  test('CONTROL NEGATIVO: la resta ingenua de milisegundos da OTRA respuesta', () => {
    // Asi se escribe el defecto que este modulo evita: `(hoy - fecha) / 86400000`
    // con la hora de la maquina dentro. A las 19:00 UTC del 19 —que es la 1 de
    // la tarde en Zacatecas— una cotizacion del 12 lleva 7 dias de calendario,
    // pero la resta da 7.79 y un `Math.ceil` la mandaria al dia 8: fuera de
    // plazo por una hora del dia, no por un dia.
    const cotizada = Date.parse('2026-09-12T00:00:00Z')
    const ahora = Date.parse('2026-09-19T19:00:00Z')
    const ingenuo = (ahora - cotizada) / 86400000
    expect(Math.ceil(ingenuo)).toBe(8)
    expect(diasDeCalendario('2026-09-12', '2026-09-19')).toBe(7)
    expect(Math.ceil(ingenuo)).not.toBe(diasDeCalendario('2026-09-12', '2026-09-19'))
  })

  test('el "hoy" sale de hoyEnMX, no de toISOString', () => {
    // A las 18:01 de Zacatecas el UTC ya dice manana: una cotizacion capturada
    // de noche naceria con un dia de edad.
    const fuente = leer('lib/bot-conversion.ts')
    expect(fuente).toContain("from '@/lib/date-format'")
    expect(fuente).toContain('hoyEnMX(ahora)')
    expect(fuente).not.toContain('new Date().toISOString().slice(0, 10)')
  })
})

// ============================================================================
// 2. LOS OTROS RECHAZOS
// ============================================================================

test.describe('Paso 6 · lo que no se convierte', () => {
  test('una cotizacion ya convertida no se cobra dos veces', () => {
    const j = juzgarConversion(cotizacion({ estado: 'CONVERTIDA' }), 2, mediodiaMX('2026-09-19'))
    expect(j.ok).toBe(false)
    if (!j.ok) expect(j.motivo).toBe('ya-convertida')
  })

  test('sin renglones no hay que vender', () => {
    const j = juzgarConversion(cotizacion(), 0, mediodiaMX('2026-09-19'))
    expect(j.ok).toBe(false)
    if (!j.ok) expect(j.motivo).toBe('sin-renglones')
  })

  test('a un prospecto suelto no se le puede cobrar, y se dice como arreglarlo', () => {
    // Una venta se asienta contra una entidad y su cuenta; un nombre en texto
    // no tiene donde recibir el dinero. Desde el Paso 5 darlo de alta se hace
    // en el mismo chat, asi que el mensaje lo dice.
    const j = juzgarConversion(
      cotizacion({ id_comprador: null, nombre_prospecto: 'Don Chuy' }),
      2,
      mediodiaMX('2026-09-19')
    )
    expect(j.ok).toBe(false)
    if (!j.ok) {
      expect(j.motivo).toBe('sin-comprador')
      expect(j.mensaje).toContain('Don Chuy')
      expect(j.mensaje).toContain('Dalo de alta')
    }
  })

  test('el orden de los rechazos: ya-convertida gana sobre el plazo', () => {
    // Una convertida de hace un mes tiene que decir "ya se convirtio", no
    // "pasaron 30 dias": el segundo mensaje sugiere que se podria si fuera mas
    // reciente, y eso es falso.
    const j = juzgarConversion(
      cotizacion({ estado: 'CONVERTIDA', fecha: '2026-08-01' }),
      2,
      mediodiaMX('2026-09-19')
    )
    expect(j.ok).toBe(false)
    if (!j.ok) expect(j.motivo).toBe('ya-convertida')
  })
})

// ============================================================================
// 3. EL PRECIO DE HOY, AL LADO, SIEMPRE
// ============================================================================

function linea(sobre: Partial<LineaConvertida> = {}): LineaConvertida {
  return {
    id_producto: 'p1',
    nombre: 'Destilado Plata 750',
    cantidad: 2,
    precio_cotizado: 600,
    precio_hoy: 600,
    subtotal: 1200,
    ...sobre
  }
}

test.describe('Paso 6 · el precio de hoy se ensena aunque sea el mismo', () => {
  test('CONTROL NEGATIVO: cuando NO cambio, el mensaje dice "igual" y lo ensena', () => {
    // Es la prueba central de esta seccion. Si la columna solo saliera cuando
    // hay diferencia, no verla significaria "no se movio" — y ese mismo silencio
    // seria el sintoma de que la comparacion se rompio.
    const m = mensajeDeConversion(cotizacion(), [linea()], venta(1200), contexto())
    expect(m).toContain('hoy $600.00')
    expect(m).toContain('igual')
  })

  test('cuando subio, se dice, y se respeta lo cotizado', () => {
    const lineas = [linea({ precio_hoy: 700 })]
    expect(comoSeMovio(lineas[0])).toBe('subio')
    const m = mensajeDeConversion(cotizacion(), lineas, venta(1200), contexto())
    expect(m).toContain('subio')
    // 2 piezas x $100 de diferencia.
    expect(diferenciaContraHoy(lineas)).toBe(200)
    expect(m).toContain('respeto lo cotizado')
  })

  test('cuando bajo, tambien se dice: el cliente paga de mas por la promesa', () => {
    const lineas = [linea({ precio_hoy: 500 })]
    expect(comoSeMovio(lineas[0])).toBe('bajo')
    expect(diferenciaContraHoy(lineas)).toBe(-200)
    const m = mensajeDeConversion(cotizacion(), lineas, venta(1200), contexto())
    expect(m).toContain('mas caro al cliente')
  })

  test('un producto sin precio de lista hoy se dice, no se calla como "igual"', () => {
    const l = linea({ precio_hoy: null })
    expect(comoSeMovio(l)).toBe('desconocido')
    const m = mensajeDeConversion(cotizacion(), [l], venta(1200), contexto())
    expect(m).toContain('no hay precio de lista')
    // Y no ensucia la diferencia con un cero falso.
    expect(diferenciaContraHoy([l])).toBe(0)
  })

  test('el que se COBRA es el cotizado, no el de hoy', () => {
    // Una cotizacion es una promesa de precio. Recalcularla al convertir seria
    // no haberla hecho.
    const fuente = leer('app/api/bot/convertir/proponer/route.ts')
    expect(fuente).toContain('precio_unitario: precio')
    expect(fuente).toContain('precio_cotizado: precio')
    expect(fuente).toContain('precio_hoy: precioHoyDe.get')
  })

  test('el precio de hoy se lee con la zona de la COTIZACION', () => {
    // Compararlo contra otra zona seria comparar dos cosas distintas y llamarlo
    // "subio".
    expect(leer('app/api/bot/convertir/proponer/route.ts')).toContain(
      "p.precios.find((x) => x.zona === cot.zona)"
    )
  })
})

// ============================================================================
// 4. EL SELLO
// ============================================================================

test.describe('Paso 6 · el sello cubre la venta entera, no el folio', () => {
  test('cambiar un precio DENTRO de la venta cambia el sello', () => {
    // La canonizacion es RECURSIVA: `venta` es un objeto anidado y entra
    // completo. Sellar solo `id_cotizacion` seria un sello inutil.
    const a = conversion()
    const b: PayloadConversion = {
      ...a,
      venta: {
        ...a.venta,
        items: [{ ...a.venta.items[0], precio_unitario: 1 }]
      }
    }
    expect(sellarConversion(a)).not.toBe(sellarConversion(b))
    expect(selloConversionCoincide(b, sellarConversion(a))).toBe(false)
  })

  test('reordenar las llaves anidadas NO cambia el sello', () => {
    const a = conversion()
    const clon = JSON.parse(conversionCanonica(a)) as PayloadConversion
    expect(selloConversionCoincide(clon, sellarConversion(a))).toBe(true)
  })

  test('las llaves selladas son las cuatro del payload', () => {
    expect([...LLAVES_CONVERSION].sort()).toEqual(Object.keys(conversion()).sort())
  })

  test('el discriminador se mira ANTES que el sello', () => {
    const fuente = leer('app/api/bot/convertir/confirmar/route.ts')
    const iTipo = fuente.indexOf("guardado?.tipo !== 'conversion'")
    const iSello = fuente.indexOf('selloConversionCoincide(fila, borrador.sello)')
    expect(iTipo).toBeGreaterThan(0)
    expect(iSello).toBeGreaterThan(iTipo)
  })
})

// ============================================================================
// 5. LA CARRERA Y LAS DOS ESCRITURAS
// ============================================================================

test.describe('Paso 6 · no se cobra dos veces, y el orden es el correcto', () => {
  test('el confirmar relee la cotizacion antes de vender', () => {
    // Sin esta lectura, dos "va" seguidos escriben dos ventas de la misma
    // cotizacion: la segunda solo fallaria al marcar, cuando el inventario ya
    // salio dos veces.
    const fuente = leer('app/api/bot/convertir/confirmar/route.ts')
    const iRelee = fuente.indexOf("from('cotizaciones')")
    const iVende = fuente.indexOf('await registrarVenta(')
    expect(iRelee).toBeGreaterThan(0)
    expect(iVende).toBeGreaterThan(iRelee)
    expect(fuente).toContain("cotAhora.estado === 'CONVERTIDA'")
  })

  test('primero la venta, despues la marca', () => {
    // Al reves quedaria una cotizacion CONVERTIDA apuntando a un ticket que no
    // existe — que ademas el CHECK no deja escribir.
    const fuente = leer('app/api/bot/convertir/confirmar/route.ts')
    const iVende = fuente.indexOf('await registrarVenta(')
    const iMarca = fuente.indexOf("estado: 'CONVERTIDA'")
    expect(iMarca).toBeGreaterThan(iVende)
  })

  test('las dos columnas de la marca se mueven en el MISMO update', () => {
    // `CHECK ((estado = 'CONVERTIDA') = (id_ticket IS NOT NULL))`: separarlas no
    // es un estado intermedio feo, es una fila que Postgres no acepta.
    const fuente = leer('app/api/bot/convertir/confirmar/route.ts')
    expect(fuente).toMatch(/update\(\{\s*estado:\s*'CONVERTIDA',\s*id_ticket:\s*resultado\.ticketId\s*\}\)/)
  })

  test('si la marca falla, se DICE: la venta es buena y la marca falta', () => {
    // No se anula la venta para "dejar todo como estaba": la venta es el hecho
    // real, el inventario ya salio.
    const fuente = leer('app/api/bot/convertir/confirmar/route.ts')
    expect(fuente).toContain('cotizacion_marcada: false')
    expect(fuente).toContain('NO pude marcar')
  })

  test('se cuenta la fila devuelta, no se confia en la ausencia de error', () => {
    // ERP-66: un UPDATE denegado por RLS contesta 200 con cero filas.
    const fuente = leer('app/api/bot/convertir/confirmar/route.ts')
    expect(fuente).toContain('(marcada?.length ?? 0) === 1')
  })
})

test.describe('Paso 6 · anular la venta libera la cotizacion', () => {
  const sql = leer(
    'supabase/migrations/20260919153518_fase5_anular_una_venta_libera_su_cotizacion.sql'
  )

  test('la migracion mueve estado e id_ticket juntos', () => {
    expect(sql).toContain('UPDATE public.cotizaciones')
    expect(sql).toContain('id_ticket = NULL')
  })

  test('vuelve a VIGENTE o a VENCIDA segun su propia fecha, no siempre a VIGENTE', () => {
    // Resucitar una promesa de precio que caduco hace un mes seria peor que el
    // defecto que esto arregla.
    expect(sql).toContain("THEN 'VIGENTE'")
    expect(sql).toContain("ELSE 'VENCIDA'")
  })

  test('el dia se toma en hora de Mexico', () => {
    expect(sql).toContain("America/Mexico_City")
  })

  test('sigue siendo SECURITY INVOKER', () => {
    expect(sql).toContain('SECURITY INVOKER')
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/)
  })

  test('y el TypeScript lee el conteo nuevo', () => {
    expect(leer('lib/ticket-annul-cascade.ts')).toContain('cotizaciones: number')
  })

  test('el mensaje de la conversion se lo dice a la persona', () => {
    expect(mensajeDeConversionHecha('COT-0007', 'abcd1234-0000-0000-0000-000000000000', 1200)).toContain(
      'se libera sola'
    )
  })
})

// ============================================================================
// utilidades
// ============================================================================

function venta(total: number): PayloadVenta {
  return {
    id_vendedor: 'e-vendedor',
    id_comprador: 'e-comprador',
    id_cuenta_destino: 'cta-1',
    condicion_pago: 'CONTADO',
    items: [{ id_producto: 'p1', cantidad: 2, precio_unitario: 600, subtotal_linea: 1200 }],
    subtotal_catalogo: total,
    total_cobrado_real: total,
    usuario_creador: 'telegram:norman'
  }
}

function conversion(): PayloadConversion {
  return {
    id_cotizacion: 'c1',
    folio: 'COT-0007',
    venta: venta(1200),
    usuario_creador: 'telegram:norman'
  }
}

function contexto() {
  return {
    nombreComprador: 'Aeropuerto',
    nombreCuenta: 'Efectivo (CEO Admin)',
    condicionPago: 'CONTADO' as const,
    diasDesdeLaCotizacion: 4,
    vencidaParaElCliente: false,
    avisos: []
  }
}
