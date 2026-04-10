'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

interface PosiblePatrocinador {
  id: string
  nombre: string
}

export default function NuevoMiembroPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [posiblesPatrocinadores, setPosiblesPatrocinadores] = useState<PosiblePatrocinador[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)
  
  const [nombre, setNombre] = useState('')
  const [rol, setRol] = useState<'DST' | 'LOC'>('DST')
  const [zona, setZona] = useState('Zacatecas')
  const [telefono, setTelefono] = useState('')
  const [ubicacionMaps, setUbicacionMaps] = useState('')
  const [idPadre, setIdPadre] = useState('')
  const [comisionBase, setComisionBase] = useState('')
  const [comisionBaseLocal, setComisionBaseLocal] = useState('')
  const [comisionHijoLocal, setComisionHijoLocal] = useState('')
  const [comisionLogistica, setComisionLogistica] = useState('')

  useEffect(() => {
    const fetchPatrocinadores = async () => {
      try {
        const { data, error } = await supabase
          .from('entidades')
          .select('id, nombre')
          .eq('rol', 'DST')
          .order('nombre', { ascending: true })

        if (error) {
          console.error('Error fetching patrocinadores:', error)
          return
        }

        setPosiblesPatrocinadores(data || [])
      } catch (error) {
        console.error('Error in fetchPatrocinadores:', error)
      } finally {
        setIsLoadingData(false)
      }
    }

    fetchPatrocinadores()
  }, [])

  useEffect(() => {
    if (rol === 'DST') {
      setIdPadre('')
    }
  }, [rol])

  const handleRegistrarMiembro = async () => {
    if (!nombre || !comisionLogistica) {
      alert('Por favor completa todos los campos obligatorios.')
      return
    }

    if (rol === 'LOC' && !comisionBaseLocal) {
      alert('Por favor completa la Comisión Base Local.')
      return
    }

    if (rol === 'DST' && (!comisionBase || !comisionHijoLocal)) {
      alert('Por favor completa la Comisión Base y Comisión Hijo Local.')
      return
    }

    setIsLoading(true)

    try {
      const comisionBaseDecimal = rol === 'DST' ? parseFloat(comisionBase) / 100 : 0
      const comisionBaseLocalDecimal = rol === 'LOC' ? parseFloat(comisionBaseLocal) / 100 : 0
      const comisionHijoLocalDecimal = rol === 'DST' ? parseFloat(comisionHijoLocal) / 100 : 0
      const comisionLogisticaDecimal = parseFloat(comisionLogistica) / 100

      const { error } = await supabase
        .from('entidades')
        .insert({
          nombre: nombre,
          rol: rol,
          zona: zona,
          telefono: telefono || null,
          id_padre: rol === 'LOC' && idPadre !== '' ? idPadre : null,
          comision_base: comisionBaseDecimal,
          comision_base_local: comisionBaseLocalDecimal,
          comision_hijo_local: comisionHijoLocalDecimal,
          comision_logistica: comisionLogisticaDecimal,
          ubicacion_maps: ubicacionMaps || null
        })

      if (error) {
        console.error('Error inserting miembro:', error)
        alert(`Error al registrar miembro: ${error.message}`)
        return
      }

      alert('✅ Miembro registrado exitosamente en la red.')
      router.push('/dashboard/distribuidores')
      router.refresh()
    } catch (error) {
      console.error('Error in handleRegistrarMiembro:', error)
      alert('Error al registrar el miembro. Inténtalo de nuevo.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <Link 
            href="/dashboard/distribuidores"
            className="text-blue-600 hover:text-blue-800 mb-4 inline-block"
          >
            ← Volver a Distribuidores
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Nuevo Miembro de la Red</h1>
          <p className="text-gray-600 mt-2">Registro con jerarquía y estructura de comisiones</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="space-y-6">
            <div>
              <label htmlFor="nombre" className="block text-sm font-medium text-gray-700 mb-2">
                Nombre Completo
              </label>
              <input
                type="text"
                id="nombre"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Ej. Juan Pérez García"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label htmlFor="rol" className="block text-sm font-medium text-gray-700 mb-2">
                  Rol
                </label>
                <select
                  id="rol"
                  value={rol}
                  onChange={(e) => setRol(e.target.value as 'DST' | 'LOC')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="DST">DST (Distribuidor)</option>
                  <option value="LOC">LOC (Local)</option>
                </select>
              </div>

              <div>
                <label htmlFor="zona" className="block text-sm font-medium text-gray-700 mb-2">
                  Zona
                </label>
                <select
                  id="zona"
                  value={zona}
                  onChange={(e) => setZona(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="Zacatecas">Zacatecas</option>
                  <option value="Foraneo">Foráneo</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="telefono" className="block text-sm font-medium text-gray-700 mb-2">
                Teléfono (Opcional)
              </label>
              <input
                type="tel"
                id="telefono"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                placeholder="Ej. 4921234567"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label htmlFor="ubicacion_maps" className="block text-sm font-medium text-gray-700 mb-2">
                Ubicación Maps (URL)
              </label>
              <input
                type="url"
                id="ubicacion_maps"
                value={ubicacionMaps}
                onChange={(e) => setUbicacionMaps(e.target.value)}
                placeholder="https://maps.google.com/..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Enlace a Google Maps de la ubicación</p>
            </div>

            {rol === 'LOC' && (
              <div>
                <label htmlFor="patrocinador" className="block text-sm font-medium text-gray-700 mb-2">
                  Patrocinador (Opcional)
                </label>
                <select
                  id="patrocinador"
                  value={idPadre}
                  onChange={(e) => setIdPadre(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  disabled={isLoadingData}
                >
                  <option value="">
                    {isLoadingData ? 'Cargando...' : 'Ninguno (Línea Directa)'}
                  </option>
                  {posiblesPatrocinadores.map((patrocinador) => (
                    <option key={patrocinador.id} value={patrocinador.id}>
                      {patrocinador.nombre}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Solo aplica para Locales</p>
              </div>
            )}

            <div className="border-t border-gray-200 pt-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">Estructura de Comisiones</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {rol === 'DST' && (
                  <div>
                    <label htmlFor="comisionBase" className="block text-sm font-medium text-gray-700 mb-2">
                      Comisión Base (%)
                    </label>
                    <input
                      type="number"
                      id="comisionBase"
                      value={comisionBase}
                      onChange={(e) => setComisionBase(e.target.value)}
                      step="0.01"
                      min="0"
                      max="100"
                      placeholder="Ej. 15"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-500 mt-1">Comisión estándar por venta directa</p>
                  </div>
                )}

                {rol === 'LOC' && (
                  <div>
                    <label htmlFor="comisionBaseLocal" className="block text-sm font-medium text-gray-700 mb-2">
                      Comisión Base Local (%)
                    </label>
                    <input
                      type="number"
                      id="comisionBaseLocal"
                      value={comisionBaseLocal}
                      onChange={(e) => setComisionBaseLocal(e.target.value)}
                      step="0.01"
                      min="0"
                      max="100"
                      placeholder="Ej. 10"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-500 mt-1">Comisión por ventas en locales propios</p>
                  </div>
                )}

                {rol === 'DST' && (
                  <div>
                    <label htmlFor="comisionHijoLocal" className="block text-sm font-medium text-gray-700 mb-2">
                      Comisión Hijo Local (%)
                    </label>
                    <input
                      type="number"
                      id="comisionHijoLocal"
                      value={comisionHijoLocal}
                      onChange={(e) => setComisionHijoLocal(e.target.value)}
                      step="0.01"
                      min="0"
                      max="100"
                      placeholder="Ej. 5"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-500 mt-1">Comisión por ventas de locales patrocinados</p>
                  </div>
                )}

                <div>
                  <label htmlFor="comisionLogistica" className="block text-sm font-medium text-gray-700 mb-2">
                    Comisión Logística (%)
                  </label>
                  <input
                    type="number"
                    id="comisionLogistica"
                    value={comisionLogistica}
                    onChange={(e) => setComisionLogistica(e.target.value)}
                    step="0.01"
                    min="0"
                    max="100"
                    placeholder="Ej. 3"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Comisión por manejo y entrega de producto</p>
                </div>
              </div>
            </div>

            <div className="flex gap-4 pt-4">
              <button
                onClick={handleRegistrarMiembro}
                disabled={
                  isLoading || 
                  !nombre || 
                  !comisionLogistica ||
                  (rol === 'LOC' && !comisionBaseLocal) ||
                  (rol === 'DST' && (!comisionBase || !comisionHijoLocal))
                }
                className="flex-1 bg-blue-600 text-white py-3 px-4 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
              >
                {isLoading ? 'Registrando...' : '✅ Registrar Miembro'}
              </button>
              <Link
                href="/dashboard/distribuidores"
                className="flex-1 bg-gray-200 text-gray-800 py-3 px-4 rounded-md hover:bg-gray-300 transition-colors text-center font-medium"
              >
                Cancelar
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
