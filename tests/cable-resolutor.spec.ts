import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * EL CABLE ENTRE EL RESOLUTOR Y LA FILA - la clase entera, no un caso.
 *
 * --- QUE DEFECTO CAZA ------------------------------------------------------
 * *Integration gap*: una funcion correcta conectada al campo equivocado. El
 * resolutor esta probado, la fila se escribe, y entre los dos se cambio la
 * variable. **Ninguna prueba unitaria lo ve**, porque la unidad pasa.
 *
 * El caso real, del 2026-09-05 (W13/ERP-59): `app/actions/abonos.ts` validaba
 * `idCuentaOrigenResuelta` en los tres sitios que deciden -origen igual a
 * destino, lectura de `cuentas_financieras`, veto de FULL_TAX- y escribia
 * `idCuentaOrigen` en la fila. Sobrevivio a 267 pruebas verdes.
 *
 * --- POR QUE ESTA PRUEBA Y NO LA QUE YA HABIA ------------------------------
 * `tests/avisos.spec.ts` ya vigila ese cable, pero **vigila UN archivo por su
 * nombre**: dos `toContain` sobre `app/actions/abonos.ts`. El dia que se
 * escribio, el MISMO par ya existia sin vigilancia en `app/actions/compras.ts`
 * -`idCuentaOrigen` / `idCuentaOrigenResuelta`, mismo resolutor
 * (`resolverCuentaOrigenPorDefecto`), misma forma- y hoy hay cuatro pares de
 * esta forma en cuatro archivos con una sola prueba encima.
 *
 * Es la misma leccion que el bloque `EXENTAS` de `tests/avisos.spec.ts`: una
 * prueba escrita contra el incidente protege el incidente; para proteger la
 * CLASE hay que barrer.
 *
 * --- LA REGLA, Y POR QUE ES AUTOMATIZABLE ----------------------------------
 * El repo ya tiene una convencion de nombre, consistente en los cuatro casos:
 * cuando un valor crudo pasa por un resolutor, el resultado se llama igual
 * **mas el sufijo `Resuelto`/`Resuelta`**. Eso vuelve la regla mecanica:
 *
 *   si en un archivo existe `xResuelta`, entonces `x` -la version CRUDA-
 *   no puede aparecer NUNCA como el valor de una propiedad.
 *
 * La propiedad es lo que acaba en la base. El crudo puede leerse, compararse y
 * pasarse como argumento cuanto quiera; lo que no puede es escribirse.
 *
 * No hace falta editar esta prueba para cubrir un par nuevo: el que se llame
 * `algoResuelto` queda vigilado el dia que se escribe.
 */

/** Solo el codigo de produccion que puede escribir en la base. */
const RAICES = ['app', 'lib']

/** TypeScript, no los `.tsx` de pantalla: una pantalla no escribe en la base. */
function fuentesTypeScript(raiz: string): string[] {
  const salida: string[] = []
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      const ruta = join(dir, entrada)
      if (statSync(ruta).isDirectory()) {
        if (entrada === 'node_modules' || entrada === '.next') continue
        recorrer(ruta)
        continue
      }
      if (ruta.endsWith('.ts') && !ruta.endsWith('.d.ts')) salida.push(ruta)
    }
  }
  recorrer(join(process.cwd(), raiz))
  return salida
}

/**
 * El codigo que de verdad corre. Los comentarios de este repo **citan a
 * proposito la version rota** para explicar que se arreglo (ver la cabecera de
 * `registrarAbonoAction`), asi que mirarlos produciria un rojo permanente
 * sobre texto muerto. Es el mismo filtro que usa `tests/avisos.spec.ts`.
 */
function sinComentarios(fuente: string): string {
  return fuente
    .split('\n')
    .filter((linea) => {
      const limpia = linea.trim()
      return !limpia.startsWith('//') && !limpia.startsWith('*') && !limpia.startsWith('/*')
    })
    .join('\n')
}

/**
 * `idCuentaOrigenResuelta` -> `idCuentaOrigen`.
 *
 * `[a-z]` al principio, y no es cosmetico: deja fuera los TIPOS. `CuentaResuelta`
 * e `ImportacionResuelta` son interfaces, no variables, y una interfaz no se
 * escribe en ninguna fila.
 */
const DECLARA_RESUELTA = /\b([a-z]\w*?)(?:Resuelto|Resuelta)\b/g

interface ParSombra {
  archivo: string
  crudo: string
  resuelto: string
}

function paresSombraEn(archivo: string, codigoVivo: string): ParSombra[] {
  const vistos = new Map<string, ParSombra>()
  for (const hallazgo of codigoVivo.matchAll(DECLARA_RESUELTA)) {
    const resuelto = hallazgo[0]
    const crudo = hallazgo[1]
    // Un sufijo pegado a casi nada no nombra una sombra: nombra una variable
    // que se llama `loResuelto` y punto.
    if (crudo.length < 3) continue
    if (!vistos.has(resuelto)) vistos.set(resuelto, { archivo, crudo, resuelto })
  }
  return [...vistos.values()]
}

/**
 * El crudo en posicion de VALOR de una propiedad, que es exactamente lo que
 * acaba en la base.
 *
 * Los dos anclajes son lo que evita los falsos positivos, y los dos ya se
 * probaron contra el codigo de hoy:
 *   - el ancla despues de los dos puntos deja fuera
 *     `id_comprador: comprador.idComprador` (el valor empieza en `comprador`)
 *     y `idComprador: string | null` (ahi el crudo es el NOMBRE, no el valor).
 *   - el `\b` del final deja fuera `categoria: categoriaResuelta`, donde el
 *     crudo `categoria` es prefijo del resuelto.
 */
function lineasQueEscribenElCrudo(codigoVivo: string, crudo: string): string[] {
  const patron = new RegExp(`^\\s*[a-z_]\\w*:\\s*${crudo}\\b\\s*[,}]?\\s*$`, 'gm')
  return [...codigoVivo.matchAll(patron)].map((m) => m[0].trim())
}

test.describe('El cable entre el resolutor y la fila', () => {
  test('LA CLASE DE DEFECTO: se escribe la variable RESUELTA, nunca la cruda', () => {
    const raizRepo = process.cwd()
    const pares: ParSombra[] = []
    const culpables: string[] = []

    for (const raiz of RAICES) {
      for (const ruta of fuentesTypeScript(raiz)) {
        const codigoVivo = sinComentarios(readFileSync(ruta, 'utf-8'))
        const relativo = relative(raizRepo, ruta).split(sep).join('/')

        for (const par of paresSombraEn(relativo, codigoVivo)) {
          pares.push(par)
          for (const linea of lineasQueEscribenElCrudo(codigoVivo, par.crudo)) {
            culpables.push(
              `${par.archivo}: la fila escribe "${linea}", pero el valor que paso por el ` +
                `resolutor es "${par.resuelto}". Se valida una cosa y se escribe otra: ` +
                'una funcion correcta conectada al campo equivocado da verde en la ' +
                'prueba de la funcion.'
            )
          }
        }
      }
    }

    // -- CONTROL POSITIVO ---------------------------------------------------
    // Sin esto, un regex roto y un repo limpio dan la MISMA observacion: cero
    // culpables sobre cero pares. Los cuatro que existen hoy son
    // `idCompradorResuelto` (pos), `idCuentaOrigenResuelta` (abonos y compras)
    // y `categoriaResuelta` (finanzas/nuevo). Si el barrido encuentra menos de
    // tres, lo que se rompio es el instrumento, no el codigo.
    expect(
      pares.length,
      'el barrido no encontro los pares resolutor/crudo que se sabe que existen: ' +
        'el regex o la lista de raices se rompio'
    ).toBeGreaterThanOrEqual(3)

    expect(culpables, culpables.join('\n')).toEqual([])
  })

  test('los cuatro pares conocidos siguen estando donde se midieron', () => {
    // Un inventario, no un duplicado del chequeo de arriba. Si alguien renombra
    // el resuelto y de paso cablea el crudo, la prueba de arriba se quedaria sin
    // pares que mirar y pasaria en verde POR VACIA. Esto la ancla a los archivos
    // concretos. Medido el 2026-09-12.
    const esperados: Array<[string, string]> = [
      ['app/actions/pos.ts', 'idCompradorResuelto'],
      ['app/actions/abonos.ts', 'idCuentaOrigenResuelta'],
      ['app/actions/compras.ts', 'idCuentaOrigenResuelta'],
      ['app/api/finanzas/nuevo/route.ts', 'categoriaResuelta']
    ]

    for (const [archivo, variable] of esperados) {
      const codigoVivo = sinComentarios(readFileSync(join(process.cwd(), archivo), 'utf-8'))
      expect(
        codigoVivo.includes(variable),
        `${archivo} ya no declara "${variable}". Si se renombro, actualiza esta lista ` +
          'Y comprueba que la fila siga escribiendo el valor resuelto.'
      ).toBe(true)
    }
  })
})
