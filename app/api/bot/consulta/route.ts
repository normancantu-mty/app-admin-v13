/**
 * AG-04 Fase 3 — CONSULTAS. **Este endpoint no escribe. Nunca.**
 *
 * Lee de las vistas canonicas **a traves de `lib/vistas.ts`** —que es donde ya
 * viven los lectores tipados y donde las pruebas de equivalencia los comparan
 * fila por fila contra el TypeScript de la app— y devuelve TEXTO YA FORMATEADO.
 * El proceso del bot solo lo reenvia; el modelo no vuelve a tocarlo.
 *
 * Asi, un numero que sale de aqui es el numero de la vista, o no es nada.
 *
 * El alcance se aplica en el servidor con el rol que viene de `bot_identidades`
 * (`ADMIN` ve todo, cualquier otro ve solo lo suyo). **No se le cree al
 * cliente:** el bot no manda `id_entidad`, y si lo mandara se ignora.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { leerCartera, leerStockPorCubeta, leerVentasPorMes } from '@/lib/vistas'
import {
  entidadALaQueSeAcota,
  esConsultaValida,
  pieDeConsulta,
  textoCartera,
  textoStock,
  textoVentas,
  type AlcanceConsulta
} from '@/lib/bot-consultas'

export const dynamic = 'force-dynamic'

const MESES_DE_VENTAS = 6

/** El filtro de `stock` empata contra el producto O contra el punto de venta. */
function coincide(fila: { producto: string; entidad: string }, filtro: string): boolean {
  const q = filtro.toLowerCase()
  return (
    (fila.producto ?? '').toLowerCase().includes(q) ||
    (fila.entidad ?? '').toLowerCase().includes(q)
  )
}

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      consulta?: unknown
      filtro?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }
    if (!esConsultaValida(cuerpo.consulta)) {
      return NextResponse.json({ error: 'Esa consulta no existe.' }, { status: 422 })
    }

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json(
        { error: 'No te tengo dado de alta. Pideselo a Norman.' },
        { status: 403 }
      )
    }

    const alcance: AlcanceConsulta = {
      idEntidad: identidad.idEntidad,
      rol: identidad.rolEntidad,
      nombreEntidad: identidad.nombreEntidad
    }
    const acotarA = entidadALaQueSeAcota(alcance)
    const filtroCrudo = String(cuerpo.filtro ?? '').trim()
    const filtro = filtroCrudo === '' ? null : filtroCrudo

    if (cuerpo.consulta === 'stock') {
      const filas = await leerStockPorCubeta(supabase, acotarA ?? undefined)
      // El filtro se aplica AQUI y no en la base: el lector de la vista es el
      // que las pruebas de equivalencia validan, y meterle un `ilike` por fuera
      // lo sacaria de ese camino probado. Son decenas de filas.
      //
      // **Y se prueba contra el producto Y contra el punto de venta**, no solo
      // contra el producto. Medido el 2026-09-12: a "cuantas botellas tiene
      // Delirio 85" el clasificador devuelve filtro "Delirio 85", que es una
      // ENTIDAD. Exigirle al modelo que distinga un producto de un punto de
      // venta es pedirle un dato que no tiene; el servidor si lo tiene.
      const visibles = filtro ? filas.filter((f) => coincide(f, filtro)) : filas
      return NextResponse.json({
        ok: true,
        texto: textoStock(visibles, filtro) + pieDeConsulta('v_stock_por_cubeta')
      })
    }

    if (cuerpo.consulta === 'cartera') {
      const todas = await leerCartera(supabase)
      // `leerCartera` no acepta filtro de entidad: se acota aqui, con el mismo
      // `acotarA` que calcula `entidadALaQueSeAcota`. Un solo lugar decide.
      const filas = acotarA ? todas.filter((f) => f.id_entidad === acotarA) : todas
      return NextResponse.json({
        ok: true,
        texto: textoCartera(filas) + pieDeConsulta('v_cartera', filas[0]?.calculado_en ?? null)
      })
    }

    // ventas — la unica que NO se acota, porque es la cifra de la empresa. Hoy
    // solo un ADMIN la puede pedir. **Si algun dia se da de alta a un
    // distribuidor, esto tiene que decidirse ANTES**, no despues.
    if (acotarA) {
      return NextResponse.json(
        { error: 'Esa consulta es de la empresa; tu alta solo alcanza a lo tuyo.' },
        { status: 403 }
      )
    }
    const meses = (await leerVentasPorMes(supabase)).slice(0, MESES_DE_VENTAS)
    return NextResponse.json({
      ok: true,
      texto: textoVentas(meses) + pieDeConsulta('v_ventas_por_mes')
    })
  } catch (e) {
    console.error('[bot] consulta reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
