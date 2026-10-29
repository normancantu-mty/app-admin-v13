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
 */

import Link from 'next/link'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { getServerSupabaseClient } from '@/lib/server-session'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import { fechaHoraMx, mxn, num } from '@/lib/v2/formato'
import { AbrirModal, CambiarModal } from '@/components/v2/modal/AbrirModal'
import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import { filasPedidas, TANDA } from '@/components/v2/finanzas/Movimientos'
import InventarioVista from '@/components/v2/inventario/InventarioVista'
import { LotesVista } from '@/components/v2/inventario/Lotes'

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

export default async function InventarioV2({ searchParams }: { searchParams: Promise<{ tipo?: string | string[]; filas?: string | string[] }> }) {
  const usuario = await exigirMandoV2()
  const captura = puedeCapturarMatriz(usuario.rol)
  const sp = await searchParams
  const tq = Array.isArray(sp.tipo) ? sp.tipo[0] : sp.tipo
  const tipo = tq === 'ENTRADA_COMPRA' || tq === 'PRODUCCION' ? tq : ''
  const filas = filasPedidas(sp.filas)

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
    const s = u.toString()
    return `/v2/inventario${s ? `?${s}` : ''}#capturas`
  }

  return (
    <>
      <EncabezadoPagina
        titulo="Inventario"
        sub="Stock, movimientos, lotes, compras y envasados de la matriz"
        acciones={
          captura ? (
            <>
              <AbrirModal className="btn p" href="/v2/m/compra" titulo="Comprar insumos" tam="md" data-testid="inv-comprar">
                Comprar
              </AbrirModal>
              <AbrirModal className="btn p" href="/v2/m/envasado" titulo="Registrar envasado" tam="md" data-testid="inv-envasar">
                Envasar
              </AbrirModal>
            </>
          ) : null
        }
      />

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="hd">
          <div>
            <h2>Stock y movimientos</h2>
            <div className="sub">Stock contra todo el ledger; KPIs y movimientos del rango global. Anular, merma y logística inversa aquí mismo.</div>
          </div>
        </div>
        <div className="v1">
          <InventarioVista sinAcciones />
        </div>
      </section>

      <section className="card" style={{ marginBottom: 16 }} id="lotes">
        <div className="hd">
          <div>
            <h2>Lotes</h2>
            <div className="sub">Rendimiento por lote · v_lote_rendimiento (los registra el bot)</div>
          </div>
        </div>
        <LotesVista />
      </section>

      <section className="card" id="capturas" data-testid="inv-capturas">
        <div className="hd">
          <div>
            <h2>Compras y envasados</h2>
            <div className="sub">
              {nCompras} compras activas por {mxn(gastoCompras)} (cantidad × costo del movimiento) · {num(botellasEnvasadas)} piezas envasadas
            </div>
          </div>
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
        </div>
        {errorLectura ? (
          <div className="msg mal">No se pudieron leer las compras y envasados: {errorLectura}</div>
        ) : filtradas.length === 0 ? (
          <div className="vacio">
            <b>Sin {tipo === 'ENTRADA_COMPRA' ? 'compras' : tipo === 'PRODUCCION' ? 'envasados' : 'compras ni envasados'} registrados</b>
          </div>
        ) : (
          <div className="tabla-w">
            <table className="t">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Producto</th>
                  <th className="r">Cantidad</th>
                  <th className="r">Costo unitario</th>
                  <th className="r">Importe</th>
                  <th>Creado por</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((f) => {
                  const p = producto.get(f.id_producto)
                  const costo = f.costo_unitario_movimiento === null ? null : Number(f.costo_unitario_movimiento)
                  return (
                    <tr key={f.id} style={activas(f) ? undefined : { opacity: 0.5 }}>
                      <td style={{ whiteSpace: 'nowrap' }}>{fechaHoraMx(f.fecha_movimiento)}</td>
                      <td>
                        <span className={`chip ${f.tipo_movimiento === 'ENTRADA_COMPRA' ? 'info' : 'chile'}`}>{f.tipo_movimiento === 'ENTRADA_COMPRA' ? 'Compra' : 'Envasado'}</span>
                        {!activas(f) && <span className="chip">{f.status.toLowerCase()}</span>}
                      </td>
                      <td>
                        <b>{p?.nombre ?? 'Producto sin dato'}</b>
                        {f.notas && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{f.notas}</div>}
                      </td>
                      <td className="r">
                        {num(Number(f.cantidad))} {p?.unidad_medida ?? ''}
                      </td>
                      <td className="r">{costo === null ? '—' : mxn(costo)}</td>
                      <td className="r">{costo === null ? '—' : mxn(costo * Number(f.cantidad))}</td>
                      <td className="mono">{f.usuario_creador ?? 'sin dato'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="fuente">
          Mostrando {visibles.length} de {filtradas.length} · inventario_ledger (ENTRADA_COMPRA y PRODUCCION de terminados)
        </div>
        {filtradas.length > visibles.length && (
          <div style={{ marginTop: 10 }}>
            <CambiarModal className="btn" href={href({ filas: filas + TANDA })}>
              Cargar más ({Math.min(TANDA, filtradas.length - visibles.length)} de {filtradas.length - visibles.length} restantes)
            </CambiarModal>
          </div>
        )}
      </section>
    </>
  )
}
