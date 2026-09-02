import { test, expect } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * PRUEBA DE ARQUITECTURA — la regla que dejo escrita el incidente del 2026-09-02.
 *
 * Que paso: `lib/dashboard-utils.ts` y `lib/risk-utils.ts` importaban
 * `{ supabase } from '@/lib/supabase'`, que es un `createBrowserClient`. Usado
 * desde un Server Component ese cliente no ve las cookies de Next: viaja como
 * `anon`. Al cerrarse la lectura anonima la base empezo a contestar
 * `permission denied`, los `try/catch` lo convertian en `[]` y el Dashboard
 * General paso dias pintando ceros. `tsc`, `lint`, `npm test` y `npm run build`
 * estuvieron en verde todo ese tiempo.
 *
 * Esta prueba no necesita navegador, ni servidor, ni sesion, ni credenciales:
 * lee el codigo fuente del repo y termina en milisegundos. Por eso corre
 * siempre — en `npm test` y en CI — a diferencia de las de humo, que dependen
 * de una cuenta real. Una prueba que se salta no protege nada.
 */

const RAIZ = path.resolve(__dirname, '..')

/** El unico modulo prohibido: el cliente de NAVEGADOR. */
const CLIENTE_DE_NAVEGADOR = path.resolve(RAIZ, 'lib', 'supabase.ts')

/** Carpetas de codigo propio. `node_modules` y `.next` quedan fuera. */
const CARPETAS = ['app', 'lib', 'components']
const DIRECTORIOS_IGNORADOS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out'])
const EXTENSIONES = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])

/** El texto exacto que tiene que leer quien rompa la regla. */
const MENSAJE =
  'Este archivo corre en el servidor: usa createServerClient con cookies, no el cliente de ' +
  'navegador. Ver el incidente del 2026-09-02 en docs/MAPA_ERP_v001_2026-09-01.md.'

/**
 * UNICAS excepciones dentro de `lib/`, cada una con su porque.
 *
 * No se agregan en silencio: van aqui para que aparezcan en el diff y alguien
 * tenga que defenderlas en la revision. Y no basta con listarlas — la cuarta
 * prueba de este archivo vigila que sigan siendo ciertas: si un archivo de
 * SERVIDOR llega a importar cualquiera de estas, la suite falla igual.
 */
const EXCEPCIONES_LIB: ReadonlyArray<{ archivo: string; porque: string }> = [
  {
    archivo: 'lib/feed-utils.ts',
    porque:
      '`fetchAuditFeed` la llama unicamente <AuditFeed/>, que es "use client" y se ejecuta en ' +
      'el navegador dentro de un useEffect. Ahi el cliente de navegador es el correcto: lleva ' +
      'la sesion del usuario. El dia que un Server Component la importe, la cuarta prueba de ' +
      'este archivo truena y hay que pasarla al patron de lib/risk-utils.ts (cliente por ' +
      'parametro).'
  },
  {
    archivo: 'lib/auth-utils.client.ts',
    porque:
      'El sufijo `.client` declara el lado en el nombre del archivo, igual que lo haria un ' +
      '"use client". Hoy no lo importa nadie; si vuelve a usarse solo puede ser desde ' +
      'componentes de cliente, y la cuarta prueba lo verifica.'
  }
]

const ARCHIVOS_EXCEPTUADOS = new Set(
  EXCEPCIONES_LIB.map((excepcion) => path.resolve(RAIZ, excepcion.archivo))
)

// ============================================================================
// LECTURA DEL CODIGO FUENTE
// ============================================================================

function listarArchivos(directorio: string): string[] {
  if (!existsSync(directorio)) return []

  const encontrados: string[] = []
  for (const entrada of readdirSync(directorio, { withFileTypes: true })) {
    if (entrada.isDirectory()) {
      if (DIRECTORIOS_IGNORADOS.has(entrada.name)) continue
      encontrados.push(...listarArchivos(path.join(directorio, entrada.name)))
    } else if (EXTENSIONES.has(path.extname(entrada.name))) {
      encontrados.push(path.join(directorio, entrada.name))
    }
  }
  return encontrados
}

const ARCHIVOS_DEL_REPO = CARPETAS.flatMap((carpeta) => listarArchivos(path.join(RAIZ, carpeta)))

/**
 * Quita comentarios conservando el numero de lineas, para que el reporte apunte
 * a la linea real. Sin esto, la prosa de `lib/risk-utils.ts` — que CITA el
 * import prohibido para explicar el bug — se contaria como violacion.
 */
function sinComentarios(codigo: string): string {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, (bloque) => bloque.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_coincidencia, antes: string) => antes)
}

/** Un archivo es DE CLIENTE si su primera linea util es 'use client'. */
function esArchivoDeCliente(codigo: string): boolean {
  const primeraLineaUtil = sinComentarios(codigo)
    .split('\n')
    .map((linea) => linea.trim())
    .find((linea) => linea.length > 0)

  return /^['"]use client['"]/.test(primeraLineaUtil ?? '')
}

const PATRONES_DE_IMPORT = [
  /(?:^|\n)\s*import\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from 'y' (tambien multilinea)
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g, //                  import 'y'
  /(?:^|\n)\s*export\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g, // export ... from 'y'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, //                 import('y')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g //                 require('y')
]

/** Convierte `@/lib/supabase` o `./supabase` en la ruta absoluta del archivo. */
function resolverModulo(especificador: string, archivoOrigen: string): string | null {
  let base: string
  if (especificador.startsWith('@/')) {
    base = path.resolve(RAIZ, especificador.slice(2))
  } else if (especificador.startsWith('.')) {
    base = path.resolve(path.dirname(archivoOrigen), especificador)
  } else {
    return null // paquete de node_modules: no es codigo del repo
  }

  for (const sufijo of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']) {
    const candidato = base + sufijo
    if (existsSync(candidato) && statSync(candidato).isFile()) return path.resolve(candidato)
  }
  return null
}

interface ImportacionResuelta {
  destino: string
  linea: number
  texto: string
}

function importacionesDe(archivo: string, codigo: string): ImportacionResuelta[] {
  const limpio = sinComentarios(codigo)
  const lineasOriginales = codigo.split('\n')
  const encontradas = new Map<string, ImportacionResuelta>()

  for (const patron of PATRONES_DE_IMPORT) {
    patron.lastIndex = 0
    let coincidencia: RegExpExecArray | null
    while ((coincidencia = patron.exec(limpio)) !== null) {
      const destino = resolverModulo(coincidencia[1], archivo)
      if (!destino) continue

      const linea = limpio.slice(0, coincidencia.index + coincidencia[0].length).split('\n').length
      const clave = `${destino}:${linea}`
      if (!encontradas.has(clave)) {
        encontradas.set(clave, {
          destino,
          linea,
          texto: lineasOriginales[linea - 1]?.trim() ?? ''
        })
      }
    }
  }

  return [...encontradas.values()]
}

/** Se lee el repo una sola vez; las pruebas de abajo consultan este mapa. */
const REPO = ARCHIVOS_DEL_REPO.map((archivo) => {
  const codigo = readFileSync(archivo, 'utf8')
  return {
    absoluto: archivo,
    relativo: path.relative(RAIZ, archivo).split(path.sep).join('/'),
    esCliente: esArchivoDeCliente(codigo),
    importaciones: importacionesDe(archivo, codigo)
  }
})

interface Violacion {
  relativo: string
  linea: number
  texto: string
}

function importadoresDe(
  destinos: Set<string>,
  filtro: (archivo: (typeof REPO)[number]) => boolean
): Violacion[] {
  return REPO.filter(filtro).flatMap((archivo) =>
    archivo.importaciones
      .filter((importacion) => destinos.has(importacion.destino))
      .map((importacion) => ({
        relativo: archivo.relativo,
        linea: importacion.linea,
        texto: importacion.texto
      }))
  )
}

function reportar(violaciones: Violacion[], encabezado: string): string {
  const lineas = violaciones.map(
    (violacion) => `  ${violacion.relativo}:${violacion.linea}  ${violacion.texto}`
  )
  return `${encabezado}\n\n${lineas.join('\n')}\n\n${MENSAJE}`
}

const SOLO_EL_PROHIBIDO = new Set([CLIENTE_DE_NAVEGADOR])

// ============================================================================
// LAS REGLAS
// ============================================================================

test.describe('arquitectura: el cliente de navegador no cruza al servidor', () => {
  test('el repo se leyo de verdad (guardia contra un escaneo vacio)', () => {
    // Si un refactor mueve las carpetas, las pruebas de abajo pasarian por no
    // encontrar nada que revisar. Este piso lo impide.
    expect(
      REPO.length,
      'El escaneo no encontro archivos en app/, lib/ ni components/: revisa CARPETAS y RAIZ.'
    ).toBeGreaterThan(50)
    expect(existsSync(CLIENTE_DE_NAVEGADOR), `No existe ${CLIENTE_DE_NAVEGADOR}`).toBe(true)
  })

  test('lib/** nunca importa el cliente de navegador', () => {
    const violaciones = importadoresDe(
      SOLO_EL_PROHIBIDO,
      (archivo) =>
        archivo.relativo.startsWith('lib/') && !ARCHIVOS_EXCEPTUADOS.has(archivo.absoluto)
    )

    expect(
      violaciones,
      reportar(
        violaciones,
        `${violaciones.length} archivo(s) de lib/ importan lib/supabase.ts (createBrowserClient). ` +
          'Los modulos compartidos reciben el cliente por parametro (ver lib/risk-utils.ts) o ' +
          'construyen el suyo con createServerClient (ver lib/dashboard-utils.ts).'
      )
    ).toEqual([])
  })

  test('ningun archivo de servidor en app/ o components/ importa el cliente de navegador', () => {
    const violaciones = importadoresDe(
      SOLO_EL_PROHIBIDO,
      (archivo) =>
        (archivo.relativo.startsWith('app/') || archivo.relativo.startsWith('components/')) &&
        !archivo.esCliente
    )

    expect(
      violaciones,
      reportar(
        violaciones,
        `${violaciones.length} archivo(s) sin 'use client' importan lib/supabase.ts. ` +
          'Server Components, layouts, route handlers y server actions leen la sesion con ' +
          'createServerClient y el cookieStore ya resuelto (`await cookies()`).'
      )
    ).toEqual([])
  })

  test('las excepciones de lib/ solo las importan archivos de cliente', () => {
    const violaciones = importadoresDe(ARCHIVOS_EXCEPTUADOS, (archivo) => !archivo.esCliente)

    expect(
      violaciones,
      reportar(
        violaciones,
        `${violaciones.length} archivo(s) de servidor importan un modulo exceptuado de lib/. ` +
          'La excepcion valia solo mientras ese modulo corriera unicamente en el navegador, y ' +
          'ese supuesto acaba de romperse. Excepciones vigentes:\n' +
          EXCEPCIONES_LIB.map(
            (excepcion) => `    - ${excepcion.archivo}: ${excepcion.porque}`
          ).join('\n')
      )
    ).toEqual([])
  })

  test('la lista de excepciones no tiene entradas muertas', () => {
    // Una excepcion que ya no hace falta es permiso regalado. Si el archivo
    // desaparece o deja de importar el cliente, hay que borrarla de la lista.
    const muertas = EXCEPCIONES_LIB.filter((excepcion) => {
      const absoluto = path.resolve(RAIZ, excepcion.archivo)
      if (!existsSync(absoluto)) return true
      const entrada = REPO.find((archivo) => archivo.absoluto === absoluto)
      return !entrada?.importaciones.some(
        (importacion) => importacion.destino === CLIENTE_DE_NAVEGADOR
      )
    })

    expect(
      muertas.map((excepcion) => excepcion.archivo),
      'Estas excepciones ya no importan el cliente de navegador (o el archivo ya no existe). ' +
        'Borralas de EXCEPCIONES_LIB en tests/arquitectura.spec.ts.'
    ).toEqual([])
  })
})
