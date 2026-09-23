/**
 * EL CONTENIDO del documento termico, resuelto en un solo lugar.
 *
 * ─── POR QUE EXISTE ESTE ARCHIVO ────────────────────────────────────────────
 *
 * El mismo documento se pinta DOS veces y con motores distintos: la pagina web
 * (`app/ticket/[id]/page.tsx`, con Tailwind) y la imagen PNG que el bot manda
 * por Telegram (`app/api/documento/[id]/imagen`, con Satori via `next/og`).
 * Satori no sabe pintar Tailwind, asi que **las dos pinturas son forzosamente
 * distintas y eso se acepta**.
 *
 * Lo que NO puede divergir es el CONTENIDO: el folio, las lineas, el total y el
 * estado de cuenta tienen que ser el mismo numero en la pantalla y en la
 * imagen, o el cliente recibe un comprobante que no cuadra con el sistema.
 * **Se comparte el dato, no los pixeles.** Por eso esta funcion recibe el
 * cliente de Supabase como parametro: la corre el navegador con la sesion del
 * usuario, y la corre el servidor con la llave de servicio, y las dos obtienen
 * exactamente lo mismo.
 *
 * `tests/documento-termico.spec.ts` vigila que nadie vuelva a resolver estos
 * datos por su cuenta.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchDesgloseTextoPorTicketId } from '@/lib/ticket-desglose'
import { fechaParaPersona } from '@/lib/fechas'

export interface LineaDocumento {
  id: string
  nombre: string
  cantidad: number
  precioUnitario: number
}

export interface MovimientoDocumento {
  id: string
  fecha: string
  concepto: string
  monto: number
}

export interface DocumentoDatos {
  /** La linea chica bajo el nombre de la empresa: es lo unico que distingue un ticket de una cotizacion. */
  subtitulo: string
  fecha: string
  folio: string
  vendedor: string
  comprador: string
  /**
   * D71 (Fase 8): como se llama el receptor. "Comprador:" en un ticket;
   * "Para:" en una cotizacion, porque todavia no compro nada. Opcional para
   * que quien no lo diga siga pintando "Comprador:".
   */
  etiquetaReceptor?: string
  /** D71: que lista de precio aplica ("Precio de distribuidor" / "Precio al publico en general"). */
  listaDePrecio?: string
  lineas: LineaDocumento[]
  /**
   * D72 (Fase 8): cuando hay descuento, los renglones suman el SUBTOTAL de
   * lista y el total es menor. Sin esta linea el papel no cuadra: los
   * renglones dicen una cifra y el total otra, sin explicar la diferencia.
   */
  descuento?: { subtotal: number; etiqueta: string; importe: number }
  etiquetaTotal: string
  total: number
  movimientos: MovimientoDocumento[]
  pie: string[]
}

type Cliente = SupabaseClient<Database>

interface MovimientoIntermedio extends MovimientoDocumento {
  orden: number
}

export const PIE_TICKET = ['Gracias por su compra', 'Este ticket es valido como comprobante']

export function folioDeTicket(id: string): string {
  return id.slice(0, 8).toUpperCase()
}

/**
 * El estado de cuenta chico: los ultimos 5 movimientos de la entidad, sin
 * contar el ticket que se esta imprimiendo. Sale de dos fuentes -- tickets y
 * abonos -- porque en este ERP la deuda se genera vendiendo y se baja abonando.
 */
async function ultimosCincoMovimientos(
  client: Cliente,
  idEntidad: string,
  idTicketActual: string
): Promise<MovimientoDocumento[]> {
  const [ticketsResult, abonosResult] = await Promise.all([
    client
      .from('transacciones_tickets')
      .select('id, fecha_transaccion, id_comprador, id_vendedor, monto_base_ingreso, total_cobrado_real, condicion_pago')
      .or(`id_comprador.eq.${idEntidad},id_vendedor.eq.${idEntidad}`)
      .order('fecha_transaccion', { ascending: false })
      .limit(10),
    client
      .from('finanzas_ledger')
      .select('id, fecha_movimiento, monto')
      .in('status', ['ACTIVO', 'APPROVED'])
      .eq('tipo_movimiento', 'ABONO_DEUDA')
      .eq('id_entidad_relacionada', idEntidad)
      .order('fecha_movimiento', { ascending: false })
      .limit(10)
  ])

  const deTickets: MovimientoIntermedio[] = (ticketsResult.data ?? [])
    .filter((row) => row.id !== idTicketActual && !!row.fecha_transaccion)
    .map((row) => {
      const fecha = row.fecha_transaccion as string
      const esCompra = row.id_comprador === idEntidad
      const condicion = row.condicion_pago === 'CONCESION' ? 'CONCESION' : 'CONTADO'
      return {
        id: `ticket-${row.id}`,
        fecha,
        concepto: esCompra ? `VENTA (${condicion})` : 'VENTA REALIZADA',
        monto: esCompra
          ? (row.monto_base_ingreso ?? row.total_cobrado_real ?? 0)
          : (row.total_cobrado_real ?? row.monto_base_ingreso ?? 0),
        orden: new Date(fecha).getTime()
      }
    })

  const deAbonos: MovimientoIntermedio[] = (abonosResult.data ?? [])
    .filter((row) => !!row.fecha_movimiento)
    .map((row) => {
      const fecha = row.fecha_movimiento as string
      return {
        id: `abono-${row.id}`,
        fecha,
        concepto: 'ABONO',
        monto: -Math.abs(row.monto || 0),
        orden: new Date(fecha).getTime()
      }
    })

  const ordenados = [...deTickets, ...deAbonos]
    .filter((row) => Number.isFinite(row.orden))
    .sort((a, b) => b.orden - a.orden)
    .slice(0, 5)

  // A cada VENTA del mini estado de cuenta se le pega su desglose de lineas,
  // que es lo que vuelve util el resumen: "debes 3,552" no dice nada; "3x
  // Plata 750 ($1,184 c/u)" si.
  const idsDeTicket = ordenados
    .filter((m) => m.id.startsWith('ticket-'))
    .map((m) => m.id.replace(/^ticket-/, ''))

  if (idsDeTicket.length === 0) {
    return ordenados.map(({ orden: _orden, ...resto }) => resto)
  }

  const desglose = await fetchDesgloseTextoPorTicketId(client, idsDeTicket)
  return ordenados.map(({ orden: _orden, ...resto }) => {
    if (!resto.id.startsWith('ticket-')) return resto
    const texto = desglose.get(resto.id.replace(/^ticket-/, ''))
    return texto ? { ...resto, concepto: `${resto.concepto}\n${texto}` } : resto
  })
}

/**
 * Arma el documento de una venta ya ocurrida.
 *
 * Funciona con CUALQUIER cliente de Supabase: el del navegador (con la sesion
 * del usuario y su RLS) o el de servicio (para la imagen que manda el bot).
 * Devuelve `null` si el ticket no existe o si el cliente no tiene permiso.
 */
export async function armarDocumentoDeTicket(
  client: Cliente,
  idTicket: string
): Promise<DocumentoDatos | null> {
  const { data: ticket, error } = await client
    .from('transacciones_tickets')
    .select(`
      *,
      vendedor:entidades!id_vendedor(nombre),
      comprador:entidades!id_comprador(nombre, rol)
    `)
    .eq('id', idTicket)
    .single()

  if (error || !ticket) return null

  const vendedor = (ticket.vendedor ?? null) as { nombre: string } | null
  const comprador = (ticket.comprador ?? null) as { nombre: string; rol: string } | null

  // Cuando la venta fue a publico en general no hay comprador, pero puede haber
  // un abono que si diga de quien es la deuda. Esa es la entidad del estado de
  // cuenta.
  let idEntidad: string | null = ticket.id_comprador ?? null
  if (!idEntidad) {
    const { data: abono } = await client
      .from('finanzas_ledger')
      .select('id_entidad_relacionada')
      .eq('id_ticket', idTicket)
      .eq('tipo_movimiento', 'ABONO_DEUDA')
      .order('fecha_movimiento', { ascending: false })
      .limit(1)
      .maybeSingle()
    idEntidad = abono?.id_entidad_relacionada ?? null
  }

  const { data: detalles } = await client
    .from('ticket_detalles')
    .select('*, producto:catalogo_productos(nombre)')
    .eq('id_ticket', idTicket)

  const lineas: LineaDocumento[] = (detalles ?? []).map((d) => {
    const producto = (d.producto ?? null) as { nombre: string } | null
    return {
      id: d.id,
      nombre: producto?.nombre ?? 'Producto',
      cantidad: d.cantidad,
      precioUnitario: d.precio_unitario
    }
  })

  // Un distribuidor paga la deuda NETA: la empresa absorbe sus impuestos. Un
  // cliente cualquiera paga el bruto. Confundirlos cobra de mas o de menos.
  const esDistribuidor = comprador?.rol === 'DST'

  return {
    subtitulo: 'Sistema de Punto de Venta',
    // Si no hay fecha no se le inventa una: el formateador pinta un guion. Un
    // comprobante con fecha fabricada es peor que uno que admite no tenerla.
    fecha: ticket.fecha_transaccion ?? '',
    folio: folioDeTicket(ticket.id),
    vendedor: vendedor?.nombre || 'Desconocido',
    comprador: comprador?.nombre || 'Publico en General',
    lineas,
    etiquetaTotal: esDistribuidor ? 'Total (Deuda Neta):' : 'Total:',
    total: esDistribuidor ? ticket.monto_base_ingreso : ticket.total_cobrado_real,
    movimientos: idEntidad ? await ultimosCincoMovimientos(client, idEntidad, idTicket) : [],
    pie: PIE_TICKET
  }
}

/**
 * El pie de una cotizacion. **Dice lo unico que la distingue de un ticket**: no
 * es un comprobante de nada, y caduca.
 */
export const PIE_COTIZACION = [
  'Esta cotizacion NO es un comprobante de venta',
  'Los precios pierden vigencia en la fecha indicada'
]

/**
 * Arma el documento de una cotizacion (ERP-87).
 *
 * ─── POR QUE NO ES `armarDocumentoDeTicket` CON UN `if` ─────────────────────
 * Porque no lee las mismas tablas: una cotizacion vive en `cotizaciones` y
 * `cotizacion_detalles`, no en `transacciones_tickets`. Lo que SI se comparte
 * es lo que importa — `DocumentoDatos`, o sea el contrato del contenido — de
 * modo que la pagina y la imagen PNG siguen pintando una sola forma.
 *
 * ─── LAS TRES DIFERENCIAS, Y POR QUE CADA UNA ───────────────────────────────
 *   · `subtitulo` dice "Cotizacion" y la vigencia. Es la linea que evita que
 *     alguien reciba esta imagen y la archive como su ticket.
 *   · `movimientos` va SIEMPRE vacio. Un estado de cuenta en una cotizacion
 *     mezclaria lo que alguien debe con lo que todavia no ha comprado.
 *   · `total` es el cotizado, sin neteo de distribuidor: en una cotizacion no
 *     hay impuestos que absorber porque no hay cuenta que los reciba.
 *
 * Se lee de `v_cotizaciones` y no de la tabla para que el `estado` que se pinta
 * sea el EFECTIVO: una cotizacion caduca por el paso del tiempo, y la tabla
 * seguiria diciendo VIGENTE.
 */
// ─── D71/D72 (Fase 8): EL ARMADO PURO DE LA COTIZACION ─────────────────────
// Separado de la lectura para poder probarlo con datos de fixture
// (`tests/documento-termico.spec.ts`), sin base.

export interface FilaCotizacionDocumento {
  folio: string | null
  fecha: string | null
  vigente_hasta: string | null
  estado_efectivo: string | null
  para_quien: string | null
  total: number | string | null
  notas: string | null
}

export const LISTA_DISTRIBUIDOR = 'Precio de distribuidor'
export const LISTA_PUBLICO = 'Precio al publico en general'

/** D71: la lista que aplica. Solo un comprador DST paga precio de distribuidor. */
export function listaDePrecioPara(rolComprador: string | null | undefined): string {
  return rolComprador === 'DST' ? LISTA_DISTRIBUIDOR : LISTA_PUBLICO
}

/**
 * El nombre de la promocion, leido de `notas`. `notaDeDescuento`
 * (`lib/bot-descuento.ts`) la escribe como `"<etiqueta> <N>%: de $X a $Y."`.
 * Si no empata, "Descuento" a secas: el importe sale de los numeros, no de
 * este texto, asi que un motivo ilegible nunca cambia una cifra.
 */
export function etiquetaDeDescuento(notas: string | null | undefined): string {
  const m = /^\s*(.+?)\s+(\d+(?:\.\d+)?)%:\s+de\s+\$/.exec(String(notas ?? ''))
  if (!m) return 'Descuento'
  return `${m[1].trim()} (${m[2]}%)`
}

const centavos = (n: number) => Math.round(n * 100)

export function datosDeCotizacion(
  cot: FilaCotizacionDocumento,
  vendedor: string,
  lineas: LineaDocumento[],
  rolComprador: string | null | undefined
): DocumentoDatos {
  // El estado efectivo va en el subtitulo cuando ya no sirve. Una cotizacion
  // vencida que se imprime igual que una viva es una promesa que se cobra dos
  // meses despues al precio del mes pasado.
  const vigencia =
    cot.estado_efectivo === 'CONVERTIDA'
      ? 'Cotizacion ya convertida en venta'
      : cot.estado_efectivo === 'VENCIDA'
        ? `Cotizacion VENCIDA el ${fechaParaPersona(cot.vigente_hasta)}`
        : `Cotizacion vigente hasta el ${fechaParaPersona(cot.vigente_hasta)}`

  const total = Number(cot.total ?? 0)
  // Los renglones se suman en centavos: la diferencia contra el total es la
  // que decide si hay linea de descuento, y un 0.0000001 de flotante no puede
  // inventar un descuento de cero pesos.
  const subtotalCentavos = lineas.reduce((acc, l) => acc + centavos(l.precioUnitario * l.cantidad), 0)
  const importeCentavos = subtotalCentavos - centavos(total)
  const descuento =
    importeCentavos > 0
      ? {
          subtotal: subtotalCentavos / 100,
          etiqueta: etiquetaDeDescuento(cot.notas),
          importe: importeCentavos / 100
        }
      : undefined

  return {
    subtitulo: vigencia,
    fecha: cot.fecha ?? '',
    folio: cot.folio ?? '',
    vendedor: vendedor || 'Desconocido',
    comprador: cot.para_quien || 'Sin nombre',
    etiquetaReceptor: 'Para:',
    listaDePrecio: listaDePrecioPara(rolComprador),
    lineas,
    descuento,
    etiquetaTotal: 'Total cotizado:',
    total,
    movimientos: [],
    pie: PIE_COTIZACION
  }
}

export async function armarDocumentoDeCotizacion(
  client: Cliente,
  idCotizacion: string
): Promise<DocumentoDatos | null> {
  const { data: cot, error } = await client
    .from('v_cotizaciones')
    .select('*, vendedor:entidades!id_vendedor(nombre), receptor:entidades!id_comprador(rol)')
    .eq('id', idCotizacion)
    .maybeSingle()

  if (error || !cot) return null

  const vendedor = (cot.vendedor ?? null) as { nombre: string } | null
  const receptor = (cot.receptor ?? null) as { rol: string } | null

  const { data: detalles } = await client
    .from('cotizacion_detalles')
    .select('*, producto:catalogo_productos(nombre)')
    .eq('id_cotizacion', idCotizacion)

  const lineas: LineaDocumento[] = (detalles ?? []).map((d) => {
    const producto = (d.producto ?? null) as { nombre: string } | null
    return {
      id: d.id,
      nombre: producto?.nombre ?? 'Producto',
      cantidad: d.cantidad,
      precioUnitario: d.precio_unitario
    }
  })

  return datosDeCotizacion(cot, vendedor?.nombre ?? '', lineas, receptor?.rol)
}
