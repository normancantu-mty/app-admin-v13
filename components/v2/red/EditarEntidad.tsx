'use client'
// Paridad v2: copia de app/dashboard/distribuidores/EditEntidadModal.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import { useState, useTransition } from 'react'
import { updateEntidadAction, eliminarEntidadAction } from '@/app/actions/distribuidores'
import type { FilaRed as DirectoryRow } from '@/lib/v2/red-tipos'

interface EditEntidadModalProps {
  row: DirectoryRow
  isOpen: boolean
  onClose: () => void
  canDeleteEntity?: boolean
}

export default function EditEntidadModal({ row, isOpen, onClose, canDeleteEntity = false }: EditEntidadModalProps) {
  const { refrescar } = useModalV2()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const [nombre, setNombre] = useState(row.nombre)
  const [telefono, setTelefono] = useState(row.telefono ?? '')
  const [ubicacionMaps, setUbicacionMaps] = useState(row.ubicacionMaps ?? '')
  const [zona, setZona] = useState(row.zona)

  // Commission fields — convert stored decimal (0.20) → percentage display (20)
  const [comisionBase, setComisionBase] = useState(
    row.comision_base ? String(Math.round(row.comision_base * 10000) / 100) : ''
  )
  const [comisionBaseLocal, setComisionBaseLocal] = useState(
    row.comision_base_local ? String(Math.round(row.comision_base_local * 10000) / 100) : ''
  )
  const [comisionHijoLocal, setComisionHijoLocal] = useState(
    row.comision_hijo_local ? String(Math.round(row.comision_hijo_local * 10000) / 100) : ''
  )
  const [aplicaRedondeo, setAplicaRedondeo] = useState(row.aplica_redondeo_costo ?? true)

  if (!isOpen) return null

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)

    startTransition(async () => {
      try {
        await updateEntidadAction(row.id, {
          nombre,
          telefono,
          ubicacion_maps: ubicacionMaps,
          zona,
          comision_base: row.rol === 'DST' ? parseFloat(comisionBase) || 0 : 0,
          comision_base_local: row.rol === 'LOC' ? parseFloat(comisionBaseLocal) || 0 : 0,
          comision_hijo_local: row.rol === 'DST' ? parseFloat(comisionHijoLocal) || 0 : 0,
          aplica_redondeo_costo: aplicaRedondeo
        })
        onClose()
        refrescar()
      } catch (submitError: unknown) {
        const msg = submitError instanceof Error ? submitError.message : 'No se pudo guardar los cambios.'
        setError(msg)
      }
    })
  }

  const handleDelete = () => {
    setError(null)
    startTransition(async () => {
      try {
        await eliminarEntidadAction(row.id)
        setDeleteOpen(false)
        onClose()
        refrescar()
      } catch (submitError: unknown) {
        const msg = submitError instanceof Error ? submitError.message : 'No se pudo eliminar la entidad.'
        setError(msg)
      }
    })
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="border-b border-gray-200 px-6 py-4 shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">Editar entidad</h3>
          <p className="text-sm text-gray-500 mt-1">{row.nombre} ({row.rol})</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
            {/* ── Nombre ─────────────────────────────────────────── */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
              <input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                required
              />
            </div>

            {/* ── Teléfono / Zona ─────────────────────────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono</label>
                <input
                  value={telefono}
                  onChange={(e) => setTelefono(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Zona</label>
                <input
                  value={zona}
                  onChange={(e) => setZona(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  required
                />
              </div>
            </div>

            {/* ── Ubicación Maps ──────────────────────────────────── */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Enlace de Ubicación (Maps)
              </label>
              <input
                value={ubicacionMaps}
                onChange={(e) => setUbicacionMaps(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="https://maps.google.com/..."
              />
            </div>

            {/* ── Comisión Base ───────────────────────────────────── */}
            <div className="border-t border-gray-200 pt-4 space-y-4">
              <h4 className="text-sm font-semibold text-gray-800">Configuración Comercial</h4>

              {row.rol === 'DST' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Comisión Base (%)
                    </label>
                    <input
                      type="number"
                      min="0" max="100" step="0.01"
                      value={comisionBase}
                      onChange={(e) => setComisionBase(e.target.value)}
                      placeholder="Ej. 20"
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-gray-400 mt-1">Venta directa DST</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Comisión de Red / Hijo (%)
                    </label>
                    <input
                      type="number"
                      min="0" max="100" step="0.01"
                      value={comisionHijoLocal}
                      onChange={(e) => setComisionHijoLocal(e.target.value)}
                      placeholder="Ej. 10"
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-gray-400 mt-1">Pasiva de LOC patrocinado</p>
                  </div>
                </div>
              )}

              {row.rol === 'LOC' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Comisión Base Local (%)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={comisionBaseLocal}
                    onChange={(e) => setComisionBaseLocal(e.target.value)}
                    placeholder="Ej. 15"
                    className="w-36 rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">Ej: 15 = 15% de comisión.</p>
                </div>
              )}

              {/* ── Redondeo de Costo ─────────────────────────────── */}
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="aplica_redondeo_edit"
                  checked={aplicaRedondeo}
                  onChange={(e) => setAplicaRedondeo(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <label htmlFor="aplica_redondeo_edit" className="text-sm font-medium text-gray-700 cursor-pointer">
                    Redondear costo del distribuidor hacia arriba (Eliminar decimales)
                  </label>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Aplica <code className="bg-gray-100 px-1 rounded">Math.ceil</code> al costo calculado.
                  </p>
                </div>
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-200 px-6 py-4 shrink-0 flex flex-wrap justify-between items-center gap-3">
            <div className="min-h-[2rem] flex items-center">
              {canDeleteEntity && (row.rol === 'DST' || row.rol === 'LOC') ? (
                !deleteOpen ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteOpen(true)
                      setError(null)
                    }}
                    className="text-sm font-medium text-red-600 hover:text-red-800"
                    disabled={isPending}
                  >
                    Eliminar de la red…
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-red-700 font-medium">¿Eliminar permanentemente?</span>
                    <button
                      type="button"
                      onClick={handleDelete}
                      className="rounded-md bg-red-600 px-3 py-1.5 text-white hover:bg-red-700 disabled:bg-gray-400"
                      disabled={isPending}
                    >
                      Confirmar
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteOpen(false)}
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50"
                      disabled={isPending}
                    >
                      Cancelar
                    </button>
                  </div>
                )
              ) : null}
            </div>
            <div className="flex justify-end gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              disabled={isPending}
            >
              Cerrar
            </button>
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-gray-400"
              disabled={isPending}
            >
              {isPending ? 'Guardando...' : 'Guardar cambios'}
            </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
