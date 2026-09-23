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
import { clienteDeServicio, resolverIdentidad, tokenValido, type ClienteServicio } from '@/lib/bot-servidor'
import {
  filasDelPeriodo,
  periodoDeProduccion,
  textoProduccion,
  type FilaEnvasado
} from '@/lib/bot-envasado'
import { mensajeDeRendimiento } from '@/lib/bot-lotes'
import { fechaLocal } from '@/lib/fechas'
import { leerCartera, leerStockPorCubeta, leerVentasPorMes } from '@/lib/vistas'
import {
  entidadALaQueSeAcota,
  esConsultaValida,
  filtrarCartera,
  pieDeConsulta,
  textoCartera,
  textoStock,
  textoVentas,
  type AlcanceConsulta
} from '@/lib/bot-consultas'

export const dynamic = 'force-dynamic'

const MESES_DE_VENTAS = 6

/**
 * Fase 8, D83: todo `lote_envasado` con su lote y su producto. Son las filas de
 * produccion de la empresa (hoy 0, un envasado por dia y formato cuando haya):
 * se filtran por periodo en `filasDelPeriodo`, que es pura y tiene su prueba.
 */
async function leerEnvasado(supabase: ClienteServicio): Promise<FilaEnvasado[]> {
  const [{ data: envasado }, { data: lotes }, { data: productos }] = await Promise.all([
    supabase.from('lote_envasado').select('fecha, botellas, id_lote, id_producto'),
    supabase.from('lotes').select('id, codigo_lote'),
    supabase.from('catalogo_productos').select('id, nombre').eq('tipo', 'TERMINADO')
  ])
  const codigo = new Map((lotes ?? []).map((l) => [l.id, l.codigo_lote]))
  const nombre = new Map((productos ?? []).map((p) => [p.id, p.nombre]))
  return (envasado ?? []).map((e) => ({
    fecha: String(e.fecha),
    codigo_lote: String(codigo.get(e.id_lote) ?? '?'),
    producto: String(nombre.get(e.id_producto) ?? '?'),
    botellas: Number(e.botellas)
  }))
}

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
      const suyas = acotarA ? todas.filter((f) => f.id_entidad === acotarA) : todas
      // D76 (Fase 8): "cuanto me debe aeropuerto" contesta SOLO Aeropuerto.
      // El filtro se aplica DESPUES del alcance: un DST no ve a otros por nombre.
      const filas = filtrarCartera(suyas, filtro)
      return NextResponse.json({
        ok: true,
        texto:
          textoCartera(filas, filtro) +
          pieDeConsulta('v_cartera', filas[0]?.calculado_en ?? suyas[0]?.calculado_en ?? null)
      })
    }

    // produccion (D83) — cifra de la empresa, como ventas: solo la matriz.
    if (cuerpo.consulta === 'produccion') {
      if (acotarA) {
        return NextResponse.json(
          { error: 'Esa consulta es de la empresa; tu alta solo alcanza a lo tuyo.' },
          { status: 403 }
        )
      }
      // "Hoy" es hoy en Zacatecas (D69), no en UTC.
      const periodo = periodoDeProduccion(filtro, fechaLocal(new Date()))
      const filas = filasDelPeriodo(await leerEnvasado(supabase), periodo)
      let texto = textoProduccion(filas, periodo)
      if (periodo.tipo === 'lote') {
        const { data: lote } = await supabase
          .from('v_lote_rendimiento')
          .select(
            'codigo_lote, alcohol_absoluto_l, litros_al_grado_objetivo, botellas_750_teoricas, grado_ponderado, alcanza_el_grado_diluyendo, costo_por_ml, tandas_sin_grado, insumos_sin_costo, faltan_costo'
          )
          .ilike('codigo_lote', periodo.codigo.replace(/[%_\\]/g, (c) => '\\' + c))
          .maybeSingle()
        if (!lote) {
          texto = `No tengo el lote ${periodo.codigo}.`
        } else {
          const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
          const rendimiento = mensajeDeRendimiento({
            alcohol_absoluto_l: n(lote.alcohol_absoluto_l),
            litros_al_grado_objetivo: n(lote.litros_al_grado_objetivo),
            botellas_750_teoricas: n(lote.botellas_750_teoricas),
            grado_ponderado: n(lote.grado_ponderado),
            alcanza_el_grado_diluyendo: lote.alcanza_el_grado_diluyendo,
            costo_por_ml: n(lote.costo_por_ml),
            tandas_sin_grado: n(lote.tandas_sin_grado),
            insumos_sin_costo: n(lote.insumos_sin_costo),
            faltan_costo: lote.faltan_costo ?? null
          })
          if (rendimiento) texto = texto + '\n\n' + rendimiento
        }
      }
      return NextResponse.json({
        ok: true,
        texto: texto + pieDeConsulta(periodo.tipo === 'lote' ? 'lote_envasado + v_lote_rendimiento' : 'lote_envasado')
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
