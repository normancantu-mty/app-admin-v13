import { test, expect } from '@playwright/test'
import { spawnSync } from 'child_process'
import { readdirSync } from 'fs'
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
 */

const RAIZ = join(__dirname, '..')
const CARPETA_BOT = join(RAIZ, 'bot')

/** ¿Hay interprete? Se pregunta una vez, no en cada prueba. */
function pythonDisponible(): string | null {
  for (const candidato of ['python', 'python3']) {
    const r = spawnSync(candidato, ['--version'], { encoding: 'utf8' })
    if (r.status === 0) return candidato
  }
  return null
}

const PYTHON = pythonDisponible()

if (!PYTHON) {
  // Que falte el interprete tiene que VERSE, igual que una credencial faltante.
  // Un "skipped" callado es como se pierde la mitad de una suite.
  console.warn(
    '[playwright] Las pruebas de Python del bot se saltan: no hay `python` ni `python3` en el PATH.'
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
      encoding: 'utf8'
    })
    expect(r.status).toBe(3)
  })

  // Y el gemelo: que el interprete de verdad corra desde la raiz del repo, que
  // es de donde las pruebas importan `bot/`.
  test('CONTROL NEGATIVO: el interprete corre desde la raiz del repo', () => {
    const r = spawnSync(PYTHON as string, ['-c', 'import os; print(os.getcwd())'], {
      cwd: RAIZ,
      encoding: 'utf8'
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim().toLowerCase()).toBe(RAIZ.toLowerCase())
  })
})
