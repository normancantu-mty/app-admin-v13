'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CATEGORIAS_INGRESOS, CATEGORIAS_EGRESOS } from '@/lib/catalog-constants'
import { SUBCATEGORIAS } from '@/lib/catalog-constants'

interface CuentaFinancieraFormOption {
  id: string
  nombre: string
  tipo: string
}

interface FinanzaFormProps {
  cuentas: CuentaFinancieraFormOption[]
}

export default function FinanzaForm({ cuentas }: FinanzaFormProps) {
  const [tipoMovimiento, setTipoMovimiento] = useState<'INGRESO_VENTA' | 'GASTO_OPERATIVO' | 'TRANSFERENCIA'>('INGRESO_VENTA')
  const [categoria, setCategoria] = useState('Venta_Directa')
  const [cuentaOrigen, setCuentaOrigen] = useState(cuentas[0]?.id ?? '')
  const [cuentaDestino, setCuentaDestino] = useState(cuentas[0]?.id ?? '')
  const [monto, setMonto] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      if (tipoMovimiento === 'TRANSFERENCIA' && (!cuentaOrigen || !cuentaDestino || cuentaOrigen === cuentaDestino)) {
        alert('Selecciona cuentas válidas de origen y destino para la transferencia.')
        return
      }

      const formData = new FormData(e.currentTarget)
      const payload = {
        tipo_movimiento: tipoMovimiento,
        categoria,
        cuenta_destino: cuentaDestino,
        cuenta_origen: tipoMovimiento === 'TRANSFERENCIA' ? cuentaOrigen : null,
        subcategoria: formData.get('subcategoria') || null,
        monto: parseFloat(monto),
        descripcion
      }

      const response = await fetch('/api/finanzas/nuevo', {
        method: 'POST',
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        throw new Error('Error al guardar el movimiento')
      }

      window.location.href = '/dashboard/finanzas'
    } catch (error) {
      console.error('Error:', error)
      alert('Error al guardar el movimiento')
    } finally {
      setIsLoading(false)
    }
  }

  const categoriasActuales = tipoMovimiento === 'INGRESO_VENTA' ? CATEGORIAS_INGRESOS : CATEGORIAS_EGRESOS
  const categoriaToSubcategoriaKey: Record<string, keyof typeof SUBCATEGORIAS> = {
    Compra_Insumos: 'Compra_Insumos',
    Venta_Directa: 'Venta_Directa',
    Logistica_Envios: 'Logistica_Envios',
  }
  const subcategoriaKey = categoriaToSubcategoriaKey[categoria] ?? (categoria as keyof typeof SUBCATEGORIAS)
  const subcategoriasActuales = SUBCATEGORIAS[subcategoriaKey] || []

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Tipo de Movimiento */}
      <div>
        <label htmlFor="tipo_movimiento" className="block text-sm font-medium text-gray-700 mb-2">
          Tipo de Movimiento
        </label>
        <select
          id="tipo_movimiento"
          name="tipo_movimiento"
          value={tipoMovimiento}
          onChange={(e) => {
            const nuevoTipo = e.target.value as 'INGRESO_VENTA' | 'GASTO_OPERATIVO' | 'TRANSFERENCIA'
            setTipoMovimiento(nuevoTipo)
            if (nuevoTipo === 'INGRESO_VENTA') {
              setCategoria('Venta_Directa')
            } else if (nuevoTipo === 'GASTO_OPERATIVO') {
              setCategoria('Compra_Insumos')
            } else {
              setCategoria('Transferencia')
            }
          }}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        >
          <option value="INGRESO_VENTA">💰 Ingreso</option>
          <option value="GASTO_OPERATIVO">💸 Egreso</option>
          <option value="TRANSFERENCIA">🔁 Transferencia</option>
        </select>
      </div>

      {/* Categoría */}
      {tipoMovimiento !== 'TRANSFERENCIA' && (
      <div>
        <label htmlFor="categoria" className="block text-sm font-medium text-gray-700 mb-2">
          Categoría
        </label>
        <select
          id="categoria"
          name="categoria"
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        >
          {categoriasActuales.map(cat => (
            <option key={cat.value} value={cat.value}>
              {cat.label}
            </option>
          ))}
        </select>
      </div>
      )}

      {/* Cuenta Destino */}
      {tipoMovimiento === 'TRANSFERENCIA' ? (
      <>
      <div>
        <label htmlFor="cuenta_origen" className="block text-sm font-medium text-gray-700 mb-2">
          Cuenta Origen
        </label>
        <select
          id="cuenta_origen"
          name="cuenta_origen"
          value={cuentaOrigen}
          onChange={(e) => setCuentaOrigen(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        >
          {cuentas.length === 0 ? (
            <option value="" disabled>
              No hay cuentas financieras disponibles
            </option>
          ) : (
            cuentas.map((cuenta) => (
              <option key={cuenta.id} value={cuenta.id}>
                {cuenta.nombre}
              </option>
            ))
          )}
        </select>
      </div>
      <div>
        <label htmlFor="cuenta_destino" className="block text-sm font-medium text-gray-700 mb-2">
          Cuenta Destino
        </label>
        <select
          id="cuenta_destino"
          name="cuenta_destino"
          value={cuentaDestino}
          onChange={(e) => setCuentaDestino(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        >
          {cuentas
            .filter((cuenta) => cuenta.id !== cuentaOrigen)
            .map((cuenta) => (
              <option key={cuenta.id} value={cuenta.id}>
                {cuenta.nombre}
              </option>
            ))}
        </select>
      </div>
      </>
      ) : (
      <div>
        <label htmlFor="cuenta_destino" className="block text-sm font-medium text-gray-700 mb-2">
          Cuenta Destino
        </label>
        <select
          id="cuenta_destino"
          name="cuenta_destino"
          value={cuentaDestino}
          onChange={(e) => setCuentaDestino(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        >
          {cuentas.length === 0 ? (
            <option value="" disabled>
              No hay cuentas financieras disponibles
            </option>
          ) : (
            cuentas.map((cuenta) => (
              <option key={cuenta.id} value={cuenta.id}>
                {cuenta.nombre}
              </option>
            ))
          )}
        </select>
      </div>
      )}

      {/* Subcategoría (condicional) */}
      {tipoMovimiento !== 'TRANSFERENCIA' && subcategoriasActuales.length > 0 && (
        <div>
          <label htmlFor="subcategoria" className="block text-sm font-medium text-gray-700 mb-2">
            Subcategoría
          </label>
          <select
            id="subcategoria"
            name="subcategoria"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {subcategoriasActuales.map(sub => (
              <option key={sub} value={sub}>
                {sub}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Monto */}
      <div>
        <label htmlFor="monto" className="block text-sm font-medium text-gray-700 mb-2">
          Monto (MXN)
        </label>
        <input
          type="number"
          id="monto"
          name="monto"
          value={monto}
          onChange={(e) => setMonto(e.target.value)}
          step="0.01"
          min="0"
          placeholder="0.00"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        />
      </div>

      {/* TODO ERP-xx: recurrencia real. Los campos es_recurrente / frecuencia /
          duracion_meses se quitaron de la UI: handleSubmit arma el payload a mano
          y nunca los enviaba, asi que marcar "gasto recurrente" no hacia nada. */}

      {/* Descripción */}
      <div>
        <label htmlFor="descripcion" className="block text-sm font-medium text-gray-700 mb-2">
          Descripción (Opcional)
        </label>
        <textarea
          id="descripcion"
          name="descripcion"
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          rows={3}
          placeholder="Añade notas o detalles adicionales..."
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* Buttons */}
      <div className="flex gap-4 pt-4">
        <button
          type="submit"
          disabled={isLoading}
          className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {isLoading ? 'Guardando...' : 'Guardar Movimiento'}
        </button>
        <Link
          href="/dashboard/finanzas"
          className="flex-1 bg-gray-200 text-gray-800 py-2 px-4 rounded-md hover:bg-gray-300 transition-colors text-center"
        >
          Cancelar
        </Link>
      </div>
    </form>
  )
}
