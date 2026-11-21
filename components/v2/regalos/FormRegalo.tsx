'use client'

/**
 * Captura de un regalo. Escrito el 2026-11-20 por un ejecutor del Socio.
 * Solo UI: valida con `validarSolicitudRegalo` (la misma que el servidor) y
 * guarda con `registrarRegaloAction`. Si no hay existencia, AVISA antes de
 * guardar y deja guardar igual (el ERP avisa, nunca bloquea).
 */

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { registrarRegaloAction } from '@/app/actions/regalos'
import { QUIENES_CONOCIDOS, validarSolicitudRegalo, type SolicitudRegalo } from '@/lib/regalos'

export interface ProductoForm {
  id: string
  nombre: string
  /** Piezas en la matriz (PAGADO + CONSIGNADO), para el aviso. */
  hay: number
}

const OTRO = '__otro__'

export function FormRegalo({ productos, hoy }: { productos: ProductoForm[]; hoy: string }) {
  const router = useRouter()
  const [pendiente, startTransition] = useTransition()
  const [fecha, setFecha] = useState(hoy)
  const [quienSel, setQuienSel] = useState<string>(QUIENES_CONOCIDOS[0])
  const [quienOtro, setQuienOtro] = useState('')
  const [motivo, setMotivo] = useState('')
  const [cantidades, setCantidades] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const solicitud: SolicitudRegalo = useMemo(
    () => ({
      fecha,
      quien_regalo: quienSel === OTRO ? quienOtro : quienSel,
      motivo,
      lineas: productos
        .map((p) => ({ id_producto: p.id, cantidad: Number(cantidades[p.id] || 0) }))
        .filter((l) => l.cantidad !== 0)
    }),
    [fecha, quienSel, quienOtro, motivo, cantidades, productos]
  )
  const invalida = validarSolicitudRegalo(solicitud)
  const faltan = productos.filter((p) => Number(cantidades[p.id] || 0) > Math.max(0, p.hay))

  const guardar = () => {
    setError(null)
    setOk(null)
    if (invalida) {
      setError(invalida)
      return
    }
    startTransition(async () => {
      const r = await registrarRegaloAction(solicitud)
      if (!r.ok) {
        setError(r.error)
        return
      }
      const piezas = solicitud.lineas.reduce((a, l) => a + l.cantidad, 0)
      setOk(
        `Guardado: ${piezas} ${piezas === 1 ? 'pieza' : 'piezas'} de ${solicitud.quien_regalo}. Bajó el inventario.` +
          (r.avisos.length ? ` Aviso: ${r.avisos.join(' ')}` : '')
      )
      setCantidades({})
      setMotivo('')
      router.refresh()
    })
  }

  return (
    <section className="card" data-testid="form-regalo">
      <div className="hd">
        <div>
          <h2>Registrar regalo</h2>
          <div className="sub">Sale del inventario de la matriz; no toca dinero.</div>
        </div>
      </div>
      <div className="campo">
        <label htmlFor="rg-fecha">Fecha</label>
        <input id="rg-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
      </div>
      <div className="campo">
        <label htmlFor="rg-quien">Quién regaló</label>
        <select id="rg-quien" value={quienSel} onChange={(e) => setQuienSel(e.target.value)}>
          {QUIENES_CONOCIDOS.map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
          <option value={OTRO}>Otra persona…</option>
        </select>
        {quienSel === OTRO ? (
          <input aria-label="Nombre de quien regaló" placeholder="Nombre" value={quienOtro} onChange={(e) => setQuienOtro(e.target.value)} />
        ) : null}
      </div>
      <div className="campo">
        <span className="lbl">Piezas</span>
        {productos.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              aria-label={`Piezas de ${p.nombre}`}
              inputMode="numeric"
              placeholder="0"
              value={cantidades[p.id] ?? ''}
              onChange={(e) => setCantidades((c) => ({ ...c, [p.id]: e.target.value.replace(/[^0-9]/g, '') }))}
              style={{ width: 80 }}
            />
            <span style={{ flex: 1 }}>{p.nombre}</span>
            <span className="chip">hay {p.hay}</span>
          </div>
        ))}
      </div>
      <div className="campo">
        <label htmlFor="rg-motivo">Motivo o evento</label>
        <textarea id="rg-motivo" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. Evento de la Cámara de Comercio, Zacatecas" />
      </div>
      {faltan.length > 0 ? (
        <div className="msg info" role="status">
          Aviso: no alcanza la existencia de {faltan.map((p) => p.nombre).join(', ')}. Se puede guardar igual: el inventario queda en
          negativo y se nota en el stock.
        </div>
      ) : null}
      {error ? (
        <div className="msg mal" role="alert">
          {error}
        </div>
      ) : null}
      {ok ? <div className="msg ok">{ok}</div> : null}
      <div className="fila-acc" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn p" disabled={pendiente || invalida !== null} onClick={guardar} data-testid="guardar-regalo">
          {pendiente ? 'Guardando…' : 'Guardar regalo'}
        </button>
      </div>
    </section>
  )
}
