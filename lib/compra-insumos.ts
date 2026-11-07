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
  const { data: cuenta, error: cuentaError } = await supabase
    .from('cuentas_financieras')
    .select('id, id_entidad')
    .eq('id', idCuentaOrigen)
    .maybeSingle()
  if (cuentaError) {
    return { ok: false, error: `No se pudo leer la cuenta: ${cuentaError.message}` }
  }
  if (!cuenta || cuenta.id_entidad !== idEntidad) {
    return { ok: false, error: 'La cuenta de origen no pertenece a tu entidad.' }
  }

  // --- PASO A: entra el insumo, al almacen de la entidad que compro (ERP-16).
  const inventarioPayload: InventarioInsert = {
    id_producto: idInsumo,
    tipo_movimiento: 'ENTRADA_COMPRA',
    cantidad,
    id_entidad_destino: idEntidad,
    usuario_creador: compra.usuarioCreador,
    status: 'ACTIVO',
    ...(compra.notas ? { notas: compra.notas } : {}),
    ...(compra.fechaMovimiento ? { fecha_movimiento: compra.fechaMovimiento } : {})
  }
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
  const finanzasPayload: FinanzaInsert = {
    id_cuenta_origen: idCuentaOrigen,
    tipo_movimiento: 'COMPRA_INSUMOS',
    categoria: compra.categoria || CATEGORIA_COMPRA_WEB,
    monto: costoTotal,
    usuario_creador: compra.usuarioCreador,
    status: 'ACTIVO',
    ...(compra.subcategoria ? { subcategoria: compra.subcategoria } : {}),
    ...(compra.descripcion ? { descripcion: compra.descripcion } : {}),
    ...(compra.fechaMovimiento ? { fecha_movimiento: compra.fechaMovimiento } : {})
  }

  const { data: filaFinanzas, error: finanzasError } = await supabase
    .from('finanzas_ledger')
    .insert(finanzasPayload)
    .select('id')
    .maybeSingle()

  if (finanzasError) {
    const { error: errorCompensacion } = await supabase
      .from('inventario_ledger')
      .update({ status: 'ANULADO', notas: 'ANULADO: falló el registro del gasto de la compra' })
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
