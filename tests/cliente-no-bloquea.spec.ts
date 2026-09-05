import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENTIDAD_PENDIENTE_DE_ASIGNAR } from '../lib/avisos'
import {
  avisoConcesionSinComprador,
  filtrarCompradoresPermitidos,
  puedeGenerarTicket,
  type EntidadCompradora
} from '../lib/pos-ui'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ERP-81 — un rechazo no deja de serlo por vivir en el cliente.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * La cola de ERP-59 ablando once validaciones del servidor. Cinco de ellas
 * tenian ADEMAS un candado en la pantalla — un `disabled=`, un `max=`, un
 * `return` antes del envio — que nadie quito. El resultado fue el peor de los
 * dos mundos: el servidor decia que si, la pantalla decia que no, y el caso
 * estrella de la cola (W4, la concesion sin comprador) **no se podia ejercer
 * desde la aplicacion**.
 *
 * Las dos primeras pruebas son las que Norman pidio por su nombre. Las de
 * "codigo vivo" son la red para las otras cuatro pantallas, que no tienen
 * logica extraible sin un refactor mas grande: leen el fuente, como
 * `tests/arquitectura.spec.ts`.
 */

const ADMIN = { id: 'e0000000-0000-0000-0000-000000000001', rol: 'ADMIN' }
const DST = { id: 'f0443423-60a0-4156-9bcd-52394ae274fe', rol: 'DST' }

const CENTINELA: EntidadCompradora = { id: ENTIDAD_PENDIENTE_DE_ASIGNAR, rol: 'LOC' }

// ────────────────────────────────────────────────────────────────────────────
// 1. ERP-81 · el boton
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-81 · "Generar Ticket" no se apaga por falta de comprador', () => {
  const ventaViable = {
    isSubmitting: false,
    idVendedor: ADMIN.id,
    itemsEnCarrito: 3
  }

  test('CONCESION sin comprador: EL BOTON SE HABILITA', () => {
    // Esta es la prueba. Si vuelve a fallar, el camino W4 esta muerto otra vez
    // y la cola nace sin su caso estrella.
    expect(
      puedeGenerarTicket({ ...ventaViable, condicionPago: 'CONCESION', idComprador: '' })
    ).toBe(true)
  })

  test('CONCESION con el centinela elegido a mano: tambien se habilita', () => {
    expect(
      puedeGenerarTicket({
        ...ventaViable,
        condicionPago: 'CONCESION',
        idComprador: ENTIDAD_PENDIENTE_DE_ASIGNAR
      })
    ).toBe(true)
  })

  test('lo que SI apaga el boton son hechos, no datos que falten', () => {
    const base = { condicionPago: 'CONTADO' as const, idComprador: DST.id }

    // Sin vendedor no hay quien venda.
    expect(puedeGenerarTicket({ ...ventaViable, ...base, idVendedor: '' })).toBe(false)
    // Sin renglones no hay que vender.
    expect(puedeGenerarTicket({ ...ventaViable, ...base, itemsEnCarrito: 0 })).toBe(false)
    // Con un envio en vuelo no se manda otro.
    expect(puedeGenerarTicket({ ...ventaViable, ...base, isSubmitting: true })).toBe(false)
    // Y una venta normal, claro, pasa.
    expect(puedeGenerarTicket({ ...ventaViable, ...base })).toBe(true)
  })

  test('el letrero pasa de bloqueo a aviso, y dice lo que va a pasar', () => {
    const aviso = avisoConcesionSinComprador('CONCESION', '')
    expect(aviso).toContain('PENDIENTE DE ASIGNAR')
    expect(aviso).toContain('aviso abierto')
    expect(aviso).toContain('asignes al comprador')

    // Y no aparece cuando no aplica.
    expect(avisoConcesionSinComprador('CONCESION', DST.id)).toBeNull()
    expect(avisoConcesionSinComprador('CONTADO', '')).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 2. ERP-80 · el desplegable
// ────────────────────────────────────────────────────────────────────────────

test.describe('ERP-80 · el centinela no llega a opcionesCompradores', () => {
  const RED: EntidadCompradora[] = [
    { id: 'loc-1', rol: 'LOC', id_padre: DST.id },
    { id: 'loc-2', rol: 'LOC', id_padre: ADMIN.id },
    { id: DST.id, rol: 'DST', id_padre: ADMIN.id },
    CENTINELA
  ]

  test('vendedor ADMIN: ve DST y LOC, pero NUNCA el centinela', () => {
    // Este era el hueco exacto: el filtro del ADMIN es `rol === 'DST' || 'LOC'`
    // y el centinela es LOC, asi que aparecia como si fuera un cliente mas.
    const opciones = filtrarCompradoresPermitidos(RED, ADMIN)

    expect(opciones.map((o) => o.id)).not.toContain(ENTIDAD_PENDIENTE_DE_ASIGNAR)
    expect(opciones.map((o) => o.id).sort()).toEqual(['loc-1', 'loc-2', DST.id].sort())
  })

  test('vendedor DST: solo sus hijos, y tampoco el centinela', () => {
    const conCentinelaHijo = [...RED, { id: ENTIDAD_PENDIENTE_DE_ASIGNAR, rol: 'LOC', id_padre: DST.id }]
    const opciones = filtrarCompradoresPermitidos(conCentinelaHijo, DST)

    expect(opciones.map((o) => o.id)).not.toContain(ENTIDAD_PENDIENTE_DE_ASIGNAR)
    expect(opciones.map((o) => o.id)).toEqual(['loc-1'])
  })

  test('nadie se vende a si mismo', () => {
    expect(filtrarCompradoresPermitidos(RED, DST).map((o) => o.id)).not.toContain(DST.id)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 3. Las otras cuatro pantallas, por lectura del fuente
// ────────────────────────────────────────────────────────────────────────────

/** El fuente sin lineas de comentario: los bloques explican lo que se quito. */
function codigoVivo(rutaRelativa: string): string {
  return readFileSync(join(process.cwd(), rutaRelativa), 'utf-8')
    .split('\n')
    .filter((linea) => {
      const l = linea.trim()
      return !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*')
    })
    .join('\n')
}

test.describe('Ninguna pantalla vuelve a bloquear un punto que paso a warning', () => {
  test('POS: el boton ya no mira al comprador (W4)', () => {
    const pos = codigoVivo('app/pos/page.tsx')
    expect(pos).not.toContain('requiereCompradorConcesion')
    expect(pos).toContain('puedeGenerarTicket')
  })

  test('Cobranza: ni el sobregiro ni el corte en cero apagan el boton (W1, W1b)', () => {
    const cobranza = codigoVivo('app/dashboard/distribuidores/[id]/cobranza/CobranzaClient.tsx')

    // Se mira LA LINEA del `disabled`, no el archivo entero: las dos
    // condiciones siguen existiendo, y deben — ahora pintan un letrero que dice
    // que va a pasar. Lo que no pueden hacer es apagar el boton.
    const linea = cobranza.split('\n').find((l) => l.includes('const disableSubmit'))
    expect(linea, 'no encontre la definicion de disableSubmit').toBeTruthy()
    expect(linea).not.toContain('hasSobregiro')
    expect(linea).not.toContain('hasDiferenciasPositivas')

    // Y los dos letreros siguen ahi: quitar el bloqueo sin avisar seria peor.
    expect(cobranza).toContain('resumen.hasSobregiro &&')
    expect(cobranza).toContain('!hasDiferenciasPositivas &&')
  })

  test('Produccion: la falta de receta ya no apaga el boton (W3)', () => {
    const produccion = codigoVivo('app/dashboard/inventario/nuevo/page.tsx')
    expect(produccion).not.toContain('previewInsumos.length === 0')
  })

  test('Compra: falta la cuenta de origen (W13) no bloquea, pero el costo SI', () => {
    const compra = codigoVivo('app/dashboard/inventario/compra/page.tsx')
    expect(compra).not.toContain('|| !cuentaOrigen}')
    // W5 salio de la lista por la frontera de los dos ledgers: sin monto no se
    // puede escribir el lado monetario. Este bloqueo TIENE que seguir vivo.
    expect(compra).toContain('!costoTotal')
  })

  test('Abono: ni la cuenta de origen ni la fecha futura bloquean (W13, W11)', () => {
    const abono = codigoVivo('app/dashboard/distribuidores/[id]/abono/page.tsx')
    expect(abono).not.toContain('!idCuentaOrigen ||')
    // El `max` del <input type="date"> impedia siquiera teclear una fecha futura.
    expect(abono).not.toContain('max={hoyLocalISO()}')
    expect(abono).not.toContain("setFormError('La fecha del pago no puede ser futura.')")
    // Pero el destino y el reparto excedido SIGUEN bloqueando.
    expect(abono).toContain('!idCuentaDestino')
    expect(abono).toContain('excedeMonto')
  })
})
