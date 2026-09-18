import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * CENTINELA — el enrutador del bot (Fase 2 de "Telegram como unica interfaz").
 *
 * El enrutador vive en Python y no se puede probar desde Playwright sin montar
 * un Telegram falso. Lo que SI se puede vigilar, y es lo que de verdad se
 * rompe en silencio, son las propiedades estructurales:
 *
 *   1. que el enrutador NO escriba en la base por su cuenta, saltandose la
 *      puerta sellada (`/proponer` -> boton VA -> `/confirmar`);
 *   2. que la cascada vieja siga existiendo como red de seguridad;
 *   3. que el prompt conserve las reglas que hacen al bot conciso, que son
 *      requisito de Norman y no estilo.
 *
 * Son pruebas estaticas sobre el texto de los archivos: baratas, deterministas,
 * y fallan el dia que alguien borre la red o le quite una regla al prompt.
 */

const RAIZ = join(__dirname, '..')
const ENRUTADOR = join(RAIZ, 'bot', 'enrutador.py')
const BOT = join(RAIZ, 'bot', 'bot_gastos.py')

function leer(ruta: string): string {
  return readFileSync(ruta, 'utf-8')
}

/** Quita comentarios y docstrings para no juzgar el codigo por su prosa. */
function soloCodigo(fuente: string): string {
  return fuente
    .replace(/"""[\s\S]*?"""/g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('#'))
    .join('\n')
}

test.describe('ERP-85 · el enrutador del bot', () => {
  test('el enrutador no escribe: no conoce la red ni la base', () => {
    // Si algun dia el enrutador aprendiera a hacer POST, el modelo podria
    // mandar una fila sin pasar por el sello. La frontera se defiende aqui,
    // donde es una linea, y no en una revision de codigo que se olvida.
    const codigo = soloCodigo(leer(ENRUTADOR))
    for (const prohibido of ['urllib', 'requests', '_post(', 'supabase', 'psycopg']) {
      expect(codigo, `enrutador.py no debe usar ${prohibido}`).not.toContain(prohibido)
    }
  })

  test('la cascada vieja sigue siendo la red de seguridad', () => {
    // El bot lleva meses capturando gastos. Un modulo nuevo no se apuesta el
    // camino que ya funciona: si el enrutador falla, se cae al de siempre.
    const codigo = soloCodigo(leer(BOT))
    expect(codigo).toContain('_enrutar_y_despachar')
    expect(codigo, 'el camino viejo _proponer tiene que seguir invocandose').toContain(
      '_proponer(update, texto, _pendiente)'
    )
  })

  test('el despacho pasa por la puerta sellada, nunca directo a la base', () => {
    const codigo = soloCodigo(leer(BOT))
    expect(codigo).toContain("_post(\"/api/bot/gasto/proponer\"")
    // Confirmar manda solo el sello; jamas la fila.
    expect(codigo).not.toContain('insert into')
  })

  test('el prompt conserva las reglas de concision que pidio Norman', () => {
    const fuente = leer(ENRUTADOR)
    const REGLAS: Array<[string, string]> = [
      ['no inventar valores', 'NUNCA inventes un valor'],
      ['una sola pregunta', 'UNA sola, corta'],
      ['no repetir lo entendido', 'NUNCA le repitas de vuelta'],
      ['la fecha nunca se pregunta', 'LA FECHA NUNCA ES OBLIGATORIA'],
      ['nada de menus', 'Nunca contestes con un menu']
    ]
    for (const [nombre, marca] of REGLAS) {
      expect(fuente, `falta la regla: ${nombre}`).toContain(marca)
    }
  })

  test('toda intencion declarada tiene un camino en el bot', () => {
    // Una intencion que el enrutador sabe producir pero que el bot no sabe
    // atender es un mensaje que se traga en silencio.
    const enrutador = leer(ENRUTADOR)
    const bloque = enrutador.slice(
      enrutador.indexOf('INTENCIONES = ('),
      enrutador.indexOf(')', enrutador.indexOf('INTENCIONES = ('))
    )
    const intenciones = [...bloque.matchAll(/"([a-z]+)"/g)].map((m) => m[1])
    expect(intenciones.length, 'no se leyeron las intenciones').toBeGreaterThan(4)

    const bot = leer(BOT)
    for (const intencion of intenciones) {
      if (intencion === 'charla') continue // es el cajon por defecto, no lleva rama
      expect(bot, `la intencion "${intencion}" no se atiende en bot_gastos.py`).toContain(
        `"${intencion}"`
      )
    }
  })

  test('control negativo: el centinela detecta un enrutador que escribiera', () => {
    const impostor = 'import urllib.request\ndef enrutar(): _post("/api/bot/gasto/confirmar")'
    expect(soloCodigo(impostor)).toContain('urllib')
  })
})
