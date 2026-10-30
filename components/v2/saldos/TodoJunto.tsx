/**
 * Front v2 — la vista «Sumado» de los saldos: todo junto. Escrito el 2026-10-30
 * por el ejecutor de saldos (lanzado por el Socio). Componente de SERVIDOR, solo
 * presenta: las cifras llegan ya calculadas por quien lo pinta (panel, modal de
 * cuenta, /panel/finanzas).
 *
 * QUE SUMA EL TOTAL Y QUE NO (la regla, no una opinion):
 *  - ENTRA: el `saldo_cuenta()` de TODAS las cuentas de las entidades ADMIN
 *    (`leerCuentasMatriz`). Es el mismo «Total en cuentas» de siempre, el que el
 *    panel compara con la cascada (Account_Firewall: solo cuentas de la matriz).
 *    Incluye la Cuenta Gilberto (LIBRE, solo egresos): es una cuenta de la matriz
 *    y la cascada la cuenta entre «las 4 cuentas»; su saldo se pinta con su signo.
 *  - Transferencias por convertir YA estan dentro del saldo de Transferencias: no
 *    se suman otra vez. Al convertir, el 5% se va a comision (gasto «Financieros»).
 *  - NO ENTRA (se ensena aparte, rotulado): lo por cobrar (es derecho a cobro, no
 *    dinero en cuenta), los impuestos por pagar (es pasivo), la deuda de los locales
 *    con su distribuidor (no es de la matriz: `esDeudaConLaMatriz`, T6), las piezas
 *    (botellas en la matriz y concesion en piso: producto, sin valorizar aqui).
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import type { ReactNode } from 'react'
import { AbrirModal, CambiarModal } from '@/components/v2/modal/AbrirModal'
import { redondear } from '@/lib/v2/dinero'
import { mxn, num } from '@/lib/v2/formato'

export interface FilaTodoJunto {
  id: string
  nombre: string
  saldo: number
  href: string
  /** Chip corto junto al nombre (p. ej. «LIBRE · solo egresos»). */
  chip?: string
  /** Una linea de detalle bajo el nombre. */
  nota?: ReactNode
  /** Clase de la cuenta (EFECTIVO, FISCAL...): da el color cuando la fila es la marcada. */
  clase?: string | null
}

export interface FotoCompleta {
  porCobrar: number
  nodosPorCobrar: number
  /** null = v_pasivo_fiscal sin fila: «Sin dato», nunca 0. */
  impuestos: number | null
  iva: number | null
  ieps: number | null
  deudaConDistribuidor: number
  nodosConDistribuidor: number
  botellasMatriz: number
  piezasEnPiso: number
}

function pct(parte: number, total: number): number | null {
  if (total <= 0 || parte < 0) return null
  return Math.round((parte / total) * 1000) / 10
}

function Envolver({
  como,
  href,
  titulo,
  className,
  children
}: {
  como: 'abrir' | 'cambiar'
  href: string
  titulo: string
  className: string
  children: ReactNode
}) {
  return como === 'abrir' ? (
    <AbrirModal href={href} titulo={titulo} className={className}>
      {children}
    </AbrirModal>
  ) : (
    <CambiarModal href={href} className={className}>
      {children}
    </CambiarModal>
  )
}

export function TodoJunto({
  filas,
  total,
  cuadraConMovimientos,
  pendienteTransferencias,
  foto,
  enlace = 'abrir',
  marcada
}: {
  filas: FilaTodoJunto[]
  total: number
  /** null = esta pantalla no lo comprueba. */
  cuadraConMovimientos?: boolean | null
  /** Monto de transferencias por convertir (ya dentro del saldo de Transferencias). */
  pendienteTransferencias?: number | null
  /** La foto completa (solo el panel la trae). */
  foto?: FotoCompleta
  /** Abrir el modal de la cuenta (panel) o cambiar de modal (dentro de uno). */
  enlace?: 'abrir' | 'cambiar'
  /** id de la cuenta que se esta viendo (se resalta). */
  marcada?: string
}) {
  const positivas = filas.filter((f) => f.saldo > 0).length
  const comision = pendienteTransferencias ? redondear(pendienteTransferencias * 0.05) : 0
  const posicion = foto && foto.impuestos !== null ? redondear(total + foto.porCobrar - foto.impuestos) : null

  return (
    <div className={`vs-junto${marcada ? ' vs-foco' : ''}`} data-testid="todo-junto">
      <div className="vs-total">
        <span className="t">{marcada ? 'Contexto · ' : ''}Todo junto · {filas.length} cuentas de la matriz</span>
        <span className="v">{mxn(total)}</span>
        <span className="d">
          Suma de saldo_cuenta() de {filas.map((f) => f.nombre).join(' + ')}
          {cuadraConMovimientos === true && <> · <span className="chip good">cuadra con los movimientos</span></>}
          {cuadraConMovimientos === false && <> · <span className="chip crit">NO cuadra con los movimientos</span></>}
        </span>
      </div>

      <div className="vs-desglose">
        {filas.map((f) => {
          const p = pct(f.saldo, total)
          // Con una cuenta marcada (modal de cuenta, /panel/finanzas?cuenta=x) esa fila es
          // la protagonista y las demas van chicas y atenuadas.
          const foco = marcada ? (marcada === f.id ? ' on' : ' otra') : ''
          return (
            <Envolver key={f.id} como={enlace} href={f.href} titulo={f.nombre} className={`vs-fila${foco}`}>
              <span className={`vs-nom${marcada === f.id ? ' on' : ''}`} data-clase={f.clase ?? undefined}>
                <b>{f.nombre}</b>
                {f.chip && <span className="chip warn">{f.chip}</span>}
                {f.nota && <small>{f.nota}</small>}
              </span>
              <span className="vs-m" data-clase={f.clase ?? undefined}>
                <b className={f.saldo < 0 ? 'neg' : undefined}>{mxn(f.saldo)}</b>
                <small>{p === null ? (f.saldo < 0 ? 'resta al total' : '—') : `${p}% del total`}</small>
                <span className="barra">
                  <i style={{ width: `${p === null ? 0 : Math.min(100, p)}%` }} />
                </span>
              </span>
            </Envolver>
          )
        })}
        <div className="vs-fila vs-suma">
          <span className="vs-nom">
            <b>Total</b>
            <small>{positivas === filas.length ? 'todas con saldo a favor' : `${filas.length - positivas} cuenta(s) en cero o negativo`}</small>
          </span>
          <span className="vs-m">
            <b>{mxn(total)}</b>
          </span>
        </div>
      </div>

      {pendienteTransferencias ? (
        <p className="vs-nota">
          Transferencias por convertir: <b>{mxn(pendienteTransferencias)}</b>, ya dentro del saldo de Transferencias (no se suma otra vez). Al
          convertirlas, el 5% ({mxn(pendienteTransferencias)} × 0.05 = <b>{mxn(comision)}</b>) se va a comisión.
        </p>
      ) : null}

      {foto && (
        <>
          <div className="vs-foto">
            <AbrirModal href={`${RUTA_BASE}/m/cartera`} titulo="Cartera completa" className="kpi">
              <span className="t">
                + Por cobrar (matriz) <span>›</span>
              </span>
              <span className="v">{mxn(foto.porCobrar)}</span>
              <span className="d">{foto.nodosPorCobrar} nodos · derecho a cobro, no dinero en cuenta</span>
            </AbrirModal>
            <div className="kpi">
              <span className="t">− Impuestos por pagar</span>
              <span className="v">{foto.impuestos === null ? 'Sin dato' : mxn(foto.impuestos)}</span>
              <span className="d">
                IVA {foto.iva === null ? 'Sin dato' : mxn(foto.iva)} · IEPS {foto.ieps === null ? 'Sin dato' : mxn(foto.ieps)}
              </span>
            </div>
            <div className="kpi fuerte">
              <span className="t">= Posición</span>
              <span className="v">{posicion === null ? 'Sin dato' : mxn(posicion)}</span>
              <span className="d">
                {posicion === null
                  ? 'Falta v_pasivo_fiscal: sin impuestos no se calcula'
                  : `${mxn(total)} + ${mxn(foto.porCobrar)} − ${mxn(foto.impuestos ?? 0)}`}
              </span>
            </div>
          </div>
          <div className="vs-fuera">
            <b>No entra en ninguna suma:</b>
            <span>
              {foto.nodosConDistribuidor} locales deben <b>{mxn(foto.deudaConDistribuidor)}</b> a su distribuidor (no es de la matriz)
            </span>
            <span>
              {num(foto.botellasMatriz)} pzas en la matriz y {num(foto.piezasEnPiso)} pzas en concesión en la red (producto, sin valorizar)
            </span>
          </div>
        </>
      )}
    </div>
  )
}
