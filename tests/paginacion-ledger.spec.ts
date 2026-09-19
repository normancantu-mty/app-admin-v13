import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * CENTINELA DE ERP-25 — el ledger no se lee truncado.
 *
 * El defecto que vigila: **PostgREST corta en 1000 filas y no lo dice.** No
 * devuelve error, no pone bandera, no deja rastro en el log. Una lectura de
 * ledger que se va a sumar y llega cortada no produce un fallo: produce un
 * **numero falso en pantalla**, que es la clase de defecto mas cara del ERP
 * porque nadie lo busca hasta que ya decidio algo.
 *
 * Lo que el ticket decia y lo que se encontro NO eran lo mismo, y vale
 * anotarlo: el ticket hablaba de `.limit(1000)`. Al medir el 2026-09-14 no
 * quedaba ni uno — las pantallas grandes ya paginaban. Lo vivo eran diez
 * lecturas **sin `.limit()` y sin `.range()`**, que se comen el corte igual y
 * ademas no dejan la pista del numero mil en el codigo. Se arreglaron todas
 * antes de encender esta prueba, a proposito: un centinela cuya lista de
 * excepciones es el repo entero no protege nada.
 *
 * Igual que `tests/arquitectura.spec.ts`, esta prueba **lee el codigo fuente**.
 * No necesita navegador, ni servidor, ni base, ni sesion: corre en el proyecto
 * `puras`, en milisegundos, en cada push. Una prueba que se salta no protege.
 *
 * Y el analizador es una funcion pura (`analizarFuente`) para que la ultima
 * prueba de este archivo sea un **control negativo de verdad**: se le dan
 * fragmentos rotos a proposito y se exige que los marque. Sin eso, una prueba
 * verde solo demuestra que el analizador no encontro nada — que es exactamente
 * lo que haria uno que no busca.
 */

const RAIZ = path.resolve(__dirname, '..')
const CARPETAS = ['app', 'lib', 'components']
const DIRECTORIOS_IGNORADOS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out'])
const EXTENSIONES = new Set(['.ts', '.tsx'])

/**
 * Las tablas y vistas cuyo truncamiento produce un numero falso. Las tres
 * primeras son los libros; las demas, las vistas canonicas que los replican.
 */
const LEDGERS = [
  'inventario_ledger',
  'finanzas_ledger',
  'transacciones_tickets',
  'v_movimiento_clasificado',
  'v_saldo_entidad',
  'v_cartera',
  'v_stock_por_cubeta',
  'v_pasivo_fiscal'
]

/** Las dos puertas que paginan. Todo lo demas es una lectura cruda. */
const ENVOLTORIOS = ['fetchTodasLasFilas', 'leerTodo']

/** Una cadena que escribe no lee: no hay nada que truncar. */
const ESCRITURAS = new Set(['insert', 'update', 'delete', 'upsert'])

/** Una fila, por contrato de PostgREST. Tampoco hay nada que truncar. */
const UNA_FILA = new Set(['single', 'maybeSingle'])

/**
 * `select('...', { head: true })` — la lectura que **no devuelve ni una fila**.
 *
 * Con `head: true` PostgREST contesta con los encabezados y cuerpo vacio: el
 * numero viaja en `Content-Range` y **es el total que empata el filtro, no el
 * de la pagina**. El corte de las mil filas no lo puede tocar porque no hay
 * filas que cortar; paginar un conteo no significa nada.
 *
 * Se agrego el 2026-09-19, cuando `medirAlcanceDeAnulacion` —que cuenta las
 * filas que va a arrastrar una anulacion, para poder decirlas antes del "va"—
 * salio marcada. Era un hueco del analizador, no un defecto del codigo: la
 * alternativa habria sido traerse las filas enteras para contarlas, que es
 * literalmente lo que ERP-25 existe para evitar.
 */
const CUENTA_SIN_FILAS = /\bhead\s*:\s*true\b/

/**
 * Techo de un `.limit()` legitimo. Por debajo es un "ultimos N" de una pantalla
 * de actividad; de aqui para arriba alguien esta creyendo que pide *todo*, y
 * `.limit(1000)` —el numero exacto del tope de PostgREST— es el caso que
 * nombraba ERP-25.
 */
const LIMITE_MAXIMO_RAZONABLE = 100

export type ClaseDeFalla = 'limite-grande' | 'limite-sin-orden' | 'sin-paginar'

export interface Hallazgo {
  clase: ClaseDeFalla
  tabla: string
  linea: number
  cadena: string
}

/**
 * Quita comentarios de linea y de bloque, conservando la longitud del texto
 * (los sustituye por espacios) para que los numeros de linea no se muevan.
 *
 * Hace falta: `lib/vistas.ts` explica en su JSDoc por que `types/database.ts`
 * no conoce las vistas, y al hacerlo **escribe `client.from('v_saldo_entidad')`
 * dentro del comentario**. Un centinela que no distingue prosa de codigo se
 * pone rojo por una explicacion, y un centinela que se pone rojo sin razon se
 * apaga a la semana.
 */
function sinComentarios(texto: string): string {
  const salida = texto.split('')
  let i = 0
  let enCadena: string | null = null

  while (i < texto.length) {
    const c = texto[i]
    const siguiente = texto[i + 1]

    if (enCadena) {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === enCadena) enCadena = null
      i += 1
      continue
    }

    if (c === "'" || c === '"' || c === '`') {
      enCadena = c
      i += 1
      continue
    }

    if (c === '/' && siguiente === '/') {
      while (i < texto.length && texto[i] !== '\n') {
        salida[i] = ' '
        i += 1
      }
      continue
    }

    if (c === '/' && siguiente === '*') {
      while (i < texto.length && !(texto[i] === '*' && texto[i + 1] === '/')) {
        if (texto[i] !== '\n') salida[i] = ' '
        i += 1
      }
      // Los dos caracteres del cierre.
      salida[i] = ' '
      if (i + 1 < texto.length) salida[i + 1] = ' '
      i += 2
      continue
    }

    i += 1
  }

  return salida.join('')
}

/** Indice del `)` que cierra el `(` que esta en `apertura`. */
function cierreDe(texto: string, apertura: number): number {
  let nivel = 0
  for (let i = apertura; i < texto.length; i += 1) {
    if (texto[i] === '(') nivel += 1
    else if (texto[i] === ')') {
      nivel -= 1
      if (nivel === 0) return i
    }
  }
  return texto.length - 1
}

/** Los tramos `fetchTodasLasFilas(...)` / `leerTodo(...)`, con sus genericos. */
function tramosPaginados(texto: string): Array<[number, number]> {
  const tramos: Array<[number, number]> = []
  for (const nombre of ENVOLTORIOS) {
    const patron = new RegExp(`\\b${nombre}\\s*(?:<[^>]*>)?\\s*\\(`, 'g')
    let m: RegExpExecArray | null
    while ((m = patron.exec(texto)) !== null) {
      const apertura = m.index + m[0].length - 1
      tramos.push([m.index, cierreDe(texto, apertura)])
    }
  }
  return tramos
}

/**
 * La cadena de metodos que arranca en `.from(`: sus nombres y el argumento de
 * cada uno. Se recorre con parentesis balanceados y no con una expresion
 * regular sobre la linea, porque estas cadenas ocupan diez lineas y llevan
 * objetos, plantillas y `select()` multilinea dentro.
 */
function cadenaDesde(texto: string, inicio: number): Array<{ metodo: string; argumento: string }> {
  const piezas: Array<{ metodo: string; argumento: string }> = []
  const paso = /\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/y
  let i = inicio

  for (;;) {
    paso.lastIndex = i
    const m = paso.exec(texto)
    if (!m) return piezas

    const apertura = paso.lastIndex - 1
    const cierre = cierreDe(texto, apertura)
    piezas.push({ metodo: m[1], argumento: texto.slice(apertura + 1, cierre) })
    i = cierre + 1
  }
}

/**
 * El analizador, puro y exportado: texto de un archivo → lecturas de ledger que
 * violan alguna de las tres reglas.
 *
 * - **A.** Ningun `.limit(N)` con `N >= 100` sobre un ledger.
 * - **B.** Un `.limit(N)` exige `.order(...)`: "los ultimos N" sin orden no
 *   significa nada, y el dia que Postgres cambie el plan cambia el resultado.
 * - **C.** Cualquier otra lectura multi-fila pasa por `fetchTodasLasFilas`.
 */
export function analizarFuente(fuente: string): Hallazgo[] {
  const texto = sinComentarios(fuente)
  const tramos = tramosPaginados(texto)
  const hallazgos: Hallazgo[] = []

  for (const tabla of LEDGERS) {
    const patron = new RegExp(`\\.\\s*from\\s*\\(\\s*['"\`]${tabla}['"\`]\\s*\\)`, 'g')
    let m: RegExpExecArray | null

    while ((m = patron.exec(texto)) !== null) {
      const piezas = cadenaDesde(texto, m.index)
      const metodos = new Set(piezas.map((p) => p.metodo))
      const linea = texto.slice(0, m.index).split('\n').length
      const cadena = piezas.map((p) => p.metodo).join('.')

      if ([...ESCRITURAS].some((e) => metodos.has(e))) continue
      if ([...UNA_FILA].some((u) => metodos.has(u))) continue
      if (metodos.has('range')) continue
      // El conteo puro: `select(..., { head: true })` no trae filas. Ver arriba.
      const seleccion = piezas.find((p) => p.metodo === 'select')
      if (seleccion && CUENTA_SIN_FILAS.test(seleccion.argumento)) continue
      if (tramos.some(([desde, hasta]) => m!.index > desde && m!.index < hasta)) continue

      const limite = piezas.find((p) => p.metodo === 'limit')
      if (limite) {
        const n = Number(limite.argumento.trim())
        if (!Number.isFinite(n) || n >= LIMITE_MAXIMO_RAZONABLE) {
          hallazgos.push({ clase: 'limite-grande', tabla, linea, cadena })
        } else if (!metodos.has('order')) {
          hallazgos.push({ clase: 'limite-sin-orden', tabla, linea, cadena })
        }
        continue
      }

      hallazgos.push({ clase: 'sin-paginar', tabla, linea, cadena })
    }
  }

  return hallazgos
}

function archivosDeCodigo(): string[] {
  const encontrados: string[] = []

  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (DIRECTORIOS_IGNORADOS.has(entrada)) continue
      const completo = path.join(dir, entrada)
      if (statSync(completo).isDirectory()) recorrer(completo)
      else if (EXTENSIONES.has(path.extname(entrada))) encontrados.push(completo)
    }
  }

  for (const carpeta of CARPETAS) recorrer(path.join(RAIZ, carpeta))
  return encontrados
}

const EXPLICACION: Record<ClaseDeFalla, string> = {
  'limite-grande':
    'ERP-25 · `.limit(N)` con N >= 100 sobre un ledger. PostgREST corta en 1000 sin avisar, ' +
    'asi que ese numero no pide "todo": pide un truncamiento. Usa `fetchTodasLasFilas` de ' +
    '`lib/paginacion.ts`.',
  'limite-sin-orden':
    'ERP-25 · `.limit(N)` sin `.order(...)`. "Los ultimos N" sin un orden declarado son N ' +
    'cualesquiera, y cambian cuando cambie el plan de Postgres.',
  'sin-paginar':
    'ERP-25 · lectura multi-fila de un ledger sin paginar. Un ledger truncado NO da error: da ' +
    'un stock o un saldo falso. Envuelvela en `fetchTodasLasFilas` de `lib/paginacion.ts`, o ' +
    'cierra la lectura con `.single()` / `.maybeSingle()` si de verdad es una fila.'
}

test.describe('ERP-25 · ninguna lectura de ledger se lee truncada', () => {
  test('todo el codigo de app/, lib/ y components/ pagina sus ledgers', () => {
    const fallas: string[] = []

    for (const archivo of archivosDeCodigo()) {
      const relativo = path.relative(RAIZ, archivo).replace(/\\/g, '/')
      for (const h of analizarFuente(readFileSync(archivo, 'utf8'))) {
        fallas.push(`${relativo}:${h.linea} → ${h.tabla} (${h.cadena})\n    ${EXPLICACION[h.clase]}`)
      }
    }

    expect(fallas, `Lecturas de ledger sin paginar:\n\n${fallas.join('\n\n')}\n`).toEqual([])
  })

  test('el analizador de verdad mira el repo: encuentra las lecturas paginadas', () => {
    // Control de instrumento. Si `LEDGERS` o la busqueda de archivos se rompen,
    // la prueba de arriba pasaria en verde por no haber mirado nada.
    const conLedger = archivosDeCodigo().filter((archivo) =>
      LEDGERS.some((t) => readFileSync(archivo, 'utf8').includes(`'${t}'`))
    )

    expect(conLedger.length).toBeGreaterThan(15)
  })

  test('CONTROL NEGATIVO: los tres defectos se detectan, y lo correcto no', () => {
    const roto = (cuerpo: string) => analizarFuente(`const x = ${cuerpo}`)

    // A — el `.limit(1000)` literal de ERP-25.
    expect(roto(`supabase.from('inventario_ledger').select('cantidad').limit(1000)`)[0]?.clase).toBe(
      'limite-grande'
    )

    // B — un "ultimos N" sin orden.
    expect(roto(`supabase.from('finanzas_ledger').select('monto').limit(20)`)[0]?.clase).toBe(
      'limite-sin-orden'
    )

    // C — el defecto que de verdad estaba vivo: ni limit ni range.
    expect(
      roto(`supabase.from('inventario_ledger').select('cantidad').eq('status', 'ACTIVO')`)[0]?.clase
    ).toBe('sin-paginar')

    // D — el conteo puro, que NO es un defecto: `head: true` no trae filas.
    expect(
      roto(
        `supabase.from('finanzas_ledger').select('id', { count: 'exact', head: true }).eq('id_ticket', t)`
      )
    ).toEqual([])
    expect(
      roto(
        `supabase.from('inventario_ledger').select('id', { head: true, count: 'exact' }).ilike('notas', p)`
      )
    ).toEqual([])

    // ...pero contar TRAYENDOSE las filas si lo es, y es el defecto que ERP-25
    // nombra. La exencion tiene que morder solo con `head: true`, no con
    // cualquier `count`.
    expect(
      roto(`supabase.from('finanzas_ledger').select('id', { count: 'exact' }).eq('id_ticket', t)`)[0]
        ?.clase
    ).toBe('sin-paginar')

    // Y los cuatro casos legitimos, que tienen que salir limpios.
    expect(roto(`supabase.from('finanzas_ledger').select('monto').order('fecha').limit(20)`)).toEqual([])
    expect(roto(`supabase.from('finanzas_ledger').select('monto').eq('id', id).single()`)).toEqual([])
    expect(roto(`supabase.from('finanzas_ledger').insert(payload)`)).toEqual([])
    expect(
      analizarFuente(
        `const y = await fetchTodasLasFilas<Fila>(() => supabase.from('finanzas_ledger').select('monto'), 'x')`
      )
    ).toEqual([])
  })

  test('CONTROL NEGATIVO: una consulta escrita DENTRO de un comentario no cuenta', () => {
    // `lib/vistas.ts` documenta el problema de tipos escribiendo
    // `client.from('v_saldo_entidad')` en su JSDoc. Sin esta regla, la prueba se
    // pondria roja por una explicacion — y un centinela que grita sin razon se
    // apaga a la semana.
    expect(analizarFuente(`/** client.from('v_saldo_entidad').select('*') */`)).toEqual([])
    expect(analizarFuente(`// supabase.from('finanzas_ledger').select('monto')`)).toEqual([])

    // Pero el de al lado, que es codigo, si cuenta.
    const mezcla = `
      /** Ejemplo: supabase.from('v_cartera').select('*') */
      const x = supabase.from('v_cartera').select('deuda')
    `
    expect(analizarFuente(mezcla).map((h) => h.clase)).toEqual(['sin-paginar'])
  })
})
