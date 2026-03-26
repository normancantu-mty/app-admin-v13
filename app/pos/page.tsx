'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { calculateReverseTaxes, type TipoFiscalidad } from '@/lib/finance-utils'
import type { Entidad as EntidadBase } from '@/types/database'

interface Entidad extends Omit<EntidadBase, 'comisiones'> {
  comision_base: number
  comision_base_local: number
  comision_hijo_local: number
  comision_logistica: number
}

interface ListaPrecio {
  zona: string
  precio_final: number
}

interface ProductoConPrecio {
  id: string
  sku: string
  nombre: string
  listas_precios: ListaPrecio[]
}

interface ItemCarrito {
  producto: ProductoConPrecio
  cantidad: number
  subtotal: number
}

interface CuentaFinanciera {
  id: string
  nombre: string
  tipo_fiscalidad: TipoFiscalidad
}

export default function POSPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const vendedorUrl = searchParams.get('vendedor')
  
  const [entidades, setEntidades] = useState<Entidad[]>([])
  const [productos, setProductos] = useState<ProductoConPrecio[]>([])
  const [cuentas, setCuentas] = useState<CuentaFinanciera[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [loggedInUserId, setLoggedInUserId] = useState<string | null>(null)
  const [loggedInUserRole, setLoggedInUserRole] = useState<string | null>(null)
  const [idVendedor, setIdVendedor] = useState('')
  const [idComprador, setIdComprador] = useState('')
  const [idCuentaDestino, setIdCuentaDestino] = useState('')
  const [tipoFiscalidadCuenta, setTipoFiscalidadCuenta] = useState<TipoFiscalidad>('FULL_TAX')
  const [productoSeleccionado, setProductoSeleccionado] = useState('')
  const [cantidadInput, setCantidadInput] = useState('1')
  
  const [carrito, setCarrito] = useState<ItemCarrito[]>([])

  const [precioFinalTotal, setPrecioFinalTotal] = useState(0)
  const [porcentajeDescuento, setPorcentajeDescuento] = useState(0)
  const [totalNeto, setTotalNeto] = useState(0)
  const [desglose, setDesglose] = useState({
    montoBase: 0,
    ieps: 0,
    iva: 0
  })

  useEffect(() => {
    const fetchLoggedInUser = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session && session.user.email) {
          const { data: entidad } = await supabase
            .from('entidades')
            .select('id, rol')
            .eq('email', session.user.email)
            .single()
          
          if (entidad) {
            setLoggedInUserId(entidad.id)
            setLoggedInUserRole(entidad.rol)
            
            if (entidad.rol !== 'ADMIN') {
              setIdVendedor(entidad.id)
            }
          }
        }
      } catch (error) {
        console.error('Error fetching logged-in user:', error)
      }
    }
    
    fetchLoggedInUser()
  }, [])

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [entidadesRes, productosRes, cuentasRes] = await Promise.all([
          supabase.from('entidades').select('*').order('nombre', { ascending: true }),
          supabase
            .from('catalogo_productos')
            .select(`
              id,
              sku,
              nombre,
              listas_precios (zona, precio_final)
            `)
            .eq('tipo', 'TERMINADO'),
          supabase.from('cuentas_financieras').select('id, nombre, tipo_fiscalidad').order('nombre', { ascending: true })
        ])

        if (entidadesRes.error) {
          console.error('Error fetching entidades:', entidadesRes.error)
        } else {
          setEntidades(entidadesRes.data || [])
        }

        if (productosRes.error) {
          console.error('Error fetching productos:', productosRes.error)
        } else {
          setProductos(productosRes.data || [])
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

  useEffect(() => {
    if (vendedorUrl && entidades.length > 0 && !isLoadingData && loggedInUserRole === 'ADMIN') {
      setIdVendedor(vendedorUrl)
    }
  }, [vendedorUrl, entidades, isLoadingData, loggedInUserRole])

  useEffect(() => {
    if (idVendedor && cuentas.length > 0) {
      const vendedorActual = entidades.find(e => e.id === idVendedor)
      if (vendedorActual && vendedorActual.rol !== 'ADMIN') {
        const cuentaSeleccionada = cuentas.find(c => c.id === idCuentaDestino)
        if (cuentaSeleccionada && cuentaSeleccionada.tipo_fiscalidad !== 'LIBRE') {
          const cuentaEfectivo = cuentas.find(c => c.tipo_fiscalidad === 'LIBRE')
          if (cuentaEfectivo) {
            setIdCuentaDestino(cuentaEfectivo.id)
            setTipoFiscalidadCuenta(cuentaEfectivo.tipo_fiscalidad)
          }
        }
      }
    }
  }, [idVendedor, cuentas, entidades, idCuentaDestino])

  useEffect(() => {
    const totalCarrito = carrito.reduce((sum, item) => sum + item.subtotal, 0)
    setPrecioFinalTotal(totalCarrito)
    
    let descuentoDecimal = 0
    const compradorActual = entidades.find(e => e.id === idComprador)
    if (compradorActual) {
      if (compradorActual.rol === 'DST') descuentoDecimal = compradorActual.comision_base || 0
      if (compradorActual.rol === 'LOC') descuentoDecimal = compradorActual.comision_base_local || 0
    }
    
    const montoDescuento = totalCarrito * descuentoDecimal
    const neto = totalCarrito - montoDescuento
    
    setPorcentajeDescuento(descuentoDecimal * 100)
    setTotalNeto(neto)

    if (totalCarrito > 0) {
      const resultado = calculateReverseTaxes(neto, tipoFiscalidadCuenta)
      setDesglose(resultado)
    } else {
      setDesglose({ montoBase: 0, ieps: 0, iva: 0 })
    }
  }, [carrito, idComprador, tipoFiscalidadCuenta, entidades])

  const getPrecioAplicable = (producto: ProductoConPrecio): number => {
    const zonaComprador = entidades.find(e => e.id === idComprador)?.zona || 'Zacatecas'
    const precioAplicable = producto.listas_precios.find(p => p.zona === zonaComprador)?.precio_final || 0
    return precioAplicable
  }

  const handleAgregarAlCarrito = () => {
    if (!productoSeleccionado || !cantidadInput) {
      alert('Selecciona un producto y cantidad')
      return
    }

    const producto = productos.find(p => p.id === productoSeleccionado)
    if (!producto) return

    const cantidad = parseInt(cantidadInput) || 0
    if (cantidad <= 0) {
      alert('La cantidad debe ser mayor a 0')
      return
    }

    const precioAplicable = getPrecioAplicable(producto)
    const subtotal = precioAplicable * cantidad

    const itemExistente = carrito.find(item => item.producto.id === producto.id)
    
    if (itemExistente) {
      setCarrito(carrito.map(item =>
        item.producto.id === producto.id
          ? { ...item, cantidad: item.cantidad + cantidad, subtotal: item.subtotal + subtotal }
          : item
      ))
    } else {
      setCarrito([...carrito, { producto, cantidad, subtotal }])
    }

    setProductoSeleccionado('')
    setCantidadInput('1')
  }

  const handleEliminarDelCarrito = (productoId: string) => {
    setCarrito(carrito.filter(item => item.producto.id !== productoId))
  }

  const handleGenerarTicket = async () => {
    if (!idVendedor || !idCuentaDestino || carrito.length === 0) {
      alert('Por favor completa vendedor, cuenta destino y agrega productos al carrito')
      return
    }

    setIsSubmitting(true)

    try {
      const { data: ticketData, error: ticketError } = await supabase
        .from('transacciones_tickets')
        .insert({
          id_vendedor: idVendedor,
          id_comprador: idComprador === '' ? null : idComprador,
          subtotal_catalogo: precioFinalTotal,
          total_cobrado_real: totalNeto,
          monto_base_ingreso: desglose.montoBase,
          impuesto_iva_calculado: desglose.iva,
          impuesto_ieps_calculado: desglose.ieps,
          id_cuenta_destino: idCuentaDestino
        })
        .select()
        .single()

      if (ticketError) {
        console.error('Error inserting ticket:', ticketError)
        alert(`Error al generar ticket: ${ticketError.message}`)
        return
      }

      const detalles = carrito.map(item => {
        const precioAplicable = getPrecioAplicable(item.producto)
        return {
          id_ticket: ticketData.id,
          id_producto: item.producto.id,
          cantidad: item.cantidad,
          precio_unitario: precioAplicable,
          subtotal_linea: item.subtotal
        }
      })

      const { error: detallesError } = await supabase
        .from('ticket_detalles')
        .insert(detalles)

      if (detallesError) {
        console.error('Error inserting ticket detalles:', detallesError)
        alert(`Error al guardar detalles: ${detallesError.message}`)
        return
      }

      const vendedorActual = entidades.find(e => e.id === idVendedor)
      const esVentaPublicoAdmin = vendedorActual?.rol === 'ADMIN' && !idComprador

      const movimientosFinancieros: any[] = []

      if (esVentaPublicoAdmin) {
        movimientosFinancieros.push({
          id_cuenta_destino: idCuentaDestino,
          id_ticket: ticketData.id,
          tipo_movimiento: 'INGRESO_VENTA',
          monto: desglose.montoBase,
          categoria_gasto: 'Venta de mercancia'
        })
      }

      if (vendedorActual?.rol === 'LOC' && vendedorActual.id_padre) {
        const padre = entidades.find(e => e.id === vendedorActual.id_padre)
        if (padre) {
          // Fórmula estricta: (padre.hijo_local + vendedor.base_local) - padre.base
          const porcentajeBono = (padre.comision_hijo_local + vendedorActual.comision_base_local) - padre.comision_base
          if (porcentajeBono > 0) {
            const bonoCalculado = Math.round((desglose.montoBase * porcentajeBono) * 100) / 100
            movimientosFinancieros.push({
              id_entidad_relacionada: padre.id,
              tipo_movimiento: 'ABONO_DEUDA',
              monto: bonoCalculado,
              categoria_gasto: 'Comisión Pasiva por venta de ' + vendedorActual.nombre
            })
          }
        }
      }

      if (movimientosFinancieros.length > 0) {
        const { error: finanzasError } = await supabase
          .from('finanzas_ledger')
          .insert(movimientosFinancieros)

        if (finanzasError) {
          console.error('Error inserting finanzas ledger:', finanzasError)
          alert(`Error al registrar ingreso financiero: ${finanzasError.message}`)
          return
        }
      }

      const inventarioMovimientos = carrito.map(item => ({
        id_producto: item.producto.id,
        tipo_movimiento: 'SALIDA_VENTA',
        cantidad: item.cantidad
      }))

      const { error: inventarioError } = await supabase
        .from('inventario_ledger')
        .insert(inventarioMovimientos)

      if (inventarioError) {
        console.error('Error inserting inventario ledger:', inventarioError)
        alert(`Error al registrar salida de inventario: ${inventarioError.message}`)
        return
      }

      router.push(`/ticket/${ticketData.id}`)
    } catch (error) {
      console.error('Error in handleGenerarTicket:', error)
      alert('Error al guardar el ticket')
    } finally {
      setIsSubmitting(false)
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN'
    }).format(amount)
  }

  if (isLoadingData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">⏳</div>
          <p className="text-gray-600">Cargando datos...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <button
          onClick={() => router.back()}
          className="text-blue-600 hover:text-blue-800 mb-4 inline-flex items-center gap-1 text-sm font-medium"
        >
          ← Volver
        </button>
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-800">Punto de Venta (POS)</h1>
          <p className="text-gray-600 mt-2">Sistema de generación de tickets con carrito de compras</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Columna Izquierda: Captura */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-xl font-semibold text-gray-800 mb-6">Captura</h2>
            
            <div className="space-y-4">
              {/* Vendedor */}
              <div>
                <label htmlFor="vendedor" className="block text-sm font-medium text-gray-700 mb-2">
                  Vendedor
                </label>
                <select
                  id="vendedor"
                  value={idVendedor}
                  onChange={(e) => setIdVendedor(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                  disabled={loggedInUserRole !== 'ADMIN'}
                  required
                >
                  <option value="">Selecciona vendedor...</option>
                  {entidades.map(entidad => (
                    <option key={entidad.id} value={entidad.id}>
                      {entidad.nombre} ({entidad.rol})
                    </option>
                  ))}
                </select>
                {loggedInUserRole !== 'ADMIN' && (
                  <p className="text-xs text-gray-500 mt-1">Sesión vinculada a tu cuenta de distribuidor</p>
                )}
              </div>

              {/* Comprador */}
              <div>
                <label htmlFor="comprador" className="block text-sm font-medium text-gray-700 mb-2">
                  Comprador
                </label>
                <select
                  id="comprador"
                  value={idComprador}
                  onChange={(e) => setIdComprador(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Público en General</option>
                  {entidades.map(entidad => (
                    <option key={entidad.id} value={entidad.id}>
                      {entidad.nombre} ({entidad.rol})
                    </option>
                  ))}
                </select>
              </div>

              {/* Cuenta Destino */}
              <div>
                <label htmlFor="cuenta" className="block text-sm font-medium text-gray-700 mb-2">
                  Cuenta Destino
                </label>
                <select
                  id="cuenta"
                  value={idCuentaDestino}
                  onChange={(e) => {
                    const cuentaId = e.target.value
                    setIdCuentaDestino(cuentaId)
                    const cuenta = cuentas.find(c => c.id === cuentaId)
                    if (cuenta) {
                      setTipoFiscalidadCuenta(cuenta.tipo_fiscalidad)
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  required
                >
                  <option value="">Selecciona cuenta...</option>
                  {(() => {
                    const vendedorActual = entidades.find(e => e.id === idVendedor)
                    const cuentasFiltradas = vendedorActual && vendedorActual.rol !== 'ADMIN'
                      ? cuentas.filter(c => c.tipo_fiscalidad === 'LIBRE')
                      : cuentas
                    return cuentasFiltradas.map(cuenta => (
                      <option key={cuenta.id} value={cuenta.id}>
                        {cuenta.nombre} ({cuenta.tipo_fiscalidad})
                      </option>
                    ))
                  })()}
                </select>
              </div>

              <div className="border-t border-gray-200 pt-4 mt-6">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Agregar Producto</h3>
                
                {/* Producto */}
                <div className="mb-3">
                  <label htmlFor="producto" className="block text-sm font-medium text-gray-700 mb-2">
                    Producto
                  </label>
                  <select
                    id="producto"
                    value={productoSeleccionado}
                    onChange={(e) => setProductoSeleccionado(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Selecciona producto...</option>
                    {productos.map(producto => {
                      const precioAplicable = getPrecioAplicable(producto)
                      return (
                        <option key={producto.id} value={producto.id}>
                          {producto.nombre} - {formatCurrency(precioAplicable)}
                        </option>
                      )
                    })}
                  </select>
                </div>

                {/* Cantidad */}
                <div className="mb-3">
                  <label htmlFor="cantidad" className="block text-sm font-medium text-gray-700 mb-2">
                    Cantidad
                  </label>
                  <input
                    type="number"
                    id="cantidad"
                    value={cantidadInput}
                    onChange={(e) => setCantidadInput(e.target.value)}
                    min="1"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <button
                  onClick={handleAgregarAlCarrito}
                  className="w-full bg-green-600 text-white py-2 px-4 rounded-md hover:bg-green-700 transition-colors font-semibold"
                >
                  + Añadir al Carrito
                </button>
              </div>
            </div>
          </div>

          {/* Columna Central: Carrito */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-xl font-semibold text-gray-800 mb-6">Carrito de Compras</h2>
            
            {carrito.length === 0 ? (
              <div className="text-center py-12">
                <div className="text-gray-400 text-5xl mb-3">🛒</div>
                <p className="text-gray-500">El carrito está vacío</p>
              </div>
            ) : (
              <div className="space-y-3">
                {carrito.map((item, index) => {
                  const precioUnitario = getPrecioAplicable(item.producto)
                  return (
                    <div key={index} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50">
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex-1">
                          <p className="font-semibold text-gray-800">{item.producto.nombre}</p>
                          <p className="text-sm text-gray-600">
                            {formatCurrency(precioUnitario)} × {item.cantidad}
                          </p>
                        </div>
                        <button
                          onClick={() => handleEliminarDelCarrito(item.producto.id)}
                          className="text-red-600 hover:text-red-800 font-bold ml-2"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="text-right">
                        <span className="text-lg font-bold text-gray-900">
                          {formatCurrency(item.subtotal)}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <button
              onClick={handleGenerarTicket}
              disabled={isSubmitting || !idVendedor || !idCuentaDestino || carrito.length === 0}
              className="w-full mt-6 bg-blue-600 text-white py-3 px-4 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
            >
              {isSubmitting ? 'Generando...' : '🎫 Generar Ticket'}
            </button>
          </div>

          {/* Columna Derecha: Desglose */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-xl font-semibold text-gray-800 mb-6">Desglose Financiero</h2>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-gray-700">Subtotal</span>
                  <span className="text-lg font-semibold text-gray-900">{formatCurrency(precioFinalTotal)}</span>
                </div>
                {porcentajeDescuento > 0 && (
                  <div className="flex justify-between text-green-600 text-sm">
                    <span>Descuento Mayorista ({porcentajeDescuento}%):</span>
                    <span>-${(precioFinalTotal - totalNeto).toFixed(2)}</span>
                  </div>
                )}
              </div>
              
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-gray-600 mb-1">Total a Cobrar</p>
                <p className="text-3xl font-bold text-blue-600">{formatCurrency(totalNeto)}</p>
              </div>

              <div className="border-t border-gray-200 pt-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-gray-700">Monto Base (Ingreso Real)</span>
                  <span className="text-lg font-semibold text-gray-900">{formatCurrency(desglose.montoBase)}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-600">IVA (16%)</span>
                  <span className="text-gray-700">{formatCurrency(desglose.iva)}</span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-600">IEPS (53%)</span>
                  <span className="text-gray-700">{formatCurrency(desglose.ieps)}</span>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 mt-4">
                <p className="text-xs text-gray-500 text-center">
                  Cálculo inverso con factor 1.69. Los precios incluyen impuestos.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
