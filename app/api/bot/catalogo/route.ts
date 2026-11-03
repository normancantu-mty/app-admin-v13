/**
 * EL CATALOGO QUE SE VENDE. **Este endpoint no escribe. Nunca.**
 *
 * ─── POR QUE EXISTE (D35, 2026-09-19) ───────────────────────────────────────
 *
 * El enrutador extraia el nombre del producto **a ciegas**: `_pedazo_contexto`
 * le mandaba al modelo el borrador a medias, las categorias de gasto y quienes
 * deben — **del catalogo de productos, nada** — y el empate lo hacia despues un
 * comparador literal de TypeScript. Por eso `"750 ml"` con un espacio no
 * encontraba `Destilado Plata 750ml`, y por eso `"grandes"` no encontraba nada:
 * esa palabra no existe en ninguna fila contra la que empatar.
 *
 * Al modelo, que con tres filas enfrente resuelve *"las grandes"* sin
 * despeinarse, no se le estaba preguntando. **El modelo entendia pero no
 * buscaba.** Esto le da de comer.
 *
 * ─── LO QUE ESTO NO AFLOJA ──────────────────────────────────────────────────
 *
 * La lista cerrada sigue cerrada. El modelo **ESCOGE de esta lista, no INVENTA
 * un producto**: devuelve un `id_producto` y `venta/proponer` y
 * `cotizacion/proponer` lo siguen validando contra el catalogo leido de la base
 * en ese momento (`catalogo.find((p) => p.id === idProducto)`), con su 422 si no
 * esta. Un id que el modelo se saque de la manga se rechaza igual que antes.
 *
 * ─── POR QUE NO LLEVA IDENTIDAD DE ENTIDAD ──────────────────────────────────
 *
 * Aqui no va ni un precio. El precio depende de la zona del comprador y de la
 * cascada de comisiones, y eso lo resuelve el `proponer` con la identidad ya
 * verificada. Lo que sale de aqui es el vocabulario —que existe y como se
 * llama—, no una cotizacion. El token del bot sigue siendo obligatorio.
 */

import { NextResponse } from 'next/server'
import {
  clienteDeServicio,
  leerCatalogo,
  leerCatalogoDeVenta,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json().catch(() => ({}))) as { telegram_id?: unknown }
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }

    const catalogo = await leerCatalogoDeVenta(supabase)
    // 2026-11-03 - UNA SOLA LISTA: tambien el vocabulario de categorias de gasto
    // (`categorias_movimiento`), para que el bot lo tenga ANTES de su primer
    // gasto y una subcategoria agregada en el ERP le llegue sin reiniciarlo.
    const categorias = (await leerCatalogo(supabase)).map((c) => c.nombre)
    if (catalogo.length === 0) {
      return NextResponse.json(
        { error: 'No pude leer el catalogo.' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      categorias,
      productos: catalogo.map((p) => ({
        id: p.id,
        sku: p.sku,
        nombre: p.nombre,
        ml_por_unidad: p.ml_por_unidad
      }))
    })
  } catch (e) {
    console.error('[bot] catalogo reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
