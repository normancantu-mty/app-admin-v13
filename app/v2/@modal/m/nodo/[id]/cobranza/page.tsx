/** Paridad v2 — modal «Cobrar, contar inventario» (corte de concesión; misma lectura que la v1). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { padreDeNodo } from '@/lib/v2/nodo'
import { getServerSupabaseClient } from '@/lib/server-session'
import { getStockEsperadoPorEntidad } from '@/lib/inventario-auditoria'
import { esCuentaFiscal } from '@/lib/venta-cuenta-fiscal'
import { comisionBaseLocalDecimal } from '@/lib/comision-base-local'
import { Modal } from '@/components/v2/modal/Modal'
import CobranzaClient from '@/components/v2/nodo/Cobranza'

function normalizar(v: string): string {
  return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export default async function ModalCobranza({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirSesionV2()
  // LOC y SOCIO no operan (el RLS de estas escrituras solo deja a ADMIN y DST): 404 aunque llegue por URL.
  if (usuario.rol !== 'ADMIN' && usuario.rol !== 'DST') notFound()
  const { id } = await params
  const supabase = await getServerSupabaseClient()
  const { data: objetivo } = await supabase
    .from('entidades')
    .select('id, nombre, rol, id_nodo_padre, id_padre, comision_base, comision_base_local')
    .eq('id', id)
    .single()
  if (!objetivo) notFound()
  const padreId = objetivo.id_nodo_padre ?? objetivo.id_padre
  const puedeAuditar = usuario.rol === 'ADMIN' || usuario.id === objetivo.id || (usuario.rol === 'DST' && padreId === usuario.id)
  if (!puedeAuditar) notFound()
  const padre = padreDeNodo(id, usuario)

  const { data: cuentasDestino } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre, tipo_fiscalidad')
    .eq('id_entidad', usuario.id)
    .order('nombre', { ascending: true })
  const cuentas = cuentasDestino ?? []

  let cuerpo: React.ReactNode
  if (cuentas.length === 0) {
    cuerpo = <div className="vacio"><b>No hay cuentas destino disponibles para registrar la cobranza.</b></div>
  } else {
    let cuentaDefault = cuentas.find((c) => normalizar(c.nombre).startsWith('cta-'))
    if (usuario.rol === 'ADMIN') cuentaDefault = cuentas.find((c) => esCuentaFiscal(c.tipo_fiscalidad)) ?? cuentaDefault ?? cuentas[0]
    else cuentaDefault = cuentaDefault ?? cuentas[0]
    const stock = await getStockEsperadoPorEntidad(objetivo.id)
    const ids = stock.map((s) => s.idProducto)
    const { data: productos } = ids.length
      ? await supabase.from('catalogo_productos').select('id, nombre, costo_unitario, listas_precios(precio_final)').in('id', ids)
      : { data: [] as { id: string; listas_precios: { precio_final: number | null }[] | null }[] }
    const rows = stock.map((item) => {
      const p = (productos ?? []).find((x) => x.id === item.idProducto)
      const precioRetail = Number(p?.listas_precios?.[0]?.precio_final || 0)
      return { ...item, precioCobroUnitario: precioRetail * (1 - comisionBaseLocalDecimal(objetivo.comision_base_local)) }
    })
    cuerpo =
      rows.length === 0 ? (
        <div className="vacio"><b>No hay productos terminados con stock esperado para esta entidad.</b></div>
      ) : (
        <div className="v1">
          <CobranzaClient
            padre={padre}
            idEntidadObjetivo={objetivo.id}
            rows={rows}
            cuentasDestino={cuentas.map((c) => ({ id: c.id, nombre: c.nombre }))}
            cuentaDestinoDefault={cuentaDefault.id}
          />
        </div>
      )
  }
  return (
    <Modal titulo="Cobrar, contar inventario" sub={`Entidad auditada: ${objetivo.nombre} (${objetivo.rol})`} padre={padre}>
      {cuerpo}
    </Modal>
  )
}
