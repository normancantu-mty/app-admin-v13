'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import type { TablesInsert } from '@/types/database'

interface Insumo {
  id: string
  nombre: string
  sku: string
  unidad_medida: string
}

interface CuentaFinanciera {
  id: string
  nombre: string
}

type InventarioInsert = TablesInsert<'inventario_ledger'>
type FinanzaInsert = TablesInsert<'finanzas_ledger'>

export default function CompraInsumosPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [cuentas, setCuentas] = useState<CuentaFinanciera[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)

  const [insumoSeleccionado, setInsumoSeleccionado] = useState('')
  const [cantidad, setCantidad] = useState('')
  const [costoTotal, setCostoTotal] = useState('')
  const [cuentaOrigen, setCuentaOrigen] = useState('')

  useEffect(() => {
    const fetchData = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.user?.email) {
          return
        }

        const { data: currentEntidad, error: entidadError } = await supabase
          .from('entidades')
          .select('id')
          .eq('email', session.user.email)
          .single()

        if (entidadError || !currentEntidad?.id) {
          console.error('Error fetching current entidad:', entidadError)
          return
        }

        const [insumosRes, cuentasRes] = await Promise.all([
          supabase
            .from('catalogo_productos')
            .select('id, nombre, sku, unidad_medida')
            .eq('tipo', 'INSUMO')
            .order('nombre', { ascending: true }),
          supabase
            .from('cuentas_financieras')
            .select('id, nombre')
            .eq('id_entidad', currentEntidad.id)
            .order('nombre', { ascending: true })
        ])

        if (insumosRes.error) {
          console.error('Error fetching insumos:', insumosRes.error)
        } else {
          setInsumos(insumosRes.data || [])
        }

        if (cuentasRes.error) {
          console.error('Error fetching cuentas:', cuentasRes.error)
        } else {
          setCuentas(cuentasRes.data || [])
        }
      } catch (error) {
        console.error('Error in fetchData:', error)
      } finally {
        setIsLoadingData(false)
      }
    }

    fetchData()
  }, [])

  const handleRegistrarCompra = async () => {
    if (!insumoSeleccionado || !cantidad || !costoTotal || !cuentaOrigen) {
      alert('Por favor completa todos los campos.')
      return
    }

    const cantidadNum = parseFloat(cantidad)
    const costoNum = parseFloat(costoTotal)

    if (isNaN(cantidadNum) || cantidadNum <= 0 || isNaN(costoNum) || costoNum <= 0) {
      alert('La cantidad y el costo deben ser valores numéricos positivos.')
      return
    }

    setIsLoading(true)

    try {
      const {
        data: { user },
        error: authError
      } = await supabase.auth.getUser()

      if (authError || !user?.email) {
        alert('No se pudo validar tu sesión para auditoría. Inicia sesión nuevamente.')
        return
      }

      const inventarioPayload: InventarioInsert = {
        id_producto: insumoSeleccionado,
        tipo_movimiento: 'ENTRADA_COMPRA',
        cantidad: cantidadNum,
        usuario_creador: user.email
      }

      const { error: inventarioError } = await supabase
        .from('inventario_ledger')
        .insert(inventarioPayload)

      if (inventarioError) {
        console.error('Error inserting inventario:', inventarioError)
        alert(`Error al registrar entrada de inventario: ${inventarioError.message}`)
        return
      }

      const finanzasPayload: FinanzaInsert = {
        id_cuenta_origen: cuentaOrigen,
        tipo_movimiento: 'COMPRA_INSUMOS',
        categoria: 'Insumos',
        monto: costoNum,
        status: 'ACTIVO',
        usuario_creador: user.email
      }

      const { error: finanzasError } = await supabase
        .from('finanzas_ledger')
        .insert(finanzasPayload)

      if (finanzasError) {
        console.error('Error inserting finanzas:', finanzasError)
        alert(`Error al registrar gasto financiero: ${finanzasError.message}`)
        return
      }

      alert('✅ Compra registrada exitosamente. Inventario y finanzas actualizados.')
      router.push('/dashboard/inventario')
      router.refresh()
    } catch (error) {
      console.error('Error in handleRegistrarCompra:', error)
      alert('Error al registrar la compra. Inténtalo de nuevo.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <Link 
            href="/dashboard/inventario"
            className="text-blue-600 hover:text-blue-800 mb-4 inline-block"
          >
            ← Volver a Inventario
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Compra de Insumos</h1>
          <p className="text-gray-600 mt-2">Transacción dual: Impacta inventario y finanzas</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
          <div className="space-y-6">
            <div>
              <label htmlFor="insumo" className="block text-sm font-medium text-gray-700 mb-2">
                Insumo Comprado
              </label>
              <select
                id="insumo"
                value={insumoSeleccionado}
                onChange={(e) => setInsumoSeleccionado(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                disabled={isLoadingData}
              >
                <option value="">
                  {isLoadingData ? 'Cargando insumos...' : 'Selecciona un insumo...'}
                </option>
                {insumos.map(insumo => (
                  <option key={insumo.id} value={insumo.id}>
                    [{insumo.sku}] - {insumo.nombre} ({insumo.unidad_medida})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="cantidad" className="block text-sm font-medium text-gray-700 mb-2">
                Cantidad Adquirida
              </label>
              <input
                type="number"
                id="cantidad"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
                min="0.0001"
                step="0.0001"
                placeholder="Ej: 10 o 0.5000"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
              />
            </div>

            <div>
              <label htmlFor="costo" className="block text-sm font-medium text-gray-700 mb-2">
                Costo Total (MXN)
              </label>
              <input
                type="number"
                id="costo"
                value={costoTotal}
                onChange={(e) => setCostoTotal(e.target.value)}
                min="0.01"
                step="0.01"
                placeholder="Ej: 1500.00"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
              />
              <p className="text-xs text-gray-500 mt-1">Lo que se le pagó al proveedor</p>
            </div>

            <div>
              <label htmlFor="cuenta" className="block text-sm font-medium text-gray-700 mb-2">
                Cuenta de Origen
              </label>
              <select
                id="cuenta"
                value={cuentaOrigen}
                onChange={(e) => setCuentaOrigen(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                disabled={isLoadingData}
              >
                <option value="">
                  {isLoadingData ? 'Cargando cuentas...' : 'Selecciona cuenta de origen...'}
                </option>
                {cuentas.map(cuenta => (
                  <option key={cuenta.id} value={cuenta.id}>
                    {cuenta.nombre}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">De dónde salió el dinero</p>
            </div>

            <div className="flex gap-4 pt-4">
              <button
                onClick={handleRegistrarCompra}
                disabled={isLoading || !insumoSeleccionado || !cantidad || !costoTotal || !cuentaOrigen}
                className="flex-1 bg-green-600 text-white py-3 px-4 rounded-md hover:bg-green-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
              >
                {isLoading ? 'Registrando...' : '💰 Registrar Compra'}
              </button>
              <Link
                href="/dashboard/inventario"
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
