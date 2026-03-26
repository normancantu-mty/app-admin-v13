'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import type { CurrentUser } from '@/lib/auth-utils'

interface CuentaFinanciera {
  id: string
  nombre: string
  tipo_fiscalidad: 'IVA_ONLY' | 'FULL_TAX' | 'EXENTO'
}

type EstadoFinanzaLedger = 'APPROVED' | 'PENDING'

async function getCurrentUserFromClient(): Promise<CurrentUser | null> {
  const { data: { session } } = await supabase.auth.getSession()

  if (!session?.user?.email) {
    return null
  }

  const { data, error } = await supabase
    .from('entidades')
    .select('id, email, rol, nombre')
    .eq('email', session.user.email)
    .single()

  if (error || !data) {
    return null
  }

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
  const [cuentas, setCuentas] = useState<CuentaFinanciera[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)

  const [tipoMovimiento, setTipoMovimiento] = useState<'ABONO' | 'AJUSTE'>('ABONO')
  const [monto, setMonto] = useState('')
  const [idCuentaDestino, setIdCuentaDestino] = useState('')
  const [referencia, setReferencia] = useState('')

  useEffect(() => {
    const fetchCuentas = async () => {
      try {
        const { data, error } = await supabase
          .from('cuentas_financieras')
          .select('id, nombre, tipo_fiscalidad')
          .order('nombre', { ascending: true })

        if (error) {
          console.error('Error fetching cuentas:', error)
          return
        }

        setCuentas(data || [])
      } catch (error) {
        console.error('Error in fetchCuentas:', error)
      } finally {
        setIsLoadingData(false)
      }
    }

    fetchCuentas()
  }, [])

  const handleGuardarMovimiento = async () => {
    if (!monto || !idCuentaDestino) {
      alert('Por favor completa el monto y la cuenta destino.')
      return
    }

    const montoNum = parseFloat(monto)
    if (isNaN(montoNum) || montoNum <= 0) {
      alert('El monto debe ser un valor numérico positivo.')
      return
    }

    setIsLoading(true)

    try {
      const currentUser = await getCurrentUserFromClient()
      if (!currentUser) {
        alert('No se pudo validar tu sesión. Vuelve a iniciar sesión.')
        return
      }

      if (currentUser.rol === 'SOCIO') {
        alert('Acceso denegado: tu rol es de solo lectura.')
        return
      }

      const cuentaSeleccionada = cuentas.find(c => c.id === idCuentaDestino)
      if (!cuentaSeleccionada) {
        alert('Cuenta no encontrada.')
        return
      }

      const movimientos: any[] = []
      const statusMovimiento: EstadoFinanzaLedger = currentUser.rol === 'DST' ? 'PENDING' : 'APPROVED'
      const aplicarFugaFiscal = currentUser.rol === 'ADMIN' && tipoMovimiento === 'ABONO'

      movimientos.push({
        tipo_movimiento: 'ABONO_DEUDA',
        categoria: tipoMovimiento === 'ABONO' ? 'ABONO_REAL' : 'AJUSTE_MANUAL',
        monto: montoNum,
        id_cuenta_destino: idCuentaDestino,
        id_entidad_relacionada: resolvedParams.id,
        categoria_gasto: referencia || (tipoMovimiento === 'ABONO' ? 'Abono a cuenta' : 'Ajuste manual a favor'),
        status: statusMovimiento
      })

      // CRITICAL GUARDRAIL:
      // Fuga Fiscal SOLO se ejecuta para ADMIN al registrar ABONO aprobado.
      if (aplicarFugaFiscal && cuentaSeleccionada.tipo_fiscalidad === 'IVA_ONLY') {
        const base = montoNum / 1.16
        const iva = montoNum - base
        const ivaRedondeado = Math.round(iva * 100) / 100

        movimientos.push({
          tipo_movimiento: 'GASTO_OPERATIVO',
          categoria: 'Fuga_Fiscal_IVA',
          monto: ivaRedondeado,
          id_cuenta_origen: idCuentaDestino,
          categoria_gasto: 'Subsidio IVA por abono bancario',
          status: 'APPROVED'
        })
      } else if (aplicarFugaFiscal && cuentaSeleccionada.tipo_fiscalidad === 'FULL_TAX') {
        const base = montoNum / 1.7748
        const impuestos = montoNum - base
        const impuestosRedondeados = Math.round(impuestos * 100) / 100

        movimientos.push({
          tipo_movimiento: 'GASTO_OPERATIVO',
          categoria: 'Fuga_Fiscal_IEPS_IVA',
          monto: impuestosRedondeados,
          id_cuenta_origen: idCuentaDestino,
          categoria_gasto: 'Subsidio IEPS+IVA por abono bancario',
          status: 'APPROVED'
        })
      }

      const { error } = await supabase
        .from('finanzas_ledger')
        .insert(movimientos)

      if (error) {
        console.error('Error details:', error.message, error.details, error.hint)
        alert(`Error al registrar movimiento: ${error.message}`)
        return
      }

      const mensaje = currentUser.rol === 'DST'
        ? '✅ Abono enviado a validación administrativa. Estado: PENDIENTE.'
        : (tipoMovimiento === 'ABONO'
          ? '✅ Abono aprobado y registrado con fuga fiscal automatizada.'
          : '✅ Ajuste a favor registrado exitosamente.')
      alert(mensaje)
      router.push(`/dashboard/distribuidores/${resolvedParams.id}`)
      router.refresh()
    } catch (error: any) {
      console.error('Error details:', error?.message, error?.details, error?.hint)
      alert('Error al registrar el movimiento. Inténtalo de nuevo.')
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
          <h1 className="text-3xl font-bold text-gray-800">Registrar Abono / Ajuste</h1>
          <p className="text-gray-600 mt-2">Gestión financiera de deuda del distribuidor</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="space-y-6">
            <div>
              <label htmlFor="tipoMovimiento" className="block text-sm font-medium text-gray-700 mb-2">
                Tipo de Movimiento
              </label>
              <select
                id="tipoMovimiento"
                value={tipoMovimiento}
                onChange={(e) => setTipoMovimiento(e.target.value as 'ABONO' | 'AJUSTE')}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
              >
                <option value="ABONO">Abono (Pago de Deuda)</option>
                <option value="AJUSTE">Ajuste a Favor (Perdón de deuda / Bonificación)</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {tipoMovimiento === 'ABONO' ? 'El distribuidor está pagando su deuda' : 'Ajuste manual que reduce la deuda sin pago'}
              </p>
            </div>

            <div>
              <label htmlFor="monto" className="block text-sm font-medium text-gray-700 mb-2">
                Monto (MXN)
              </label>
              <input
                type="number"
                id="monto"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                min="0.01"
                step="0.01"
                placeholder="Ej. 5000.00"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                {tipoMovimiento === 'ABONO' ? 'Monto que el distribuidor está pagando' : 'Monto del ajuste a favor'}
              </p>
            </div>

            <div>
              <label htmlFor="cuenta" className="block text-sm font-medium text-gray-700 mb-2">
                Cuenta Destino (Dónde entró el dinero)
              </label>
              <select
                id="cuenta"
                value={idCuentaDestino}
                onChange={(e) => setIdCuentaDestino(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                disabled={isLoadingData}
              >
                <option value="">
                  {isLoadingData ? 'Cargando cuentas...' : 'Selecciona una cuenta...'}
                </option>
                {cuentas.map(cuenta => (
                  <option key={cuenta.id} value={cuenta.id}>
                    {cuenta.nombre} ({cuenta.tipo_fiscalidad})
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">La cuenta bancaria donde se recibió el pago</p>
            </div>

            <div>
              <label htmlFor="referencia" className="block text-sm font-medium text-gray-700 mb-2">
                Referencia / Notas (Opcional)
              </label>
              <textarea
                id="referencia"
                value={referencia}
                onChange={(e) => setReferencia(e.target.value)}
                rows={3}
                placeholder="Ej. Transferencia SPEI, Folio 123456"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
              />
              <p className="text-xs text-gray-500 mt-1">Información adicional sobre el abono</p>
            </div>

            <div className="border-t border-gray-200 pt-4">
              <div className="bg-blue-50 border border-blue-200 rounded-md p-4 mb-4">
                <h3 className="text-sm font-semibold text-blue-800 mb-2">ℹ️ Fuga Fiscal Automatizada</h3>
                <ul className="text-xs text-blue-700 space-y-1">
                  <li>• <strong>DST:</strong> El abono queda en PENDIENTE y no dispara fuga fiscal.</li>
                  <li>• <strong>ADMIN + IVA_ONLY:</strong> Se calcula IVA (16%) como gasto fiscal.</li>
                  <li>• <strong>ADMIN + FULL_TAX:</strong> Se calcula IEPS+IVA (77.48%) como gasto fiscal.</li>
                  <li>• <strong>EXENTO:</strong> No se aplicará ninguna deducción fiscal.</li>
                </ul>
              </div>
            </div>

            <div className="flex gap-4 pt-4">
              <button
                onClick={handleGuardarMovimiento}
                disabled={isLoading || !monto || !idCuentaDestino}
                className="flex-1 bg-green-600 text-white py-3 px-4 rounded-md hover:bg-green-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
              >
                {isLoading ? 'Registrando...' : tipoMovimiento === 'ABONO' ? '💰 Guardar Abono' : '✨ Guardar Ajuste'}
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
    </div>
  )
}
