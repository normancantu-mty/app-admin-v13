'use client'

/**
 * Apartado «Lotes» de la ruta escondida de correcciones (2026-11-18, agente
 * Cuartel). Corrige la CABECERA de un lote: codigo (nombre), fechas, si la
 * fermentacion termino o sigue, horas, Brix y notas. NO toca etapas.
 *
 *   Fila: «Editar»
 *   Paso 1 (revisar): el formulario + motivo -> «Continuar» (ensena antes -> despues)
 *   Paso 2 (confirmar): teclear el codigo del lote como quedara -> «Aplicar»
 *
 * La logica pura vive en `lib/ajustes-lotes.ts`; el servidor repite todo
 * (`ajustarLoteAction` + RPC `ajustar_lote`).
 */

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ajustarLoteAction, eliminarLoteAction } from '@/app/actions/ajustes-lotes'
import {
  cabeceraDesdeForm,
  cambiosDeLote,
  confirmacionLoteCasa,
  ETIQUETA_CAMPO,
  formDesdeCabecera,
  MOTIVO_MINIMO,
  renombraDeVerdad,
  type CabeceraLote,
  type FormCabecera,
  verEstado
} from '@/lib/ajustes-lotes'
import { CHIP_ESTADO, ESTADOS_LOTE, ETIQUETA_ESTADO, estadoLote, type EstadoLote } from '@/components/v2/lotes/estado'
import { avisoDeCodigoNumerico } from '@/lib/lote-alias'

export type FilaLoteCorreccion = { id: string; cabecera: CabeceraLote; alias: string[] }

const ver = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))

export function LotesCorreccion({
  lotes,
  filtro,
  recomendado,
  onAviso
}: {
  lotes: FilaLoteCorreccion[]
  filtro: string
  recomendado: string
  onAviso: (a: { tipo: 'ok' | 'mal'; texto: string }) => void
}) {
  const router = useRouter()
  const [editando, setEditando] = useState<FilaLoteCorreccion | null>(null)
  const [eliminando, setEliminando] = useState<FilaLoteCorreccion | null>(null)
  const visibles = useMemo(
    () => lotes.filter((l) => !filtro || `${l.cabecera.codigo_lote} ${l.alias.join(' ')} ${l.cabecera.notas ?? ''}`.toLowerCase().includes(filtro)),
    [lotes, filtro]
  )

  return (
    <>
      <div className="msg info" data-testid="lotes-info">
        Corrige la cabecera del lote (no las etapas). Queda en la bitácora con tu usuario y el motivo. Si cambias el código, el nombre
        anterior queda como <b>alias</b>: el bot sigue encontrando el lote por cualquiera de los dos.
        {recomendado ? (
          <>
            {' '}
            El siguiente consecutivo es <b className="mono">{recomendado}</b>.
          </>
        ) : null}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="t" data-testid="tabla-lotes" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th>Lote</th>
              <th>Inicio</th>
              <th>Estado</th>
              <th>Fermentación</th>
              <th className="r">Horas</th>
              <th className="r">Brix chile / final</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visibles.map((l) => (
              <tr key={l.id}>
                <td>
                  <b className="mono">{l.cabecera.codigo_lote}</b>
                  {l.alias.length ? (
                    <div className="mono" style={{ color: 'var(--muted)' }}>
                      antes: {l.alias.join(', ')}
                    </div>
                  ) : null}
                </td>
                <td className="mono">{l.cabecera.fecha_inicio}</td>
                <td>
                  <span className={`chip ${CHIP_ESTADO[estadoLote(l.cabecera.estado_proceso)]}`}>{ETIQUETA_ESTADO[estadoLote(l.cabecera.estado_proceso)]}</span>
                </td>
                <td>
                  {l.cabecera.fecha_fin_fermentacion ? (
                    <span className="chip info">terminó {l.cabecera.fecha_fin_fermentacion}</span>
                  ) : (
                    <span className="chip warn">en curso</span>
                  )}
                </td>
                <td className="r mono">{ver(l.cabecera.horas_fermentacion)}</td>
                <td className="r mono">
                  {ver(l.cabecera.brix_chile)} / {ver(l.cabecera.brix_final)}
                </td>
                <td className="r">
                  <button type="button" className="btn mini" onClick={() => setEditando(l)}>
                    Editar
                  </button>{' '}
                  <button type="button" className="btn mini" onClick={() => setEliminando(l)} data-testid="lt-eliminar" style={{ color: 'var(--bad, #b00020)' }}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visibles.length === 0 ? <div className="vacio">Sin coincidencias</div> : null}
      </div>

      {editando ? (
        <DialogoLote
          fila={editando}
          recomendado={recomendado}
          onCerrar={() => setEditando(null)}
          onHecho={(texto) => {
            setEditando(null)
            onAviso({ tipo: 'ok', texto })
            router.refresh()
          }}
        />
      ) : null}

      {eliminando ? (
        <DialogoEliminarLote
          fila={eliminando}
          onCerrar={() => setEliminando(null)}
          onHecho={(texto) => {
            setEliminando(null)
            onAviso({ tipo: 'ok', texto })
            router.refresh()
          }}
        />
      ) : null}
    </>
  )
}

function DialogoEliminarLote({ fila, onCerrar, onHecho }: { fila: FilaLoteCorreccion; onCerrar: () => void; onHecho: (texto: string) => void }) {
  const codigo = fila.cabecera.codigo_lote
  const [motivo, setMotivo] = useState('')
  const [tecleo, setTecleo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendiente, iniciar] = useTransition()
  const casa = confirmacionLoteCasa(tecleo, codigo)
  const listo = casa && motivo.trim().length >= MOTIVO_MINIMO

  const eliminar = () => {
    if (!listo) return
    setError(null)
    iniciar(async () => {
      const r = await eliminarLoteAction({ id: fila.id, confirmacion: tecleo, motivo })
      if (!r.ok) {
        setError(r.error)
        return
      }
      onHecho(`Lote ${r.codigo_lote} eliminado (${r.entradas} insumo(s), ${r.salidas} tanda(s), ${r.etapas} etapa(s)). La foto completa queda en la bitácora.`)
    })
  }

  return (
    <div
      className="m-fondo"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pendiente) onCerrar()
      }}
    >
      <div className="m-caja sm" role="dialog" aria-modal="true" aria-label="Eliminar lote" data-testid="dialogo-eliminar-lote">
        <div className="m-hd">
          <div className="m-tit">
            <h2>Eliminar el lote {codigo}</h2>
            <div className="m-sub">{fila.alias.length ? `antes: ${fila.alias.join(', ')}` : 'No se deshace desde la pantalla'}</div>
          </div>
          <button type="button" className="m-cerrar" aria-label="Cerrar" onClick={onCerrar} disabled={pendiente}>
            ×
          </button>
        </div>
        <div className="m-bd" style={{ padding: 18 }}>
          <div className="msg warn">
            Se borra el lote <b className="mono">{codigo}</b> con sus insumos, tandas, etapas y alias. Si ya tiene envasado ligado (movió inventario), el
            sistema lo rechaza. La foto completa queda en la bitácora con tu usuario y el motivo.
          </div>
          <div className="campo">
            <label htmlFor="le-motivo">Motivo (obligatorio)</label>
            <textarea id="le-motivo" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. lote de prueba; capturado dos veces" />
          </div>
          <div className="campo">
            <label htmlFor="le-tecleo">
              Para confirmar, escribe el código del lote: <b className="mono">{codigo}</b>
            </label>
            <input id="le-tecleo" autoComplete="off" value={tecleo} onChange={(e) => setTecleo(e.target.value)} data-testid="le-tecleo" />
          </div>
          {tecleo !== '' && !casa ? <div className="msg mal">No coincide con el código.</div> : null}
          {error ? (
            <div className="msg mal" role="alert">
              {error}
            </div>
          ) : null}
          <div className="fila-acc" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onCerrar} disabled={pendiente}>
              Cancelar
            </button>
            <button type="button" className="btn p" disabled={!listo || pendiente} onClick={eliminar} data-testid="le-eliminar">
              {pendiente ? 'Eliminando…' : `Eliminar ${codigo}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function DialogoLote({
  fila,
  recomendado,
  onCerrar,
  onHecho
}: {
  fila: FilaLoteCorreccion
  recomendado: string
  onCerrar: () => void
  onHecho: (texto: string) => void
}) {
  const visto = fila.cabecera
  const [paso, setPaso] = useState<1 | 2>(1)
  const [form, setForm] = useState<FormCabecera>(() => formDesdeCabecera(visto))
  const [motivo, setMotivo] = useState('')
  const [tecleo, setTecleo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendiente, iniciar] = useTransition()

  const leido = cabeceraDesdeForm(form)
  const cambios = leido.ok ? cambiosDeLote(visto, leido.cabecera) : []
  const errorPaso1 = !leido.ok
    ? leido.error
    : cambios.length === 0
      ? 'No cambiaste nada.'
      : motivo.trim().length < MOTIVO_MINIMO
        ? `El motivo es obligatorio (mínimo ${MOTIVO_MINIMO} caracteres).`
        : null
  const nuevoCodigo = leido.ok ? leido.cabecera.codigo_lote : ''
  const aviso = leido.ok && renombraDeVerdad(visto.codigo_lote, nuevoCodigo) ? avisoDeCodigoNumerico(nuevoCodigo, recomendado) : null
  const casa = confirmacionLoteCasa(tecleo, nuevoCodigo)
  const pon = (k: keyof FormCabecera, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  const aplicar = () => {
    if (!leido.ok || !casa) return
    setError(null)
    iniciar(async () => {
      const r = await ajustarLoteAction({ id: fila.id, visto, nuevo: leido.cabecera, motivo, paso1: true, confirmacion: tecleo })
      if (!r.ok) {
        setError(r.error)
        return
      }
      const renombre = r.antes.codigo_lote !== r.despues.codigo_lote ? ` Alias: ${r.alias.join(', ') || '—'}.` : ''
      onHecho(`Lote ${r.despues.codigo_lote} corregido (${r.cambios.map((c) => ETIQUETA_CAMPO[c as keyof typeof ETIQUETA_CAMPO] ?? c).join(', ')}).${renombre}`)
    })
  }

  return (
    <div
      className="m-fondo"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pendiente) onCerrar()
      }}
    >
      <div className="m-caja sm" role="dialog" aria-modal="true" aria-label="Corregir lote" data-testid="dialogo-lote">
        <div className="m-hd">
          <div className="m-tit">
            <h2>{paso === 1 ? 'Corregir lote (1 de 2)' : 'Confirmar corrección (2 de 2)'}</h2>
            <div className="m-sub">
              {visto.codigo_lote}
              {fila.alias.length ? ` · antes: ${fila.alias.join(', ')}` : ''}
            </div>
          </div>
          <button type="button" className="m-cerrar" aria-label="Cerrar" onClick={onCerrar} disabled={pendiente}>
            ×
          </button>
        </div>
        <div className="m-bd" style={{ padding: 18 }}>
          {paso === 1 ? (
            <>
              <div className="campo">
                <label htmlFor="lt-codigo">Código (nombre)</label>
                <input id="lt-codigo" value={form.codigo_lote} maxLength={40} onChange={(e) => pon('codigo_lote', e.target.value)} />
                {aviso ? <div className="msg warn">{aviso}</div> : null}
              </div>
              <div className="campo">
                <label htmlFor="lt-inicio">Inicio de fermentación</label>
                <input id="lt-inicio" type="date" value={form.fecha_inicio} onChange={(e) => pon('fecha_inicio', e.target.value)} />
              </div>
              <div className="campo">
                <label htmlFor="lt-estado">Estado del lote</label>
                <select id="lt-estado" value={form.estado_proceso} onChange={(e) => pon('estado_proceso', e.target.value as EstadoLote)} data-testid="lt-estado">
                  {ESTADOS_LOTE.map((e) => (
                    <option key={e} value={e}>
                      {ETIQUETA_ESTADO[e]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="campo">
                <span>Fermentación</span>
                <div className="seg" role="group" aria-label="Estado de la fermentación">
                  <button type="button" className={!form.terminada ? 'on' : ''} onClick={() => pon('terminada', false)} data-testid="lt-en-curso">
                    En curso
                  </button>
                  <button
                    type="button"
                    className={form.terminada ? 'on' : ''}
                    onClick={() => setForm((f) => ({ ...f, terminada: true, fecha_fin_fermentacion: f.fecha_fin_fermentacion || f.fecha_inicio }))}
                    data-testid="lt-terminada"
                  >
                    Terminada
                  </button>
                </div>
              </div>
              {form.terminada ? (
                <div className="campo">
                  <label htmlFor="lt-fin">Fin de fermentación</label>
                  <input
                    id="lt-fin"
                    type="date"
                    value={form.fecha_fin_fermentacion}
                    min={form.fecha_inicio || undefined}
                    onChange={(e) => pon('fecha_fin_fermentacion', e.target.value)}
                  />
                </div>
              ) : null}
              <div className="grid g3">
                <div className="campo">
                  <label htmlFor="lt-horas">Horas</label>
                  <input id="lt-horas" inputMode="decimal" value={form.horas_fermentacion} onChange={(e) => pon('horas_fermentacion', e.target.value)} />
                </div>
                <div className="campo">
                  <label htmlFor="lt-brix-chile">Brix chile</label>
                  <input id="lt-brix-chile" inputMode="decimal" value={form.brix_chile} onChange={(e) => pon('brix_chile', e.target.value)} />
                </div>
                <div className="campo">
                  <label htmlFor="lt-brix-final">Brix final</label>
                  <input id="lt-brix-final" inputMode="decimal" value={form.brix_final} onChange={(e) => pon('brix_final', e.target.value)} />
                </div>
              </div>
              <div className="campo">
                <label htmlFor="lt-notas">Notas</label>
                <textarea id="lt-notas" rows={2} value={form.notas} onChange={(e) => pon('notas', e.target.value)} />
              </div>
              <div className="campo">
                <label htmlFor="lt-motivo">Motivo (obligatorio)</label>
                <textarea id="lt-motivo" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. nomenclatura nueva; la fecha de fin se capturó mal" />
              </div>
              {errorPaso1 && (cambios.length > 0 || motivo !== '' || !leido.ok) ? <div className="msg mal">{errorPaso1}</div> : null}
              <div className="fila-acc" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={onCerrar}>
                  Cancelar
                </button>
                <button type="button" className="btn p" disabled={errorPaso1 !== null} onClick={() => setPaso(2)} data-testid="lt-continuar">
                  Continuar
                </button>
              </div>
            </>
          ) : (
            <>
              <table className="t" style={{ marginBottom: 12 }}>
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Antes</th>
                    <th>Después</th>
                  </tr>
                </thead>
                <tbody>
                  {cambios.map((c) => (
                    <tr key={c.campo}>
                      <td>{ETIQUETA_CAMPO[c.campo]}</td>
                      <td className="mono">{c.campo === 'estado_proceso' ? verEstado(c.antes) : c.campo === 'fecha_fin_fermentacion' && c.antes === null ? 'en curso' : ver(c.antes)}</td>
                      <td className="mono">{c.campo === 'estado_proceso' ? verEstado(c.despues) : c.campo === 'fecha_fin_fermentacion' && c.despues === null ? 'en curso' : ver(c.despues)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {leido.ok && renombraDeVerdad(visto.codigo_lote, nuevoCodigo) ? (
                <div className="msg info">
                  «{visto.codigo_lote}» quedará como alias: el bot seguirá encontrando el lote por ese nombre.
                </div>
              ) : null}
              <div className="msg info">
                Motivo: «{motivo.trim()}». Para confirmar, escribe el código del lote como quedará: <b className="mono">{nuevoCodigo}</b>
              </div>
              <div className="campo">
                <label htmlFor="lt-tecleo">Escribe el código del lote</label>
                <input id="lt-tecleo" autoComplete="off" value={tecleo} onChange={(e) => setTecleo(e.target.value)} autoFocus />
              </div>
              {tecleo !== '' && !casa ? <div className="msg mal">No coincide con el código.</div> : null}
              {error ? (
                <div className="msg mal" role="alert">
                  {error}
                </div>
              ) : null}
              <div className="fila-acc" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setPaso(1)} disabled={pendiente}>
                  Atrás
                </button>
                <button type="button" className="btn p" disabled={!casa || pendiente} onClick={aplicar} data-testid="lt-aplicar">
                  {pendiente ? 'Aplicando…' : 'Aplicar corrección'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
