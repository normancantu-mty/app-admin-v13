'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { esCompradorSeleccionable } from '@/lib/avisos'
import { calculateReverseTaxes, type TipoFiscalidad } from '@/lib/finance-utils'
import { calculateWaterfall } from '@/lib/pricing-waterfall'
import { procesarVentaPOS } from '@/app/actions/pos'
import type { Tables } from '@/types/database'

type Entidad = Tables<'entidades'>

type EntidadCompradorOpcion = Entidad & { displayLabel: string }

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
  precioUnitario: number
  subtotal: number
}

type CondicionPago = 'CONTADO' | 'CONCESION'

interface CuentaFinanciera {
  id: string
  nombre: string
  tipo_fiscalidad: TipoFiscalidad
  id_entidad?: string | null
}

function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export default function POSPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const vendedorUrl = searchParams.get('vendedor')
  
  const [entidades, setEntidades] = useState<Entidad[]>([])
  const [productos, setProductos] = useState<ProductoConPrecio[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [compradoresPermitidos, setCompradoresPermitidos] = useState<Entidad[]>([])
  const [cuentasDisponibles, setCuentasDisponibles] = useState<CuentaFinanciera[]>([])

  const [loggedInUserRole, setLoggedInUserRole] = useState<string | null>(null)
  const [activeUserEntityName, setActiveUserEntityName] = useState('')
  const [idVendedor, setIdVendedor] = useState('')
  const [idComprador, setIdComprador] = useState('')
  const [origenInventarioId, setOrigenInventarioId] = useState('')
  const [idCuentaDestino, setIdCuentaDestino] = useState('')
  const [condicionPago, setCondicionPago] = useState<CondicionPago>('CONTADO')
  const [tipoFiscalidadCuenta, setTipoFiscalidadCuenta] = useState<TipoFiscalidad>('FULL_TAX')
  const [productoSeleccionado, setProductoSeleccionado] = useState('')
  const [cantidadInput, setCantidadInput] = useState('1')
  
  const [carrito, setCarrito] = useState<ItemCarrito[]>([])

  const [precioFinalTotal, setPrecioFinalTotal] = useState(0)
  const [desglose, setDesglose] = useState({
    montoBase: 0,
    ieps: 0,
    iva: 0
  })

  const compradorSeleccionado = entidades.find((entidad) => entidad.id === idComprador)
  const vendedorSeleccionado = entidades.find((entidad) => entidad.id === idVendedor)
  const distribuidorPadreComprador = compradorSeleccionado?.id_padre || compradorSeleccionado?.id_nodo_padre
    ? entidades.find((entidad) => entidad.id === (compradorSeleccionado.id_padre || compradorSeleccionado.id_nodo_padre))
    : null

  const mostrarSelectorOrigenInventario = Boolean(
    vendedorSeleccionado?.rol === 'ADMIN' &&
    compradorSeleccionado?.rol === 'LOC' &&
    distribuidorPadreComprador?.id
  )
  
  const esCompradorDST = compradorSeleccionado?.rol === 'DST'
  const totalVisualCobro = esCompradorDST ? desglose.montoBase : precioFinalTotal
  const requiereCompradorConcesion = condicionPago === 'CONCESION' && idComprador === ''

  // MAPEO INFALIBLE: Buscamos al padre en la memoria local, no dependemos del JOIN de Supabase
  const opcionesCompradores: EntidadCompradorOpcion[] = compradoresPermitidos.map((ent) => {
    let label = `${ent.nombre} (${ent.rol})`

    if (ent.rol === 'LOC') {
      const padreLocal = entidades.find(e => e.id === ent.id_nodo_padre || e.id === ent.id_padre)
      if (padreLocal) {
        label = `${ent.nombre} (Loc-${padreLocal.nombre})`
      } else {
        label = `${ent.nombre} (LOC)`
      }
    }

    return {
      ...ent,
      displayLabel: label
    }
  })

  useEffect(() => {
    const fetchLoggedInUser = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session && session.user.email) {
          const { data: entidad } = await supabase
            .from('entidades')
            .select('id, rol, nombre')
            .eq('email', session.user.email)
            .single()
          
          if (entidad) {
            setLoggedInUserRole(entidad.rol)
            setActiveUserEntityName(entidad.nombre ?? '')
            
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
        const [entidadesRes, productosRes] = await Promise.all([
          supabase
            .from('entidades')
            .select('*')
            .order('nombre', { ascending: true }),
          supabase
            .from('catalogo_productos')
            .select(`
              id,
              sku,
              nombre,
              listas_precios (zona, precio_final)
            `)
            .eq('tipo', 'TERMINADO')
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
    let isCancelled = false

    const fetchCompradoresPermitidos = async () => {
      if (!idVendedor) {
        setCompradoresPermitidos([])
        return
      }

      const vendedorActual = entidades.find((entidad) => entidad.id === idVendedor)
      if (!vendedorActual) {
        setCompradoresPermitidos([])
        return
      }

      const { data, error } = await supabase
        .from('entidades')
        .select('*')
        .neq('id', vendedorActual.id)
        .order('nombre', { ascending: true })

      if (error) {
        console.error('Error fetching compradores permitidos:', error)
        if (!isCancelled) setCompradoresPermitidos([])
        return
      }

      if (!isCancelled) {
        const lista = (data || []) as Entidad[]
        const compradoresFiltrados = lista.filter((c) => {
          // ERP-80. El centinela "PENDIENTE DE ASIGNAR" es un LOC, asi que caia
          // dentro del filtro del ADMIN y se podia elegir como si fuera un
          // cliente. No lo es: es el marcador de las consignaciones sin dueno.
          if (!esCompradorSeleccionable(c)) return false
          if (vendedorActual.rol === 'ADMIN') {
            return c.rol === 'DST' || c.rol === 'LOC'
          }
          return c.id_padre === vendedorActual.id || c.id_nodo_padre === vendedorActual.id
        })
        setCompradoresPermitidos(compradoresFiltrados)
      }
    }

    fetchCompradoresPermitidos()

    return () => {
      isCancelled = true
    }
  }, [idVendedor, entidades])

  useEffect(() => {
    let isCancelled = false

    const normalizeText = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '')
        .toLowerCase()

    const fetchCuentasDisponibles = async () => {
      if (!idVendedor) {
        setCuentasDisponibles([])
        setIdCuentaDestino('')
        return
      }

      const vendedorActual = entidades.find((entidad) => entidad.id === idVendedor)
      if (!vendedorActual) {
        setCuentasDisponibles([])
        setIdCuentaDestino('')
        return
      }

      const { data, error } = await supabase
        .from('cuentas_financieras')
        .select('id, nombre, tipo_fiscalidad, id_entidad')
        .eq('id_entidad', vendedorActual.id)
        .order('nombre', { ascending: true })

      if (error) {
        console.error('Error fetching cuentas financieras para POS:', error)
        if (!isCancelled) {
          setCuentasDisponibles([])
          setIdCuentaDestino('')
        }
        return
      }
      let cuentas = (data || []) as CuentaFinanciera[]
      if (loggedInUserRole !== 'ADMIN') {
        cuentas = cuentas.filter((cuenta) => cuenta.tipo_fiscalidad === 'LIBRE')
      }

      if (isCancelled) return

      setCuentasDisponibles(cuentas)

      if (cuentas.length === 0) {
        setIdCuentaDestino('')
        return
      }

      const nombreCtaDefault = `CTA-${vendedorActual.nombre || activeUserEntityName || ''}`
      const cuentaPreferida = cuentas.find((cuenta) =>
        normalizeText(cuenta.nombre) === normalizeText(nombreCtaDefault)
      )
      const cuentaFallbackCta = cuentas.find((cuenta) =>
        normalizeText(cuenta.nombre).startsWith('cta-')
      )
      const cuentaDefault = cuentaPreferida ?? cuentaFallbackCta ?? cuentas[0]

      setIdCuentaDestino((current) => {
        if (current && cuentas.some((cuenta) => cuenta.id === current)) {
          return current
        }
        return cuentaDefault.id
      })
    }

    fetchCuentasDisponibles()

    return () => {
      isCancelled = true
    }
  }, [idVendedor, entidades, activeUserEntityName, loggedInUserRole])

  useEffect(() => {
    if (!idComprador) return
    const permitido = compradoresPermitidos.some((entidad) => entidad.id === idComprador)
    if (!permitido) {
      setIdComprador('')
    }
  }, [compradoresPermitidos, idComprador])

  useEffect(() => {
    if (!idVendedor) {
      setOrigenInventarioId('')
      return
    }

    if (!mostrarSelectorOrigenInventario || !distribuidorPadreComprador?.id) {
      setOrigenInventarioId(idVendedor)
      return
    }

    setOrigenInventarioId((current) => {
      if (current === idVendedor || current === distribuidorPadreComprador.id) {
        return current
      }
      return idVendedor
    })
  }, [idVendedor, mostrarSelectorOrigenInventario, distribuidorPadreComprador?.id])

  useEffect(() => {
    let isCancelled = false

    const fetchCuentaFiscalidad = async () => {
      if (!idCuentaDestino) {
        setTipoFiscalidadCuenta('FULL_TAX')
        return
      }

      const { data, error } = await supabase
        .from('cuentas_financieras')
        .select('tipo_fiscalidad')
        .eq('id', idCuentaDestino)
        .single()

      if (error) {
        console.error('Error fetching fiscalidad de cuenta CTA:', error)
        if (!isCancelled) setTipoFiscalidadCuenta('FULL_TAX')
        return
      }

      if (!isCancelled) {
        const fiscalidad = data && typeof data === 'object' ? data.tipo_fiscalidad : null
        setTipoFiscalidadCuenta((fiscalidad as TipoFiscalidad) ?? 'FULL_TAX')
      }
    }

    fetchCuentaFiscalidad()

    return () => {
      isCancelled = true
    }
  }, [idCuentaDestino])

  useEffect(() => {
    const totalCarrito = roundTo2(carrito.reduce((sum, item) => sum + item.subtotal, 0))
    setPrecioFinalTotal(totalCarrito)

    if (totalCarrito > 0) {
      const resultado = calculateReverseTaxes(totalCarrito, tipoFiscalidadCuenta)
      setDesglose(resultado)
    } else {
      setDesglose({ montoBase: 0, ieps: 0, iva: 0 })
    }
  }, [carrito, tipoFiscalidadCuenta])

  const getPrecioAplicable = useCallback((producto: ProductoConPrecio): number => {
    const zonaComprador = entidades.find(e => e.id === idComprador)?.zona || 'Zacatecas'
    const precioAplicable = producto.listas_precios.find(p => p.zona === zonaComprador)?.precio_final || 0
    return precioAplicable
  }, [entidades, idComprador])

  const getCostoFinalParaCarrito = useCallback((producto: ProductoConPrecio): number => {
    const precioAplicable = getPrecioAplicable(producto)
    const compradorActual = entidades.find((entidad) => entidad.id === idComprador)

    if (compradorActual?.rol === 'DST' || compradorActual?.rol === 'LOC') {
      const waterfall = calculateWaterfall(
        { listas_precios: [{ precio_final: precioAplicable }] },
        compradorActual,
        compradorActual.rol
      )
      return roundTo2(waterfall.tuCosto)
    }

    return roundTo2(precioAplicable)
  }, [entidades, getPrecioAplicable, idComprador])

  useEffect(() => {
    setCarrito((prev) => {
      let changed = false
      const updated = prev.map((item) => {
        const nuevoPrecioUnitario = getCostoFinalParaCarrito(item.producto)
        const nuevoSubtotal = roundTo2(nuevoPrecioUnitario * item.cantidad)
        if (
          Math.abs(item.precioUnitario - nuevoPrecioUnitario) > 0.001 ||
          Math.abs(item.subtotal - nuevoSubtotal) > 0.001
        ) {
          changed = true
          return { ...item, precioUnitario: nuevoPrecioUnitario, subtotal: nuevoSubtotal }
        }
        return item
      })
      return changed ? updated : prev
    })
  }, [getCostoFinalParaCarrito])

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

    const precioUnitario = getCostoFinalParaCarrito(producto)
    const subtotal = roundTo2(precioUnitario * cantidad)

    const itemExistente = carrito.find(item => item.producto.id === producto.id)
    
    if (itemExistente) {
      setCarrito(carrito.map(item =>
        item.producto.id === producto.id
          ? {
              ...item,
              cantidad: item.cantidad + cantidad,
              precioUnitario,
              subtotal: roundTo2((item.cantidad + cantidad) * precioUnitario)
            }
          : item
      ))
    } else {
      setCarrito([...carrito, { producto, cantidad, precioUnitario, subtotal }])
    }

    setProductoSeleccionado('')
    setCantidadInput('1')
  }

  const handleEliminarDelCarrito = (productoId: string) => {
    setCarrito(carrito.filter(item => item.producto.id !== productoId))
  }

  const handleGenerarTicket = async () => {
    if (!idVendedor || carrito.length === 0) {
      alert('Por favor completa vendedor y agrega productos al carrito')
      return
    }

    setIsSubmitting(true)

    try {
      const result = await procesarVentaPOS({
        idVendedor,
        idComprador: idComprador === '' ? null : idComprador,
        origenInventarioId: origenInventarioId || idVendedor,
        idCuentaDestino: idCuentaDestino || null,
        condicion_pago: condicionPago,
        subtotalCatalogo: precioFinalTotal,
        totalCobradoReal: precioFinalTotal,
        montoBaseIngreso: desglose.montoBase,
        impuestoIvaCalculado: desglose.iva,
        impuestoIepsCalculado: desglose.ieps,
        items: carrito.map((item) => ({
          id_producto: item.producto.id,
          cantidad: item.cantidad,
          precio_unitario: item.precioUnitario,
          subtotal_linea: item.subtotal
        }))
      })

      if (!result.ok || !result.ticketId) {
        alert(result.error || 'Error al procesar la venta')
        return
      }

      router.refresh()
      router.push(`/ticket/${result.ticketId}`)
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
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-xl font-semibold text-gray-800 mb-6">Captura</h2>
            
            <div className="space-y-4">
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
                  {opcionesCompradores.map((comprador) => (
                    <option key={comprador.id} value={comprador.id}>
                      {comprador.displayLabel}
                    </option>
                  ))}
                </select>
              </div>

              {mostrarSelectorOrigenInventario && (
                <div>
                  <label htmlFor="origen_inventario" className="block text-sm font-medium text-gray-700 mb-2">
                    Origen de Inventario
                  </label>
                  <select
                    id="origen_inventario"
                    value={origenInventarioId || idVendedor}
                    onChange={(e) => setOrigenInventarioId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value={idVendedor}>Mi Inventario (Bodega Central)</option>
                    <option value={distribuidorPadreComprador?.id || ''}>
                      Inventario de su Distribuidor
                    </option>
                  </select>
                </div>
              )}

              <div>
                <label htmlFor="condicion_pago" className="block text-sm font-medium text-gray-700 mb-2">
                  Modalidad de Venta
                </label>
                <select
                  id="condicion_pago"
                  value={condicionPago}
                  onChange={(e) => setCondicionPago(e.target.value as CondicionPago)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="CONTADO">Contado</option>
                  <option value="CONCESION">Concesión</option>
                </select>
              </div>

              <div>
                <label htmlFor="cuenta_destino" className="block text-sm font-medium text-gray-700 mb-2">
                  Cuenta Destino
                </label>
                <select
                  id="cuenta_destino"
                  value={idCuentaDestino}
                  onChange={(e) => setIdCuentaDestino(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {cuentasDisponibles.length === 0 ? (
                    <option value="">No hay cuentas disponibles</option>
                  ) : (
                    cuentasDisponibles.map((cuenta) => (
                      <option key={cuenta.id} value={cuenta.id}>
                        {cuenta.nombre}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="border-t border-gray-200 pt-4 mt-6">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Agregar Producto</h3>
                
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
                      const precioAplicable = getCostoFinalParaCarrito(producto)
                      return (
                        <option key={producto.id} value={producto.id}>
                          {producto.nombre} - {formatCurrency(precioAplicable)}
                        </option>
                      )
                    })}
                  </select>
                </div>

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
                  const precioUnitario = item.precioUnitario
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
              disabled={isSubmitting || !idVendedor || carrito.length === 0 || requiereCompradorConcesion}
              className="w-full mt-6 bg-blue-600 text-white py-3 px-4 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
            >
              {isSubmitting ? 'Generando...' : '🎫 Generar Ticket'}
            </button>
            {requiereCompradorConcesion && (
              <p className="mt-2 text-sm text-amber-700">
                Identifique al cliente para otorgar concesión
              </p>
            )}
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-xl font-semibold text-gray-800 mb-6">Desglose Financiero</h2>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-gray-700">Subtotal</span>
                  <span className="text-lg font-semibold text-gray-900">{formatCurrency(precioFinalTotal)}</span>
                </div>
                <div className="flex justify-between text-sm text-gray-700">
                  <span>Total costo final de items:</span>
                  <span>{formatCurrency(precioFinalTotal)}</span>
                </div>
              </div>
              
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-gray-600 mb-1">
                  {esCompradorDST ? 'Total a Cobrar (Deuda Neta)' : 'Total a Cobrar'}
                </p>
                <p className="text-3xl font-bold text-blue-600">{formatCurrency(totalVisualCobro)}</p>
                {esCompradorDST && (
                  <p className="text-xs text-blue-700 mt-1">(Impuestos absorbidos por la empresa)</p>
                )}
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
                  Cálculo inverso con factor 1.7748 (IEPS 53% + IVA 16% sobre Base+IEPS).
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}