import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { exigirEntidadDelMovimiento, motivoEntidadFaltante } from '../lib/inventario-invariante'

/**
 * CENTINELA DE ERP-16 — "falla pero no registra una falla". (Norman, 2026-09-14)
 *
 * Dos mitades, y la segunda es la que hace que esto sea un mecanismo y no un
 * recordatorio:
 *
 *   A. la REGLA — `motivoEntidadFaltante` juzga un movimiento suelto.
 *   B. el CABLEADO — ningun archivo puede insertar en `inventario_ledger` sin
 *      pasar por la puerta. Esto es lo que impide que el defecto vuelva por un
 *      INSERT nuevo que nadie recuerde guardar, que es exactamente como
 *      llegaron `compras.ts` y `devoluciones.ts` a escribir la misma fila rota
 *      en dos archivos distintos sin que nadie lo notara.
 *
 * Todo puro: sin navegador, sin base, sin sesion. Corre en cada push y en CI.
 */

const RAIZ = path.resolve(__dirname, '..')
const CARPETAS = ['app', 'lib']
const IGNORADOS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out'])
const EXTENSIONES = new Set(['.ts', '.tsx'])

/** El modulo de la regla se excluye: el ES la puerta, no pasa por ella. */
const EXENTOS = new Set([path.join('lib', 'inventario-invariante.ts')])

// ---------------------------------------------------------------------------
//  EL INSTRUMENTO. Se define aqui y se PRUEBA abajo antes de usarlo sobre el
//  repo: un detector que no puede encontrar nada y un repo limpio producen
//  exactamente la misma observacion.
// ---------------------------------------------------------------------------

/**
 * Cuantas veces el archivo inserta en `inventario_ledger`.
 *
 * Reconoce las dos formas que existen en este repo -encadenada en varias lineas
 * y todo en una-, exigiendo que lo PRIMERO despues de `from('inventario_ledger')`
 * sea `.insert(`. Nada de "busca .insert en los siguientes 300 caracteres": eso
 * salta de una sentencia a la siguiente y produce falsos positivos.
 */
export function insertsDeInventario(fuente: string): number {
  return [...fuente.matchAll(/\.from\(\s*['"]inventario_ledger['"]\s*\)\s*\.insert\s*\(/g)].length
}

/** Cuantas veces el archivo llama a la puerta. */
export function llamadasAlGuardia(fuente: string): number {
  return [...fuente.matchAll(/exigirEntidadDelMovimiento\s*\(/g)].length
}

function archivosDeCodigo(): string[] {
  const salida: string[] = []
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (IGNORADOS.has(entrada)) continue
      const completo = path.join(dir, entrada)
      if (statSync(completo).isDirectory()) recorrer(completo)
      else if (EXTENSIONES.has(path.extname(entrada))) salida.push(completo)
    }
  }
  for (const carpeta of CARPETAS) recorrer(path.join(RAIZ, carpeta))
  return salida
}

// ===========================================================================
//  A. LA REGLA
// ===========================================================================

test.describe('A - la regla: toda entrada dice a quien, toda salida dice de quien', () => {
  test('ENTRADA_COMPRA sin destino es el defecto de ERP-16', () => {
    const motivo = motivoEntidadFaltante({ tipo_movimiento: 'ENTRADA_COMPRA' })
    expect(motivo).toContain('ENTRADA')
    expect(motivo).toContain('id_entidad_destino')
  })

  test('ENTRADA_COMPRA con destino pasa', () => {
    expect(
      motivoEntidadFaltante({ tipo_movimiento: 'ENTRADA_COMPRA', id_entidad_destino: 'e1' })
    ).toBeNull()
  })

  test('una SALIDA sin origen tambien se detiene', () => {
    expect(motivoEntidadFaltante({ tipo_movimiento: 'SALIDA_VENTA' })).toContain('id_entidad_origen')
  })

  test('un tipo que no es ni entrada ni salida se detiene (hoy: LIQUIDACION_INTERNA)', () => {
    // Esta en INVENTARIO_TIPOS_MOVIMIENTO y en ninguna de las dos listas. Si
    // alguien lo escribiera, no moveria stock en ningun tablero y nadie se
    // enteraria: la misma falla silenciosa de ERP-16 por otra puerta.
    const motivo = motivoEntidadFaltante({
      tipo_movimiento: 'LIQUIDACION_INTERNA',
      id_entidad_destino: 'e1',
      id_entidad_origen: 'e2'
    })
    expect(motivo).toContain('no esta en TIPOS_MOVIMIENTO_ENTRADA')
  })

  test('CONTROL NEGATIVO - la entidad EQUIVOCADA no salva al movimiento', () => {
    // Una entrada con origen y sin destino SI trae "una entidad", y una regla
    // floja -"que traiga alguna"- la dejaria pasar. Es el caso realista: el POS
    // arma entradas y salidas dentro del mismo arreglo.
    expect(
      motivoEntidadFaltante({ tipo_movimiento: 'ENTRADA_COMPRA', id_entidad_origen: 'e9' })
    ).not.toBeNull()
    expect(
      motivoEntidadFaltante({ tipo_movimiento: 'SALIDA_VENTA', id_entidad_destino: 'e9' })
    ).not.toBeNull()
  })

  test('CONTROL NEGATIVO - las seis formas REALES del ledger pasan todas', () => {
    // Medidas contra la base el 2026-09-14: son los seis tipos que existen en
    // las 484 filas, con la entidad que cada uno trae de verdad. Si la regla
    // rechazara una de estas, seria mas estricta que el sistema que vigila, y
    // la primera captura real se caeria en produccion.
    const reales = [
      { tipo_movimiento: 'ENTRADA_CONCESION', id_entidad_destino: 'loc1' },
      { tipo_movimiento: 'SALIDA_CONCESION', id_entidad_origen: 'admin' },
      { tipo_movimiento: 'TRASPASO', id_entidad_origen: 'admin' },
      { tipo_movimiento: 'SALIDA_VENTA', id_entidad_origen: 'admin' },
      { tipo_movimiento: 'PRODUCCION', id_entidad_destino: 'admin' },
      { tipo_movimiento: 'MERMA', id_entidad_origen: 'admin' }
    ]
    for (const mov of reales) {
      expect(motivoEntidadFaltante(mov), `${mov.tipo_movimiento} deberia pasar`).toBeNull()
    }
  })

  test('la puerta LANZA, y dice cual movimiento del lote fue', () => {
    const lote = [
      { tipo_movimiento: 'SALIDA_VENTA', id_entidad_origen: 'admin' },
      { tipo_movimiento: 'ENTRADA_COMPRA' }
    ]
    expect(() => exigirEntidadDelMovimiento(lote, 'prueba')).toThrow(
      /\[ERP-16\] prueba: movimiento 2 de 2/
    )
  })

  test('CONTROL NEGATIVO - la puerta NO lanza con un lote sano', () => {
    expect(() =>
      exigirEntidadDelMovimiento(
        [
          { tipo_movimiento: 'SALIDA_VENTA', id_entidad_origen: 'admin' },
          { tipo_movimiento: 'ENTRADA_COMPRA', id_entidad_destino: 'loc1' }
        ],
        'prueba'
      )
    ).not.toThrow()
  })
})

// ===========================================================================
//  B. EL CABLEADO
// ===========================================================================

test.describe('B - el instrumento, antes de creerle', () => {
  test('cuenta los INSERT de las dos formas que existen en el repo', () => {
    const encadenado = "await supabase\n  .from('inventario_ledger')\n  .insert(payload)"
    const enUnaLinea = "await supabase.from('inventario_ledger').insert(filas)"
    expect(insertsDeInventario(encadenado)).toBe(1)
    expect(insertsDeInventario(enUnaLinea)).toBe(1)
    expect(insertsDeInventario(`${encadenado}\n${enUnaLinea}`)).toBe(2)
  })

  test('CONTROL NEGATIVO - no confunde un SELECT, un UPDATE ni una tabla vecina', () => {
    expect(insertsDeInventario("supabase.from('inventario_ledger').select('id')")).toBe(0)
    expect(insertsDeInventario("supabase.from('inventario_ledger').update({ a: 1 })")).toBe(0)
    expect(insertsDeInventario("supabase.from('finanzas_ledger').insert(payload)")).toBe(0)
    // El caso que mata a un detector perezoso: un SELECT de inventario y, mas
    // abajo, un INSERT en OTRA tabla. "busca .insert cerca" contaria 1.
    expect(
      insertsDeInventario(
        "supabase.from('inventario_ledger').select('id')\nawait supabase.from('finanzas_ledger').insert(x)"
      )
    ).toBe(0)
  })

  test('CONTROL NEGATIVO - el detector SI se pone rojo con un archivo sin guardia', () => {
    const archivoRoto = "await supabase.from('inventario_ledger').insert(payload)"
    expect(insertsDeInventario(archivoRoto)).toBe(1)
    expect(llamadasAlGuardia(archivoRoto)).toBe(0)
    expect(llamadasAlGuardia(archivoRoto) >= insertsDeInventario(archivoRoto)).toBe(false)
  })
})

test.describe('B - el cableado sobre el repo real', () => {
  const archivos = archivosDeCodigo()

  test('encuentra los 7 INSERT a inventario_ledger que hay hoy', () => {
    // La guardia contra el modo de fallo silencioso de esta prueba: si el
    // recorrido devolviera cero archivos, la de abajo pasaria en verde sobre
    // nada. Un instrumento roto y un repo limpio se ven igual.
    expect(archivos.length).toBeGreaterThan(50)
    const total = archivos.reduce((n, a) => n + insertsDeInventario(readFileSync(a, 'utf8')), 0)

    // Eran 7 hasta el 2026-09-17. ERP-11 se llevo el del POS: el movimiento de
    // inventario de una venta ya no se escribe desde TypeScript, viaja dentro
    // de `registrar_venta_atomica` para caer en la misma transaccion que el
    // ticket. El numero exacto se conserva a proposito y no se cambia por un
    // `>=`: lo que esta prueba defiende es que **nadie meta un INSERT nuevo sin
    // darse cuenta**, y un umbral no caza eso. Si esto se pone rojo, primero
    // averigua cual archivo lo movio.
    // Fase 9 (D93, 2026-09-23): vuelven a ser 7. El nuevo es la entrada de
    // insumo por chat, `app/api/bot/inventario/confirmar/route.ts`, y llama a
    // la puerta (lo comprueba la prueba de abajo).
    // 2026-11-07 (bot con paridad de la web): siguen 7. El de
    // `registrarSalidaCascada` se mudo, sin cambiar, a `lib/salida-cascada.ts`
    // para que la merma del bot use la MISMA escritura que la web.
    expect(total).toBe(7)
  })

  test('cada archivo que inserta llama a la puerta, al menos una vez por INSERT', () => {
    const culpables: string[] = []

    for (const archivo of archivos) {
      const relativo = path.relative(RAIZ, archivo)
      if (EXENTOS.has(relativo)) continue

      const fuente = readFileSync(archivo, 'utf8')
      const inserts = insertsDeInventario(fuente)
      if (inserts === 0) continue

      const guardias = llamadasAlGuardia(fuente)
      if (guardias < inserts) {
        culpables.push(
          `${relativo}: ${inserts} INSERT y ${guardias} llamada(s) a exigirEntidadDelMovimiento`
        )
      }
    }

    expect(
      culpables,
      'ERP-16: hay un INSERT a inventario_ledger que no pasa por exigirEntidadDelMovimiento. ' +
        'Un movimiento sin su entidad NO falla: los tableros leen el destino nulo como la Matriz.'
    ).toEqual([])
  })
})
