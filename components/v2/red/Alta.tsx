'use client'
// Paridad v2: copia de app/dashboard/distribuidores/nuevo/page.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

import { FormEvent, useState, useEffect } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import { supabase } from '@/lib/supabase'
import { registrarEntidadAction } from '@/app/actions/distribuidores'

interface PosiblePatrocinador {
  id: string
  nombre: string
}

export default function Alta({ padre }: { padre?: string }) {
  const { irTrasGuardar, cerrar } = useModalV2()
  const [isLoading, setIsLoading] = useState(false)
  const [posiblesPatrocinadores, setPosiblesPatrocinadores] = useState<PosiblePatrocinador[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)
  const [loggedInRole, setLoggedInRole] = useState<string | null>(null)

  const [nombre, setNombre] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rol, setRol] = useState<'DST' | 'LOC'>('DST')
  const [zona, setZona] = useState('Zacatecas')
  const [telefono, setTelefono] = useState('')
  const [ubicacionMaps, setUbicacionMaps] = useState('')
  const [idNodoPadre, setIdNodoPadre] = useState('')
  const [comisionBase, setComisionBase] = useState('')
  const [comisionBaseLocal, setComisionBaseLocal] = useState('')
  const [comisionHijoLocal, setComisionHijoLocal] = useState('')
  const [aplicaRedondeo, setAplicaRedondeo] = useState(true)

  useEffect(() => {
    const cargarDatos = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.user?.email) {
          const { data: currentEntidad } = await supabase
            .from('entidades')
            .select('rol')
            .eq('email', session.user.email)
            .single()
          if (currentEntidad?.rol) setLoggedInRole(currentEntidad.rol)
        }

        const { data: patrocinadores } = await supabase
          .from('entidades')
          .select('id, nombre')
          .eq('rol', 'DST')
          .order('nombre')

        setPosiblesPatrocinadores(patrocinadores || [])
      } catch (error) {
        console.error('Error cargando datos:', error)
      } finally {
        setIsLoadingData(false)
      }
    }

    cargarDatos()
  }, [])

  useEffect(() => {
    if (rol === 'DST') {
      setIdNodoPadre('')
    } else {
      setEmail('')
      setPassword('')
    }
  }, [rol])

  useEffect(() => {
    if (loggedInRole === 'DST') {
      setRol('LOC')
      setIdNodoPadre('')
    }
  }, [loggedInRole])

  const handleRegistrarMiembro = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const nombreForm = String(formData.get('nombre') || '').trim()
    const emailForm = String(formData.get('email') || '').trim().toLowerCase()
    const passwordForm = String(formData.get('password') || '').trim()
    const requestedRol = String(formData.get('rol') || 'DST') as 'DST' | 'LOC'
    const rolForm = loggedInRole === 'DST' ? 'LOC' : requestedRol
    const zonaForm = String(formData.get('zona') || 'Zacatecas')
    const telefonoForm = String(formData.get('telefono') || '').trim()
    const ubicacionMapsForm = String(formData.get('ubicacion_maps') || '').trim()
    const idNodoPadreForm = String(formData.get('id_nodo_padre') || '').trim()

    if (!nombreForm) {
      alert('Por favor ingresa el nombre del miembro.')
      return
    }
    if (rolForm === 'DST' && (!emailForm || !passwordForm)) {
      alert('Para Distribuidores debes capturar email y password.')
      return
    }

    setIsLoading(true)

    try {
      await registrarEntidadAction({
        nombre: nombreForm,
        email: rolForm === 'DST' ? emailForm : null,
        password: rolForm === 'DST' ? passwordForm : null,
        rol: rolForm,
        zona: zonaForm,
        telefono: telefonoForm || null,
        ubicacion_maps: ubicacionMapsForm || null,
        id_nodo_padre: rolForm === 'LOC' ? (idNodoPadreForm || null) : null,
        comision_base:       rolForm === 'DST' ? parseFloat(comisionBase)      || 0 : 0,
        comision_base_local: rolForm === 'LOC' ? parseFloat(comisionBaseLocal) || 0 : 0,
        comision_hijo_local: rolForm === 'DST' ? parseFloat(comisionHijoLocal) || 0 : 0,
        aplica_redondeo_costo: aplicaRedondeo
      })

      alert('Miembro registrado exitosamente en la red.')
      // v2 (2026-10-29, Socio ejecutor): sin refrescar() junto al push. El refresh del
      // route ACTUAL le puede ganar al push y deja al usuario en el formulario ya guardado
      // (medido 2 veces en 4 baterias: abono y POS) -> riesgo de capturar dos veces. Con
      // staleTimes.dynamic = 0 (default de Next 15+) el push ya trae datos frescos.
      irTrasGuardar(padre)
    } catch (error: unknown) {
      console.error('Error registrando miembro:', error)
      const msg = error instanceof Error ? error.message : 'Error al registrar el miembro.'
      alert(msg)
    } finally {
      setIsLoading(false)
    }
  }

  const isAdmin = loggedInRole === 'ADMIN'
  const isDst = loggedInRole === 'DST'

  return (
    <div>
      <div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <form className="space-y-6" onSubmit={handleRegistrarMiembro}>
            {/* ── Nombre ────────────────────────────────────────────── */}
            <div>
              <label htmlFor="nombre" className="block text-sm font-medium text-gray-700 mb-2">
                Nombre Completo
              </label>
              <input
                type="text"
                id="nombre"
                name="nombre"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Ej. Juan Pérez García"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* ── Credenciales DST ──────────────────────────────────── */}
            {rol === 'DST' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                    Email
                  </label>
                  <input
                    type="email"
                    id="email"
                    name="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="usuario@empresa.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                    Password
                  </label>
                  <input
                    type="password"
                    id="password"
                    name="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Contraseña temporal"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            )}

            {/* ── Rol / Zona ────────────────────────────────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label htmlFor="rol" className="block text-sm font-medium text-gray-700 mb-2">
                  Rol
                </label>
                <select
                  id="rol"
                  name="rol"
                  value={rol}
                  onChange={(e) => setRol(e.target.value as 'DST' | 'LOC')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={isDst}
                >
                  {!isDst && <option value="DST">DST (Distribuidor)</option>}
                  <option value="LOC">LOC (Local)</option>
                </select>
                {isDst && (
                  <p className="text-xs text-gray-500 mt-1">Tu rol solo permite registrar Locales.</p>
                )}
              </div>

              <div>
                <label htmlFor="zona" className="block text-sm font-medium text-gray-700 mb-2">
                  Zona
                </label>
                <select
                  id="zona"
                  name="zona"
                  value={zona}
                  onChange={(e) => setZona(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="Zacatecas">Zacatecas</option>
                  <option value="Foraneo">Foráneo</option>
                </select>
              </div>
            </div>

            {/* ── Teléfono ──────────────────────────────────────────── */}
            <div>
              <label htmlFor="telefono" className="block text-sm font-medium text-gray-700 mb-2">
                Teléfono (Opcional)
              </label>
              <input
                type="tel"
                id="telefono"
                name="telefono"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                placeholder="4921234567"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* ── Ubicación Maps ────────────────────────────────────── */}
            <div>
              <label htmlFor="ubicacion_maps" className="block text-sm font-medium text-gray-700 mb-2">
                Ubicación Maps (URL)
              </label>
              <input
                type="url"
                id="ubicacion_maps"
                name="ubicacion_maps"
                value={ubicacionMaps}
                onChange={(e) => setUbicacionMaps(e.target.value)}
                placeholder="https://maps.google.com/..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* ── Nodo Padre (LOC only) ─────────────────────────────── */}
            {rol === 'LOC' && isAdmin && (
              <div>
                <label htmlFor="patrocinador" className="block text-sm font-medium text-gray-700 mb-2">
                  Nodo Padre (Opcional)
                </label>
                <select
                  id="patrocinador"
                  name="id_nodo_padre"
                  value={idNodoPadre}
                  onChange={(e) => setIdNodoPadre(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={isLoadingData}
                >
                  <option value="">
                    {isLoadingData ? 'Cargando...' : 'Ninguno (Línea Directa)'}
                  </option>
                  {posiblesPatrocinadores.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Solo aplica para Locales</p>
              </div>
            )}

            {/* ── Configuración Comercial ───────────────────────────── */}
            <div className="border-t border-gray-200 pt-6 space-y-4">
              <h3 className="text-base font-semibold text-gray-800">Configuración Comercial</h3>

              {rol === 'DST' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="comision_base" className="block text-sm font-medium text-gray-700 mb-1">
                      Comisión Base (%)
                    </label>
                    <input
                      type="number"
                      id="comision_base"
                      min="0" max="100" step="0.01"
                      value={comisionBase}
                      onChange={(e) => setComisionBase(e.target.value)}
                      placeholder="Ej. 20"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                    <p className="text-xs text-gray-400 mt-1">Venta directa DST</p>
                  </div>
                  <div>
                    <label htmlFor="comision_hijo_local" className="block text-sm font-medium text-gray-700 mb-1">
                      Comisión de Red / Hijo (%)
                    </label>
                    <input
                      type="number"
                      id="comision_hijo_local"
                      min="0" max="100" step="0.01"
                      value={comisionHijoLocal}
                      onChange={(e) => setComisionHijoLocal(e.target.value)}
                      placeholder="Ej. 10"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                    <p className="text-xs text-gray-400 mt-1">Pasiva de LOC patrocinado</p>
                  </div>
                </div>
              )}

              {rol === 'LOC' && (
                <div>
                  <label htmlFor="comision_base_local" className="block text-sm font-medium text-gray-700 mb-2">
                    Comisión Base Local (%)
                  </label>
                  <input
                    type="number"
                    id="comision_base_local"
                    min="0"
                    max="100"
                    step="0.01"
                    value={comisionBaseLocal}
                    onChange={(e) => setComisionBaseLocal(e.target.value)}
                    placeholder="Ej. 15"
                    className="w-40 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Porcentaje de comisión del canal local. Ej: 15 = 15%.
                  </p>
                </div>
              )}

              {/* ── Redondeo de Costo ─────────────────────────────── */}
              <div className="flex items-start gap-3 mt-2">
                <input
                  type="checkbox"
                  id="aplica_redondeo"
                  checked={aplicaRedondeo}
                  onChange={(e) => setAplicaRedondeo(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <label htmlFor="aplica_redondeo" className="text-sm font-medium text-gray-700 cursor-pointer">
                    Redondear costo del distribuidor hacia arriba (Eliminar decimales)
                  </label>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Aplica <code className="bg-gray-100 px-1 rounded">Math.ceil</code> al costo calculado para eliminar
                    fracciones de peso y simplificar la liquidación.
                  </p>
                </div>
              </div>
            </div>

            {/* ── Actions ───────────────────────────────────────────── */}
            <div className="flex gap-4 pt-4">
              <button
                type="submit"
                disabled={isLoading || !nombre || (rol === 'DST' && (!email || !password))}
                className="flex-1 bg-blue-600 text-white py-3 px-4 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
              >
                {isLoading ? 'Registrando...' : 'Registrar Miembro'}
              </button>
              <button type="button" onClick={() => cerrar()} className="flex-1 bg-gray-200 text-gray-800 py-3 px-4 rounded-md hover:bg-gray-300 transition-colors text-center font-medium">
                Cancelar
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
