'use client'
// v2: alta de categoria/subcategoria (tabla categorias_movimiento). Escrito el 2026-11-03 por el ejecutor del Socio.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Fila {
  tipo: string
  categoria: string
  subcategoria: string
  activa: boolean
}

export default function Categorias({ filas }: { filas: Fila[] }) {
  const router = useRouter()
  const [tipo, setTipo] = useState<'EGRESO' | 'INGRESO'>('EGRESO')
  const [categoria, setCategoria] = useState('')
  const [subcategoria, setSubcategoria] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null)

  const porCategoria = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const f of filas) {
      if (f.tipo !== tipo) continue
      const lista = m.get(f.categoria) ?? []
      lista.push(f.subcategoria + (f.activa ? '' : ' (inactiva)'))
      m.set(f.categoria, lista)
    }
    return m
  }, [filas, tipo])

  const enviar = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setGuardando(true)
    setAviso(null)
    try {
      const r = await fetch('/api/categorias/nueva', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo, categoria, subcategoria })
      })
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        categoria?: string
        subcategoria?: string
        categoria_nueva?: boolean
      }
      if (!r.ok || !j.ok) {
        setAviso({ ok: false, texto: j.error ?? 'No pude guardarla.' })
        return
      }
      setAviso({ ok: true, texto: `Listo: ${j.categoria} / ${j.subcategoria}${j.categoria_nueva ? ' (categoría nueva)' : ''}.` })
      setSubcategoria('')
      router.refresh()
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={enviar} className="space-y-3">
        <div>
          <label className="block text-sm font-medium">Tipo</label>
          <select value={tipo} onChange={(e) => setTipo(e.target.value as 'EGRESO' | 'INGRESO')} className="w-full rounded border px-2 py-1">
            <option value="EGRESO">Gasto (egreso)</option>
            <option value="INGRESO">Ingreso</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium">Categoría (elige una o escribe una nueva)</label>
          <input
            list="categorias-existentes"
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
            required
            maxLength={60}
            className="w-full rounded border px-2 py-1"
          />
          <datalist id="categorias-existentes">
            {[...porCategoria.keys()].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="block text-sm font-medium">Subcategoría</label>
          <input value={subcategoria} onChange={(e) => setSubcategoria(e.target.value)} required maxLength={60} className="w-full rounded border px-2 py-1" />
        </div>
        <button type="submit" disabled={guardando} className="btn p">
          {guardando ? 'Guardando…' : 'Agregar'}
        </button>
        {aviso ? <p className={aviso.ok ? 'text-green-700' : 'text-red-700'}>{aviso.texto}</p> : null}
      </form>

      <div>
        <h3 className="font-semibold">Lista actual ({tipo === 'EGRESO' ? 'gastos' : 'ingresos'})</h3>
        <ul className="text-sm">
          {[...porCategoria.entries()].map(([c, subs]) => (
            <li key={c}>
              <strong>{c}</strong>: {subs.join(' · ')}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
