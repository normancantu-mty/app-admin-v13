'use server'

/**
 * ERP-54 — El evento `CONTEO_FISICO`, del lado del servidor.
 *
 * LO QUE ESTA ACCION NO HACE, Y ES EL PUNTO DEL TICKET:
 *
 *   * **No escribe en `finanzas_ledger`.** Contar no es cobrar. La deuda nace
 *     en el ticket de CONCESION y ahi se queda.
 *   * **No ajusta `inventario_ledger`.** El libro no se corrige solo (D-E28):
 *     la diferencia contra lo contado es el dato que este evento produce, y
 *     fundirla con el libro la destruye en el mismo acto de registrarla.
 *
 * Lo que si hace: guardar lo que se conto, con la foto del libro al lado, y
 * dejar aviso en la cola cuando no cuadran.
 */

import { revalidatePath } from 'next/cache'
import { getServerSupabaseClient, resolverSesionOperador } from '@/lib/server-session'
import { getStockPorCubetaPorEntidad } from '@/lib/inventario-auditoria'
import { registrarAviso } from '@/lib/avisos-server'
import {
  claveDeLibro,
  diferenciasDeConteo,
  resumenDeDescuadres,
  soloDescuadres,
  validarConteo,
  type ConteoCapturado,
  type DiferenciaConteo,
  type LibroPorSku
} from '@/lib/conteo'

export type RegistrarConteoResult =
  | { success: true; idConteo: string; diferencias: DiferenciaConteo[]; resumen: string }
  | { success: false; error: string }

/** Hoy, en hora de Mexico. La fecha del hecho se compara contra esta, no contra UTC. */
function hoyEnMexico(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

async function leerLibro(idEntidad: string): Promise<LibroPorSku> {
  const { stockPagado, stockConsignado } = await getStockPorCubetaPorEntidad(idEntidad)
  const libro: LibroPorSku = new Map()

  for (const fila of stockPagado) {
    libro.set(claveDeLibro('PAGADO', fila.idProducto), fila.stockEsperado)
  }
  for (const fila of stockConsignado) {
    libro.set(claveDeLibro('CONSIGNADO', fila.idProducto), fila.stockEsperado)
  }

  return libro
}

export async function registrarConteoFisicoAction(
  entrada: ConteoCapturado
): Promise<RegistrarConteoResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesion = await resolverSesionOperador(supabase)
    if (!sesion.ok) {
      return { success: false, error: sesion.error }
    }

    const errores = validarConteo(entrada, hoyEnMexico())
    if (errores.length > 0) {
      return { success: false, error: errores.join(' ') }
    }

    // Tirantes de la app sobre el cinturon del RLS. La politica `conteos_ins_dst`
    // ya rechaza contar por una entidad ajena, pero el mensaje que devuelve
    // Postgres no dice que paso; este si. Y `leerLibro` corre con service role,
    // o sea que sin este chequeo un DST leeria stock que no le toca aunque el
    // INSERT falle despues.
    if (sesion.sesion.rol !== 'ADMIN' && sesion.sesion.rol !== 'SOCIO') {
      const { data: mias, error: errorMias } = await supabase.rpc('mis_entidades')

      if (errorMias) {
        return { success: false, error: `No se pudo comprobar de quien es la entidad: ${errorMias.message}` }
      }

      // `mis_entidades()` es `SETOF uuid`, asi que llega como lista de strings.
      const permitidas = new Set<string>(mias ?? [])
      if (!permitidas.has(entrada.idEntidad)) {
        return { success: false, error: 'Ese punto de venta no es tuyo: no puedes capturar su conteo.' }
      }
    }

    const libro = await leerLibro(entrada.idEntidad)
    const diferencias = diferenciasDeConteo(entrada.lineas, libro)

    const { data: cabecera, error: errorCabecera } = await supabase
      .from('conteos_fisicos')
      .insert({
        id_entidad: entrada.idEntidad,
        fecha_conteo: entrada.fechaConteo,
        notas: entrada.notas ?? null
        // `usuario_creador` lo pone el trigger `trg_autor_conteos`.
      })
      .select('id')
      .single()

    if (errorCabecera || !cabecera) {
      return {
        success: false,
        error: `No se pudo guardar el conteo: ${errorCabecera?.message ?? 'sin detalle'}`
      }
    }

    const { error: errorDetalle } = await supabase.from('conteo_detalles').insert(
      diferencias.map((d) => ({
        id_conteo: cabecera.id,
        id_producto: d.idProducto,
        cubeta: d.cubeta,
        piezas_contadas: d.piezasContadas,
        libro_decia: d.libroDecia
      }))
    )

    if (errorDetalle) {
      // Queda una cabecera sin lineas. **Es inocuo a proposito**: `v_conteo_ultimo`
      // hace JOIN con el detalle, asi que un conteo sin lineas no existe para
      // nadie que lea. Se prefiere eso a compensar con un UPDATE que un DST no
      // tiene permiso de hacer (la politica de anulacion es solo del ADMIN).
      return {
        success: false,
        error: `El conteo no se guardo completo y no cuenta: ${errorDetalle.message}`
      }
    }

    const descuadres = soloDescuadres(diferencias)
    if (descuadres.length > 0) {
      await registrarAviso(supabase, {
        tipo: 'W15',
        idEntidad: entrada.idEntidad,
        mensaje: `Conteo del ${entrada.fechaConteo}: ${resumenDeDescuadres(diferencias)}`,
        datosCapturados: {
          id_conteo: cabecera.id,
          fecha_conteo: entrada.fechaConteo,
          descuadres: descuadres.map((d) => ({
            id_producto: d.idProducto,
            cubeta: d.cubeta,
            contadas: d.piezasContadas,
            libro: d.libroDecia,
            diferencia: d.diferencia
          }))
        }
      })
    }

    revalidatePath('/dashboard/conteo')
    revalidatePath('/dashboard/avisos')
    revalidatePath('/dashboard/cartera')

    return {
      success: true,
      idConteo: cabecera.id,
      diferencias,
      resumen: resumenDeDescuadres(diferencias)
    }
  } catch (error) {
    const detalle = error instanceof Error ? error.message : 'error desconocido'
    return { success: false, error: `No se pudo registrar el conteo: ${detalle}` }
  }
}

// ─── Lo que la pantalla necesita para poder capturar ─────────────────────────

export interface EntidadParaConteo {
  id: string
  nombre: string
  rol: string
}

export type EntidadesParaConteoResult =
  | { success: true; entidades: EntidadParaConteo[] }
  | { success: false; error: string }

/**
 * Los puntos de venta que este usuario puede contar. **No filtra por rol en el
 * `WHERE`**: lo hace el RLS de `entidades`, igual que la cola de avisos. Un
 * ADMIN ve todos, un DST ve los suyos, y la consulta es una sola — que es lo
 * que evita que el filtro de la app y el de la base digan cosas distintas.
 */
export async function listarEntidadesParaConteoAction(): Promise<EntidadesParaConteoResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesion = await resolverSesionOperador(supabase)
    if (!sesion.ok) return { success: false, error: sesion.error }

    const { data, error } = await supabase
      .from('entidades')
      .select('id, nombre, rol')
      .neq('rol', 'ADMIN')
      .order('nombre')

    if (error) return { success: false, error: `No se pudieron leer los puntos de venta: ${error.message}` }

    return { success: true, entidades: (data ?? []) as EntidadParaConteo[] }
  } catch (error) {
    const detalle = error instanceof Error ? error.message : 'error desconocido'
    return { success: false, error: detalle }
  }
}

export interface RenglonDeLibro {
  idProducto: string
  producto: string
  cubeta: 'PAGADO' | 'CONSIGNADO'
  libroDice: number
}

export type LibroDeEntidadResult =
  | { success: true; renglones: RenglonDeLibro[] }
  | { success: false; error: string }

/**
 * Lo que el libro dice que hay, para que el que cuenta lo tenga enfrente.
 *
 * **Se enseña a proposito, aunque sesgue el conteo.** La alternativa —contar a
 * ciegas— suena mas pura y en la practica produce lo que ya tenemos: nadie
 * cuenta. Y el sesgo queda registrado: `libro_decia` se guarda en la fila, asi
 * que un conteo que copia el libro linea por linea es visible despues.
 */
export async function leerLibroDeEntidadAction(idEntidad: string): Promise<LibroDeEntidadResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesion = await resolverSesionOperador(supabase)
    if (!sesion.ok) return { success: false, error: sesion.error }

    if (sesion.sesion.rol !== 'ADMIN' && sesion.sesion.rol !== 'SOCIO') {
      const { data: mias, error: errorMias } = await supabase.rpc('mis_entidades')
      if (errorMias) return { success: false, error: errorMias.message }

      if (!new Set<string>(mias ?? []).has(idEntidad)) {
        return { success: false, error: 'Ese punto de venta no es tuyo.' }
      }
    }

    const { stockPagado, stockConsignado } = await getStockPorCubetaPorEntidad(idEntidad)

    const renglones: RenglonDeLibro[] = [
      ...stockConsignado.map((fila) => ({
        idProducto: fila.idProducto,
        producto: fila.producto,
        cubeta: 'CONSIGNADO' as const,
        libroDice: fila.stockEsperado
      })),
      ...stockPagado.map((fila) => ({
        idProducto: fila.idProducto,
        producto: fila.producto,
        cubeta: 'PAGADO' as const,
        libroDice: fila.stockEsperado
      }))
    ]

    return { success: true, renglones }
  } catch (error) {
    const detalle = error instanceof Error ? error.message : 'error desconocido'
    return { success: false, error: `No se pudo leer el libro: ${detalle}` }
  }
}
