'use client'

/**
 * Tablas editables de `/panel/correcciones` con la DOBLE confirmacion
 * (2026-11-03, agente de la ruta admin). La logica pura vive en
 * `lib/ajustes-admin.ts`; aqui solo el estado del dialogo.
 *
 *   Fila: valor nuevo -> «Corregir»
 *   Paso 1 (revisar): actual -> nuevo, diferencia y motivo obligatorio -> «Continuar»
 *   Paso 2 (confirmar): teclear el valor nuevo otra vez -> «Aplicar ajuste»
 */

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { aplicarAjusteAction } from '@/app/actions/ajustes-admin'
import {
  calcularDiferencia,
  claveInventario,
  confirmacionCasa,
  errorDePaso1,
  leerNumero,
  type ClaseAjuste
} from '@/lib/ajustes-admin'

export type FilaStock = {
  id_entidad: string
  entidad: string
  rol: string
  id_producto: string
  producto: string
  sku: string | null
  tipo_producto: string
  unidad_medida: string | null
  cubeta: string
  stock: number
}

export type FilaCuenta = {
  id: string
  nombre: string
  clase: string | null
  entidad: string
  rol: string
  saldo: number
}

type Objetivo = { clase: ClaseAjuste; clave: string; titulo: string; detalle: string; actual: number; nuevoTexto: string }

const fmtCant = (n: number) => n.toLocaleString('es-MX', { maximumFractionDigits: 4 })
const fmtDinero = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })
const fmt = (clase: ClaseAjuste, n: number) => (clase === 'inventario' ? fmtCant(n) : fmtDinero(n))
const conSigno = (clase: ClaseAjuste, n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(clase, Math.abs(n))}`

export function Correcciones({ stock, cuentas }: { stock: FilaStock[]; cuentas: FilaCuenta[] }) {
  const router = useRouter()
  const [vista, setVista] = useState<'stock' | 'cuentas'>('stock')
  const [filtro, setFiltro] = useState('')
  const [nuevos, setNuevos] = useState<Record<string, string>>({})
  const [objetivo, setObjetivo] = useState<Objetivo | null>(null)
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'mal'; texto: string } | null>(null)

  const f = filtro.trim().toLowerCase()
  const stockVisible = useMemo(
    () => stock.filter((s) => !f || `${s.entidad} ${s.producto} ${s.sku ?? ''} ${s.cubeta}`.toLowerCase().includes(f)),
    [stock, f]
  )
  const cuentasVisibles = useMemo(
    () => cuentas.filter((c) => !f || `${c.entidad} ${c.nombre} ${c.clase ?? ''}`.toLowerCase().includes(f)),
    [cuentas, f]
  )

  const abrir = (o: Objetivo) => {
    setAviso(null)
    setObjetivo(o)
  }

  return (
    <section className="card" data-testid="correcciones">
      <div className="msg info">
        Cada corrección escribe un <b>movimiento de ajuste</b> por la diferencia (valor nuevo − valor calculado), con tu usuario y el
        motivo. No se edita ni se borra ninguna fila. Si algo se capturó mientras revisabas, el ajuste se rechaza.
      </div>
      {aviso ? (
        <div className={`msg ${aviso.tipo}`} role="status" data-testid="correcciones-aviso">
          {aviso.texto}
        </div>
      ) : null}
      <div className="fila-acc" style={{ margin: '8px 0 12px', flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="Qué corregir">
          <button type="button" className={vista === 'stock' ? 'on' : ''} onClick={() => setVista('stock')} style={{ padding: '7px 12px', fontWeight: 600 }}>
            Inventario ({stock.length})
          </button>
          <button type="button" className={vista === 'cuentas' ? 'on' : ''} onClick={() => setVista('cuentas')} style={{ padding: '7px 12px', fontWeight: 600 }}>
            Cuentas ({cuentas.length})
          </button>
        </div>
        <input className="in" placeholder="Filtrar por entidad, producto, cuenta…" value={filtro} onChange={(e) => setFiltro(e.target.value)} style={{ minWidth: 240 }} />
      </div>

      {vista === 'stock' ? (
        <div className="inv-scroll" style={{ overflowX: 'auto' }}>
          <table className="t" data-testid="tabla-stock" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th>Entidad</th>
                <th>Producto</th>
                <th>Cubeta</th>
                <th className="r">Stock actual</th>
                <th className="r">Stock nuevo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stockVisible.map((s) => {
                const clave = claveInventario({ idEntidad: s.id_entidad, idProducto: s.id_producto, cubeta: s.cubeta as 'PAGADO' | 'CONSIGNADO' })
                const texto = nuevos[clave] ?? ''
                return (
                  <tr key={clave}>
                    <td>
                      {s.entidad} {s.rol === 'ADMIN' ? <span className="chip chile">matriz</span> : <span className="chip">{s.rol}</span>}
                    </td>
                    <td>
                      <b>{s.producto}</b>
                      <div className="mono" style={{ color: 'var(--muted)' }}>
                        {s.sku ?? ''} · {s.tipo_producto.toLowerCase()}
                      </div>
                    </td>
                    <td>
                      <span className={`chip ${s.cubeta === 'CONSIGNADO' ? 'warn' : 'info'}`}>{s.cubeta}</span>
                    </td>
                    <td className={`r mono ${s.stock < 0 ? 'neg' : ''}`}>
                      {fmtCant(s.stock)} {s.unidad_medida ?? ''}
                    </td>
                    <td className="r">
                      <input
                        className="in"
                        inputMode="decimal"
                        aria-label={`Stock nuevo de ${s.producto} en ${s.entidad} ${s.cubeta}`}
                        value={texto}
                        onChange={(e) => setNuevos((n) => ({ ...n, [clave]: e.target.value }))}
                        style={{ width: 110, textAlign: 'right' }}
                      />
                    </td>
                    <td className="r">
                      <button
                        type="button"
                        className="btn mini"
                        disabled={texto.trim() === ''}
                        onClick={() =>
                          abrir({
                            clase: 'inventario',
                            clave,
                            titulo: s.producto,
                            detalle: `${s.entidad} · cubeta ${s.cubeta}`,
                            actual: s.stock,
                            nuevoTexto: texto
                          })
                        }
                      >
                        Corregir
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {stockVisible.length === 0 ? <div className="vacio">Sin coincidencias</div> : null}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="t" data-testid="tabla-cuentas" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th>Entidad</th>
                <th>Cuenta</th>
                <th className="r">Saldo actual</th>
                <th className="r">Saldo nuevo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cuentasVisibles.map((c) => {
                const texto = nuevos[c.id] ?? ''
                return (
                  <tr key={c.id}>
                    <td>
                      {c.entidad} {c.rol === 'ADMIN' ? <span className="chip chile">matriz</span> : c.rol ? <span className="chip">{c.rol}</span> : null}
                    </td>
                    <td>
                      <b>{c.nombre}</b>
                      {c.clase ? <div className="mono" style={{ color: 'var(--muted)' }}>{c.clase}</div> : null}
                    </td>
                    <td className={`r mono ${c.saldo < 0 ? 'neg' : ''}`}>{fmtDinero(c.saldo)}</td>
                    <td className="r">
                      <input
                        className="in"
                        inputMode="decimal"
                        aria-label={`Saldo nuevo de ${c.nombre}`}
                        value={texto}
                        onChange={(e) => setNuevos((n) => ({ ...n, [c.id]: e.target.value }))}
                        style={{ width: 130, textAlign: 'right' }}
                      />
                    </td>
                    <td className="r">
                      <button
                        type="button"
                        className="btn mini"
                        disabled={texto.trim() === ''}
                        onClick={() =>
                          abrir({ clase: 'saldo', clave: c.id, titulo: c.nombre, detalle: c.entidad, actual: c.saldo, nuevoTexto: texto })
                        }
                      >
                        Corregir
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {cuentasVisibles.length === 0 ? <div className="vacio">Sin coincidencias</div> : null}
        </div>
      )}

      {objetivo ? (
        <DialogoAjuste
          objetivo={objetivo}
          onCerrar={() => setObjetivo(null)}
          onHecho={(texto) => {
            setObjetivo(null)
            setNuevos((n) => {
              const { [objetivo.clave]: _quitado, ...resto } = n
              void _quitado
              return resto
            })
            setAviso({ tipo: 'ok', texto })
            router.refresh()
          }}
        />
      ) : null}
    </section>
  )
}

function DialogoAjuste({ objetivo, onCerrar, onHecho }: { objetivo: Objetivo; onCerrar: () => void; onHecho: (texto: string) => void }) {
  const { clase, actual } = objetivo
  const [paso, setPaso] = useState<1 | 2>(1)
  const [nuevoTexto, setNuevoTexto] = useState(objetivo.nuevoTexto)
  const [motivo, setMotivo] = useState('')
  const [tecleo, setTecleo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendiente, iniciar] = useTransition()

  const nuevo = leerNumero(nuevoTexto)
  const dif = nuevo === null ? null : calcularDiferencia(actual, nuevo, clase)
  const errorPaso1 = errorDePaso1({ clase, actual, nuevoTexto, motivo })
  const casa = nuevo !== null && confirmacionCasa(tecleo, nuevo, clase)

  const aplicar = () => {
    if (nuevo === null || !casa) return
    setError(null)
    iniciar(async () => {
      const r = await aplicarAjusteAction({ clase, clave: objetivo.clave, visto: actual, nuevo, motivo, paso1: true, confirmacion: tecleo })
      if (!r.ok) {
        setError(r.error)
        return
      }
      onHecho(
        `Ajuste registrado: ${objetivo.titulo} (${objetivo.detalle}) pasó de ${fmt(clase, r.anterior)} a ${fmt(clase, r.nuevo)} (${conSigno(clase, r.diferencia)}).`
      )
    })
  }

  return (
    <div
      className="m-fondo"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pendiente) onCerrar()
      }}
    >
      <div className="m-caja sm" role="dialog" aria-modal="true" aria-label="Confirmar corrección" data-testid="dialogo-ajuste">
        <div className="m-hd">
          <div className="m-tit">
            <h2>{paso === 1 ? 'Revisar corrección (1 de 2)' : 'Confirmar corrección (2 de 2)'}</h2>
            <div className="m-sub">
              {objetivo.titulo} · {objetivo.detalle}
            </div>
          </div>
          <button type="button" className="m-cerrar" aria-label="Cerrar" onClick={onCerrar} disabled={pendiente}>
            ×
          </button>
        </div>
        <div className="m-bd" style={{ padding: 18 }}>
          <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', marginBottom: 12 }}>
            <div className="kpi">
              <span className="t">Actual</span>
              <span className="v">{fmt(clase, actual)}</span>
            </div>
            <div className="kpi">
              <span className="t">Nuevo</span>
              <span className="v">{nuevo === null ? '—' : fmt(clase, nuevo)}</span>
            </div>
            <div className="kpi fuerte">
              <span className="t">Diferencia</span>
              <span className={`v ${dif && dif.diferencia < 0 ? 'neg' : 'pos'}`}>{dif ? conSigno(clase, dif.diferencia) : '—'}</span>
            </div>
          </div>

          {paso === 1 ? (
            <>
              <div className="campo">
                <label htmlFor="aj-nuevo">{clase === 'inventario' ? 'Stock nuevo' : 'Saldo nuevo'}</label>
                <input id="aj-nuevo" inputMode="decimal" value={nuevoTexto} onChange={(e) => setNuevoTexto(e.target.value)} />
              </div>
              <div className="campo">
                <label htmlFor="aj-motivo">Motivo (obligatorio)</label>
                <textarea id="aj-motivo" rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. conteo físico del 3 nov; el bot registró 2 veces la venta" />
              </div>
              {errorPaso1 && (nuevoTexto.trim() !== '' || motivo !== '') ? <div className="msg mal">{errorPaso1}</div> : null}
              <div className="fila-acc" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={onCerrar}>
                  Cancelar
                </button>
                <button type="button" className="btn p" disabled={errorPaso1 !== null} onClick={() => setPaso(2)} data-testid="aj-continuar">
                  Continuar
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="msg info">
                Se escribirá un ajuste de <b>{dif ? conSigno(clase, dif.diferencia) : ''}</b> con el motivo: «{motivo.trim()}». Para confirmar,
                escribe otra vez el valor nuevo: <b className="mono">{nuevo === null ? '' : String(nuevo)}</b>
              </div>
              <div className="campo">
                <label htmlFor="aj-tecleo">Escribe el valor nuevo</label>
                <input id="aj-tecleo" inputMode="decimal" autoComplete="off" value={tecleo} onChange={(e) => setTecleo(e.target.value)} autoFocus />
              </div>
              {tecleo !== '' && !casa ? <div className="msg mal">No coincide con el valor nuevo.</div> : null}
              {error ? (
                <div className="msg mal" role="alert">
                  {error}
                </div>
              ) : null}
              <div className="fila-acc" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setPaso(1)} disabled={pendiente}>
                  Atrás
                </button>
                <button type="button" className="btn p" disabled={!casa || pendiente} onClick={aplicar} data-testid="aj-aplicar">
                  {pendiente ? 'Aplicando…' : 'Aplicar ajuste'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
