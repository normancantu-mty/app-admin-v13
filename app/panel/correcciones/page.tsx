/**
 * `/panel/correcciones` — correcciones del ADMIN por movimiento de ajuste.
 * Escrito el 2026-11-03 por el agente de la ruta admin. Ruta ESCONDIDA: ningun
 * menu la enlaza. 404 para todo rol que no sea ADMIN (puerta abajo, antes de leer).
 *
 * Solo dos cosas: (a) el stock de un producto YA registrado en una cubeta de una
 * entidad; (b) el saldo de una cuenta financiera existente. No crea productos ni
 * cuentas, no borra ni edita filas: escribe un ajuste por la diferencia.
 *
 * GRANULARIDAD DEL STOCK: entidad x producto x cubeta (PAGADO/CONSIGNADO), la de
 * `v_stock_por_cubeta`, leida de `stock_ajustable()` — la misma regla con la que
 * la RPC recalcula antes de escribir. La pantalla de Inventario muestra el stock
 * de la matriz sumando sus dos cubetas; aqui se separan porque el ajuste se
 * aplica a UNA cubeta.
 *
 * (c) 2026-11-18: la CABECERA de un lote (codigo, fechas, horas, Brix, notas;
 * no las etapas) con `ajustar_lote`. Al renombrar, el nombre anterior queda como
 * alias (se muestran). Ver la migracion 20261118192907.
 */

import { getServerSupabaseClient } from '@/lib/server-session'
import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Correcciones, type FilaCuenta, type FilaStock } from './Correcciones'
import type { FilaLoteCorreccion } from './LotesCorreccion'

export const dynamic = 'force-dynamic'

export default async function PaginaCorrecciones() {
  // Solo ADMIN (SOCIO incluido fuera): 404, la ruta "no existe".
  const usuario = await exigirSesionV2()
  if (usuario.rol !== 'ADMIN') notFound()
  const supabase = await getServerSupabaseClient()

  let stock: FilaStock[] = []
  let cuentas: FilaCuenta[] = []
  let lotes: FilaLoteCorreccion[] = []
  let recomendado = ''
  let error: string | null = null
  try {
    const [s, c, e, l, a, sig] = await Promise.all([
      supabase.rpc('stock_ajustable'),
      supabase.from('cuentas_financieras').select('id, nombre, clase, id_entidad').not('clase', 'is', null).order('nombre'),
      supabase.from('entidades').select('id, nombre, rol'),
      supabase
        .from('lotes')
        .select('id, codigo_lote, fecha_inicio, fecha_fin_fermentacion, horas_fermentacion, brix_chile, brix_final, notas')
        .order('fecha_inicio', { ascending: false }),
      supabase.from('lote_alias').select('id_lote, alias, creado_en').order('creado_en'),
      supabase.rpc('siguiente_codigo_lote')
    ])
    if (s.error) throw new Error(`stock_ajustable: ${s.error.message}`)
    if (c.error) throw new Error(`cuentas_financieras: ${c.error.message}`)
    if (e.error) throw new Error(`entidades: ${e.error.message}`)
    if (l.error) throw new Error(`lotes: ${l.error.message}`)
    if (a.error) throw new Error(`lote_alias: ${a.error.message}`)
    if (sig.error) throw new Error(`siguiente_codigo_lote: ${sig.error.message}`)
    recomendado = String(sig.data ?? '')
    const alias = new Map<string, string[]>()
    for (const f of a.data ?? []) alias.set(f.id_lote, [...(alias.get(f.id_lote) ?? []), f.alias])
    const num = (v: number | string | null) => (v === null ? null : Number(v))
    lotes = (l.data ?? []).map((x) => ({
      id: x.id,
      alias: alias.get(x.id) ?? [],
      cabecera: {
        codigo_lote: x.codigo_lote,
        fecha_inicio: String(x.fecha_inicio).slice(0, 10),
        fecha_fin_fermentacion: x.fecha_fin_fermentacion ? String(x.fecha_fin_fermentacion).slice(0, 10) : null,
        horas_fermentacion: num(x.horas_fermentacion),
        brix_chile: num(x.brix_chile),
        brix_final: num(x.brix_final),
        notas: x.notas
      }
    }))
    stock = (s.data ?? []).map((f) => ({ ...f, stock: Number(f.stock) }))
    const entidad = new Map((e.data ?? []).map((x) => [x.id, x]))
    const saldos = await Promise.all(
      (c.data ?? []).map(async (cta) => {
        const r = await supabase.rpc('saldo_cuenta', { p_id_cuenta: cta.id })
        if (r.error) throw new Error(`saldo_cuenta(${cta.nombre}): ${r.error.message}`)
        return Number(r.data)
      })
    )
    cuentas = (c.data ?? []).map((cta, i) => {
      const ent = cta.id_entidad ? entidad.get(cta.id_entidad) : undefined
      return { id: cta.id, nombre: cta.nombre, clase: cta.clase, entidad: ent?.nombre ?? '—', rol: ent?.rol ?? '', saldo: saldos[i] }
    })
    cuentas.sort((a, b) => Number(b.rol === 'ADMIN') - Number(a.rol === 'ADMIN') || a.entidad.localeCompare(b.entidad) || a.nombre.localeCompare(b.nombre))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <>
      <EncabezadoPagina
        titulo="Correcciones (ADMIN)"
        sub="Corrige stock y saldos con un movimiento de ajuste auditado, y la cabecera de un lote con bitácora y alias."
      />
      {error ? (
        <div className="msg mal">No se pudieron leer los datos: {error}</div>
      ) : (
        <Correcciones stock={stock} cuentas={cuentas} lotes={lotes} recomendado={recomendado} />
      )}
    </>
  )
}
