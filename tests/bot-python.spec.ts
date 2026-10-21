import { test, expect } from '@playwright/test'
import { spawnSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * EL PUENTE — las pruebas de Python, dentro de `npm run verificar`.
 *
 * ─── POR QUE EXISTE (D6/D8, 2026-09-19) ─────────────────────────────────────
 *
 * El bot vive en Python y la suite vive en Playwright. Hasta hoy eso significo
 * que **las pruebas de Python no las corria nadie**: `bot/probar_callback_data.py`
 * existe desde el 2026-09-12 y `npm run verificar` jamas la ejecuto. Una prueba
 * que solo corre cuando alguien se acuerda de escribir su nombre en una
 * terminal no es una comprobacion; es una intencion.
 *
 * Y la mitad gemela: los cuatro archivos que SI corrian sobre el bot
 * —`bot-enrutador.spec.ts` y sus vecinos— leian el codigo fuente con
 * `readFileSync` y comparaban texto. Por eso el defecto 1 vivio una semana:
 * `app/api/bot/cancelar/route.ts` estaba escrito, la prueba encontraba su texto,
 * y **nadie llamaba a la ruta**. Un arreglo cubierto por una prueba que hace
 * `readFileSync` no esta cubierto.
 *
 * Esto no lee codigo: lo CORRE, en el interprete que de verdad ejecuta el bot,
 * y falla en rojo si el codigo no hace lo que dice.
 *
 * ─── COMO SE AGREGA UNA PRUEBA ──────────────────────────────────────────────
 *
 * Se llama `bot/probar_<algo>.py`, sale con 0 si pasa y con !=0 si falla. No
 * hay que registrarla aqui: este archivo las descubre. Registrarlas a mano es
 * otra forma de "cuando alguien se acuerde".
 *
 * Y una regla para el script: NO llama al modelo real. `enrutador.enrutar` tiene
 * un solo `subprocess.run` (el de `claude -p`) y `probar_tope.py` lo dobla con un
 * `CompletedProcess` fijo; el `WARNING ... overloaded` que se ve en la salida es
 * el stderr SIMULADO del caso de control, no una llamada (medido 2026-10-21).
 */

const RAIZ = join(__dirname, '..')
const CARPETA_BOT = join(RAIZ, 'bot')

/**
 * ─── EL INTERPRETE Y SU CODIFICACION (E-615, 2026-10-21) ────────────────────
 *
 * El pre-push de Norman detuvo el push con `1178 passed · 2 failed`:
 * `probar_tope.py` y `probar_voz_salida.py` murieron con
 * `UnicodeEncodeError: 'charmap' codec can't encode character '\u2219'` al
 * imprimir su linea `ok/FALLA`. Dos causas, las dos de este archivo:
 *
 *  1. Tomaba `python` pelon del PATH. En la shell `(base)` de Norman eso es
 *     anaconda 3.12; el bot corre en `C:\Python310\python.exe`. Un puente que
 *     corre las pruebas en OTRO interprete que el bot no prueba el bot.
 *  2. No fijaba la codificacion de salida. Python en Windows hereda cp1252 de la
 *     consola y los scripts imprimen `∙` y `✅`. La misma suite pasaba o fallaba
 *     segun quien la lanzara y desde donde.
 *
 * Por eso: se prefiere el interprete del bot si existe y se anuncia cual se uso;
 * y TODO spawn de Python sale con UTF-8 fijado por el puente, no heredado. Las
 * variables se quitan del entorno padre antes de ponerlas, para que el control
 * de abajo no pase "porque la shell de hoy ya las traia".
 */
const PYTHON_DEL_BOT = 'C:\\Python310\\python.exe'

const _base: NodeJS.ProcessEnv = { ...process.env }
delete _base.PYTHONUTF8
delete _base.PYTHONIOENCODING
/** Entorno de TODO spawn de Python en este archivo: UTF-8 fijado, no heredado. */
const ENTORNO: NodeJS.ProcessEnv = { ..._base, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
/** El mismo entorno SIN la proteccion: solo lo usa el control negativo. */
const ENTORNO_CP1252: NodeJS.ProcessEnv = { ..._base, PYTHONIOENCODING: 'cp1252' }

/** ¿Hay interprete? Se pregunta una vez, no en cada prueba. */
function pythonDisponible(): string | null {
  const candidatos = existsSync(PYTHON_DEL_BOT) ? [PYTHON_DEL_BOT, 'python', 'python3'] : ['python', 'python3']
  for (const candidato of candidatos) {
    const r = spawnSync(candidato, ['--version'], { encoding: 'utf8', env: ENTORNO })
    if (r.status === 0) {
      console.log(`[playwright] Pruebas de Python del bot con: ${candidato} (${(r.stdout || r.stderr || '').trim()})`)
      return candidato
    }
  }
  return null
}

const PYTHON = pythonDisponible()

if (!PYTHON) {
  // Que falte el interprete tiene que VERSE, igual que una credencial faltante.
  // Un "skipped" callado es como se pierde la mitad de una suite.
  console.warn(
    `[playwright] Las pruebas de Python del bot se saltan: no existe ${PYTHON_DEL_BOT} ni hay \`python\`/\`python3\` en el PATH.`
  )
}

/** Los archivos de prueba del bot, descubiertos, no listados a mano. */
const PRUEBAS = readdirSync(CARPETA_BOT)
  .filter((n) => n.startsWith('probar_') && n.endsWith('.py'))
  .sort()

test.describe('las pruebas de Python del bot corren dentro de la suite', () => {
  test.skip(!PYTHON, 'No hay interprete de Python en el PATH.')

  // Control de que el descubrimiento sirve: si un dia el `readdirSync` apunta a
  // la carpeta equivocada, esta lista queda vacia y TODO lo de abajo daria
  // verde sin correr nada. Es el mismo modo de fallo que el defecto 1.
  test('hay pruebas de Python que correr', () => {
    expect(PRUEBAS.length).toBeGreaterThan(0)
    expect(PRUEBAS).toContain('probar_vigilante.py')
    expect(PRUEBAS).toContain('probar_callback_data.py')
  })

  for (const archivo of PRUEBAS) {
    test(`bot/${archivo}`, () => {
      const r = spawnSync(PYTHON as string, [join('bot', archivo)], {
        cwd: RAIZ,
        encoding: 'utf8',
        env: ENTORNO,
        timeout: 60_000
      })
      // La salida completa va al mensaje del fallo: quien lea el rojo tiene que
      // ver QUE caso fallo, no solo que algo fallo.
      const salida = (r.stdout || '') + (r.stderr || '')
      expect(r.status, `bot/${archivo} fallo:\n${salida}`).toBe(0)
    })
  }

  // CONTROL NEGATIVO, y es el que le da valor a los de arriba: el puente tiene
  // que poder dar ROJO. Si `spawnSync` estuviera mal armado —mal `cwd`, mal
  // interprete, la promesa sin esperar— cada prueba de arriba daria verde sin
  // ejecutar una linea, que es exactamente el hueco que estamos cerrando.
  test('CONTROL NEGATIVO: un Python que falla se ve como rojo', () => {
    const r = spawnSync(PYTHON as string, ['-c', 'import sys; sys.exit(3)'], {
      cwd: RAIZ,
      encoding: 'utf8',
      env: ENTORNO
    })
    expect(r.status).toBe(3)
  })

  // E-615: los scripts imprimen `∙` y `✅`. Con el entorno del puente eso sale
  // bien en CUALQUIER interprete y CUALQUIER consola; si un dia alguien quita
  // `ENTORNO` de un spawn, esto es lo que se pone rojo antes que el pre-push.
  test('E-615: el puente imprime fuera de cp1252 sin morir', () => {
    const r = spawnSync(PYTHON as string, ['-c', "print('\\u2219 \\u2705')"], {
      cwd: RAIZ,
      encoding: 'utf8',
      env: ENTORNO
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('∙ ✅')
  })

  // Y su control negativo: el MISMO print con la consola en cp1252 tiene que
  // morir con el error que detuvo el push. Si no muere, el control de arriba no
  // esta probando nada (la codificacion no dependia del entorno).
  test('CONTROL NEGATIVO E-615: con cp1252 el mismo print muere', () => {
    const r = spawnSync(PYTHON as string, ['-c', "print('\\u2219 \\u2705')"], {
      cwd: RAIZ,
      encoding: 'utf8',
      env: ENTORNO_CP1252
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('UnicodeEncodeError')
  })

  // El interprete que corre las pruebas tiene que ser el del bot cuando existe.
  // Si no, "las pruebas pasan" no dice nada sobre el proceso que de verdad corre.
  test('el puente usa el interprete del bot cuando existe', () => {
    test.skip(!existsSync(PYTHON_DEL_BOT), `No existe ${PYTHON_DEL_BOT} en esta maquina.`)
    expect(PYTHON).toBe(PYTHON_DEL_BOT)
    const r = spawnSync(PYTHON as string, ['-c', 'import sys; print(sys.executable)'], {
      cwd: RAIZ,
      encoding: 'utf8',
      env: ENTORNO
    })
    expect(r.stdout.trim().toLowerCase()).toBe(PYTHON_DEL_BOT.toLowerCase())
  })

  // Y el gemelo: que el interprete de verdad corra desde la raiz del repo, que
  // es de donde las pruebas importan `bot/`.
  test('CONTROL NEGATIVO: el interprete corre desde la raiz del repo', () => {
    const r = spawnSync(PYTHON as string, ['-c', 'import os; print(os.getcwd())'], {
      cwd: RAIZ,
      encoding: 'utf8',
      env: ENTORNO
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim().toLowerCase()).toBe(RAIZ.toLowerCase())
  })
})
