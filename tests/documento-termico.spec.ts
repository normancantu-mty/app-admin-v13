/**
 * CENTINELA — el documento termico se define UNA vez.
 *
 * El mismo comprobante se pinta con dos motores distintos: la pagina web con
 * Tailwind y la imagen PNG con Satori (`next/og`), que no sabe pintar Tailwind.
 * Que las PINTURAS sean dos es inevitable y esta aceptado. Que los DATOS sean
 * dos no: seria un comprobante en pantalla y otro en el telefono del cliente,
 * con cifras distintas y ninguna forma de saber cual manda.
 *
 * Por eso estas pruebas son estaticas, sobre el texto de los archivos: no
 * necesitan navegador ni base, y fallan en el momento en que alguien vuelve a
 * resolver los datos por su cuenta.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'

const RAIZ = join(__dirname, '..')

const PAGINA = join(RAIZ, 'app', 'ticket', '[id]', 'page.tsx')
const IMAGEN = join(RAIZ, 'app', 'api', 'documento', '[id]', 'imagen', 'route.tsx')
const FUENTE_DE_DATOS = join(RAIZ, 'lib', 'documento.ts')

function leer(ruta: string): string {
  return readFileSync(ruta, 'utf-8')
}

/** Quita comentarios para no juzgar codigo por lo que dice la prosa que lo explica. */
function sinComentarios(fuente: string): string {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n')
}

test.describe('el documento termico se define una sola vez', () => {
  test('las dos pinturas piden sus datos a lib/documento', () => {
    for (const ruta of [PAGINA, IMAGEN]) {
      const fuente = sinComentarios(leer(ruta))
      expect(
        fuente,
        `${ruta} tiene que armar su documento con armarDocumentoDeTicket`
      ).toContain('armarDocumentoDeTicket')
    }
  })

  test('ninguna pintura consulta las tablas de la venta por su cuenta', () => {
    // Si una pintura vuelve a hacer su propio .from('transacciones_tickets'),
    // ya tiene una segunda definicion del documento aunque hoy coincida.
    const TABLAS = ['transacciones_tickets', 'ticket_detalles', 'finanzas_ledger']
    for (const ruta of [PAGINA, IMAGEN]) {
      const fuente = sinComentarios(leer(ruta))
      for (const tabla of TABLAS) {
        expect(fuente, `${ruta} no debe consultar ${tabla} directamente`).not.toContain(
          `from('${tabla}')`
        )
      }
    }
  })

  test('control positivo: lib/documento SI consulta esas tablas', () => {
    // Sin esto, la prueba de arriba pasaria igual si alguien borrara la
    // consulta de todos lados y el documento quedara vacio.
    const fuente = sinComentarios(leer(FUENTE_DE_DATOS))
    expect(fuente).toContain("from('transacciones_tickets')")
    expect(fuente).toContain("from('ticket_detalles')")
  })

  test('la imagen exige el token del bot antes de leer nada', () => {
    // La ruta corre con la llave de servicio y salta la RLS: el token es lo
    // unico que la separa de ser una fuga de todos los tickets.
    const fuente = sinComentarios(leer(IMAGEN))
    expect(fuente).toContain('tokenValido')

    const posicionToken = fuente.indexOf('tokenValido(request)')
    const posicionLectura = fuente.indexOf('armarDocumentoDeTicket(')
    expect(posicionToken, 'no se encontro la guarda del token').toBeGreaterThan(-1)
    expect(
      posicionToken,
      'el token se tiene que revisar ANTES de tocar la base'
    ).toBeLessThan(posicionLectura)
  })

  test('control negativo: el centinela detecta una pintura que se salta la fuente', () => {
    const impostora = "const { data } = await supabase.from('transacciones_tickets').select('*')"
    expect(impostora).toContain("from('transacciones_tickets')")
    expect(impostora).not.toContain('armarDocumentoDeTicket')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// D70-D72 (Fase 8): LA COTIZACION, sobre datos de fixture
// ════════════════════════════════════════════════════════════════════════════
import {
  datosDeCotizacion,
  etiquetaDeDescuento,
  LISTA_DISTRIBUIDOR,
  LISTA_PUBLICO,
  type FilaCotizacionDocumento,
  type LineaDocumento
} from '@/lib/documento'

const LINEAS: LineaDocumento[] = [
  { id: 'a', nombre: 'Destilado Plata 750ml', cantidad: 10, precioUnitario: 480 },
  { id: 'b', nombre: 'Destilado Plata 250ml', cantidad: 5, precioUnitario: 179 }
]
const SUMA_RENGLONES = 10 * 480 + 5 * 179 // 5,695

function fila(extra: Partial<FilaCotizacionDocumento>): FilaCotizacionDocumento {
  return {
    folio: 'COT-0099',
    fecha: '2026-09-22',
    vigente_hasta: '2026-10-07',
    estado_efectivo: 'VIGENTE',
    para_quien: 'Aeropuerto',
    total: SUMA_RENGLONES,
    notas: null,
    ...extra
  }
}

test.describe('D70-D72 · el documento de la cotizacion', () => {
  test('a un DST con descuento: precio de distribuidor, "Para:", y la linea del descuento cuadra', () => {
    const total = 5125.5 // 10% de 5,695
    const d = datosDeCotizacion(
      fila({ total, notas: 'promocion de septiembre 10%: de $5,695.00 a $5,125.50.' }),
      'CEO Admin', LINEAS, 'DST')
    expect(d.listaDePrecio).toBe(LISTA_DISTRIBUIDOR)
    expect(d.etiquetaReceptor).toBe('Para:')
    expect(d.subtitulo).toBe('Cotizacion vigente hasta el 07/10/2026')
    expect(d.descuento).toEqual({ subtotal: 5695, etiqueta: 'promocion de septiembre (10%)', importe: 569.5 })
    // La cuenta que el papel tiene que poder hacer: renglones - descuento = total.
    const renglones = d.lineas.reduce((a, l) => a + l.cantidad * l.precioUnitario, 0)
    expect(Math.round((renglones - d.descuento!.importe) * 100)).toBe(Math.round(d.total * 100))
  })

  test('CONTROL NEGATIVO: con descuento, los renglones SIN la linea de descuento no igualan el total', () => {
    const d = datosDeCotizacion(fila({ total: 5125.5 }), 'CEO Admin', LINEAS, 'DST')
    const renglones = d.lineas.reduce((a, l) => a + l.cantidad * l.precioUnitario, 0)
    expect(renglones).not.toBe(d.total)
  })

  test('a publico sin descuento: precio al publico, sin linea de descuento', () => {
    const d = datosDeCotizacion(fila({ para_quien: 'Juan Prospecto' }), 'CEO Admin', LINEAS, null)
    expect(d.listaDePrecio).toBe(LISTA_PUBLICO)
    expect(d.descuento).toBeUndefined()
    expect(d.comprador).toBe('Juan Prospecto')
  })

  test('un LOC tampoco es distribuidor: precio al publico', () => {
    expect(datosDeCotizacion(fila({}), 'CEO Admin', LINEAS, 'LOC').listaDePrecio).toBe(LISTA_PUBLICO)
  })

  test('vencida: lo dice con la fecha en DD/MM/AAAA', () => {
    const d = datosDeCotizacion(
      fila({ estado_efectivo: 'VENCIDA', vigente_hasta: '2026-09-01' }), 'CEO Admin', LINEAS, 'DST')
    expect(d.subtitulo).toBe('Cotizacion VENCIDA el 01/09/2026')
  })

  test('un motivo ilegible no cambia una cifra: la etiqueta cae en "Descuento"', () => {
    expect(etiquetaDeDescuento(null)).toBe('Descuento')
    expect(etiquetaDeDescuento('nota libre sin formato')).toBe('Descuento')
    expect(etiquetaDeDescuento('Descuento 12.5%: de $100.00 a $87.50.')).toBe('Descuento (12.5%)')
  })

  test('las dos pinturas ensenan el descuento, la lista y la etiqueta del receptor', () => {
    for (const ruta of [IMAGEN, join(RAIZ, 'components', 'DocumentoTermico.tsx')]) {
      const fuente = sinComentarios(leer(ruta))
      expect(fuente, ruta).toContain('descuento.importe')
      expect(fuente, ruta).toContain('istaDePrecio')
      expect(fuente, ruta).toContain('tiquetaReceptor')
    }
  })
})
