/**
 * 2026-11-26 (MAPA n7) — LA REGLA DE CUENTAS DEL ABONO, UNA SOLA PARA WEB Y BOT.
 *
 * `reglaDeCuentasDelAbono` (`lib/abono-cuentas.ts`) salio de `registrarAbonoAction`
 * sin cambiarle una decision ni un texto. Aqui se prueba pura, con cada camino y
 * sus controles negativos, y se amarra por fuente que la web y las dos rutas del
 * bot la llamen (y que la web no conserve su copia).
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONCEPTO_ABONO_DIST_A_ADMIN,
  CONCEPTO_ABONO_LOCAL_A_DST,
  CONCEPTO_CARGO_ADMIN_A_DIST,
  esAbonoDeDstPorSuLocal,
  reglaDeCuentasDelAbono,
  type CuentaDelAbono
} from '@/lib/abono-cuentas'
import { REFERENCIAS_ABONO, referenciaEsInocua } from '@/lib/bot-abonos'

const MATRIZ: CuentaDelAbono = { id: 'c-norman', id_entidad: 'ent-matriz', rol: 'ADMIN' }
const GIL: CuentaDelAbono = { id: 'c-gil', id_entidad: 'dst-a', rol: 'DST' }
const OTRO_DST: CuentaDelAbono = { id: 'c-otro', id_entidad: 'dst-b', rol: 'DST' }
const LOCAL: CuentaDelAbono = { id: 'c-loc', id_entidad: 'loc-a1', rol: 'LOC' }

test.describe('reglaDeCuentasDelAbono', () => {
  test('DST por SU local -> cuenta propia del DST: ABONO_DEUDA, sin aprobacion, Local -> Distribuidor', () => {
    const r = reglaDeCuentasDelAbono({
      rolCaptura: 'DST', idEntidadCaptura: 'dst-a', idEntidadDeudor: 'loc-a1', origen: LOCAL, destino: GIL
    })
    expect(r).toMatchObject({
      ok: true, esLocalASuDst: true, tipoMovimiento: 'ABONO_DEUDA',
      requiereAprobacionAdmin: false, concepto: CONCEPTO_ABONO_LOCAL_A_DST
    })
  })

  test('CONTROL: DST por SU local hacia la MATRIZ -> rechazado (es el hueco n7)', () => {
    const r = reglaDeCuentasDelAbono({
      rolCaptura: 'DST', idEntidadCaptura: 'dst-a', idEntidadDeudor: 'loc-a1', origen: LOCAL, destino: MATRIZ
    })
    expect(r).toEqual({ ok: false, error: 'El abono de tu local entra a tu propia cuenta, no a la de la matriz ni a otra.' })
  })

  test('DST por SU deuda -> matriz: PENDIENTE (D97), Distribuidor -> Admin', () => {
    const r = reglaDeCuentasDelAbono({
      rolCaptura: 'DST', idEntidadCaptura: 'dst-a', idEntidadDeudor: 'dst-a', origen: GIL, destino: MATRIZ
    })
    expect(r).toMatchObject({ ok: true, esLocalASuDst: false, requiereAprobacionAdmin: true, concepto: CONCEPTO_ABONO_DIST_A_ADMIN })
  })

  test('ADMIN, local de un DST, a la matriz: vale (el aviso es del bot, no de la regla)', () => {
    const r = reglaDeCuentasDelAbono({
      rolCaptura: 'ADMIN', idEntidadCaptura: 'ent-matriz', idEntidadDeudor: 'loc-a1',
      idDstDelDeudor: 'dst-a', origen: LOCAL, destino: MATRIZ
    })
    expect(r).toMatchObject({ ok: true, esLocalASuDst: false, requiereAprobacionAdmin: false, concepto: CONCEPTO_ABONO_DIST_A_ADMIN })
  })

  test('ADMIN, local de un DST, a la cuenta de SU DST: Local -> Distribuidor, sin aprobacion', () => {
    const r = reglaDeCuentasDelAbono({
      rolCaptura: 'ADMIN', idEntidadCaptura: 'ent-matriz', idEntidadDeudor: 'loc-a1',
      idDstDelDeudor: 'dst-a', origen: LOCAL, destino: GIL
    })
    expect(r).toMatchObject({ ok: true, esLocalASuDst: true, tipoMovimiento: 'ABONO_DEUDA', requiereAprobacionAdmin: false, concepto: CONCEPTO_ABONO_LOCAL_A_DST })
  })

  test('CONTROL: ADMIN, local de Gil, a la cuenta de OTRO DST -> rechazado', () => {
    const r = reglaDeCuentasDelAbono({
      rolCaptura: 'ADMIN', idEntidadCaptura: 'ent-matriz', idEntidadDeudor: 'loc-a1',
      idDstDelDeudor: 'dst-a', origen: LOCAL, destino: OTRO_DST
    })
    expect(r.ok).toBe(false)
  })

  test('CONTROL (la web, sin DST del deudor): ADMIN de LOC a cuenta de DST sigue rechazado como antes', () => {
    const r = reglaDeCuentasDelAbono({
      rolCaptura: 'ADMIN', idEntidadCaptura: 'ent-matriz', idEntidadDeudor: 'loc-a1',
      idDstDelDeudor: null, origen: LOCAL, destino: GIL
    })
    expect(r).toEqual({ ok: false, error: 'Solo se permiten transferencias cruzadas entre ADMIN y Distribuidor/Local.' })
  })

  test('ADMIN -> DST es CARGO_DEUDA, como siempre', () => {
    const r = reglaDeCuentasDelAbono({
      rolCaptura: 'ADMIN', idEntidadCaptura: 'ent-matriz', idEntidadDeudor: 'dst-a', origen: MATRIZ, destino: GIL
    })
    expect(r).toMatchObject({ ok: true, tipoMovimiento: 'CARGO_DEUDA', concepto: CONCEPTO_CARGO_ADMIN_A_DIST, cuentaNoAdmin: GIL })
  })

  test('CONTROL: origen que no es del deudor -> rechazado', () => {
    const r = reglaDeCuentasDelAbono({
      rolCaptura: 'DST', idEntidadCaptura: 'dst-a', idEntidadDeudor: 'loc-a1', origen: OTRO_DST, destino: GIL
    })
    expect(r).toEqual({ ok: false, error: 'La cuenta de origen tiene que ser del local.' })
  })

  test('esAbonoDeDstPorSuLocal: solo un DST, solo si el deudor no es el mismo', () => {
    expect(esAbonoDeDstPorSuLocal('DST', 'dst-a', 'loc-a1')).toBe(true)
    expect(esAbonoDeDstPorSuLocal('DST', 'dst-a', 'dst-a')).toBe(false)
    expect(esAbonoDeDstPorSuLocal('ADMIN', 'ent-matriz', 'loc-a1')).toBe(false)
  })

  test('los dos conceptos de abono estan en la lista cerrada del bot y son inocuos para v_pasivo_fiscal', () => {
    expect(REFERENCIAS_ABONO).toContain(CONCEPTO_ABONO_DIST_A_ADMIN)
    expect(REFERENCIAS_ABONO).toContain(CONCEPTO_ABONO_LOCAL_A_DST)
    for (const r of REFERENCIAS_ABONO) expect(referenciaEsInocua(r)).toBe(true)
  })
})

test.describe('una sola regla: web y bot llaman a la misma funcion', () => {
  const leer = (ruta: string) => readFileSync(join(process.cwd(), ruta), 'utf8')

  for (const ruta of ['app/actions/abonos.ts', 'app/api/bot/abono/proponer/route.ts', 'app/api/bot/abono/confirmar/route.ts']) {
    test(`${ruta} llama a reglaDeCuentasDelAbono`, () => {
      expect(leer(ruta)).toContain('reglaDeCuentasDelAbono(')
    })
  }

  test('la web ya no trae su copia de la regla (los textos viven en lib/abono-cuentas.ts)', () => {
    const web = leer('app/actions/abonos.ts')
    expect(web).not.toContain('Solo se permiten transferencias cruzadas')
    expect(web).not.toContain("'Abono de Deuda (Local -> Distribuidor)'")
  })
})
