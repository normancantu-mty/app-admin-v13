'use client'
// v2: catalogo de suscripciones (tabla `suscripciones`). Escrito el 2026-11-09 por el Socio (ejecutor).
// No importa lib/suscripciones a proposito: arrastra lib/bot-sello (node:crypto) al bundle del navegador.
// El servidor manda todo ya en texto; aqui solo se pinta y se manda el formulario.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export interface ItemSuscripcion {
  id: number
  nombre: string
  monto: number
  moneda: 'MXN' | 'USD'
  dia_cobro: number | null
  id_cuenta: string | null
  subcategoria: string
  activa: boolean
  notas: string | null
  montoTexto: string
  estado: 'pagada' | 'pendiente' | 'por_cobrar' | 'baja' | 'inactiva'
  pagadoTexto: string | null
}

const ROTULO: Record<ItemSuscripcion['estado'], string> = {
  pagada: 'Pagada',
  pendiente: 'Pendiente',
  por_cobrar: 'Aún no toca',
  baja: 'Dada de baja',
  inactiva: 'Inactiva'
}

const VACIO = { id: 0, nombre: '', monto: '', moneda: 'MXN', dia_cobro: '', id_cuenta: '', subcategoria: 'Otras', activa: true, notas: '' }

export default function Suscripciones({
  mes,
  items,
  totalLineas,
  anteriores = [],
  cuentas,
  subcategorias
}: {
  mes: string
  items: ItemSuscripcion[]
  totalLineas: string[]
  /** Meses anteriores que siguen sin pagar, ya en texto ("ManyChat · octubre 2026 · $480.00"). */
  anteriores?: string[]
  cuentas: { id: string; nombre: string }[]
  subcategorias: string[]
}) {
  const router = useRouter()
  const [f, setF] = useState(VACIO)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null)

  const editar = (s: ItemSuscripcion) => {
    setAviso(null)
    setF({
      id: s.id,
      nombre: s.nombre,
      monto: String(s.monto),
      moneda: s.moneda,
      dia_cobro: s.dia_cobro === null ? '' : String(s.dia_cobro),
      id_cuenta: s.id_cuenta ?? '',
      subcategoria: s.subcategoria,
      activa: s.activa,
      notas: s.notas ?? ''
    })
  }

  const enviar = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setGuardando(true)
    setAviso(null)
    try {
      const r = await fetch('/api/suscripciones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: f.id || undefined,
          nombre: f.nombre,
          monto: f.monto,
          moneda: f.moneda,
          dia_cobro: f.dia_cobro === '' ? null : f.dia_cobro,
          id_cuenta: f.id_cuenta || null,
          subcategoria: f.subcategoria,
          activa: f.activa,
          notas: f.notas || null
        })
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!r.ok || !j.ok) {
        setAviso({ ok: false, texto: j.error ?? 'No pude guardarla.' })
        return
      }
      setAviso({ ok: true, texto: `Listo: ${f.nombre}.` })
      setF(VACIO)
      router.refresh()
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold">{mes}</h3>
        {items.length === 0 ? (
          <p className="text-sm">Aún no hay suscripciones. Agrega la primera abajo.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th>Suscripción</th>
                <th>Monto</th>
                <th>Día</th>
                <th>Este mes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className={s.activa ? '' : 'opacity-60'}>
                  <td>
                    {s.nombre}
                    <div className="text-xs opacity-70">Suscripciones / {s.subcategoria}</div>
                  </td>
                  <td>{s.montoTexto}</td>
                  <td>{s.dia_cobro ?? '—'}</td>
                  <td>
                    {ROTULO[s.estado]}
                    {s.pagadoTexto ? ` (${s.pagadoTexto})` : ''}
                  </td>
                  <td>
                    <button type="button" className="btn" onClick={() => editar(s)}>
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {anteriores.length > 0 ? (
          <div className="mt-2 text-sm">
            <div className="font-semibold">Meses anteriores sin pagar</div>
            <ul>
              {anteriores.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <div className="text-xs opacity-70">Se marcan pagadas desde el bot: /suscripciones.</div>
          </div>
        ) : null}
        <div className="mt-2 text-sm">
          {totalLineas.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      </div>

      <form onSubmit={enviar} className="space-y-3">
        <h3 className="font-semibold">{f.id ? `Editar: ${f.nombre}` : 'Agregar suscripción'}</h3>
        <div>
          <label className="block text-sm font-medium">Nombre</label>
          <input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} required maxLength={60} className="w-full rounded border px-2 py-1" />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-sm font-medium">Monto</label>
            <input type="number" step="0.01" min="0.01" value={f.monto} onChange={(e) => setF({ ...f, monto: e.target.value })} required className="w-full rounded border px-2 py-1" />
          </div>
          <div>
            <label className="block text-sm font-medium">Moneda</label>
            <select value={f.moneda} onChange={(e) => setF({ ...f, moneda: e.target.value })} className="rounded border px-2 py-1">
              <option value="MXN">MXN</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Día de cobro</label>
            <input type="number" min="1" max="31" value={f.dia_cobro} onChange={(e) => setF({ ...f, dia_cobro: e.target.value })} placeholder="—" className="w-20 rounded border px-2 py-1" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium">Tipo</label>
          <select value={f.subcategoria} onChange={(e) => setF({ ...f, subcategoria: e.target.value })} className="w-full rounded border px-2 py-1">
            {subcategorias.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium">Cuenta de donde sale</label>
          <select value={f.id_cuenta} onChange={(e) => setF({ ...f, id_cuenta: e.target.value })} className="w-full rounded border px-2 py-1">
            <option value="">La cuenta del bot de Norman</option>
            {cuentas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium">Nota (p. ej. «tarjeta de Spin»; nunca el número)</label>
          <input value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} maxLength={200} className="w-full rounded border px-2 py-1" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.activa} onChange={(e) => setF({ ...f, activa: e.target.checked })} />
          Activa (el bot pregunta cada mes)
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={guardando} className="btn p">
            {guardando ? 'Guardando…' : f.id ? 'Guardar cambios' : 'Agregar'}
          </button>
          {f.id ? (
            <button type="button" className="btn" onClick={() => setF(VACIO)}>
              Cancelar
            </button>
          ) : null}
        </div>
        {aviso ? <p className={aviso.ok ? 'text-green-700' : 'text-red-700'}>{aviso.texto}</p> : null}
      </form>
    </div>
  )
}
