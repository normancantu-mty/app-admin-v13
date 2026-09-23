import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CONSULTAS } from '../lib/bot-consultas'

/**
 * CENTINELA — el enrutador del bot (Fase 2 de "Telegram como unica interfaz").
 *
 * El enrutador vive en Python y no se puede probar desde Playwright sin montar
 * un Telegram falso. Lo que SI se puede vigilar, y es lo que de verdad se
 * rompe en silencio, son las propiedades estructurales:
 *
 *   1. que el enrutador NO escriba en la base por su cuenta, saltandose la
 *      puerta sellada (`/proponer` -> boton VA -> `/confirmar`);
 *   2. que la cascada vieja siga RETIRADA — un mensaje, un solo lector — y que
 *      los tres cables del enrutador (borrador, voz, consulta) sigan puestos;
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

  test('la cascada vieja esta retirada: un mensaje, un solo lector', () => {
    // ─── ESTA PRUEBA DECIA LO CONTRARIO HASTA EL 2026-09-19 ─────────────────
    //
    // Exigia que `_proponer(update, texto, _pendiente)` siguiera invocandose,
    // con el argumento de que un modulo nuevo no se apuesta el camino que ya
    // funciona. El argumento era bueno y la conclusion estaba mal, porque la
    // cascada vieja no es una red: es un SEGUNDO LECTOR del mismo mensaje, con
    // otro prompt. Mientras estuvieron los dos cableados, el mismo dictado se
    // podia entender de dos maneras distintas segun cual corriera, y cual
    // corria dependia del orden de unos `if`. Dos lecturas que discrepan sobre
    // el monto de un gasto se ven igual desde afuera: las dos escriben una
    // fila con cara de correcta.
    //
    // La red de verdad son los comandos, que no pasan por ningun modelo y por
    // lo tanto siguen de pie cuando el modelo no. Eso es lo que se vigila aqui.
    const codigo = soloCodigo(leer(BOT))
    expect(codigo).toContain('_enrutar_y_despachar')

    for (const muerto of ['extraer(', 'extraer_abono(', 'clasificar(']) {
      expect(codigo, `bot_gastos.py no debe volver a llamar a ${muerto}`).not.toContain(muerto)
    }
    expect(codigo, 'no debe volver a importar los extractores retirados').not.toMatch(
      /^from (extraer|extraer_abono|consultar) import/m
    )

    // Y la red que SI queda tiene que seguir existiendo.
    for (const comando of ['/stock', '/cartera', '/ventas', '/abono']) {
      expect(codigo, `el comando ${comando} es la red sin modelo`).toContain(comando)
    }
  })

  test('los tres modulos retirados siguen en el repo, y lo dicen', () => {
    // Regla 6: aqui nada se borra. Pero un archivo sin llamador y sin aviso es
    // una trampa para el siguiente que lo lea y decida "esto no se usa, lo
    // cableo" — que es exactamente como llegaron a estar dos lectores vivos.
    for (const nombre of ['extraer', 'extraer_abono', 'consultar']) {
      const fuente = leer(join(RAIZ, 'bot', `${nombre}.py`))
      expect(fuente, `${nombre}.py debe seguir existiendo`).not.toHaveLength(0)
      expect(fuente.slice(0, 600), `${nombre}.py debe avisar que esta retirado`).toContain(
        'RETIRADO'
      )
    }
  })

  test('el borrador a medias llega al enrutador, y no como None literal', () => {
    // ─── EL CABLE 1.a ───────────────────────────────────────────────────────
    // `enrutar(texto, borrador, catalogo, deudores)` tiene sitio para lo que ya
    // se sabia de una captura incompleta. Hasta el 2026-09-19 el bot le mandaba
    // `None` en ese hueco y guardaba, en su lugar, el TEXTO de la vuelta
    // anterior para pegarselo al siguiente con un ". ". La diferencia no es de
    // forma: con el texto pegado el modelo re-extrae TODO en cada vuelta y
    // puede cambiar de opinion sobre un campo que nadie volvio a mencionar.
    const codigo = soloCodigo(leer(BOT))
    expect(codigo, 'el hueco del borrador no puede volver a ser None').not.toContain(
      'enrutar, texto, None'
    )
    expect(codigo).toContain('_tomar_borrador_a_medias(chat)')
    expect(codigo).toContain('_recordar_a_medias')

    // Y un borrador a medias NO lleva sello, porque todavia no hay nada que
    // sellar. Es esa ausencia la que impide confirmarlo antes de tiempo.
    expect(codigo).toContain("dato.get(\"estado\") == \"incompleto\"")
  })

  test('la voz entra por el enrutador, igual que el texto', () => {
    // ─── EL CABLE 1.b ───────────────────────────────────────────────────────
    // `manejar_voz` llamaba a la cascada vieja, asi que una nota de voz nunca
    // llegaba al enrutador: todo lo que agregaron las fases 3 y 4 (venta, lote,
    // cotizacion) existia solo para quien escribiera. Norman dicta.
    const fuente = leer(BOT)
    const voz = fuente.slice(fuente.indexOf('async def manejar_voz'))
    const cuerpo = soloCodigo(voz.slice(0, voz.indexOf('\nasync def ', 10)))
    expect(cuerpo, 'manejar_voz tiene que despachar por el enrutador').toContain(
      '_enrutar_y_despachar(update, chat, texto)'
    )
  })

  test('la consulta no se reclasifica: se usa la que trae la ruta', () => {
    // ─── EL CABLE 1.c ───────────────────────────────────────────────────────
    // El bot le preguntaba al modelo, por segunda vez, de que consulta se
    // trataba. Y las dos opiniones no hablaban el mismo idioma: `consultar.py`
    // conocia SEIS consultas y el servidor contesta TRES, asi que las otras
    // tres viajaban hasta el endpoint nada mas para que las rechazara.
    const codigo = soloCodigo(leer(BOT))
    expect(codigo).toContain('_contestar_consulta(update, chat, ruta.get("consulta")')

    // La lista cerrada vive en UN solo lugar: la tupla de Python es, letra por
    // letra, `CONSULTAS` de `lib/bot-consultas.ts` (Fase 8 D83 agrego produccion).
    const enrutador = leer(ENRUTADOR)
    const tupla = `CONSULTAS_QUE_CONTESTA = (${CONSULTAS.map((c) => `"${c}"`).join(', ')})`
    expect(CONSULTAS).toContain('produccion')
    expect(enrutador).toContain(tupla)

    // Control negativo: el centinela tiene que saber cazar la vuelta atras.
    expect(soloCodigo('await _contestar_consulta(update, chat, texto)')).not.toContain(
      '_contestar_consulta(update, chat, ruta.get("consulta")'
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
    // ─── COMO SE LEE EL BLOQUE, Y POR QUE ASI ───────────────────────────────
    // Esto cortaba en el PRIMER `)` despues de `INTENCIONES = (`. El 2026-09-19
    // se le agrego al bloque un comentario que mencionaba "(D2)", y el centinela
    // empezo a leer seis intenciones de doce — en verde, sin quejarse de nada.
    // Una prueba que se estrecha sola por un parentesis dentro de un comentario
    // es peor que no tenerla: sigue dando verde y ya no mira lo que decia mirar.
    // Ahora cierra en el `)` que abre renglon, y los comentarios se quitan
    // ANTES de sacar las comillas.
    const enrutador = leer(ENRUTADOR)
    const bloque = enrutador.match(/INTENCIONES = \(([\s\S]*?)\n\)/)
    expect(bloque, 'no se encontro el bloque INTENCIONES').not.toBeNull()
    const intenciones = [
      ...bloque![1]
        .split('\n')
        .filter((linea) => !linea.trim().startsWith('#'))
        .join('\n')
        .matchAll(/"([a-z]+)"/g)
    ].map((m) => m[1])
    expect(intenciones.length, 'no se leyeron las intenciones').toBeGreaterThan(4)
    // El centinela mide lo que dice medir: si el bloque crece, esto crece.
    expect(
      intenciones,
      'las cuatro intenciones de la Fase 5 tienen que estar en la lista leida'
    ).toEqual(expect.arrayContaining(['anular', 'corregir', 'alta', 'convertir']))

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
