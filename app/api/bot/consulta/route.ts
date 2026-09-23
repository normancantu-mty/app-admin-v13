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
import {
  clienteDeServicio,
  leerCatalogoDeVenta,
  leerCompradoresDeVenta,
  resolverIdentidad,
  tokenValido,
  type ClienteServicio
} from '@/lib/bot-servidor'
import {
  filasDelPeriodo,
  periodoDeProduccion,
  textoProduccion,
  type FilaEnvasado
} from '@/lib/bot-envasado'
import { mensajeDeRendimiento } from '@/lib/bot-lotes'
import { fechaLocal } from '@/lib/fechas'
import { leerCartera, leerSaldosEntidad, leerStockPorCubeta, leerVentasPorMes } from '@/lib/vistas'
import { esGrupo, permisoDeConsulta, type ConsultaBot } from '@/lib/bot-permisos'
import { actorDe, redDe } from '@/lib/bot-aprobacion'
import { buscarPorNombre } from '@/lib/bot-nombres'
import { esPublicoEnGeneral } from '@/lib/bot-publico'
import { aProductoDelCatalogo, precioParaComprador, ZONA_POR_DEFECTO } from '@/lib/bot-venta'
import {
  entidadALaQueSeAcota,
  esConsultaValida,
  filtrarCartera,
  pieDeConsulta,
  textoPrecios,
  textoQuienDebe,
  textoStock,
  textoVentas,
  type AlcanceConsulta,
  type TipoConsulta
} from '@/lib/bot-consultas'

export const dynamic = 'force-dynamic'

const MESES_DE_VENTAS = 6

/** Las consultas del bot, con el nombre que tienen en la tabla de permisos. */
const CONSULTA_DE_LA_TABLA: Record<TipoConsulta, ConsultaBot> = {
  stock: 'inventario',
  cartera: 'deuda',
  ventas: 'ventas',
  produccion: 'produccion',
  precios: 'precios'
}

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
      /** FASE 9 (D96): el chat donde se pregunto; en privado es la persona. */
      chat_id?: unknown
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

    // ── FASE 9 (D96/D99): LA TABLA DE PERMISOS, EN LA RUTA ──────────────────
    // Que puede ver cada rol y que se contesta "por privado" vive en
    // `lib/bot-permisos.ts`. Un DST ve lo suyo y lo de sus locales; un LOC, lo
    // suyo; ventas y produccion, solo la matriz.
    const permiso = permisoDeConsulta(actorDe(identidad), CONSULTA_DE_LA_TABLA[cuerpo.consulta])
    if (!permiso.ok) {
      return NextResponse.json(
        { error: 'Esa consulta es de la empresa; tu alta solo alcanza a lo tuyo.' },
        { status: 403 }
      )
    }
    const red = await redDe(supabase, identidad, permiso.alcance)
    // En un grupo, lo que la tabla manda "por privado" se marca: el bot lo
    // manda al chat privado de quien pregunto y en el grupo solo lo avisa.
    const privado = permiso.privado && esGrupo(cuerpo.chat_id, telegramId)
    const filtroCrudo = String(cuerpo.filtro ?? '').trim()
    const filtro = filtroCrudo === '' ? null : filtroCrudo

    if (cuerpo.consulta === 'stock') {
      const filas = (
        await leerStockPorCubeta(supabase, permiso.alcance === 'propio' ? identidad.idEntidad : undefined)
      ).filter((f) => red === null || red.has(f.id_entidad))
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
        texto: textoStock(visibles, filtro) + pieDeConsulta('v_stock_por_cubeta'),
        privado
      })
    }

    if (cuerpo.consulta === 'cartera') {
      const todas = await leerCartera(supabase)
      // `leerCartera` no acepta filtro de entidad: se acota aqui, con el mismo
      // `acotarA` que calcula `entidadALaQueSeAcota`. Un solo lugar decide.
      const suyas = red ? todas.filter((f) => red.has(f.id_entidad)) : todas
      // D76 (Fase 8): "cuanto me debe aeropuerto" contesta SOLO Aeropuerto.
      // El filtro se aplica DESPUES del alcance: un DST no ve a otros por nombre.
      const filas = filtrarCartera(suyas, filtro)
      // D99: y el efectivo que ya cobraron y no han entregado (`v_saldo_entidad`).
      const porEntregar = new Map(
        (await leerSaldosEntidad(supabase)).map((f) => [f.id_entidad, Number(f.saldo_por_pagar_efectivo) || 0])
      )
      return NextResponse.json({
        ok: true,
        texto:
          textoQuienDebe(filas, porEntregar, filtro) +
          pieDeConsulta('v_cartera + v_saldo_entidad', filas[0]?.calculado_en ?? suyas[0]?.calculado_en ?? null),
        privado
      })
    }

    // precios (D99) — publico y, segun la tabla, el de cada entidad, con la
    // MISMA cascada que cobra la venta (`precioParaComprador` ->
    // `calculateWaterfall`, la funcion de la pantalla de catalogo).
    if (cuerpo.consulta === 'precios') {
      const entidades = (await leerCompradoresDeVenta(supabase)).filter(
        (e) => (red === null || red.has(e.id)) && (e.rol === 'DST' || e.rol === 'LOC')
      )
      let entidad = filtro ? null : identidad.rolEntidad === 'ADMIN' ? null : entidades.find((e) => e.id === identidad.idEntidad) ?? null
      if (filtro && !esPublicoEnGeneral(filtro)) {
        const hallazgo = buscarPorNombre(filtro, entidades, (e) => [e.nombre])
        if (!hallazgo.ok) {
          return NextResponse.json({
            ok: true,
            texto:
              hallazgo.motivo === 'ambiguo'
                ? `"${filtro}" me da mas de uno: ${hallazgo.candidatos.map((e) => e.nombre).join(', ')}.`
                : `No tengo a "${filtro}" entre los que puedes consultar.`,
            privado
          })
        }
        entidad = hallazgo.elegido
      }
      const zona = entidad?.zona || ZONA_POR_DEFECTO
      const catalogo = (await leerCatalogoDeVenta(supabase))
        .map((p) => aProductoDelCatalogo(p, zona))
        .filter((p) => p.precio_final > 0)
      const renglones = catalogo.map((p) => ({
        producto: p.nombre,
        publico: p.precio_final,
        entidad: entidad ? precioParaComprador(p, entidad) : null
      }))
      return NextResponse.json({
        ok: true,
        texto: textoPrecios(renglones, entidad?.nombre ?? null, entidad?.rol) + pieDeConsulta('listas_precios + cascada'),
        privado
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
        texto: texto + pieDeConsulta(periodo.tipo === 'lote' ? 'lote_envasado + v_lote_rendimiento' : 'lote_envasado'),
        privado
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
      texto: textoVentas(meses) + pieDeConsulta('v_ventas_por_mes'),
      privado
    })
  } catch (e) {
    console.error('[bot] consulta reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
