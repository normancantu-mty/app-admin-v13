/**
 * El panel del empleado administrativo SIN permiso de finanzas (EMPLEADO_ADMIN,
 * 2026-11-13, plan `DESDE_CUARTEL_rol_empleado_admin_2026-11-13.md`). Con
 * permiso ve `PanelMando`. Aqui solo lo operativo de la matriz: captura
 * (envasado, compra de insumos, lotes) e inventario. Nada de saldos, cuentas,
 * cobranza ni cartera: esas paginas lo rebotan en el servidor (`exigirMandoV2`).
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { exigirMatrizV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { VerTodo } from '@/components/v2/pagina/Encabezado'

export async function PanelOperador() {
  const usuario = await exigirMatrizV2()
  return (
    <>
      <div className="ph">
        <div>
          <h1>{usuario.nombre}</h1>
          <div className="sub">Empleado administrativo · operación de la matriz</div>
        </div>
      </div>

      {puedeCapturarMatriz(usuario.rol) && (
        <div className="acciones">
          <span className="lbl">CAPTURAR</span>
          <AbrirModal className="btn p" href={`${RUTA_BASE}/m/envasado`} titulo="Registrar envasado" tam="md">+ Envasado</AbrirModal>
          <AbrirModal className="btn p" href={`${RUTA_BASE}/m/compra`} titulo="Comprar insumos" tam="md">Comprar insumos</AbrirModal>
          <AbrirModal className="btn p" href={`${RUTA_BASE}/m/lote/nuevo`} titulo="Nuevo lote" tam="lg">+ Nuevo lote</AbrirModal>
        </div>
      )}
      <div className="acciones">
        <span className="lbl">ABRIR</span>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/inventario`} titulo="Inventario">Movimientos de inventario</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/lotes`} titulo="Lotes">Ver lotes</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/avisos`} titulo="Avisos" tam="md">Avisos</AbrirModal>
      </div>
      <div className="acciones">
        <span className="lbl">VER TODO</span>
        <VerTodo href={`${RUTA_BASE}/inventario`}>Inventario →</VerTodo>
        <VerTodo href={`${RUTA_BASE}/lotes`}>Lotes →</VerTodo>
      </div>
    </>
  )
}
