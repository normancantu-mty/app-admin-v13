'use client'

/**
 * Lotes v2 — formulario de alta y edicion de un lote. Escrito el 2026-10-30 por
 * el ejecutor del Socio. Guarda con `guardarLoteAction` (sesion del usuario: el
 * RLS decide; solo ADMIN). Las reglas viven en el servidor (`validar.ts`); aqui
 * solo se arma el payload.
 *
 * En edicion, los insumos y tandas ya escritos se CORRIGEN pero no se quitan
 * (sin bitacora, un borrado no dejaria rastro). El envasado no se captura aqui:
 * es diario y va por «Envasar».
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { useState } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import { guardarLoteAction } from '@/app/actions/lotes-v2'
import type { LoteForm } from './validar'

export type InsumoOpcion = { id: string; nombre: string; sku: string | null; unidad_medida: string }

export type LoteInicial = {
  id: string | null
  codigo_lote: string
  fecha_inicio: string
  fecha_fin_fermentacion: string | null
  horas_fermentacion: number | null
  brix_chile: number | null
  brix_final: number | null
  notas: string | null
  entradas: { id_insumo: string; cantidad: number }[]
  tandas: { id: string; numero_tanda: number; litros: number | null; grado_alcohol: number | null; peso_kg: number | null; notas: string | null }[]
}

/**
 * Los cuatro insumos que se capturan por lote (Cris, 2026-11-10): cantidad directa,
 * sin lista desplegable. «Chile» se guarda contra `chile-guajillo` porque es el sku
 * que `v_lote_rendimiento` suma como kg_chile (el guajón cuesta lo mismo en el catálogo).
 */
const INSUMOS_LOTE: { sku: string; etiqueta: string }[] = [
  { sku: 'chile-guajillo', etiqueta: 'Chile' },
  { sku: 'mosto-1', etiqueta: 'Aditivo 1' },
  { sku: 'aditivo-2', etiqueta: 'Aditivo 2' },
  { sku: 'levadura-enzimas', etiqueta: 'Levadura y enzimas' }
]
const UNIDAD_CORTA: Record<string, string> = { KILOGRAMOS: 'kg', GRAMOS: 'g', LITROS: 'L', MILILITROS: 'ml', PIEZAS: 'pzas' }
type FilaTanda = { clave: number; id: string | null; numero: number | null; litros: string; grado: string; peso: string; notas: string }

const txt = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))
const numONulo = (s: string): number | null => {
  const t = s.trim().replace(',', '.')
  return t === '' ? null : Number(t)
}

let siguienteClave = 1
const clave = () => siguienteClave++

export default function FormLote({ inicial, insumos, hoy }: { inicial: LoteInicial; insumos: InsumoOpcion[]; hoy: string }) {
  const { irTrasGuardar, cerrar } = useModalV2()
  const editando = inicial.id !== null
  const [codigo, setCodigo] = useState(inicial.codigo_lote)
  const [inicio, setInicio] = useState(inicial.fecha_inicio)
  const [fin, setFin] = useState(inicial.fecha_fin_fermentacion ?? '')
  const [horas, setHoras] = useState(txt(inicial.horas_fermentacion))
  const [brixChile, setBrixChile] = useState(txt(inicial.brix_chile))
  const [brixFinal, setBrixFinal] = useState(txt(inicial.brix_final))
  const [notas, setNotas] = useState(inicial.notas ?? '')
  const porSku = new Map(insumos.filter((i) => i.sku).map((i) => [i.sku as string, i]))
  const idsFijos = new Set(INSUMOS_LOTE.map((x) => porSku.get(x.sku)?.id).filter(Boolean) as string[])
  // Insumos ya escritos que no son de los cuatro (lotes viejos o del bot): se conservan tal cual.
  const otrasEntradas = inicial.entradas.filter((e) => !idsFijos.has(e.id_insumo))
  const [cantidades, setCantidades] = useState<Record<string, string>>(() => {
    const c: Record<string, string> = {}
    for (const x of INSUMOS_LOTE) {
      const id = porSku.get(x.sku)?.id
      const e = inicial.entradas.find((en) => en.id_insumo === id)
      c[x.sku] = e ? String(e.cantidad) : ''
    }
    return c
  })
  const [filasTanda, setFilasTanda] = useState<FilaTanda[]>(() =>
    inicial.tandas.map((t) => ({ clave: clave(), id: t.id, numero: t.numero_tanda, litros: txt(t.litros), grado: txt(t.grado_alcohol), peso: txt(t.peso_kg), notas: t.notas ?? '' }))
  )
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cambiarTanda = (k: number, cambio: Partial<FilaTanda>) => setFilasTanda((fs) => fs.map((f) => (f.clave === k ? { ...f, ...cambio } : f)))
  const ultimaTanda = Math.max(0, ...filasTanda.map((t) => t.numero ?? 0))

  async function guardar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (guardando) return
    setError(null)
    const form: LoteForm = {
      id: inicial.id,
      codigo_lote: codigo,
      fecha_inicio: inicio,
      fecha_fin_fermentacion: fin || null,
      horas_fermentacion: numONulo(horas),
      brix_chile: numONulo(brixChile),
      brix_final: numONulo(brixFinal),
      notas,
      entradas: [
        ...INSUMOS_LOTE.flatMap((x) => {
          const id = porSku.get(x.sku)?.id
          const c = numONulo(cantidades[x.sku] ?? '')
          return id && c !== null ? [{ id_insumo: id, cantidad: c }] : []
        }),
        ...otrasEntradas
      ],
      tandas: filasTanda.map((t) => ({ id: t.id, litros: numONulo(t.litros), grado_alcohol: numONulo(t.grado), peso_kg: numONulo(t.peso), notas: t.notas }))
    }
    if (form.entradas.some((en) => !Number.isFinite(en.cantidad))) {
      setError('Una cantidad de insumo no se entiende. Revisa los campos.')
      return
    }
    if ([form.horas_fermentacion, form.brix_chile, form.brix_final, ...form.tandas.flatMap((t) => [t.litros, t.grado_alcohol, t.peso_kg])].some((n) => n !== null && !Number.isFinite(n))) {
      setError('Hay un número que no se entiende. Revisa los campos.')
      return
    }
    setGuardando(true)
    try {
      const r = await guardarLoteAction(form)
      if (!r.success || !r.id) {
        setError(r.error ?? 'No se pudo guardar el lote.')
        return
      }
      irTrasGuardar(`${RUTA_BASE}/m/lote/${r.id}`)
    } catch {
      setError('No se pudo guardar el lote (error de red o del servidor).')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <form onSubmit={guardar} className="lote-form" data-testid="lote-form">
      <div className="grid g3">
        <div className="campo">
          <label htmlFor="lote-codigo">Código del lote</label>
          <input id="lote-codigo" value={codigo} onChange={(e) => setCodigo(e.target.value)} maxLength={40} placeholder="L-AAAAMMDD" required />
        </div>
        <div className="campo">
          <label htmlFor="lote-inicio">Inicio de fermentación</label>
          <input id="lote-inicio" type="date" value={inicio} max={hoy} onChange={(e) => setInicio(e.target.value)} required />
        </div>
        <div className="campo">
          <label htmlFor="lote-fin">Fin de fermentación</label>
          <input id="lote-fin" type="date" value={fin} min={inicio || undefined} onChange={(e) => setFin(e.target.value)} />
        </div>
      </div>
      <div className="grid g3">
        <div className="campo">
          <label htmlFor="lote-horas">Horas de fermentación</label>
          <input id="lote-horas" inputMode="decimal" value={horas} onChange={(e) => setHoras(e.target.value)} placeholder="opcional" />
        </div>
        <div className="campo">
          <label htmlFor="lote-brix-chile">Brix del chile</label>
          <input id="lote-brix-chile" inputMode="decimal" value={brixChile} onChange={(e) => setBrixChile(e.target.value)} placeholder="opcional" />
        </div>
        <div className="campo">
          <label htmlFor="lote-brix-final">Brix final</label>
          <input id="lote-brix-final" inputMode="decimal" value={brixFinal} onChange={(e) => setBrixFinal(e.target.value)} placeholder="opcional" />
        </div>
      </div>

      <div className="lote-seccion">
        <div className="lote-seccion-hd">
          <b>Insumos</b>
          <span className="inv-sub">Cantidad que se le echó de cada uno. Vacío = no se usó.</span>
        </div>
        <div className="grid g2">
          {INSUMOS_LOTE.map((x) => {
            const ins = porSku.get(x.sku)
            const unidad = ins ? (UNIDAD_CORTA[ins.unidad_medida] ?? ins.unidad_medida.toLowerCase()) : ''
            return (
              <div key={x.sku} className="campo">
                <label htmlFor={`lote-ins-${x.sku}`}>
                  {x.etiqueta}
                  {unidad ? ` (${unidad})` : ''}
                </label>
                <input
                  id={`lote-ins-${x.sku}`}
                  inputMode="decimal"
                  value={cantidades[x.sku] ?? ''}
                  onChange={(e) => setCantidades((c) => ({ ...c, [x.sku]: e.target.value }))}
                  placeholder={ins ? 'Cantidad' : 'No está en el catálogo'}
                  disabled={!ins}
                />
              </div>
            )
          })}
        </div>
      </div>

      <div className="lote-seccion">
        <div className="lote-seccion-hd">
          <b>Tandas destiladas</b>
          <span className="inv-sub">Litros o peso (garrafa), y el grado. Sin grado no hay rendimiento ni costo por ml.</span>
        </div>
        {filasTanda.length === 0 && <div className="inv-sub">Sin tandas todavía (el lote sigue fermentando).</div>}
        {filasTanda.length > 0 && (
          <div className="lote-fila lote-fila-tanda lote-fila-hd inv-sub" aria-hidden>
            <span>#</span>
            <span>Litros</span>
            <span>Grado °</span>
            <span>Peso kg</span>
            <span>Notas</span>
            <span />
          </div>
        )}
        {filasTanda.map((t, i) => (
          <div key={t.clave} className="lote-fila lote-fila-tanda">
            <span className="mono">{t.numero ?? ultimaTanda + filasTanda.filter((x, j) => j <= i && x.numero === null).length}</span>
            <input className="in" inputMode="decimal" value={t.litros} onChange={(e) => cambiarTanda(t.clave, { litros: e.target.value })} aria-label="Litros" />
            <input className="in" inputMode="decimal" value={t.grado} onChange={(e) => cambiarTanda(t.clave, { grado: e.target.value })} aria-label="Grado" />
            <input className="in" inputMode="decimal" value={t.peso} onChange={(e) => cambiarTanda(t.clave, { peso: e.target.value })} aria-label="Peso kg" />
            <input className="in" value={t.notas} maxLength={300} onChange={(e) => cambiarTanda(t.clave, { notas: e.target.value })} aria-label="Notas de la tanda" />
            {t.id ? (
              <span className="inv-sub" title="Desde el ERP no se quita una tanda ya escrita">fija</span>
            ) : (
              <button type="button" className="btn mini" onClick={() => setFilasTanda((fs) => fs.filter((x) => x.clave !== t.clave))} aria-label="Quitar tanda">
                ×
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn mini" onClick={() => setFilasTanda((fs) => [...fs, { clave: clave(), id: null, numero: null, litros: '', grado: '', peso: '', notas: '' }])}>
          + Agregar tanda
        </button>
      </div>

      <div className="campo">
        <label htmlFor="lote-notas">Notas</label>
        <textarea id="lote-notas" rows={2} maxLength={500} value={notas} onChange={(e) => setNotas(e.target.value)} />
      </div>

      <div className="msg info">El envasado no se captura aquí: es diario y no se liga al lote. Se registra con «Envasar» en Inventario.</div>
      {error && <div className="msg mal" role="alert">{error}</div>}

      <div className="fila-acc">
        <button type="button" className="btn" onClick={() => cerrar()} disabled={guardando}>
          Cancelar
        </button>
        <button type="submit" className="btn p" disabled={guardando} data-testid="lote-guardar">
          {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Crear lote'}
        </button>
      </div>
    </form>
  )
}
