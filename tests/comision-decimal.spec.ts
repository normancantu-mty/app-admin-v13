import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  avisosDeComision,
  comisionConAvisos,
  comisionValidada,
  enPorcentaje,
  mensajeDeAlta,
  normalizarComision,
  type PayloadAlta
} from '@/lib/bot-entidad'
import { leerNumeroEscrito, porcentajeDeCampo, porcentajeParaCampo } from '@/lib/comision-porcentaje'
import { aCentavo, pisoPeso, techoPeso } from '@/lib/redondeo-dinero'
import { calculateWaterfall } from '@/lib/pricing-waterfall'

/**
 * COMISIONES CON DECIMALES: 17.5% Y 12.5% (2026-11-27).
 *
 * Norman, de voz, sobre los distribuidores de Gilberto: «dejalos asi como con
 * puntos... que sea la excepcion». Hasta hoy la columna era `numeric(5,2)` en
 * FRACCION y solo cabian enteros: el bot guardaba 18/13 con aviso y la web
 * rechazaba 17.5. La migracion `20261127120000_comision_con_decimales.sql` la
 * pasa a `numeric(7,4)`.
 *
 * CONTROL NEGATIVO: estas pruebas se corrieron contra el codigo de
 * origin/master (a83ddaf) y fallan ahi -- 17.5 daba 0.18, `comisionValidada`
 * reventaba, "17,5" era NaN y `Math.floor` le quitaba un peso al distribuidor.
 * Ver el informe del ejecutor (DESDE_EJECUTOR_comision_decimal_2026-11-27.md).
 */

const PRECIOS_REALES = [69, 99, 130, 179, 199, 599, 799] // listas_precios, medido 2026-11-27

test.describe('la comision de medio punto se guarda exacta', () => {
  test('17.5 -> 0.175 y 12.5 -> 0.125, sin aviso', () => {
    for (const [dicho, fraccion] of [
      [17.5, 0.175],
      [12.5, 0.125],
      ['17.5', 0.175],
      ['12.5', 0.125]
    ] as const) {
      const j = normalizarComision(dicho)
      expect(j.ok).toBe(true)
      if (!j.ok) continue
      expect(j.fraccion).toBe(fraccion)
      expect(j.sobreviveElRedondeo).toBe(true)
      expect(avisosDeComision(j)).toEqual([])
    }
  })

  test('coma o punto: "17,5", "12,5 %" y "17,5 por ciento" son lo mismo', () => {
    expect(leerNumeroEscrito('17,5')).toBe(17.5)
    expect(leerNumeroEscrito('12,5 %')).toBe(12.5)
    expect(leerNumeroEscrito('17,5 por ciento')).toBe(17.5)
    for (const t of ['17,5', '17,5%', ' 17.5 % ']) {
      const j = normalizarComision(t)
      expect(j.ok).toBe(true)
      if (j.ok) expect(j.fraccion).toBe(0.175)
    }
  })

  test('CONTROL NEGATIVO: lo que no es numero sigue sin ser numero (nada de 0 callado)', () => {
    expect(Number.isNaN(leerNumeroEscrito('veinte'))).toBe(true)
    expect(Number.isNaN(leerNumeroEscrito('1,000.5'))).toBe(true)
    expect(Number.isNaN(leerNumeroEscrito(''))).toBe(true)
    expect(normalizarComision('veinte').ok).toBe(false)
  })

  test('se muestra "17.5%" y "12.5%"; los enteros siguen siendo "20%"', () => {
    expect(enPorcentaje(0.175)).toBe('17.5%')
    expect(enPorcentaje(0.125)).toBe('12.5%')
    expect(enPorcentaje(0.1225)).toBe('12.25%')
    expect(enPorcentaje(0.2)).toBe('20%')
    expect(enPorcentaje(0.25)).toBe('25%')
  })

  test('el mensaje antes del "va" dice 17.5% y lo que se lleva en pesos', () => {
    const payload: PayloadAlta = {
      nombre: 'Manuel Resendiz Cancun',
      rol: 'DST',
      zona: 'Foraneo',
      email: 'x@y.com',
      telefono: null,
      id_nodo_padre: null,
      comision_base: 0.25,
      comision_base_local: 0,
      comision_hijo_local: 0.175
    }
    const m = mensajeDeAlta(payload, { nombrePadre: null, avisos: [], parecidas: [] })
    expect(m).toContain('25%')
    expect(m).toContain('17.5%')
    expect(m).toContain('$105.00') // 600 x 0.175
    expect(m).not.toContain('18%')
  })
})

test.describe('la pantalla: avisa, no bloquea', () => {
  test('editar 17.5 por la web YA NO revienta (antes: "no cabe")', () => {
    expect(comisionValidada(17.5, 'Comision base')).toBe(0.175)
    expect(comisionValidada(12.5, 'Comision hijo local')).toBe(0.125)
    expect(comisionValidada('17,5', 'Comision base')).toBe(0.175)
  })

  test('mas de dos decimales: se guarda redondeado y SE AVISA, sin bloquear', () => {
    const r = comisionConAvisos(17.555, 'Comision base')
    expect(r.fraccion).toBe(0.1756)
    expect(r.avisos.length).toBe(1)
    expect(r.avisos[0]).toContain('17.555%')
    expect(r.avisos[0]).toContain('17.56%')
    expect(r.avisos[0]).not.toContain('⚠')
  })

  test('fuera de rango (mas de 50%): se guarda y SE AVISA, sin bloquear', () => {
    const r = comisionConAvisos(60, 'Comision base')
    expect(r.fraccion).toBe(0.6)
    expect(r.avisos.join(' ')).toMatch(/mitad del precio/)
  })

  test('CONTROL NEGATIVO: 17.5, 12.5, 20 y 25 NO levantan aviso (si saliera siempre, dejaria de leerse)', () => {
    for (const v of [17.5, 12.5, 20, 25, 15, 10]) {
      expect(comisionConAvisos(v, 'x').avisos).toEqual([])
    }
  })

  test('lo que NO es comision (negativo, > 100%, texto) se sigue deteniendo', () => {
    expect(() => comisionValidada(-5, 'x')).toThrow()
    expect(() => comisionValidada(150, 'x')).toThrow()
    expect(() => comisionValidada('abc', 'x')).toThrow()
  })

  test('el campo del formulario: coma o punto, vacio = 0, basura = null (no 0 callado)', () => {
    expect(porcentajeDeCampo('17,5')).toBe(17.5)
    expect(porcentajeDeCampo('12.5')).toBe(12.5)
    expect(porcentajeDeCampo('')).toBe(0)
    expect(porcentajeDeCampo('abc')).toBeNull()
    expect(porcentajeParaCampo(0.175)).toBe('17.5')
    expect(porcentajeParaCampo(0.2)).toBe('20')
  })

  test('los formularios ya no son type=number ni parseFloat || 0', () => {
    for (const f of [
      'components/v2/red/EditarEntidad.tsx',
      'components/v2/red/Alta.tsx',
      'app/dashboard/distribuidores/EditEntidadModal.tsx',
      'app/dashboard/distribuidores/nuevo/page.tsx'
    ]) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).not.toMatch(/parseFloat\(comision/)
      expect(src, f).toContain('porcentajeDeCampo')
      expect(src, f).toContain('inputMode="decimal"')
    }
  })
})

test.describe('el bot: una comision invalida se vuelve a preguntar, no mata la alta', () => {
  test('la ruta ya no contesta 422 por la comision', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/bot/entidad/proponer/route.ts'), 'utf8')
    expect(src).not.toContain('return NextResponse.json({ error: juicio.error }, { status: 422 })')
    expect(src).toContain('mensaje: `${juicio.error} ${pedida.pregunta}`')
    expect(src).toContain('avisosDeComision(juicio)')
  })
})

test.describe('el dinero: ceil/floor sin el ruido del float', () => {
  test('40 minis de $69 al 17.5% son $483 exactos (Math.floor daba 482)', () => {
    const v = 40 * 69 * 0.175
    expect(Math.floor(v)).toBe(482) // el defecto, medido
    expect(pisoPeso(v)).toBe(483)
  })

  test('17.5% y 12.5%: pisoPeso/techoPeso dan lo mismo que la cuenta exacta en enteros', () => {
    // Cuenta exacta en milesimas de porcentaje: p*q*k/1000, sin floats.
    for (const k of [175, 125]) {
      for (const p of PRECIOS_REALES) {
        for (let q = 1; q <= 200; q++) {
          const num = p * q * k // en "milesimas"
          const pisoExacto = Math.floor(num / 1000)
          const techoExacto = Math.ceil((p * q * 1000 - num) / 1000)
          expect(pisoPeso((p * q * k) / 1000), `piso ${p}x${q} @${k}`).toBe(pisoExacto)
          expect(techoPeso(p * q * (1 - k / 1000)), `techo ${p}x${q} @${k}`).toBe(techoExacto)
        }
      }
    }
  })

  test('CONTROL NEGATIVO: con los porcentajes enteros de hoy, en efectivo NADA cambia', () => {
    for (const c of [0.1, 0.15, 0.2, 0.25]) {
      for (const p of PRECIOS_REALES) {
        for (let q = 1; q <= 200; q++) {
          const t = p * q
          expect(techoPeso(t * (1 - c))).toBe(Math.ceil(t * (1 - c)))
          expect(pisoPeso(t * c)).toBe(Math.floor(t * c))
        }
      }
    }
  })

  test('con base fiscal (/1.7748) solo cambia donde Math.ceil cobraba un peso de RUIDO', () => {
    // Medido 2026-11-27: 8 casos, p.ej. 29 x $799 fiscal al 10% = 11750 exactos
    // (1.7748 x 11750 = 20853.9 = 799 x 29 x 0.9) y Math.ceil daba 11751.
    let cambios = 0
    for (const c of [0.1, 0.15, 0.2, 0.25]) {
      for (const p of PRECIOS_REALES) {
        for (let q = 1; q <= 200; q++) {
          const v = ((p / 1.7748) * q) * (1 - c)
          if (techoPeso(v) !== Math.ceil(v)) {
            cambios++
            expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-6)
            expect(techoPeso(v)).toBe(Math.round(v))
          }
        }
      }
    }
    expect(cambios).toBe(8)
  })

  test('aCentavo deja dos decimales half-up', () => {
    expect(aCentavo(599 * (1 - 0.175))).toBe(494.18)
    expect(aCentavo(479.20000000000005)).toBe(479.2)
  })

  test('la consignacion de Gilberto al 25% sigue dando 600 / 150 / 75 (lista Foraneo)', () => {
    // Del informe de Gilberto (2026-11-26): lista Foraneo 799/199/99 menos 25%, techo al peso.
    const dst = { rol: 'DST', comision_base: 0.25, aplica_redondeo_costo: true }
    const casos: Array<[number, number]> = [[799, 600], [199, 150], [99, 75]]
    for (const [lista, esperado] of casos) {
      const r = calculateWaterfall({ listas_precios: [{ precio_final: lista }], costo_unitario: 0 }, { rol: 'ADMIN' }, 'ADMIN', 'LIBRE', dst)
      expect(r.precioLocal).toBe(esperado)
    }
  })

  test('un local al 12.5% y un distribuidor al 17.5%: precio al nodo con techo al peso', () => {
    const loc = { rol: 'LOC', comision_base_local: 0.125, aplica_redondeo_costo: true }
    const dst = { rol: 'DST', comision_base: 0.175, aplica_redondeo_costo: true }
    const prod = (lista: number) => ({ listas_precios: [{ precio_final: lista }], costo_unitario: 0 })
    // 799 x 0.875 = 699.125 -> 700 ; 799 x 0.825 = 659.175 -> 660
    expect(calculateWaterfall(prod(799), { rol: 'ADMIN' }, 'ADMIN', 'LIBRE', loc).precioLocal).toBe(700)
    expect(calculateWaterfall(prod(799), { rol: 'ADMIN' }, 'ADMIN', 'LIBRE', dst).precioLocal).toBe(660)
    // 69 x 0.875 = 60.375 -> 61 ; 600 x 0.825 = 495 exacto -> 495 (no 496)
    expect(calculateWaterfall(prod(69), { rol: 'ADMIN' }, 'ADMIN', 'LIBRE', loc).precioLocal).toBe(61)
    expect(calculateWaterfall(prod(600), { rol: 'ADMIN' }, 'ADMIN', 'LIBRE', dst).precioLocal).toBe(495)
  })
})
