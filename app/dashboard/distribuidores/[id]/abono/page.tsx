'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import type { CurrentUser } from '@/lib/auth-utils'
import type { TablesInsert } from '@/types/database'
import {
  CATEGORIA_ABONO_PENDIENTE,
  CATEGORIA_ABONO_REAL
} from '@/lib/finance-utils'

type FinanzaInsert = TablesInsert<'finanzas_ledger'>

interface CuentaOption {
  id: string
  nombre: string
  ownerEntityId: string | null
  ownerRole: string | null
  ownerNombre: string | null
}

async function getCurrentUserFromClient(): Promise<CurrentUser | null> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user?.email) return null

  const { data, error } = await supabase
    .from('entidades')
    .select('id, email, rol, nombre')
    .eq('email', session.user.email)
    .single()

  if (error || !data) return null

  return {
    id: data.id,
    email: data.email,
    rol: data.rol as CurrentUser['rol'],
    nombre: data.nombre
  }
}

export default function RegistrarAbonoPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingData, setIsLoadingData] = useState(true)
  const [cuentasAdmin, setCuentasAdmin] = useState<CuentaOption[]>([])
  const [cuentasEntidad, setCuentasEntidad] = useState<CuentaOption[]>([])

  const [idCuentaOrigen, setIdCuentaOrigen] = useState('')
  const [idCuentaDestino, setIdCuentaDestino] = useState('')
  const [monto, setMonto] = useState('')
  const [referencia, setReferencia] = useState('')

  useEffect(() => {
    const fetchCuentas = async () => {
      try {
        const { data: cuentasRaw, error: cuentasError } = await supabase
          .from('cuentas_financieras')
          .select('id, nombre, id_entidad')
          .order('nombre', { ascending: true })

        if (cuentasError || !cuentasRaw) {
          console.error('Error fetching cuentas:', cuentasError)
          return
        }

        const entityIds = Array.from(new Set(cuentasRaw.map((c) => c.id_entidad).filter(Boolean)))
        const { data: entidadesRaw, error: entidadesError } = await supabase
          .from('entidades')
          .select('id, nombre, rol')
          .in('id', entityIds)

        if (entidadesError || !entidadesRaw) {
          console.error('Error fetching entidades owners:', entidadesError)
          return
        }

        const entidadById = new Map(entidadesRaw.map((entidad) => [entidad.id, entidad]))
        const mapped: CuentaOption[] = cuentasRaw.map((cuenta) => {
          const owner = cuenta.id_entidad ? entidadById.get(cuenta.id_entidad) : null
          return {
            id: cuenta.id,
            nombre: cuenta.nombre,
            ownerEntityId: cuenta.id_entidad,
            ownerRole: owner?.rol ?? null,
            ownerNombre: owner?.nombre ?? null
          }
        })

        const sinVirtual = (cuenta: CuentaOption) => !cuenta.nombre.toLowerCase().includes('virtual')
        setCuentasAdmin(mapped.filter((cuenta) => cuenta.ownerRole === 'ADMIN' && sinVirtual(cuenta)))
        setCuentasEntidad(mapped.filter((cuenta) => cuenta.ownerEntityId === resolvedParams.id && sinVirtual(cuenta)))
      } catch (error) {
        console.error('Error in fetchCuentas:', error)
      } finally {
        setIsLoadingData(false)
      }
    }

    fetchCuentas()
  }, [resolvedParams.id])

  const cuentaOrigen = [...cuentasAdmin, ...cuentasEntidad].find((cuenta) => cuenta.id === idCuentaOrigen)
  const cuentaDestino = [...cuentasAdmin, ...cuentasEntidad].find((cuenta) => cuenta.id === idCuentaDestino)
  const origenEsAdmin = cuentaOrigen?.ownerRole === 'ADMIN'
  const destinoEsAdmin = cuentaDestino?.ownerRole === 'ADMIN'

  const conceptoAutomatico = (() => {
    if (!cuentaOrigen || !cuentaDestino) return 'Transferencia manual'
    if (origenEsAdmin && !destinoEsAdmin) return 'Cargo de Deuda (Admin → Distribuidor)'
    if (!origenEsAdmin && destinoEsAdmin) return 'Abono de Deuda (Distribuidor → Admin)'
    return 'Transferencia manual'
  })()

  const handleGuardarTransferencia = async () => {
    if (!idCuentaOrigen || !idCuentaDestino || !monto) {
      alert('Completa origen, destino y monto.')
      return
    }
    if (idCuentaOrigen === idCuentaDestino) {
      alert('Origen y destino deben ser diferentes.')
      return
    }

    const montoNum = Number.parseFloat(monto)
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      alert('El monto debe ser mayor a cero.')
      return
    }

    const currentUser = await getCurrentUserFromClient()
    if (!currentUser) {
      alert('No se pudo validar tu sesión.')
      return
    }
    if (currentUser.rol === 'SOCIO') {
      alert('Acceso denegado: tu rol es de solo lectura.')
      return
    }

    if (!cuentaOrigen || !cuentaDestino) {
      alert('No se pudo resolver origen/destino.')
      return
    }
    const transferenciaValida =
      (origenEsAdmin && !destinoEsAdmin) ||
      (!origenEsAdmin && destinoEsAdmin)
    if (!transferenciaValida) {
      alert('Solo se permiten transferencias cruzadas entre ADMIN y Distribuidor/Local.')
      return
    }

    const descripcion = referencia.trim() || conceptoAutomatico
    // Admin → Dist: CARGO_DEUDA (Admin pays dist, resolves negative debt or advances cash)
    // Dist → Admin: ABONO_DEUDA (dist remits cash to admin, reduces positive debt)
    const tipoMovimiento = (origenEsAdmin && !destinoEsAdmin) ? 'CARGO_DEUDA' : 'ABONO_DEUDA'
    const requiereAprobacionAdmin =
      currentUser.rol !== 'ADMIN' &&
      tipoMovimiento === 'ABONO_DEUDA' &&
      !origenEsAdmin &&
      destinoEsAdmin

    const movimiento: FinanzaInsert = {
      tipo_movimiento: tipoMovimiento,
      monto: Number(montoNum.toFixed(2)),
      id_cuenta_origen: idCuentaOrigen,
      id_cuenta_destino: idCuentaDestino,
      id_entidad_relacionada: resolvedParams.id,
      categoria: requiereAprobacionAdmin
        ? CATEGORIA_ABONO_PENDIENTE
        : tipoMovimiento === 'ABONO_DEUDA'
          ? CATEGORIA_ABONO_REAL
          : null,
      categoria_gasto: descripcion,
      status: 'ACTIVO'
    }

    setIsLoading(true)
    try {
      const { error } = await supabase
        .from('finanzas_ledger')
        .insert([movimiento])
      if (error) {
        alert(`Error al registrar transferencia: ${error.message}`)
        return
      }

      alert(
        requiereAprobacionAdmin
          ? 'Abono registrado y enviado a la cola de aprobación del Admin.'
          : 'Transferencia registrada correctamente.'
      )
      router.push(`/dashboard/distribuidores/${resolvedParams.id}`)
      router.refresh()
    } catch (error) {
      console.error('Error registrando transferencia:', error)
      alert('No se pudo registrar la transferencia.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <Link
            href={`/dashboard/distribuidores/${resolvedParams.id}`}
            className="text-blue-600 hover:text-blue-800 mb-4 inline-block"
          >
            ← Volver al Estado de Cuenta
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Transferencia Manual</h1>
          <p className="text-gray-600 mt-2">Control explícito de abonos, pagos de comisión y movimientos cruzados.</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6 space-y-6">
          <div>
            <label htmlFor="origen" className="block text-sm font-medium text-gray-700 mb-2">
              Origen
            </label>
            <select
              id="origen"
              value={idCuentaOrigen}
              onChange={(e) => setIdCuentaOrigen(e.target.value)}
              disabled={isLoadingData}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="">{isLoadingData ? 'Cargando cuentas...' : 'Selecciona origen...'}</option>
              <optgroup label="Cuentas ADMIN">
                {cuentasAdmin.map((cuenta) => (
                  <option key={cuenta.id} value={cuenta.id}>{cuenta.nombre}</option>
                ))}
              </optgroup>
              <optgroup label="Cuentas Distribuidor/Local">
                {cuentasEntidad.map((cuenta) => (
                  <option key={cuenta.id} value={cuenta.id}>{cuenta.nombre}</option>
                ))}
              </optgroup>
            </select>
          </div>

          <div>
            <label htmlFor="destino" className="block text-sm font-medium text-gray-700 mb-2">
              Destino
            </label>
            <select
              id="destino"
              value={idCuentaDestino}
              onChange={(e) => setIdCuentaDestino(e.target.value)}
              disabled={isLoadingData}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="">{isLoadingData ? 'Cargando cuentas...' : 'Selecciona destino...'}</option>
              <optgroup label="Cuentas ADMIN">
                {cuentasAdmin.map((cuenta) => (
                  <option key={cuenta.id} value={cuenta.id}>{cuenta.nombre}</option>
                ))}
              </optgroup>
              <optgroup label="Cuentas Distribuidor/Local">
                {cuentasEntidad.map((cuenta) => (
                  <option key={cuenta.id} value={cuenta.id}>{cuenta.nombre}</option>
                ))}
              </optgroup>
            </select>
          </div>

          <div>
            <label htmlFor="monto" className="block text-sm font-medium text-gray-700 mb-2">
              Monto
            </label>
            <input
              id="monto"
              type="number"
              min="0.01"
              step="0.01"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              placeholder="Ej. 1500.00"
            />
          </div>

          <div>
            <label htmlFor="referencia" className="block text-sm font-medium text-gray-700 mb-2">
              Referencia / Concepto
            </label>
            <input
              id="referencia"
              type="text"
              value={referencia}
              onChange={(e) => setReferencia(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              placeholder={conceptoAutomatico}
            />
            <p className="text-xs text-gray-500 mt-1">Concepto sugerido: {conceptoAutomatico}</p>
          </div>

          <div className="flex gap-4 pt-2">
            <button
              type="button"
              onClick={handleGuardarTransferencia}
              disabled={isLoading || !idCuentaOrigen || !idCuentaDestino || !monto}
              className="flex-1 bg-green-600 text-white py-3 px-4 rounded-md hover:bg-green-700 disabled:bg-gray-400 font-semibold"
            >
              {isLoading ? 'Registrando...' : 'Guardar Transferencia'}
            </button>
            <Link
              href={`/dashboard/distribuidores/${resolvedParams.id}`}
              className="flex-1 bg-gray-200 text-gray-800 py-3 px-4 rounded-md hover:bg-gray-300 transition-colors text-center font-medium"
            >
              Cancelar
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
