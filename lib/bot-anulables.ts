/**
 * AG-06 FASE 5 — LA LISTA DE LO QUE SE PUEDE ANULAR. Las lecturas.
 *
 * Vive separado de `lib/bot-anulacion.ts` porque aquello es aritmetica y texto
 * —probable sin base de datos, y por eso se prueba en el proyecto `puras`— y
 * esto son consultas. La frontera es la misma que separa `lib/bot-gastos.ts` de
 * `lib/bot-servidor.ts`.
 *
 * ─── LA LISTA Y LA GUARDA TIENEN QUE DECIR LO MISMO ─────────────────────────
 *
 * Quien autoriza de verdad es `assertAnnullmentAllowed`, en el momento de
 * escribir. Esta lista solo decide QUE BOTONES SE PINTAN. Si se armara con un
 * criterio mas ancho que la guarda, el bot ofreceria botones que al pulsarse
 * contestan "no autorizado" — que es, palabra por palabra, el defecto que D-E25
 * existe para no repetir.
 *
 * Por eso el filtro sale de `filtroDeAnulables()`, que reproduce la guarda, y
 * por eso `tests/bot-anulacion.spec.ts` compara las dos funciones campo por
 * campo en vez de confiar en que alguien se acuerde.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  describirFinanzas,
  describirInventario,
  filtroDeAnulables,
  MOVIMIENTOS_OFRECIDOS,
  ordenarAnulables,
  type ActorDelBot,
  type MovimientoAnulable
} from '@/lib/bot-anulacion'

type Cliente = SupabaseClient<Database>

/**
 * Los ultimos movimientos que ESTE actor puede anular, de los dos ledgers.
 *
 * Se piden `MOVIMIENTOS_OFRECIDOS` de cada lado y se recortan a esa misma
 * cantidad ya mezclados: pedir la mitad de cada uno daria una lista sesgada el
 * dia que solo haya movimientos de dinero, que es la mayoria de los dias.
 */
export async function listarAnulables(
  supabase: Cliente,
  actor: ActorDelBot,
  ahora: Date = new Date()
): Promise<MovimientoAnulable[]> {
  const filtro = filtroDeAnulables(actor, ahora)

  let qFin = supabase
    .from('finanzas_ledger')
    .select('id, fecha_movimiento, tipo_movimiento, monto, categoria, descripcion, id_ticket')
    // `APPROVED` sigue contando: la regla 4 de CLAUDE.md dice que el DEFAULT que
    // lo produce sigue vivo. Dejarlo fuera escondería filas reales de la lista,
    // y una fila que no se puede anular porque no se ve es peor que una que se
    // ve y se rechaza.
    .in('status', ['ACTIVO', 'APPROVED'])
    .order('fecha_movimiento', { ascending: false })
    // El 8 va LITERAL y no `MOVIMIENTOS_OFRECIDOS`, y es a proposito. El
    // centinela de ERP-25 lee el codigo fuente: un `.limit(<identificador>)` no
    // lo puede verificar desde el texto, asi que lo trata como sospechoso — y
    // hace bien, porque esa constante podria valer 5000. La duplicacion es la
    // misma decision que `VENTANA_EDICION_HORAS` en el trigger, y la vigila
    // igual una prueba: `tests/bot-anulacion.spec.ts` falla si divergen.
    .limit(8)

  let qInv = supabase
    .from('inventario_ledger')
    .select('id, fecha_movimiento, tipo_movimiento, cantidad, notas, id_producto')
    .eq('status', 'ACTIVO')
    .order('fecha_movimiento', { ascending: false })
    .limit(8) // Ver la nota de arriba: literal para que ERP-25 lo pueda leer.

  if (filtro.soloDeAutor) {
    qFin = qFin.eq('usuario_creador', filtro.soloDeAutor)
    qInv = qInv.eq('usuario_creador', filtro.soloDeAutor)
  }
  if (filtro.desdeISO) {
    qFin = qFin.gte('fecha_movimiento', filtro.desdeISO)
    qInv = qInv.gte('fecha_movimiento', filtro.desdeISO)
  }

  const [fin, inv] = await Promise.all([qFin, qInv])
  if (fin.error) throw new Error(fin.error.message)
  if (inv.error) throw new Error(inv.error.message)

  const filasInv = inv.data ?? []
  const nombres = await nombresDeProducto(
    supabase,
    filasInv.map((f) => f.id_producto)
  )

  const movimientos = [
    ...(fin.data ?? []).map((f) =>
      describirFinanzas({
        id: f.id,
        fecha_movimiento: f.fecha_movimiento,
        tipo_movimiento: f.tipo_movimiento,
        monto: f.monto,
        categoria: f.categoria,
        descripcion: f.descripcion,
        id_ticket: f.id_ticket
      })
    ),
    ...filasInv.map((f) =>
      describirInventario({
        id: f.id,
        fecha_movimiento: f.fecha_movimiento,
        tipo_movimiento: f.tipo_movimiento,
        cantidad: f.cantidad,
        notas: f.notas,
        producto: nombres.get(f.id_producto) ?? null
      })
    )
  ]

  return ordenarAnulables(movimientos).slice(0, MOVIMIENTOS_OFRECIDOS)
}

async function nombresDeProducto(
  supabase: Cliente,
  ids: readonly string[]
): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.filter(Boolean))]
  if (unicos.length === 0) return new Map()
  const { data } = await supabase
    .from('catalogo_productos')
    .select('id, nombre')
    .in('id', unicos)
  const mapa = new Map<string, string>()
  for (const p of data ?? []) mapa.set(p.id, p.nombre)
  return mapa
}

/**
 * **El uuid que manda el bot es una peticion, no una autorizacion.**
 *
 * El boton lleva un INDICE contra la lista que el bot guardo en memoria (D2), y
 * el bot traduce ese indice al uuid que le toca. Aqui se comprueba que esa fila
 * siga cumpliendo el MISMO filtro con el que se armo la lista. Sin esta vuelta,
 * un id copiado de otra conversacion bastaria para anular la fila de alguien
 * mas — y con `service_role` no hay RLS que lo pare despues.
 *
 * ─── SE COMPRUEBA CONTRA EL FILTRO, NO CONTRA LAS OCHO QUE SE PINTARON ──────
 *
 * Es la diferencia entre "esto lo puedes anular" y "esto te cupo en la
 * pantalla". Las ocho son cuantos botones se leen en un celular; el filtro es
 * la regla. Si se comprobara contra las ocho, a un ADMIN en una tarde movida se
 * le caeria el "va" porque entraron ventas nuevas entre la lista y el boton — y
 * el mensaje seria "no autorizado" para algo que si esta autorizado.
 */
export async function buscarEnLaLista(
  supabase: Cliente,
  actor: ActorDelBot,
  tabla: string,
  id: string,
  ahora: Date = new Date()
): Promise<MovimientoAnulable | null> {
  if (!id) return null
  const filtro = filtroDeAnulables(actor, ahora)

  // La fila se trae por su llave primaria — UNA, con `.maybeSingle()` — y el
  // filtro se aplica sobre ella aqui abajo, no dentro de la consulta. Se lee
  // mejor (las dos condiciones de permiso quedan juntas y a la vista) y ademas
  // el centinela de ERP-25 puede ver que la cadena cierra en una sola fila: una
  // consulta armada a pedazos en un `let` no se deja analizar desde el texto.
  if (tabla === 'finanzas') {
    const { data } = await supabase
      .from('finanzas_ledger')
      .select(
        'id, fecha_movimiento, tipo_movimiento, monto, categoria, descripcion, id_ticket, usuario_creador'
      )
      .eq('id', id)
      .in('status', ['ACTIVO', 'APPROVED'])
      .maybeSingle()
    if (!data || !pasaElFiltro(data, filtro)) return null
    return describirFinanzas(data)
  }

  if (tabla === 'inventario') {
    const { data } = await supabase
      .from('inventario_ledger')
      .select('id, fecha_movimiento, tipo_movimiento, cantidad, notas, id_producto, usuario_creador')
      .eq('id', id)
      .eq('status', 'ACTIVO')
      .maybeSingle()
    if (!data || !pasaElFiltro(data, filtro)) return null
    const nombres = await nombresDeProducto(supabase, [data.id_producto])
    return describirInventario({
      id: data.id,
      fecha_movimiento: data.fecha_movimiento,
      tipo_movimiento: data.tipo_movimiento,
      cantidad: data.cantidad,
      notas: data.notas,
      producto: nombres.get(data.id_producto) ?? null
    })
  }

  return null
}

/**
 * El mismo filtro de la lista, aplicado a una fila ya traida.
 *
 * Que sea UNA funcion y no dos copias es el punto: la lista y esta
 * comprobacion tienen que decir lo mismo, o el bot ofrece botones que no
 * funcionan.
 */
function pasaElFiltro(
  fila: { usuario_creador: string | null; fecha_movimiento: string | null },
  filtro: { soloDeAutor: string | null; desdeISO: string | null }
): boolean {
  if (filtro.soloDeAutor && fila.usuario_creador !== filtro.soloDeAutor) return false
  if (filtro.desdeISO && (fila.fecha_movimiento ?? '') < filtro.desdeISO) return false
  return true
}
