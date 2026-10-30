/**
 * Paridad v2 — la ficha de un nodo, como la pidio Norman (Q6): tres cifras (Total
 * Ganado, Saldo Pendiente, Total Mermas), la tabla del inventario a concesion y
 * los movimientos con «Cargar más», «Creado por» y «Anular». El conteo fisico
 * vive aqui (Q14), no en «Capturar». Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * Componente de servidor: lo usan el modal `/panel/m/nodo/[id]` y el panel de un
 * DST/LOC (su propia ficha).
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import type { CurrentUser } from '@/lib/auth-utils'
import type { FichaNodo } from '@/lib/v2/nodo'
import { mxn, num } from '@/lib/v2/formato'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import BotonReportarMerma from '@/components/v2/inventario/BotonReportarMerma'
import Historial from './Historial'
import { ResumenCobranzaNodo } from '@/components/v2/cobranza/ResumenCobranzaNodo'
import { esRolDeMandoV2 } from '@/lib/v2/roles'

export function FichaVista({ ficha, usuario, propia = false }: { ficha: FichaNodo; usuario: CurrentUser; propia?: boolean }) {
  const { entidad: e } = ficha
  const id = e.id
  // Operan ADMIN y DST. SOCIO lee; el LOC no opera: la RLS le niega tickets y cobranza,
  // conteo y devolucion son de ADMIN/DST (la v1 se los mostraba y fallaban).
  const opera = usuario.rol === 'ADMIN' || usuario.rol === 'DST'
  const aFavor = ficha.saldoPendiente < 0

  return (
    <div data-testid="ficha-nodo">
      <div className="ph" style={{ marginTop: 0, display: propia ? 'none' : undefined }}>
        <div>
          <span className="chip">{e.rol === 'DST' ? 'Distribuidor' : 'Local'}</span>{' '}
          {ficha.localDeMiRed && <span className="chip info">Local de mi red</span>}{' '}
          <span className="muted">
            {e.zona} · {e.telefono || 'Sin teléfono'}
          </span>
        </div>
      </div>

      {opera && (
        <div className="acciones">
          <AbrirModal className="btn p" href={`${RUTA_BASE}/m/venta?vendedor=${id}`} titulo="Nueva venta" tam="xl" data-testid="ficha-venta">
            📦 Nueva venta
          </AbrirModal>
          <AbrirModal className="btn" href={`${RUTA_BASE}/m/nodo/${id}/cobranza`} titulo="Cobrar, contar inventario" data-testid="ficha-cobranza">
            Cobrar, contar inventario
          </AbrirModal>
          <AbrirModal className="btn p" href={`${RUTA_BASE}/m/nodo/${id}/abono`} titulo="Registrar abono" tam="md" data-testid="ficha-abono">
            💵 Registrar abono
          </AbrirModal>
          <AbrirModal className="btn" href={`${RUTA_BASE}/m/nodo/${id}/devolucion`} titulo="Devolución" tam="md" data-testid="ficha-devolucion">
            🔄 Devolución
          </AbrirModal>
          <AbrirModal className="btn" href={`${RUTA_BASE}/m/nodo/${id}/conteo`} titulo="Conteo físico" tam="md" data-testid="ficha-conteo">
            Conteo físico
          </AbrirModal>
          <div className="v1">
            <BotonReportarMerma entidades={[]} entidadFijaId={id} entidadFijaNombre={e.nombre} productos={ficha.productosReportables} />
          </div>
        </div>
      )}

      <div className={`kpis ${ficha.mostrarTotalGanado ? 'k3' : ''}`} style={{ marginBottom: 16 }}>
        {ficha.mostrarTotalGanado && (
          <div className="kpi fuerte" data-testid="kpi-ganado">
            <span className="t">{propia ? 'Lo que he ganado' : 'Total ganado'}</span>
            <span className="v">{mxn(ficha.totalGanado)}</span>
            <span className="d">Comisiones del periodo (mismo cálculo que el ERP actual)</span>
          </div>
        )}
        <div className="kpi" data-testid="kpi-saldo">
          <span className="t">{aFavor ? 'Saldo a favor' : 'Saldo pendiente'}</span>
          <span className={`v ${aFavor ? 'pos' : 'neg'}`}>{mxn(Math.abs(ficha.saldoPendiente))}</span>
          <span className="d">{aFavor ? 'La matriz le debe a este nodo' : 'Deuda neta del nodo con la matriz'}</span>
        </div>
        <div className="kpi" data-testid="kpi-mermas">
          <span className="t">Total mermas</span>
          <span className="v">
            {num(ficha.totalMermas)} <small style={{ fontSize: 12, fontWeight: 600 }}>botellas</small>
          </span>
          <span className="d">Botellas históricas reportadas como merma</span>
        </div>
      </div>

      {/* Cobranza (2026-10-30): deuda, días sin abonar con su color y último abono; solo mando. */}
      {esRolDeMandoV2(usuario.rol) && !propia && <ResumenCobranzaNodo id={id} />}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="hd">
          <div>
            <h2>Inventario a concesión</h2>
            <div className="sub">Stock teórico consignado de producto terminado (v_stock_por_cubeta)</div>
          </div>
        </div>
        {ficha.inventarioConsignado.length === 0 ? (
          <div className="vacio">
            <b>0 botellas a concesión</b>
          </div>
        ) : (
          <div className="tabla-w">
            <table className="t">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="r">Cantidad</th>
                </tr>
              </thead>
              <tbody>
                {ficha.inventarioConsignado.map((r) => (
                  <tr key={r.idProducto}>
                    <td>{r.producto}</td>
                    <td className="r">{r.stockEsperado.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card v1">
        <div className="hd">
          <div>
            <h2>Movimientos</h2>
            <div className="sub">Ventas, abonos y movimientos financieros del nodo. Anular marca ANULADO; no borra.</div>
          </div>
        </div>
        <Historial actividades={ficha.actividades} perfilEntidadId={id} mostrarCreadoPor />
      </section>
    </div>
  )
}
