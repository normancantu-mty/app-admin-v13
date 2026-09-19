import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * EL CANDADO DE LAS COLUMNAS INVENTADAS — la leccion del 2026-09-19.
 *
 * Que paso: los tres `proponer` nuevos de la Fase 5 (`anular`, `entidad`,
 * `convertir`) insertaban en `bot_borradores` una columna `id_entidad` que **no
 * existe en la tabla**. Copie el bloque de un endpoint viejo donde ese dato iba
 * dentro de `meta` —que es `jsonb` y aguanta lo que sea— y lo subi un nivel.
 *
 * ─── POR QUE NI `tsc` NI EL TIPADO LO VIERON ────────────────────────────────
 *
 * `types/database.ts` esta bien: el `Insert` de `bot_borradores` no tiene
 * `id_entidad`. Pero `.insert()` de supabase-js es **generico**, y TypeScript no
 * hace revision de propiedades sobrantes cuando el parametro es un generico que
 * se infiere del argumento: la llave de mas entra sin una sola linea roja.
 *
 * El sintoma fue un 500 al final de un flujo de siete pasos: la persona
 * contestaba rol, zona, duplicado y comision, y hasta la ultima pantalla salia
 * "No pude prepararlo. No cree nada." Nada se escribia —eso estuvo bien— pero
 * el error solo se veia en la consola del servidor.
 *
 * Esta prueba lee el `Insert` de `types/database.ts` y lo compara contra las
 * llaves de PRIMER NIVEL de cada `insert` a `bot_borradores` en el codigo. Es
 * pura: no necesita base, ni red, ni sesion.
 */

const RAIZ = path.resolve(__dirname, '..')
const TABLA = 'bot_borradores'

/** Las llaves del `Insert` de la tabla, leidas del tipado generado. */
function columnasPermitidas(): Set<string> {
  const fuente = readFileSync(path.join(RAIZ, 'types', 'database.ts'), 'utf8')
  const inicio = fuente.indexOf(`      ${TABLA}: {`)
  expect(inicio, `no encontre ${TABLA} en types/database.ts`).toBeGreaterThan(-1)
  const desdeInsert = fuente.indexOf('Insert: {', inicio)
  expect(desdeInsert, `no encontre el Insert de ${TABLA}`).toBeGreaterThan(-1)
  const fin = fuente.indexOf('Update: {', desdeInsert)
  const bloque = fuente.slice(desdeInsert, fin)
  const llaves = new Set<string>()
  for (const linea of bloque.split('\n').slice(1)) {
    const m = /^\s{10}([a-z_]+)\??:/.exec(linea)
    if (m) llaves.add(m[1])
  }
  return llaves
}

/** Todos los `route.ts` debajo de `app/api/bot`. */
function rutasDelBot(): string[] {
  const salida: string[] = []
  const recorrer = (dir: string) => {
    for (const nombre of readdirSync(dir)) {
      const completo = path.join(dir, nombre)
      if (statSync(completo).isDirectory()) recorrer(completo)
      else if (nombre === 'route.ts') salida.push(completo)
    }
  }
  recorrer(path.join(RAIZ, 'app', 'api', 'bot'))
  return salida
}

/**
 * Las llaves de primer nivel del objeto literal que empieza en `desde`.
 *
 * Cuenta llaves y corchetes para saber la profundidad, y solo apunta lo que
 * esta a profundidad 1. Asi `meta: { id_entidad: ... }` NO se confunde con una
 * columna: `id_entidad` ahi adentro va a profundidad 2, dentro del `jsonb`.
 */
function llavesDePrimerNivel(fuente: string, desde: number): { llaves: string[]; fin: number } {
  const llaves: string[] = []
  let profundidad = 0
  let i = desde
  let inicioDeLinea = true
  for (; i < fuente.length; i++) {
    const c = fuente[i]
    if (c === '{' || c === '[' || c === '(') profundidad++
    else if (c === '}' || c === ']' || c === ')') {
      profundidad--
      if (profundidad === 0) break
    } else if (c === '\n') inicioDeLinea = true
    else if (profundidad === 1 && inicioDeLinea && /[a-z_]/i.test(c)) {
      const resto = fuente.slice(i)
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*[:,\n]/.exec(resto)
      if (m) llaves.push(m[1])
      inicioDeLinea = false
    } else if (!/\s/.test(c)) inicioDeLinea = false
  }
  return { llaves, fin: i }
}

test(`ningun endpoint del bot inserta una columna que ${TABLA} no tiene`, () => {
  const permitidas = columnasPermitidas()
  // Control de que la lectura del tipado sirvio: si esto se vacia, la prueba
  // pasaria siempre y no protegeria nada.
  expect(permitidas.has('sello')).toBe(true)
  expect(permitidas.has('payload')).toBe(true)
  expect(permitidas.has('id_entidad')).toBe(false)

  let inserts = 0
  for (const ruta of rutasDelBot()) {
    const fuente = readFileSync(ruta, 'utf8')
    let cursor = 0
    for (;;) {
      const enLaTabla = fuente.indexOf(`.from('${TABLA}')`, cursor)
      if (enLaTabla === -1) break
      const insert = fuente.indexOf('.insert(', enLaTabla)
      const otroFrom = fuente.indexOf('.from(', enLaTabla + 6)
      cursor = enLaTabla + 6
      // Solo el `insert` que le pertenece a ESTE `from`.
      if (insert === -1 || (otroFrom !== -1 && insert > otroFrom)) continue

      const llave = fuente.indexOf('{', insert)
      const { llaves, fin } = llavesDePrimerNivel(fuente, llave)
      cursor = fin
      inserts++

      const relativa = path.relative(RAIZ, ruta).replace(/\\/g, '/')
      for (const k of llaves) {
        expect(
          permitidas.has(k),
          `${relativa} inserta "${k}" en ${TABLA}, y esa columna no existe`
        ).toBe(true)
      }
    }
  }

  // Sin esto, borrar todos los endpoints dejaria la prueba en verde.
  expect(inserts, `no encontre ni un insert a ${TABLA}`).toBeGreaterThanOrEqual(6)
})

test('control negativo: una columna inventada SI se detecta', () => {
  const permitidas = columnasPermitidas()
  const falso = `
    const { data } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: 1,
        id_entidad: 'x',
        sello,
        payload: { meta: { id_entidad: 'y' } }
      })
  `
  const llave = falso.indexOf('{', falso.indexOf('.insert('))
  const { llaves } = llavesDePrimerNivel(falso, llave)
  const intrusas = llaves.filter((k) => !permitidas.has(k))
  // La de adentro de `payload.meta` NO cuenta; la de arriba si, y una sola vez.
  expect(intrusas).toEqual(['id_entidad'])
})

/**
 * EL SEGUNDO CANDADO — el UNIQUE parcial `bot_borradores_uno_pendiente`.
 *
 * La tabla tiene `CREATE UNIQUE INDEX ... ON (telegram_id) WHERE estado =
 * 'PENDIENTE'`: una persona puede tener UN borrador abierto, no dos. Es una
 * decision de interfaz antes que de base — con dos borradores abiertos un "va"
 * es ambiguo— pero se hace cumplir en Postgres, y quien no la respeta no recibe
 * un aviso: recibe un 23505 al final del flujo, cuando la persona ya contesto
 * todo.
 *
 * Asi se cayo el alta el 2026-09-19: los tres `proponer` nuevos insertaban sin
 * cancelar lo anterior, y el segundo intento de la sesion moria en el ultimo
 * paso. Un borrador cancelado de una conversacion vieja bastaba para dejar el
 * alta inservible hasta que alguien mirara la consola del servidor.
 */
test('todo `proponer` del bot cancela el borrador PENDIENTE antes de insertar', () => {
  const rutas = rutasDelBot().filter((r) => r.split(path.sep).includes('proponer'))
  expect(rutas.length, 'no encontre ni un proponer').toBeGreaterThanOrEqual(8)

  for (const ruta of rutas) {
    const relativa = path.relative(RAIZ, ruta).split(path.sep).join('/')
    const fuente = readFileSync(ruta, 'utf8')

    const desdeTabla = fuente.indexOf(`.from('${TABLA}')`)
    const inserta = desdeTabla === -1 ? -1 : fuente.indexOf('.insert(', desdeTabla)
    if (inserta === -1) continue // un `proponer` que no guarda borrador no aplica

    // El `update` a CANCELADO tiene que estar ANTES del insert, y filtrar por
    // las dos columnas: sin `.eq('estado', 'PENDIENTE')` cancelaria tambien los
    // CONFIRMADO, que son el historial.
    const cancela = fuente.indexOf("estado: 'CANCELADO'")
    expect(cancela, `${relativa} no cancela el borrador anterior`).toBeGreaterThan(-1)
    expect(
      cancela < inserta,
      `${relativa} cancela DESPUES de insertar, que es demasiado tarde`
    ).toBe(true)

    const bloque = fuente.slice(cancela, inserta)
    expect(bloque, `${relativa} no filtra por telegram_id al cancelar`).toContain(
      ".eq('telegram_id', telegramId)"
    )
    expect(bloque, `${relativa} no filtra por PENDIENTE al cancelar`).toContain(
      ".eq('estado', 'PENDIENTE')"
    )
  }
})
