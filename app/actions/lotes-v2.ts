'use server'

/**
 * Lotes v2 — alta y edicion de un lote desde el ERP. Escrito el 2026-10-30 por
 * el ejecutor del Socio.
 *
 * ─── POR QUE NO REUSA LA FUNCION DEL BOT ────────────────────────────────────
 * El bot escribe la cabecera con un INSERT en `lotes` y los hijos con la RPC
 * `registrar_en_lote` (una transaccion). Esa RPC tiene `execute` SOLO para
 * `service_role` (migraciones 20260923053510 y 20260923075244), y el ERP no
 * escribe con service role: escribe con la sesion del usuario para que el RLS
 * decida. El RLS de las cuatro tablas de ERP-84 (`lotes`, `lote_entradas`,
 * `lote_salidas`, `lote_envasado`) tiene INSERT, UPDATE y DELETE para ADMIN
 * (verificado en pg_policies el 2026-10-30), asi que aqui se escriben las
 * mismas filas que escribe la RPC para entradas y tandas, con la misma regla:
 *   - el insumo repetido se suma (unique id_lote,id_insumo);
 *   - las tandas se numeran despues de las que el lote ya tenia.
 *
 * ─── LO QUE NO HACE, A PROPOSITO ────────────────────────────────────────────
 *  - ENVASADO: `registrar_en_lote` escribe `lote_envasado` Y su inventario
 *    (+terminado, -empaque, con candado de stock) en una transaccion. Hacerlo
 *    aqui serian INSERTs sueltos en dos tablas sin ese candado. Ademas, desde la
 *    ronda 5 del lote v2 (Norman, 2026-10-19) el envasado es DIARIO y no se liga
 *    al lote. Se registra con «Envasar».
 *  - ETAPAS (`lote_etapas`: destilacion, muestra): no tienen politica de INSERT
 *    para `authenticated`; solo las escribe el bot. Aqui se leen. El aditivo 1 y
 *    el 2 NO son etapas (Cris, 2026-11-13): son insumos del catalogo y entran por
 *    `lote_entradas` en el alta o en la edicion (upsert), nunca por
 *    `registrar_etapa_lote` (esa RPC con 'aditivo_2' inserta la etapa Y vuelve a
 *    sumar la cantidad en `lote_entradas`: doble).
 *  - BORRAR: no se quita un insumo ni una tanda ya escritos, ni el lote. No son
 *    ledgers, pero tampoco tienen bitacora (los triggers de auditoria cubren solo
 *    los ledgers y los tickets): un borrado no dejaria rastro.
 *
 * ─── ATOMICIDAD (no hay transacciones en este repo, ver CLAUDE.md) ──────────
 * Alta: cabecera, luego UN insert multi-fila de entradas y UNO de tandas. Si un
 * hijo falla, un solo DELETE de la cabecera arrastra lo demas (on delete
 * cascade): el mismo patron de compensacion que el bot. Un lote no mueve dinero
 * ni inventario, asi que deshacerlo no deja hueco en ningun ledger.
 * Edicion: UPDATE de la cabecera, UN upsert de entradas y UNO de tandas; cada
 * sentencia es atomica. Si una falla se dice cual quedo y cual no.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { revalidatePath } from 'next/cache'
import { getServerSupabaseClient, resolverSesionOperador } from '@/lib/server-session'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { fechaLocal } from '@/lib/fechas'
import { codigoSugerido } from '@/lib/bot-lotes'
import { validarLote, type LoteForm } from '@/components/v2/lotes/validar'

export interface GuardarLoteResult {
  success: boolean
  id?: string
  error?: string
  avisos?: string[]
}

export async function guardarLoteAction(form: LoteForm): Promise<GuardarLoteResult> {
  try {
    const supabase = await getServerSupabaseClient()
    const sesion = await resolverSesionOperador(supabase)
    if (!sesion.ok) return { success: false, error: sesion.error }
    if (!puedeCapturarMatriz(sesion.sesion.rol)) {
      return { success: false, error: 'Solo la matriz (ADMIN) captura lotes.' }
    }

    const hoy = fechaLocal(new Date())
    const idLote = form?.id ? String(form.id) : null

    // Codigos tomados (tabla chica): para sugerir y para el choque sin distinguir mayusculas, como el bot.
    const { data: codigos, error: errCodigos } = await supabase.from('lotes').select('id, codigo_lote')
    if (errCodigos) return { success: false, error: `No pude leer los lotes: ${errCodigos.message}` }
    const tomados = (codigos ?? []) as { id: string; codigo_lote: string }[]

    const entrada: LoteForm = { ...form }
    if (!idLote && !String(entrada.codigo_lote ?? '').trim()) {
      entrada.codigo_lote = codigoSugerido(String(entrada.fecha_inicio || hoy), tomados.map((t) => t.codigo_lote))
    }
    const v = validarLote(entrada, hoy)
    if (!v.ok) return { success: false, error: v.error }
    const lote = v.lote

    if (tomados.some((t) => t.id !== idLote && t.codigo_lote.trim().toUpperCase() === lote.codigo_lote.toUpperCase())) {
      return { success: false, error: `El lote ${lote.codigo_lote} ya existe. Usa otro código.` }
    }

    // Los insumos tienen que existir y ser INSUMO (la lista del formulario no es garantia).
    if (lote.entradas.length > 0) {
      const ids = lote.entradas.map((e) => e.id_insumo)
      const { data: insumos, error } = await supabase.from('catalogo_productos').select('id').in('id', ids).eq('tipo', 'INSUMO')
      if (error) return { success: false, error: `No pude revisar los insumos: ${error.message}` }
      if ((insumos ?? []).length !== new Set(ids).size) return { success: false, error: 'Algún insumo no existe en el catálogo o no es INSUMO.' }
    }

    const cabecera = {
      codigo_lote: lote.codigo_lote,
      fecha_inicio: lote.fecha_inicio,
      fecha_fin_fermentacion: lote.fecha_fin_fermentacion,
      horas_fermentacion: lote.horas_fermentacion,
      brix_chile: lote.brix_chile,
      brix_final: lote.brix_final,
      notas: lote.notas
    }

    // ── ALTA ────────────────────────────────────────────────────────────────
    if (!idLote) {
      if (lote.tandas.some((t) => t.id)) return { success: false, error: 'Un lote nuevo no trae tandas ya escritas.' }
      const { data: creado, error: errLote } = await supabase
        .from('lotes')
        .insert({ ...cabecera, usuario_creador: sesion.sesion.email })
        .select('id')
        .single()
      if (errLote || !creado) {
        return { success: false, error: `No pude escribir el lote: ${errLote?.message ?? 'sin respuesta'}. No quedó nada a medias.` }
      }
      const id = creado.id as string
      const deshacer = async () => {
        await supabase.from('lotes').delete().eq('id', id)
      }
      if (lote.entradas.length > 0) {
        const { error } = await supabase.from('lote_entradas').insert(lote.entradas.map((e) => ({ id_lote: id, id_insumo: e.id_insumo, cantidad: e.cantidad })))
        if (error) {
          await deshacer()
          return { success: false, error: `No pude escribir los insumos (${error.message}). Deshice el lote entero.` }
        }
      }
      if (lote.tandas.length > 0) {
        const { error } = await supabase.from('lote_salidas').insert(
          lote.tandas.map((t, i) => ({ id_lote: id, numero_tanda: i + 1, litros: t.litros, grado_alcohol: t.grado_alcohol, peso_kg: t.peso_kg, notas: t.notas }))
        )
        if (error) {
          await deshacer()
          return { success: false, error: `No pude escribir las tandas (${error.message}). Deshice el lote entero.` }
        }
      }
      revalidatePath(`${RUTA_BASE}/lotes`)
      return { success: true, id, avisos: v.avisos }
    }

    // ── EDICION ─────────────────────────────────────────────────────────────
    const [actualRes, entRes, salRes] = await Promise.all([
      supabase.from('lotes').select('id').eq('id', idLote).maybeSingle(),
      supabase.from('lote_entradas').select('id_insumo').eq('id_lote', idLote),
      supabase.from('lote_salidas').select('id, numero_tanda').eq('id_lote', idLote)
    ])
    if (actualRes.error || !actualRes.data) return { success: false, error: 'Ese lote no existe (o no lo puedes ver).' }
    if (entRes.error || salRes.error) return { success: false, error: `No pude leer el lote: ${(entRes.error ?? salRes.error)?.message}` }

    const insumosActuales = new Set((entRes.data ?? []).map((e) => e.id_insumo as string))
    const nuevosInsumos = new Set(lote.entradas.map((e) => e.id_insumo))
    if ([...insumosActuales].some((i) => !nuevosInsumos.has(i))) {
      return { success: false, error: 'Desde el ERP no se quita un insumo ya escrito; solo se corrige su cantidad.' }
    }
    const tandasActuales = new Map((salRes.data ?? []).map((s) => [s.id as string, Number(s.numero_tanda)]))
    const idsEnForm = new Set(lote.tandas.filter((t) => t.id).map((t) => t.id as string))
    if ([...tandasActuales.keys()].some((id) => !idsEnForm.has(id))) {
      return { success: false, error: 'Desde el ERP no se quita una tanda ya escrita; solo se corrige.' }
    }
    if ([...idsEnForm].some((id) => !tandasActuales.has(id))) return { success: false, error: 'Una tanda no es de este lote.' }

    const { error: errCab } = await supabase.from('lotes').update(cabecera).eq('id', idLote)
    if (errCab) return { success: false, error: `No pude guardar la cabecera: ${errCab.message}. No cambió nada.` }

    if (lote.entradas.length > 0) {
      const { error } = await supabase
        .from('lote_entradas')
        .upsert(lote.entradas.map((e) => ({ id_lote: idLote, id_insumo: e.id_insumo, cantidad: e.cantidad })), { onConflict: 'id_lote,id_insumo' })
      if (error) return { success: false, error: `Guardé la cabecera, pero NO los insumos ni las tandas: ${error.message}` }
    }

    if (lote.tandas.length > 0) {
      let siguiente = Math.max(0, ...tandasActuales.values())
      const filas = lote.tandas.map((t) => ({
        id_lote: idLote,
        numero_tanda: t.id ? (tandasActuales.get(t.id) as number) : ++siguiente,
        litros: t.litros,
        grado_alcohol: t.grado_alcohol,
        peso_kg: t.peso_kg,
        notas: t.notas
      }))
      const { error } = await supabase.from('lote_salidas').upsert(filas, { onConflict: 'id_lote,numero_tanda' })
      if (error) return { success: false, error: `Guardé la cabecera y los insumos, pero NO las tandas: ${error.message}` }
    }

    revalidatePath(`${RUTA_BASE}/lotes`)
    return { success: true, id: idLote, avisos: v.avisos }
  } catch (e) {
    console.error('[lotes-v2] guardarLoteAction:', e)
    return { success: false, error: 'Error interno al guardar el lote.' }
  }
}
