/**
 * LA COMPRA DE INSUMOS, EN UN SOLO LUGAR (2026-11-07).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web).
 *
 * Hasta hoy la compra vivia entera dentro de `registrarCompraInsumosAction`
 * (`app/actions/compras.ts`) y el bot no la podia llamar: el bot solo movia el
 * dinero (un gasto) y el insumo nunca entraba al almacen. Ahora la pantalla y el
 * bot llaman ESTA funcion: misma validacion, mismas dos filas, misma
 * compensacion. Lo que cambia entre los dos es solo QUIEN es la entidad y el
 * autor (la sesion en la web; `bot_identidades` en el bot) y el cliente con que
 * se escribe.
 *
 * **No lleva `'use server'` a proposito** (misma razon que `lib/bot-servidor.ts`):
 * en un archivo `'use server'` toda exportacion se vuelve un endpoint invocable
 * desde el navegador.
 *
 * COMO SE COMPENSA (no hay transacciones en este repo, ver CLAUDE.md): son dos
 * tablas distintas, asi que no cabe un INSERT multi-fila. Se escribe primero el
 * inventario; si el gasto falla, la fila de inventario se **anula**
 * (`status = 'ANULADO'`), nunca se borra - regla 6.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, TablesInsert } from '@/types/database'
import { exigirEntidadDelMovimiento } from '@/lib/inventario-invariante'
import type { PayloadCompraDocumento } from '@/lib/bot-compra-documento'
import { fetchTodasLasFilas } from '@/lib/paginacion'

type InventarioInsert = TablesInsert<'inventario_ledger'>
type FinanzaInsert = TablesInsert<'finanzas_ledger'>

export interface CompraInsumos {
  idInsumo: string
  cantidad: number
  costoTotal: number
  idCuentaOrigen: string
  /** La entidad que compra: a su almacen entra el insumo y de su cuenta sale el dinero. */
  idEntidad: string
  /** Lo pone la sesion (web) o la identidad del bot; nunca el cliente. */
  usuarioCreador: string
  /** La web escribe `Insumos`; el bot, la pareja de `categorias_movimiento` que se enseno. */
  categoria?: string
  subcategoria?: string | null
  descripcion?: string | null
  /** ISO. Sin ella, el default de la base (ahora). */
  fechaMovimiento?: string | null
  /** Nota de la fila de inventario. */
  notas?: string | null
}

export type ResultadoCompra =
  | { ok: true; idInventario: string; idFinanzas: string | null; insumo: string }
  | { ok: false; error: string }

/** Lo que escribe la pantalla cuando no le dicen otra categoria. */
export const CATEGORIA_COMPRA_WEB = 'Insumos'

/** La nota con que se anula una entrada cuyo dinero no se pudo escribir. Web y bot. */
export const NOTA_COMPENSACION_COMPRA = 'ANULADO: falló el registro del gasto de la compra'

/**
 * La fila `ENTRADA_COMPRA` de una compra. **Pura.** Ronda 2 (2026-11-08): la
 * usan la compra de la web (`escribirCompraInsumos`) y la del documento del bot
 * (`escribirCompraDocumento`), para que las dos escriban la MISMA forma.
 */
export function filaEntradaCompra(f: {
  id?: string
  idInsumo: string
  cantidad: number
  idEntidad: string
  usuarioCreador: string
  notas?: string | null
  fechaMovimiento?: string | null
}): InventarioInsert {
  return {
    ...(f.id ? { id: f.id } : {}),
    id_producto: f.idInsumo,
    tipo_movimiento: 'ENTRADA_COMPRA',
    cantidad: f.cantidad,
    id_entidad_destino: f.idEntidad,
    usuario_creador: f.usuarioCreador,
    status: 'ACTIVO',
    ...(f.notas ? { notas: f.notas } : {}),
    ...(f.fechaMovimiento ? { fecha_movimiento: f.fechaMovimiento } : {})
  }
}

/** La fila `COMPRA_INSUMOS` (el dinero SALE de `id_cuenta_origen`). **Pura.** Web y bot. */
export function filaCompraInsumos(f: {
  id?: string
  idCuentaOrigen: string
  monto: number
  usuarioCreador: string
  categoria?: string | null
  subcategoria?: string | null
  descripcion?: string | null
  fechaMovimiento?: string | null
}): FinanzaInsert {
  return {
    ...(f.id ? { id: f.id } : {}),
    id_cuenta_origen: f.idCuentaOrigen,
    tipo_movimiento: 'COMPRA_INSUMOS',
    categoria: f.categoria || CATEGORIA_COMPRA_WEB,
    monto: f.monto,
    usuario_creador: f.usuarioCreador,
    status: 'ACTIVO',
    ...(f.subcategoria ? { subcategoria: f.subcategoria } : {}),
    ...(f.descripcion ? { descripcion: f.descripcion } : {}),
    ...(f.fechaMovimiento ? { fecha_movimiento: f.fechaMovimiento } : {})
  }
}

/**
 * La cuenta de origen tiene que ser de la entidad que compra. `null` si lo es;
 * si no, el error tal como lo dice la pantalla. Compartido por la compra de un
 * insumo y la de un documento de varias lineas (2026-11-08).
 */
async function validarCuentaDeLaEntidad(
  supabase: SupabaseClient<Database>,
  idCuentaOrigen: string,
  idEntidad: string
): Promise<string | null> {
  const { data: cuenta, error: cuentaError } = await supabase
    .from('cuentas_financieras')
    .select('id, id_entidad')
    .eq('id', idCuentaOrigen)
    .maybeSingle()
  if (cuentaError) return `No se pudo leer la cuenta: ${cuentaError.message}`
  if (!cuenta || cuenta.id_entidad !== idEntidad) return 'La cuenta de origen no pertenece a tu entidad.'
  return null
}

/**
 * Valida y escribe la compra: `ENTRADA_COMPRA` en `inventario_ledger` y
 * `COMPRA_INSUMOS` en `finanzas_ledger` (cuenta en `id_cuenta_origen`: el dinero
 * SALE). Si la segunda falla, la primera se anula.
 */
export async function escribirCompraInsumos(
  supabase: SupabaseClient<Database>,
  compra: CompraInsumos
): Promise<ResultadoCompra> {
  const idInsumo = String(compra?.idInsumo || '').trim()
  const idCuentaOrigen = String(compra?.idCuentaOrigen || '').trim()
  const idEntidad = String(compra?.idEntidad || '').trim()
  if (!idInsumo) return { ok: false, error: 'Completa el insumo de la compra.' }
  if (!idCuentaOrigen) return { ok: false, error: 'Falta la cuenta de origen.' }
  if (!idEntidad) return { ok: false, error: 'Falta la entidad que compra.' }

  const cantidad = Number(compra?.cantidad)
  const costoTotal = Number(compra?.costoTotal)
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    return { ok: false, error: 'La cantidad debe ser mayor a cero.' }
  }
  if (!Number.isFinite(costoTotal) || costoTotal <= 0) {
    return { ok: false, error: 'El costo total debe ser mayor a cero.' }
  }

  const { data: insumo, error: insumoError } = await supabase
    .from('catalogo_productos')
    .select('id, nombre, tipo')
    .eq('id', idInsumo)
    .eq('tipo', 'INSUMO')
    .maybeSingle()
  if (insumoError) {
    return { ok: false, error: `No se pudo leer el insumo: ${insumoError.message}` }
  }
  if (!insumo) return { ok: false, error: 'El producto no existe o no es un insumo.' }

  // La cuenta de origen tiene que ser de la entidad que compra.
  const errorCuenta = await validarCuentaDeLaEntidad(supabase, idCuentaOrigen, idEntidad)
  if (errorCuenta) return { ok: false, error: errorCuenta }

  // --- PASO A: entra el insumo, al almacen de la entidad que compro (ERP-16).
  const inventarioPayload: InventarioInsert = filaEntradaCompra({
    idInsumo,
    cantidad,
    idEntidad,
    usuarioCreador: compra.usuarioCreador,
    notas: compra.notas,
    fechaMovimiento: compra.fechaMovimiento
  })
  exigirEntidadDelMovimiento(inventarioPayload, 'compra-insumos.escribirCompraInsumos')

  const { data: filaInventario, error: inventarioError } = await supabase
    .from('inventario_ledger')
    .insert(inventarioPayload)
    .select('id')
    .single()
  if (inventarioError || !filaInventario) {
    return {
      ok: false,
      error: `Error al registrar la entrada de inventario: ${inventarioError?.message ?? 'sin detalle'}`
    }
  }

  // --- PASO B: sale el dinero. Si falla, el PASO A se anula.
  const finanzasPayload: FinanzaInsert = filaCompraInsumos({
    idCuentaOrigen,
    monto: costoTotal,
    usuarioCreador: compra.usuarioCreador,
    categoria: compra.categoria,
    subcategoria: compra.subcategoria,
    descripcion: compra.descripcion,
    fechaMovimiento: compra.fechaMovimiento
  })

  const { data: filaFinanzas, error: finanzasError } = await supabase
    .from('finanzas_ledger')
    .insert(finanzasPayload)
    .select('id')
    .maybeSingle()

  if (finanzasError) {
    const { error: errorCompensacion } = await supabase
      .from('inventario_ledger')
      .update({ status: 'ANULADO', notas: NOTA_COMPENSACION_COMPRA })
      .eq('id', filaInventario.id)
    if (errorCompensacion) {
      console.error(
        'Compensacion fallida en compra de insumos. Fila de inventario huerfana:',
        filaInventario.id,
        errorCompensacion.message
      )
      return {
        ok: false,
        error:
          `No se pudo registrar el gasto (${finanzasError.message}) Y TAMPOCO revertir la ` +
          `entrada de inventario. Avisa a administración: movimiento ${filaInventario.id}.`
      }
    }
    return {
      ok: false,
      error: `No se pudo registrar el gasto: ${finanzasError.message}. La entrada de inventario se revirtió; no quedó nada a medias.`
    }
  }

  return {
    ok: true,
    idInventario: filaInventario.id,
    idFinanzas: filaFinanzas?.id ?? null,
    insumo: String(insumo.nombre ?? '')
  }
}

// ============================================================================
// 2026-11-08 — LA COMPRA DE UN DOCUMENTO DE VARIAS LINEAS (foto de factura o
// cotizacion desde el bot). Escrito el 2026-11-08 por el ejecutor del Socio.
// ============================================================================

export type ResultadoCompraDocumento =
  | { ok: true; yaEstaba?: boolean; idsInventario: string[]; idsFinanzas: string[] }
  | { ok: false; error: string }

/**
 * Las MISMAS dos escrituras que `escribirCompraInsumos`, para N lineas a la vez:
 * `ENTRADA_COMPRA` por insumo y `COMPRA_INSUMOS` por insumo (cuenta en
 * `id_cuenta_origen`, categoria `Insumos`, igual que la pantalla), mas el flete
 * como `GASTO_OPERATIVO` (cuenta en `id_cuenta_destino`, la forma de todo gasto:
 * `FORMA_POR_DEFECTO` de `lib/bot-gastos.ts`).
 *
 * Lo que gana sobre llamar N veces a `escribirCompraInsumos`:
 *   · cada tabla se escribe en UN insert (un statement de PostgREST es una
 *     transaccion): entran todas las entradas o ninguna, y todo el dinero o nada;
 *   · entre las dos tablas, la MISMA compensacion que el nucleo: si el dinero
 *     falla, las entradas se anulan (`status = 'ANULADO'`), nunca se borran;
 *   · los ids nacieron al proponer: un doble clic choca con la llave primaria.
 */
export async function escribirCompraDocumento(
  supabase: SupabaseClient<Database>,
  compra: PayloadCompraDocumento,
  idCuentaOrigen: string
): Promise<ResultadoCompraDocumento> {
  const idEntidad = String(compra?.id_entidad || '').trim()
  const idCuenta = String(idCuentaOrigen || '').trim()
  const lineas = Array.isArray(compra?.lineas) ? compra.lineas : []
  const gastos = Array.isArray(compra?.gastos) ? compra.gastos : []
  if (!idEntidad) return { ok: false, error: 'Falta la entidad que compra.' }
  if (!idCuenta) return { ok: false, error: 'Falta la cuenta de origen.' }
  if (lineas.length === 0) return { ok: false, error: 'La compra no trae ningun insumo.' }
  for (const l of lineas) {
    if (!(Number(l.cantidad) > 0)) return { ok: false, error: 'La cantidad debe ser mayor a cero.' }
    if (!(Number(l.costo_total) > 0)) return { ok: false, error: 'El costo total debe ser mayor a cero.' }
  }
  for (const g of gastos) {
    if (!(Number(g.monto) > 0)) return { ok: false, error: 'El monto del flete debe ser mayor a cero.' }
  }

  const idsInsumo = [...new Set(lineas.map((l) => String(l.id_insumo)))]
  const { data: insumos, error: insumoError } = await supabase
    .from('catalogo_productos')
    .select('id, nombre, tipo')
    .in('id', idsInsumo)
    .eq('tipo', 'INSUMO')
  if (insumoError) return { ok: false, error: `No se pudo leer el insumo: ${insumoError.message}` }
  if ((insumos ?? []).length !== idsInsumo.length) {
    return { ok: false, error: 'Un producto de la compra no existe o no es un insumo.' }
  }

  const errorCuenta = await validarCuentaDeLaEntidad(supabase, idCuenta, idEntidad)
  if (errorCuenta) return { ok: false, error: errorCuenta }

  const idsInventario = lineas.map((l) => l.id_inventario)
  const idsFinanzas = [...lineas.map((l) => l.id_finanzas), ...gastos.map((g) => g.id_finanzas)]
  const fecha = compra.fecha_movimiento ? { fecha_movimiento: compra.fecha_movimiento } : {}
  const fechaMovimiento = compra.fecha_movimiento || null

  // --- PASO A: entran los insumos, al almacen de la entidad que compro (ERP-16).
  const filasInventario: InventarioInsert[] = lineas.map((l) =>
    filaEntradaCompra({
      id: l.id_inventario,
      idInsumo: l.id_insumo,
      cantidad: Number(l.cantidad),
      idEntidad,
      usuarioCreador: compra.usuario_creador,
      notas: l.notas,
      fechaMovimiento
    })
  )
  for (const f of filasInventario) exigirEntidadDelMovimiento(f, 'compra-insumos.escribirCompraDocumento')

  const { data: creadasInv, error: inventarioError } = await supabase
    .from('inventario_ledger')
    .insert(filasInventario)
    .select('id')
  if (inventarioError?.code === '23505') {
    // Ya entraron: un doble clic o un reintento. Solo es "ya estaba" si el dinero
    // tambien esta completo y activo; si no, se dice que quedo a medias.
    const dinero = await fetchTodasLasFilas(
      () => supabase.from('finanzas_ledger').select('id, status').in('id', idsFinanzas).order('id'),
      'No se pudo releer la compra'
    ).catch(() => [] as { id: string; status: string | null }[])
    const completo = dinero.filter((f) => f.status === 'ACTIVO').length === idsFinanzas.length
    if (completo) return { ok: true, yaEstaba: true, idsInventario, idsFinanzas }
    return {
      ok: false,
      error: 'Esa compra ya se habia intentado escribir y no quedo completa. No la repito: hay que revisarla a mano.'
    }
  }
  if (inventarioError || (creadasInv ?? []).length !== filasInventario.length) {
    return {
      ok: false,
      error: `Error al registrar la entrada de inventario: ${inventarioError?.message ?? 'no entraron todas las lineas'}`
    }
  }

  // --- PASO B: sale el dinero, todas las filas en un insert. Si falla, el PASO A se anula.
  const filasFinanzas: FinanzaInsert[] = [
    ...lineas.map(
      (l): FinanzaInsert =>
        filaCompraInsumos({
          id: l.id_finanzas,
          idCuentaOrigen: idCuenta,
          monto: Number(l.costo_total),
          usuarioCreador: compra.usuario_creador,
          descripcion: l.descripcion,
          fechaMovimiento
        })
    ),
    ...gastos.map(
      (g): FinanzaInsert => ({
        id: g.id_finanzas,
        id_cuenta_destino: idCuenta,
        tipo_movimiento: 'GASTO_OPERATIVO',
        categoria: g.categoria,
        subcategoria: g.subcategoria,
        categoria_gasto: null,
        monto: Number(g.monto),
        usuario_creador: compra.usuario_creador,
        status: 'ACTIVO',
        descripcion: g.descripcion,
        ...fecha
      })
    )
  ]
  const { data: creadasFin, error: finanzasError } = await supabase
    .from('finanzas_ledger')
    .insert(filasFinanzas)
    .select('id')

  if (finanzasError || (creadasFin ?? []).length !== filasFinanzas.length) {
    const motivo = finanzasError?.message ?? 'no entraron todas las filas de dinero'
    const { error: errorCompensacion } = await supabase
      .from('inventario_ledger')
      .update({ status: 'ANULADO', notas: NOTA_COMPENSACION_COMPRA })
      .in('id', idsInventario)
    if (errorCompensacion) {
      console.error('Compensacion fallida en compra de documento. Entradas huerfanas:', idsInventario, errorCompensacion.message)
      return {
        ok: false,
        error:
          `No se pudo registrar el dinero (${motivo}) Y TAMPOCO revertir las entradas de ` +
          `inventario. Avisa a administracion: grupo ${compra.marca}.`
      }
    }
    return {
      ok: false,
      error: `No se pudo registrar el dinero: ${motivo}. Las entradas de inventario se revirtieron; no quedo nada a medias.`
    }
  }

  return { ok: true, idsInventario, idsFinanzas }
}
