/** Paridad v2 — modal «Catálogo y precios» (waterfall de la v1 con selector Distribuidor/Local, Q7; para el DST, sus locales, Q16). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { esRolDeMandoV2 } from '@/lib/v2/roles'
import { getServerSupabaseClient } from '@/lib/server-session'
import { calculateWaterfall } from '@/lib/pricing-waterfall'
import { Modal } from '@/components/v2/modal/Modal'
import { SelectorPrecios } from '@/components/v2/precios/SelectorPrecios'
import { mxn } from '@/lib/v2/formato'

export const dynamic = 'force-dynamic'

const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function ModalPrecios({
  searchParams
}: {
  searchParams: Promise<{ fiscalidad?: string | string[]; localId?: string | string[]; tipo?: string | string[] }>
}) {
  const usuario = await exigirSesionV2()
  if (usuario.rol === 'SUB-ADMIN') notFound()
  const sp = await searchParams
  const fq = uno(sp.fiscalidad)
  const fiscalidad = fq === 'FULL_TAX' || fq === 'IVA_ONLY' ? fq : 'LIBRE'
  const tipo = uno(sp.tipo) === 'DST' ? 'DST' : 'LOC'
  const localId = uno(sp.localId) ?? ''

  const supabase = await getServerSupabaseClient()
  const { data: entidadActual } = await supabase
    .from('entidades')
    .select('id, rol, comision_base, comision_base_local, comision_hijo_local, aplica_redondeo_costo')
    .eq('id', usuario.id)
    .single()
  // Decision v2: SOCIO ve el catalogo como la matriz (solo lectura); en la v1 caia al de un LOC.
  const mando = esRolDeMandoV2(usuario.rol)
  const rolActual = (mando ? 'ADMIN' : usuario.rol === 'DST' ? 'DST' : 'LOC') as 'ADMIN' | 'DST' | 'LOC'

  const campos = 'id, nombre, rol, comision_base, comision_base_local, aplica_redondeo_costo'
  const { data: simulables } =
    rolActual === 'ADMIN'
      ? await supabase.from('entidades').select(campos).in('rol', ['DST', 'LOC']).order('nombre', { ascending: true })
      : rolActual === 'DST'
        ? await supabase.from('entidades').select(campos).eq('id_padre', usuario.id).order('nombre', { ascending: true })
        : { data: [] }
  const opciones = simulables ?? []
  const seleccionada = opciones.find((e) => e.id === localId) ?? null

  const { data: productos, error } = await supabase
    .from('catalogo_productos')
    .select('id, sku, nombre, costo_unitario, listas_precios (precio_final)')
    .eq('tipo', 'TERMINADO')
    .order('nombre', { ascending: true })

  const catalogo = (productos ?? []).map((p) => ({ ...p, w: calculateWaterfall(p, entidadActual || {}, rolActual, fiscalidad, seleccionada) }))

  return (
    <Modal titulo={rolActual === 'ADMIN' ? 'Catálogo y precios' : 'Precios para mí'} sub="Waterfall de precio: público, impuestos, tu costo y lo que ganas" tam="xl">
      {rolActual !== 'LOC' && (
        <SelectorPrecios
          fiscalidad={fiscalidad}
          tipo={tipo}
          entidadId={seleccionada?.id ?? ''}
          opciones={opciones.map((o) => ({ id: o.id, nombre: o.nombre, rol: o.rol }))}
          conTipo={rolActual === 'ADMIN'}
        />
      )}
      {error ? (
        <div className="msg mal">Error al cargar el catálogo</div>
      ) : (
        <div className="tabla-w">
          <table className="t" data-testid="tabla-precios">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="r">Precio público</th>
                <th className="r">Impuestos (SAT)</th>
                <th className="r">Tu costo operativo</th>
                <th className="r">Precio para {seleccionada ? seleccionada.nombre : 'la entidad'}</th>
                <th className="r">Ganancia directa</th>
                <th className="r">Ganancia por red</th>
              </tr>
            </thead>
            <tbody>
              {catalogo.map((p) => (
                <tr key={p.id}>
                  <td>
                    <b>{p.nombre}</b>
                  </td>
                  <td className="r">{mxn(p.w.precioPublico)}</td>
                  <td className="r">{mxn(p.w.impuestosRetenidos)}</td>
                  <td className="r">{mxn(p.w.tuCosto)}</td>
                  <td className="r">{p.w.precioLocal > 0 ? mxn(p.w.precioLocal) : '—'}</td>
                  <td className="r pos">{mxn(p.w.margenDirecto)}</td>
                  <td className="r">{mxn(p.w.comisionPasiva || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
