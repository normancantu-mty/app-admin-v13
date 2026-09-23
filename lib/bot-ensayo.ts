import { randomUUID } from 'node:crypto'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * MODO ENSAYO DEL BOT (Fase 7, D60) — el lado del servidor
 * ════════════════════════════════════════════════════════════════════════════
 *
 * El bot y las pruebas comparten UNA base: la de produccion. Probar el bot
 * punta a punta significaba escribir dinero de verdad, y en la Fase 6 el
 * auditor tuvo que doblar `/confirmar` a mano en cada arnes. Eso vivia en el
 * criterio del que prueba, no en el codigo.
 *
 * Con `BOT_ENSAYO=1`, el proceso del bot (`bot/bot_gastos.py`, `_post`) manda
 * la cabecera `x-bot-ensayo: 1` y **nunca** llama a una ruta `/confirmar` ni a
 * `/cancelar`. Este modulo es el SEGUNDO candado, y es el que hace que los
 * borradores **nunca se creen**:
 *
 * - Las LECTURAS pasan intactas: la propuesta que se ensena es la real
 *   (catalogo, precios, cartera de verdad).
 * - Toda ESCRITURA se niega por default, tabla por tabla y sin enumerar rutas:
 *   una ruta nueva queda cubierta el dia que nace.
 *   · `bot_borradores`: `insert` devuelve un id sintetico (UUID, el mismo
 *     formato que el real, para que `callback_data` no cambie de tamano) y
 *     `update`/`delete` no hacen nada. **No es cosmetico:** cada ruta `proponer`
 *     CANCELA los borradores PENDIENTE del mismo `telegram_id` antes de
 *     insertar. Un ensayo con el id de Norman le cancelaria el borrador real
 *     que tuviera abierto.
 *   · cualquier otra tabla, y cualquier `rpc`: error `ENSAYO`. Si algun dia
 *     una ruta de proponer escribe algo mas, contesta 500 en ensayo en vez de
 *     escribirlo.
 *
 * Cabecera y no campo del cuerpo: el cuerpo de un `/confirmar` es exactamente
 * `{telegram_id, borrador_id, sello}` y nadie tiene que tocarlo.
 */

export const CABECERA_ENSAYO = 'x-bot-ensayo'

export function esPeticionDeEnsayo(peticion?: Request | null): boolean {
  return peticion?.headers.get(CABECERA_ENSAYO) === '1'
}

/** Lo que devuelve una escritura negada o simulada, con la forma de PostgREST. */
interface Resultado {
  data: unknown
  error: { message: string; code: string } | null
  count: null
  status: number
  statusText: string
}

const METODOS_QUE_ESCRIBEN = new Set(['insert', 'update', 'upsert', 'delete'])

/** Las escrituras que se habrian hecho, para quien quiera leerlas (pruebas). */
export const escriturasNegadas: { tabla: string; metodo: string }[] = []

/**
 * Un constructor de consulta falso: cualquier filtro (`eq`, `select`,
 * `single`...) devuelve el mismo objeto, y al esperarlo resuelve `resultado`.
 */
function consultaFalsa(resolver: (single: boolean) => Resultado): unknown {
  let single = false
  const objetivo: Record<string, unknown> = {}
  const falsa: unknown = new Proxy(objetivo, {
    get(_o, prop) {
      if (prop === 'then') {
        return (ok: (r: Resultado) => unknown, mal?: (e: unknown) => unknown) =>
          Promise.resolve(resolver(single)).then(ok, mal)
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => {
          single = true
          return falsa
        }
      }
      return () => falsa
    }
  })
  return falsa
}

function escrituraSimulada(tabla: string, metodo: string): unknown {
  escriturasNegadas.push({ tabla, metodo })
  console.info(`[ENSAYO] ${metodo} en ${tabla}: no salio`)

  if (tabla === 'bot_borradores') {
    const id = randomUUID()
    return consultaFalsa((single) => ({
      data: metodo === 'insert' ? (single ? { id } : [{ id }]) : null,
      error: null,
      count: null,
      status: metodo === 'insert' ? 201 : 204,
      statusText: 'ENSAYO'
    }))
  }
  return consultaFalsa(() => ({
    data: null,
    error: { message: `[ENSAYO] escritura negada: ${metodo} en ${tabla}`, code: 'ENSAYO' },
    count: null,
    status: 409,
    statusText: 'ENSAYO'
  }))
}

/**
 * Envuelve un cliente de Supabase: lee de verdad, no escribe nunca. El tipo es
 * el mismo que el del cliente real a proposito, para que las rutas no cambien.
 */
export function clienteDeEnsayo<T extends object>(real: T): T {
  return new Proxy(real, {
    get(objetivo, prop, receptor) {
      if (prop === 'from') {
        return (tabla: string) => {
          const consulta = (objetivo as unknown as { from(t: string): object }).from(tabla)
          return new Proxy(consulta, {
            get(q, metodo, r) {
              if (typeof metodo === 'string' && METODOS_QUE_ESCRIBEN.has(metodo)) {
                return () => escrituraSimulada(tabla, metodo)
              }
              const valor = Reflect.get(q, metodo, r)
              return typeof valor === 'function' ? valor.bind(q) : valor
            }
          })
        }
      }
      if (prop === 'rpc') {
        return (nombre: string) => escrituraSimulada(`rpc:${nombre}`, 'rpc')
      }
      const valor = Reflect.get(objetivo, prop, receptor)
      return typeof valor === 'function' ? valor.bind(objetivo) : valor
    }
  })
}
