'use client'
// Paridad v2: copia de app/dashboard/inventario/compra/page.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

/**
 * Formulario de compra de insumos. **Solo UI**: no lee ni escribe la base.
 * Los catalogos y las dos filas del ledger las maneja
 * `app/actions/compras.ts`, que ademas compensa si la segunda falla.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { useState, useEffect } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import {
  getDatosCompraAction,
  registrarCompraInsumosAction,
  type CuentaCompra,
  type InsumoCompra
} from '@/app/actions/compras'

export default function Compra() {
  const { irTrasGuardar, cerrar } = useModalV2()
  const [isLoading, setIsLoading] = useState(false)
  const [insumos, setInsumos] = useState<InsumoCompra[]>([])
  const [cuentas, setCuentas] = useState<CuentaCompra[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)

  const [insumoSeleccionado, setInsumoSeleccionado] = useState('')
  const [cantidad, setCantidad] = useState('')
  const [costoTotal, setCostoTotal] = useState('')
  const [cuentaOrigen, setCuentaOrigen] = useState('')

  useEffect(() => {
    const fetchData = async () => {
      try {
        const resultado = await getDatosCompraAction()

        if (!resultado.success || !resultado.data) {
          console.error('Error cargando datos de compra:', resultado.error)
          return
        }

        setInsumos(resultado.data.insumos)
        setCuentas(resultado.data.cuentas)
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
      const resultado = await registrarCompraInsumosAction({
        idInsumo: insumoSeleccionado,
        cantidad: cantidadNum,
        costoTotal: costoNum,
        idCuentaOrigen: cuentaOrigen
      })

      if (!resultado.success) {
        alert(resultado.error || 'No se pudo registrar la compra.')
        return
      }

      alert('✅ Compra registrada exitosamente. Inventario y finanzas actualizados.')
      // v2 (2026-10-29, Socio ejecutor): sin refrescar() junto al push. El refresh del
      // route ACTUAL le puede ganar al push y deja al usuario en el formulario ya guardado
      // (medido 2 veces en 4 baterias: abono y POS) -> riesgo de capturar dos veces. Con
      // staleTimes.dynamic = 0 (default de Next 15+) el push ya trae datos frescos.
      irTrasGuardar(`${RUTA_BASE}/m/inventario`)
    } catch (error) {
      console.error('Error in handleRegistrarCompra:', error)
      alert('Error al registrar la compra. Inténtalo de nuevo.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div>
      <div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
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
                // ERP-59 · W13: `!cuentaOrigen` salio (el servidor cae a la cuenta
                // propia de la entidad y avisa). `!costoTotal` SE QUEDA a proposito:
                // W5 salio de la lista por la frontera de los dos ledgers -- sin
                // monto no se puede escribir el lado monetario, y media compra es
                // un asiento falso, no una captura incompleta.
                disabled={isLoading || !insumoSeleccionado || !cantidad || !costoTotal}
                className="flex-1 bg-green-600 text-white py-3 px-4 rounded-md hover:bg-green-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
              >
                {isLoading ? 'Registrando...' : '💰 Registrar Compra'}
              </button>
              <button type="button" onClick={() => cerrar()} className="flex-1 bg-gray-200 text-gray-800 py-3 px-4 rounded-md hover:bg-gray-300 transition-colors text-center font-medium">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
