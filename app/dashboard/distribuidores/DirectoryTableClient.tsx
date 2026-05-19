'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import RegistrarSeguimientoButton from './RegistrarSeguimientoButton'
import EditEntidadModal from './EditEntidadModal'

type EntidadRol = 'DST' | 'LOC' | 'SOCIO'
type RolFilter = 'ALL' | EntidadRol

export interface DirectoryRow {
  id: string
  nombre: string
  rol: EntidadRol
  zona: string
  telefono: string | null
  comision_base: number
  comision_base_local: number
  comision_hijo_local: number
  aplica_redondeo_costo: boolean
  ubicacionMaps: string | null
  patrocinador: string
  saldoPendiente: number
  saldoPorPagar: number
  semaforo: string
  seguimientoTexto: string
}

interface DirectoryTableClientProps {
  rows: DirectoryRow[]
  canEdit: boolean
  canDeleteEntity?: boolean
  /** Solo ADMIN ve la columna Zona (DST u otros roles: columna omitida del DOM). */
  showZonaColumn?: boolean
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
}

function getSeguimientoTextClass(semaforo: string): string {
  if (semaforo === '🟢') return 'text-green-600'
  if (semaforo === '🟡') return 'text-yellow-600'
  if (semaforo === '🔴') return 'text-red-600'
  return 'text-gray-500'
}

function rolEtiqueta(rol: EntidadRol): string {
  if (rol === 'DST') return 'Distribuidor'
  if (rol === 'LOC') return 'Local'
  return rol
}

export default function DirectoryTableClient({
  rows,
  canEdit,
  canDeleteEntity = false,
  showZonaColumn = false
}: DirectoryTableClientProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [roleFilter, setRoleFilter] = useState<RolFilter>('ALL')
  const [rowToEdit, setRowToEdit] = useState<DirectoryRow | null>(null)

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()

    return rows.filter((row) => {
      const matchesRole = roleFilter === 'ALL' || row.rol === roleFilter
      const matchesSearch =
        term.length === 0 ||
        row.nombre.toLowerCase().includes(term) ||
        (row.telefono?.toLowerCase().includes(term) ?? false)

      return matchesRole && matchesSearch
    })
  }, [rows, roleFilter, searchTerm])

  const clearFilters = () => {
    setSearchTerm('')
    setRoleFilter('ALL')
  }

  const seguimientoClass =
    'font-bold leading-tight [font-size:calc(0.75rem*1.3)]'

  const tableColSpan = showZonaColumn ? 7 : 6

  return (
    <div className="space-y-4">
      {rowToEdit && (
        <EditEntidadModal
          row={rowToEdit}
          isOpen={Boolean(rowToEdit)}
          onClose={() => setRowToEdit(null)}
          canDeleteEntity={canDeleteEntity}
        />
      )}
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-800">Directorio de la Red</h2>
      </div>

      <div className="px-6 grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2">
          <label htmlFor="directory-search" className="block text-xs font-medium text-gray-600 mb-1">
            Buscar
          </label>
          <input
            id="directory-search"
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Nombre o teléfono..."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>

        <div>
          <label htmlFor="directory-role-filter" className="block text-xs font-medium text-gray-600 mb-1">
            Rol
          </label>
          <select
            id="directory-role-filter"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value as RolFilter)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <option value="ALL">Todos</option>
            <option value="DST">Solo DST</option>
            <option value="LOC">Solo LOC</option>
            <option value="SOCIO">Solo SOCIO</option>
          </select>
        </div>
      </div>

      <div className="px-6 flex justify-between items-center text-xs text-gray-500">
        <span>
          Mostrando {filteredRows.length} de {rows.length} registros
        </span>
        <button
          type="button"
          onClick={clearFilters}
          className="text-blue-600 hover:text-blue-800 font-medium"
        >
          Limpiar filtros
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                Acciones
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Nombre
              </th>
              {showZonaColumn ? (
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Zona
                </th>
              ) : null}
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Patrocinador
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Saldo Pendiente
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Saldo por pagar
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Seguimiento
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={tableColSpan} className="px-6 py-8 text-center text-sm text-gray-500">
                  No hay resultados con los filtros seleccionados.
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-4 whitespace-nowrap text-sm align-top">
                    <div className="flex flex-col gap-1 min-w-[6rem]">
                      {canEdit ? (
                        <button
                          type="button"
                          onClick={() => setRowToEdit(row)}
                          className="text-left text-indigo-600 hover:text-indigo-800 font-medium text-xs sm:text-sm"
                        >
                          Editar
                        </button>
                      ) : (
                        <span className="text-xs text-gray-300 select-none">—</span>
                      )}
                      <div className="origin-left scale-95 sm:scale-100">
                        <RegistrarSeguimientoButton entidadId={row.id} />
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex flex-col gap-1">
                      <Link
                        href={`/dashboard/distribuidores/${row.id}`}
                        className="px-2 py-1 text-xs font-medium bg-blue-50 text-blue-600 rounded-md border border-blue-200 hover:bg-blue-100 transition-colors inline-block mb-1"
                      >
                        Ver estado
                      </Link>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">{row.nombre}</span>
                        <span
                          className={`inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none ${
                            row.rol === 'DST' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'
                          }`}
                        >
                          {rolEtiqueta(row.rol)}
                        </span>
                      </div>
                      <div className="flex gap-2 mt-0.5 flex-wrap">
                        {row.telefono && (
                          <a
                            href={`tel:${row.telefono}`}
                            className="text-xs text-gray-500 hover:text-blue-600 flex items-center"
                            title="Llamar"
                          >
                            📞 {row.telefono}
                          </a>
                        )}
                        {row.ubicacionMaps && (
                          <a
                            href={row.ubicacionMaps}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-gray-500 hover:text-blue-600 flex items-center"
                            title="Ver en Google Maps"
                          >
                            📍 Mapa
                          </a>
                        )}
                      </div>
                    </div>
                  </td>
                  {showZonaColumn ? (
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{row.zona}</td>
                  ) : null}
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.patrocinador}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold">
                    <span className={row.saldoPendiente > 0 ? 'text-red-600' : 'text-green-600'}>
                      {formatCurrency(Math.abs(row.saldoPendiente))}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold">
                    {row.rol === 'LOC' ? (
                      <span className="text-gray-300">—</span>
                    ) : (
                      <span className={row.saldoPorPagar > 0 ? 'text-red-600' : 'text-green-600'}>
                        {formatCurrency(row.saldoPorPagar)}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 align-middle">
                    <span className={`${seguimientoClass} ${getSeguimientoTextClass(row.semaforo)} text-left`}>
                      {row.seguimientoTexto}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
