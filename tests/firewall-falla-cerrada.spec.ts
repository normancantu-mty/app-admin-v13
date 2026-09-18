import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  calcularEgresosAdmin,
  calcularPasivosFiscalesAdmin,
  filtrarMovimientosFirewallAdmin,
  movimientoTocaCuentaAdmin,
  type MovimientoEgresoAdmin
} from '../lib/dashboard-utils'

/**
 * ERP-20 — EL ACCOUNT_FIREWALL FALLA CERRADO, Y AHORA HAY QUIEN LO SOSTENGA.
 *
 * El Account_Firewall decide que movimiento entra en un KPI de nivel Admin: el
 * que toca una cuenta del ADMIN por origen **o** por destino. El ticket lo
 * describia copiado cuatro veces con dos comportamientos distintos ante fallo,
 * y uno de ellos **devolvia la lista entera** — o sea, publicaba el ledger de
 * toda la red a quien no debia verlo.
 *
 * Al medir el 2026-09-14 la unificacion ya estaba hecha: una sola
 * implementacion en `lib/dashboard-utils.ts`, y los cinco consumidores fallando
 * cerrado. **Lo que no existia era una prueba que lo sostuviera sin base.** Las
 * dos que tocan el firewall (`cableado-pantallas`, `vistas-equivalencia`) viven
 * en el proyecto `equivalencia` y **se saltan sin credenciales**, que es
 * exactamente lo que pasa en el CI publico. Una garantia de seguridad cuyo
 * unico centinela se salta en CI no es una garantia: es una nota.
 *
 * Este archivo es puro —sin navegador, sin base, sin sesion— y corre siempre.
 *
 * **El problema, con su nombre: fail-open vs fail-closed defaults.** Cuando la
 * autorizacion se calcula a partir de un dato que se puede no tener, el caso
 * "no lo tengo" tiene que ser el mas restrictivo, no el mas barato de escribir.
 */

const CUENTA_ADMIN = 'cuenta-admin-1'
const CUENTA_ADMIN_2 = 'cuenta-admin-2'
const CUENTA_AJENA = 'cuenta-de-un-distribuidor'

const movimiento = (
  extra: Partial<MovimientoEgresoAdmin> = {}
): MovimientoEgresoAdmin => ({
  tipo_movimiento: 'GASTO_OPERATIVO',
  monto: 100,
  status: 'ACTIVO',
  categoria: null,
  id_cuenta_origen: CUENTA_AJENA,
  id_cuenta_destino: null,
  ...extra
})

test.describe('ERP-20 · sin cuentas del ADMIN, no se ve NADA', () => {
  const universo: MovimientoEgresoAdmin[] = [
    movimiento({ id_cuenta_origen: CUENTA_ADMIN, monto: 100 }),
    movimiento({ id_cuenta_origen: null, id_cuenta_destino: CUENTA_ADMIN_2, monto: 200 }),
    movimiento({ id_cuenta_origen: CUENTA_AJENA, monto: 400 }),
    movimiento({ id_cuenta_origen: null, id_cuenta_destino: CUENTA_AJENA, monto: 800 })
  ]

  test('la lista vacia de cuentas admin NO abre el ledger: devuelve vacio', () => {
    // Esta es LA linea del ticket. Si alguien vuelve a poner `return
    // movimientos` para el caso vacio, aqui se pone roja.
    expect(filtrarMovimientosFirewallAdmin(universo, [])).toEqual([])
  })

  test('CONTROL POSITIVO: con cuentas, si filtra — y filtra bien, no todo ni nada', () => {
    // Una prueba que solo mira el caso vacio pasaria igual con una funcion que
    // devuelve `[]` siempre. Este control es el que descarta esa explicacion.
    const visibles = filtrarMovimientosFirewallAdmin(universo, [CUENTA_ADMIN, CUENTA_ADMIN_2])

    expect(visibles.map((m) => m.monto)).toEqual([100, 200])
    expect(visibles.length).toBeGreaterThan(0)
    expect(visibles.length).toBeLessThan(universo.length)
  })

  test('toca por ORIGEN o por DESTINO, y la ajena por ninguno de los dos', () => {
    const cuentas = new Set([CUENTA_ADMIN])

    expect(movimientoTocaCuentaAdmin({ id_cuenta_origen: CUENTA_ADMIN, id_cuenta_destino: null }, cuentas)).toBe(true)
    expect(movimientoTocaCuentaAdmin({ id_cuenta_origen: null, id_cuenta_destino: CUENTA_ADMIN }, cuentas)).toBe(true)
    expect(movimientoTocaCuentaAdmin({ id_cuenta_origen: CUENTA_AJENA, id_cuenta_destino: CUENTA_AJENA }, cuentas)).toBe(false)
    // Las dos columnas nulas no son "sin dueño, pasa": son NO.
    expect(movimientoTocaCuentaAdmin({ id_cuenta_origen: null, id_cuenta_destino: null }, cuentas)).toBe(false)
  })

  test('un `id_cuenta` vacio no cuela: la cadena vacia no es una cuenta', () => {
    const cuentas = new Set([''])
    expect(movimientoTocaCuentaAdmin({ id_cuenta_origen: '', id_cuenta_destino: '' }, cuentas)).toBe(false)
  })
})

test.describe('ERP-20 · los consumidores heredan el default cerrado', () => {
  const egresos: MovimientoEgresoAdmin[] = [
    movimiento({ tipo_movimiento: 'GASTO_OPERATIVO', monto: 500, id_cuenta_origen: CUENTA_ADMIN }),
    movimiento({ tipo_movimiento: 'COMPRA_INSUMOS', monto: 300, id_cuenta_origen: CUENTA_AJENA })
  ]

  test('calcularEgresosAdmin sin cuentas admin da 0, no el gasto de la red', () => {
    expect(calcularEgresosAdmin(egresos, [])).toBe(0)
  })

  test('CONTROL POSITIVO: con la cuenta admin si suma, y solo lo suyo', () => {
    expect(calcularEgresosAdmin(egresos, [CUENTA_ADMIN])).toBe(500)
  })

  test('calcularPasivosFiscalesAdmin sin cuentas admin da 0 y 0', () => {
    const pasivos = [
      { tipo_movimiento: 'PASIVO_IVA', monto: 160, status: 'ACTIVO', id_cuenta_destino: CUENTA_ADMIN, id_cuenta_origen: null },
      { tipo_movimiento: 'PASIVO_IEPS', monto: 53, status: 'ACTIVO', id_cuenta_destino: CUENTA_ADMIN, id_cuenta_origen: null }
    ]

    expect(calcularPasivosFiscalesAdmin(pasivos, [])).toEqual({ ivaPorPagar: 0, iepsPorPagar: 0 })
    // Control positivo en la misma pasada: si no sumara nunca, la de arriba
    // pasaria por la razon equivocada.
    expect(calcularPasivosFiscalesAdmin(pasivos, [CUENTA_ADMIN])).toEqual({
      ivaPorPagar: 160,
      iepsPorPagar: 53
    })
  })
})

/**
 * La otra mitad de ERP-20: que siga habiendo UNA implementacion.
 *
 * Las pruebas de arriba comprueban que la que existe se porta bien. No pueden
 * ver que alguien escriba la quinta copia en otro archivo — que es justamente
 * como nacieron las cuatro. Esto lee el codigo fuente, como
 * `tests/arquitectura.spec.ts`.
 */
const RAIZ = path.resolve(__dirname, '..')
const CARPETAS = ['app', 'lib', 'components']
const IGNORADOS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out'])
const EXTENSIONES = new Set(['.ts', '.tsx'])

/** El unico archivo donde el firewall puede estar implementado. */
const CASA_DEL_FIREWALL = 'lib/dashboard-utils.ts'

function archivosDeCodigo(): string[] {
  const encontrados: string[] = []
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (IGNORADOS.has(entrada)) continue
      const completo = path.join(dir, entrada)
      if (statSync(completo).isDirectory()) recorrer(completo)
      else if (EXTENSIONES.has(path.extname(entrada))) encontrados.push(completo)
    }
  }
  for (const carpeta of CARPETAS) recorrer(path.join(RAIZ, carpeta))
  return encontrados
}

test.describe('ERP-20 · una sola implementacion, y vive donde dice que vive', () => {
  test('nadie mas DEFINE el firewall', () => {
    const definiciones: string[] = []

    for (const archivo of archivosDeCodigo()) {
      const relativo = path.relative(RAIZ, archivo).replace(/\\/g, '/')
      const fuente = readFileSync(archivo, 'utf8')

      for (const nombre of ['movimientoTocaCuentaAdmin', 'filtrarMovimientosFirewallAdmin']) {
        if (new RegExp(`function\\s+${nombre}\\s*[<(]`).test(fuente)) {
          definiciones.push(`${relativo} define ${nombre}`)
        }
      }
    }

    expect(
      definiciones,
      `El Account_Firewall solo puede definirse en ${CASA_DEL_FIREWALL}. Una copia mas es ` +
        'como nacieron las cuatro de ERP-20, y una de ellas fallaba ABIERTA.'
    ).toEqual([
      `${CASA_DEL_FIREWALL} define movimientoTocaCuentaAdmin`,
      `${CASA_DEL_FIREWALL} define filtrarMovimientosFirewallAdmin`
    ])
  })

  test('CONTROL NEGATIVO: el detector reconoce una definicion nueva', () => {
    // Sin esto, la prueba de arriba podria estar pasando porque la expresion
    // regular no encuentra nada en ningun lado.
    const copiaFalsa = `function filtrarMovimientosFirewallAdmin<T>(m: T[]): T[] { return m }`

    expect(/function\s+filtrarMovimientosFirewallAdmin\s*[<(]/.test(copiaFalsa)).toBe(true)
    expect(/function\s+filtrarMovimientosFirewallAdmin\s*[<(]/.test('// solo un comentario')).toBe(false)
  })
})
