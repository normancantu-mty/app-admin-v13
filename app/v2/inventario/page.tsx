/**
 * Paginas v2 — `/v2/inventario`: TODO el inventario y lo que tiene que ver con
 * los productos, en una pagina. Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * El modal `/v2/m/inventario` es la vista rapida desde el panel; aqui va todo:
 * stock, concesion y movimientos (el mismo `InventarioVista`), los lotes (el
 * mismo `LotesVista`) y el historial de compras y envasados. «Comprar» y
 * «Envasar» abren su modal ENCIMA de esta pagina y, al guardar, vuelven aqui.
 *
 * Solo ADMIN y SOCIO, como el modal. SOCIO lee: sin botones de captura.
 * FALLA CERRADA: si la lectura de compras/envasados falla se dice.
 *
 * Inventario compacto (2026-10-30, ejecutor del Socio): KPIs arriba y el detalle
 * en pestañas (Stock · Movimientos · En concesion · Compras y envasados · Lotes).
 * `?ver=<pestaña>` elige la inicial; los filtros de compras la conservan. Los
 * lotes son un resumen: el apartado completo con alta y edicion es `/v2/lotes`.
 */

import Link from 'next/link'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { getServerSupabaseClient } from '@/lib/server-session'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import { fechaHoraMx, mxn, num } from '@/lib/v2/formato'
import { AbrirModal, CambiarModal } from '@/components/v2/modal/AbrirModal'
import { EncabezadoPagina, VerTodo } from '@/components/v2/pagina/Encabezado'
import { filasPedidas, TANDA } from '@/components/v2/finanzas/Movimientos'
import InventarioVista from '@/components/v2/inventario/InventarioVista'
import { LotesVista } from '@/components/v2/inventario/Lotes'
import type { Pestana } from '@/components/v2/inventario/Pestanas'
import { cant } from '@/components/v2/inventario/formato-inv'

export const dynamic = 'force-dynamic'

type FilaCaptura = {
  id: string
  id_producto: string
  tipo_movimiento: string
  cantidad: number
  costo_unitario_movimiento: number | null
  status: string
  fecha_movimiento: string | null
  usuario_creador: string | null
  notas: string | null
}
type ProductoCorto = { id: string; nombre: string; tipo: string; unidad_medida: string | null }

const TIPOS_CAPTURA = ['ENTRADA_COMPRA', 'PRODUCCION']

export default async function InventarioV2({ searchParams }: { searchParams: Promise<{ tipo?: string | string[]; filas?: string | string[]; ver?: string | string[] }> }) {
  const usuario = await exigirMandoV2()
  const captura = puedeCapturarMatriz(usuario.rol)
  const sp = await searchParams
  const tq = Array.isArray(sp.tipo) ? sp.tipo[0] : sp.tipo
  const tipo = tq === 'ENTRADA_COMPRA' || tq === 'PRODUCCION' ? tq : ''
  const filas = filasPedidas(sp.filas)
  const vq = Array.isArray(sp.ver) ? sp.ver[0] : sp.ver
  const ver = vq ?? (sp.tipo !== undefined || sp.filas !== undefined ? 'capturas' : undefined)

  const supabase = await getServerSupabaseClient()
  let capturas: FilaCaptura[] = []
  let productos: ProductoCorto[] = []
  let errorLectura: string | null = null
  try {
    const [c, p] = await Promise.all([
      fetchTodasLasFilas<FilaCaptura>(
        () =>
          supabase
            .from('inventario_ledger')
            .select('id, id_producto, tipo_movimiento, cantidad, costo_unitario_movimiento, status, fecha_movimiento, usuario_creador, notas')
            .in('tipo_movimiento', TIPOS_CAPTURA)
            .order('fecha_movimiento', { ascending: false })
            .order('id', { ascending: true }),
        'inventario_ledger (compras y envasados)'
      ),
      supabase.from('catalogo_productos').select('id, nombre, tipo, unidad_medida')
    ])
    if (p.error) throw new Error(`catalogo_productos: ${p.error.message}`)
    capturas = c
    productos = (p.data ?? []) as ProductoCorto[]
  } catch (e) {
    errorLectura = e instanceof Error ? e.message : String(e)
  }
  const producto = new Map(productos.map((p) => [p.id, p]))
  // Envasado = PRODUCCION de un TERMINADO (el consumo de insumos de la receta va aparte en el ledger).
  const esEnvasado = (f: FilaCaptura) => f.tipo_movimiento === 'PRODUCCION' && producto.get(f.id_producto)?.tipo === 'TERMINADO'
  const delHistorial = capturas.filter((f) => f.tipo_movimiento === 'ENTRADA_COMPRA' || esEnvasado(f))
  const filtradas = delHistorial.filter((f) => !tipo || f.tipo_movimiento === tipo)
  const visibles = filtradas.slice(0, filas)
  const activas = (f: FilaCaptura) => f.status === 'ACTIVO'
  const nCompras = delHistorial.filter((f) => f.tipo_movimiento === 'ENTRADA_COMPRA' && activas(f)).length
  const gastoCompras = delHistorial
    .filter((f) => f.tipo_movimiento === 'ENTRADA_COMPRA' && activas(f))
    .reduce((a, f) => a + Number(f.cantidad) * Number(f.costo_unitario_movimiento ?? 0), 0)
  const botellasEnvasadas = delHistorial.filter((f) => esEnvasado(f) && activas(f)).reduce((a, f) => a + Number(f.cantidad), 0)
  const href = (cambios: { tipo?: string; filas?: number }) => {
    const u = new URLSearchParams()
    const t = cambios.tipo !== undefined ? cambios.tipo : tipo
    if (t) u.set('tipo', t)
    if (cambios.filas) u.set('filas', String(cambios.filas))
    u.set('ver', 'capturas')
    return `/v2/inventario?${u.toString()}`
  }

  const panelCapturas = (
    <div id="capturas" data-testid="inv-capturas">
      <div className="inv-filtros">
        <div className="seg" role="group" aria-label="Tipo">
          {[
            { v: '', l: 'Todo' },
            { v: 'ENTRADA_COMPRA', l: 'Compras' },
            { v: 'PRODUCCION', l: 'Envasados' }
          ].map((o) => (
            <Link key={o.v} href={href({ tipo: o.v })} replace scroll={false} className={tipo === o.v ? 'on' : ''} style={{ padding: '7px 12px', fontWeight: 600 }}>
              {o.l}
            </Link>
          ))}
        </div>
        <span className="inv-sub">
          <b>{nCompras}</b> compras activas por <b>{mxn(gastoCompras)}</b> (cantidad × costo del movimiento) · <b>{num(botellasEnvasadas)}</b> piezas envasadas
        </span>
      </div>
      {errorLectura ? (
        <div className="msg mal">No se pudieron leer las compras y envasados: {errorLectura}</div>
      ) : filtradas.length === 0 ? (
        <div className="vacio">
          <b>Sin {tipo === 'ENTRADA_COMPRA' ? 'compras' : tipo === 'PRODUCCION' ? 'envasados' : 'compras ni envasados'} registrados</b>
        </div>
      ) : (
        <div className="inv-scroll">
          <table className="t inv-t">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Producto</th>
                <th className="r">Cantidad</th>
                <th className="r inv-opc-lg">Costo unitario</th>
                <th className="r">Importe</th>
                <th className="inv-opc-lg">Creado por</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((f) => {
                const p = producto.get(f.id_producto)
                const costo = f.costo_unitario_movimiento === null ? null : Number(f.costo_unitario_movimiento)
                return (
                  <tr key={f.id} className={activas(f) ? undefined : 'anulado'}>
                    <td className="inv-fecha">{fechaHoraMx(f.fecha_movimiento)}</td>
                    <td>
                      <span className={`chip ${f.tipo_movimiento === 'ENTRADA_COMPRA' ? 'info' : 'chile'}`}>{f.tipo_movimiento === 'ENTRADA_COMPRA' ? 'Compra' : 'Envasado'}</span>
                      {!activas(f) && <span className="chip">{f.status.toLowerCase()}</span>}
                    </td>
                    <td>
                      <b>{p?.nombre ?? 'Producto sin dato'}</b>
                      {f.notas && <div className="inv-sub">{f.notas}</div>}
                      <div className="inv-sub inv-solo-chico-lg">
                        {costo === null ? '' : `${mxn(costo)} c/u · `}
                        {f.usuario_creador ?? 'sin dato'}
                      </div>
                    </td>
                    <td className="r">
                      {cant(f.cantidad)} <span className="inv-sub">{p?.unidad_medida ?? ''}</span>
                    </td>
                    <td className="r inv-opc-lg">{costo === null ? '—' : mxn(costo)}</td>
                    <td className="r">{costo === null ? '—' : mxn(costo * Number(f.cantidad))}</td>
                    <td className="mono inv-opc-lg inv-sub">{f.usuario_creador ?? 'sin dato'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="inv-pie">
        <span>Mostrando {visibles.length} de {filtradas.length} · inventario_ledger (ENTRADA_COMPRA y PRODUCCION de terminados)</span>
        {filtradas.length > visibles.length && (
          <CambiarModal className="btn mini" href={href({ filas: filas + TANDA })}>
            Cargar más ({Math.min(TANDA, filtradas.length - visibles.length)} de {filtradas.length - visibles.length} restantes)
          </CambiarModal>
        )}
      </div>
    </div>
  )

  const extras: Pestana[] = [
    { id: 'capturas', titulo: 'Compras y envasados', cuenta: delHistorial.length, contenido: panelCapturas },
    { id: 'lotes', titulo: 'Lotes', contenido: <LotesVista limite={8} /> }
  ]

  return (
    <>
      <EncabezadoPagina
        titulo="Inventario"
        sub="Stock, movimientos, lotes, compras y envasados de la matriz"
        acciones={
          <>
            {captura ? (
              <>
                <AbrirModal className="btn p" href="/v2/m/compra" titulo="Comprar insumos" tam="md" data-testid="inv-comprar">
                  Comprar
                </AbrirModal>
                <AbrirModal className="btn p" href="/v2/m/envasado" titulo="Registrar envasado" tam="md" data-testid="inv-envasar">
                  Envasar
                </AbrirModal>
              </>
            ) : null}
            <VerTodo href="/v2/lotes" className="btn">
              Lotes →
            </VerTodo>
          </>
        }
      />

      <section className="card">
        <div className="v1">
          <InventarioVista sinAcciones extras={extras} ver={ver} enUrl />
        </div>
      </section>
    </>
  )
}
