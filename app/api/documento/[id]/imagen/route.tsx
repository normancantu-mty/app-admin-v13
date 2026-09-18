/**
 * El documento termico como IMAGEN PNG, para mandarlo por Telegram o WhatsApp.
 *
 * ─── POR QUE IMAGEN Y NO PDF ────────────────────────────────────────────────
 *
 * Norman, 2026-09-18: "la verdad lo que uso es la imagen, porque lo mando por
 * WhatsApp". Un PDF llega como adjunto que hay que abrir; una imagen se ve sola
 * en la conversacion. Y de paso no hace falta ninguna dependencia nueva:
 * `ImageResponse` viene con Next.
 *
 * ─── LA FRONTERA DE SEGURIDAD ───────────────────────────────────────────────
 *
 * Esta ruta corre con la LLAVE DE SERVICIO, o sea que salta la RLS. Lo unico
 * que la protege es `tokenValido()`, el mismo secreto compartido que ya usan
 * las rutas del bot, comparado en tiempo constante. Sin ese header no se lee
 * absolutamente nada: la respuesta es 401 antes de tocar la base.
 *
 * Y una consecuencia que hay que tener presente: como salta la RLS, un id de
 * ticket valido devuelve SIEMPRE la imagen. Quien tenga el token puede pedir
 * cualquier ticket. Es aceptable porque el token vive solo en el proceso del
 * bot, que corre en la maquina de Norman -- pero si algun dia el bot se hospeda
 * afuera, esto se convierte en la pieza a revisar primero.
 */
import { ImageResponse } from 'next/og'
import { clienteDeServicio, tokenValido } from '@/lib/bot-servidor'
import { armarDocumentoDeTicket, type DocumentoDatos } from '@/lib/documento'

export const dynamic = 'force-dynamic'

const ANCHO = 560
const TINTA = '#1f2937'
const TENUE = '#6b7280'
const MONO = 'ui-monospace, "Cascadia Mono", "Segoe UI Mono", Consolas, monospace'

function fechaLarga(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-MX', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' })
}

function montoFirmado(n: number): string {
  const signo = n < 0 ? '-' : '+'
  return `${signo}$${new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(Math.abs(n))}`
}

/** Satori solo entiende flex: cada contenedor lleva display flex a mano. */
const fila = { display: 'flex', justifyContent: 'space-between', width: '100%' } as const
const columna = { display: 'flex', flexDirection: 'column' } as const
const rayada = { display: 'flex', width: '100%', borderTop: '1px dashed #9ca3af', margin: '12px 0' } as const

function Documento({ d }: { d: DocumentoDatos }) {
  return (
    <div
      style={{
        ...columna,
        width: ANCHO,
        backgroundColor: '#ffffff',
        color: TINTA,
        fontFamily: MONO,
        fontSize: 16,
        padding: 28
      }}
    >
      <div style={{ ...columna, alignItems: 'center', width: '100%' }}>
        <div style={{ display: 'flex', fontSize: 22, fontWeight: 700, textAlign: 'center' }}>
          FRESNILLO / DESTILADO DE CHILE
        </div>
        <div style={{ display: 'flex', fontSize: 14, marginTop: 4 }}>{d.subtitulo}</div>
      </div>

      <div style={rayada} />

      <div style={{ ...columna, alignItems: 'center', fontSize: 14, gap: 2 }}>
        <div style={{ display: 'flex' }}>Fecha: {fechaLarga(d.fecha)}</div>
        <div style={{ display: 'flex' }}>Folio: {d.folio}</div>
        <div style={{ display: 'flex', marginTop: 8 }}>Vendedor: {d.vendedor}</div>
        <div style={{ display: 'flex' }}>Comprador: {d.comprador}</div>
      </div>

      <div style={rayada} />

      <div style={{ ...fila, fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
        <div style={{ display: 'flex' }}>Cant</div>
        <div style={{ display: 'flex' }}>Concepto</div>
        <div style={{ display: 'flex' }}>Importe</div>
      </div>

      <div style={{ ...columna, width: '100%', gap: 10 }}>
        {d.lineas.map((l) => (
          <div key={l.id} style={{ ...columna, width: '100%', fontSize: 14 }}>
            <div style={{ display: 'flex' }}>{l.cantidad} - {l.nombre}</div>
            <div style={{ display: 'flex', color: TENUE, marginLeft: 10 }}>
              [${l.precioUnitario.toFixed(2)} c/u]
            </div>
            <div style={{ ...fila, justifyContent: 'flex-end', fontWeight: 600 }}>
              SubTotal: ${(l.precioUnitario * l.cantidad).toFixed(2)}
            </div>
          </div>
        ))}
      </div>

      <div style={rayada} />

      <div style={{ ...fila, fontSize: 20, fontWeight: 700, borderTop: `2px solid ${TINTA}`, paddingTop: 10 }}>
        <div style={{ display: 'flex' }}>{d.etiquetaTotal}</div>
        <div style={{ display: 'flex' }}>${d.total.toFixed(2)}</div>
      </div>

      {d.movimientos.length > 0 && (
        <div style={{ ...columna, width: '100%', fontSize: 13, marginTop: 14 }}>
          <div style={{ display: 'flex', fontWeight: 700 }}>ULTIMOS 5 MOVIMIENTOS</div>
          <div style={{ ...columna, width: '100%', gap: 4, marginTop: 6 }}>
            {d.movimientos.map((m) => (
              <div key={m.id} style={{ ...fila, gap: 8 }}>
                <div style={{ display: 'flex' }}>{fechaCorta(m.fecha)}</div>
                <div style={{ display: 'flex', flex: 1, justifyContent: 'center', textAlign: 'center', padding: '0 6px' }}>
                  {m.concepto.replace(/\n/g, ' · ')}
                </div>
                <div style={{ display: 'flex' }}>{montoFirmado(m.monto)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={rayada} />

      <div style={{ ...columna, alignItems: 'center', fontSize: 13, gap: 6 }}>
        {d.pie.map((renglon, i) => (
          <div key={renglon} style={{ display: 'flex', color: i === 0 ? TINTA : TENUE }}>
            {renglon}
          </div>
        ))}
      </div>
    </div>
  )
}

export async function GET(request: Request, contexto: { params: Promise<{ id: string }> }) {
  if (!tokenValido(request)) {
    return new Response('no autorizado', { status: 401 })
  }

  const { id } = await contexto.params
  const datos = await armarDocumentoDeTicket(clienteDeServicio(), id)

  if (!datos) {
    return new Response('documento no encontrado', { status: 404 })
  }

  // La altura crece con las lineas y los movimientos: un ticket de 12 productos
  // no cabe en el alto de uno de 2, y Satori recorta sin avisar.
  const alto = 420 + datos.lineas.length * 72 + datos.movimientos.length * 26 + datos.pie.length * 22

  return new ImageResponse(<Documento d={datos} />, { width: ANCHO, height: alto })
}
