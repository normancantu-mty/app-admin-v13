/**
 * Suscripciones — la puerta del bot. Escrito el 2026-11-09 por el Socio
 * (ejecutor).
 *
 * Norman, por voz: "que me pregunte cada mes si ya se aprobaron, si ya se
 * hicieron". Una ruta, varias acciones (patron de `/api/bot/lote/ciclo`):
 *
 *   · `leer`          — (latido, solo token) las preguntas que tocan HOY. Solo lectura.
 *   · `reclamar`      — (latido) la pregunta del mes se RECLAMA antes de mandarla:
 *                       'nueva' = INSERT de la fila del mes (la PK gana UNA vez);
 *                       'reintento' = compare-and-swap POSPUESTA -> PREGUNTADA.
 *                       Un reinicio del bot no repite: el estado vive en la base.
 *                       'reenvio' = una PREGUNTADA sin `id_mensaje` de hace 6+ h
 *                       (el bot murio entre el reclamo y el envio) sale UNA vez mas.
 *   · `entregado`     — (latido) la pregunta SI salio: guarda su message_id.
 *   · `soltar`        — (latido) el envio a Telegram fallo: la fila queda
 *                       POSPUESTA (motivo ENVIO_FALLIDO) con `volver_a_preguntar
 *                       = now()` y el siguiente latido la reintenta.
 *   · `listar`        — /suscripciones: lista, estado del mes, meses anteriores sin
 *                       pagar, total. Permiso de `gastos` con alcance 'todo' (la
 *                       matriz); en grupo va por privado.
 *   · `proponer_pago` — (Norman) la tarjeta "registro $X de la cuenta Y". No escribe.
 *                       Antes busca si ya hay un egreso ACTIVO de Suscripciones /
 *                       <subcategoria> de ese mes que la mencione (`candidatos`).
 *   · `pagar`         — (Norman) "Ya se pago": UN egreso en finanzas_ledger
 *                       (Suscripciones / <subcategoria>) y el mes PAGADA. Con
 *                       candidatos y sin `forzar_nuevo`: 409, no escribe.
 *   · `ligar`         — (Norman) "Es este": el mes PAGADA con ESE egreso; no
 *                       escribe otro.
 *   · `posponer`      — (Norman) "Todavia no": vuelve a preguntar en 3 dias.
 *   · `baja`          — (Norman) "Ya no la tengo": la suscripcion queda inactiva.
 *
 * Lo que escribe lo escribe SOLO Norman (`esNorman`: ADMIN sin marca y con su
 * telegram_id). Las preguntas salen solo a su chat privado (`para`).
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { clienteDeServicio, leerCatalogo, resolverIdentidad, tokenValido, type ClienteServicio, type IdentidadBot } from '@/lib/bot-servidor'
import { actorDe } from '@/lib/bot-aprobacion'
import { esGrupo, esNorman, NORMAN_TELEGRAM_ID, permisoDeConsulta } from '@/lib/bot-permisos'
import { filaEnCatalogo } from '@/lib/bot-gastos'
import { hoyEnMX } from '@/lib/date-format'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import {
  CATEGORIA_SUSCRIPCIONES,
  debePreguntar,
  esMes,
  filaDeEgreso,
  horaEnMX,
  limiteDeReenvio,
  mesActual,
  mesDe,
  montoConMoneda,
  motivoDePregunta,
  nombreDeMes,
  patronDeNombre,
  pesos,
  rangoDelMes,
  textoDeLista,
  textoDePregunta,
  volverAPreguntarEn,
  yaPagada,
  type MesDeSuscripcion,
  type Suscripcion
} from '@/lib/suscripciones'
import { aFila, COLUMNAS_FILA, esTablaFaltante, leerSuscripciones } from '@/lib/suscripciones-leer'

export const dynamic = 'force-dynamic'

const MENSAJE_SOLO_NORMAN = 'Las suscripciones las marca Norman.'
const MENSAJE_SIN_TABLAS = 'Las suscripciones aun no estan instaladas en la base (falta aplicar la migracion).'

type Cuerpo = Record<string, unknown>
const json = (cuerpo: unknown, status = 200) => NextResponse.json(cuerpo, { status })

export async function POST(request: Request) {
  if (!tokenValido(request)) return json({ error: 'No autorizado.' }, 401)
  try {
    const cuerpo = (await request.json()) as Cuerpo
    const tipada = clienteDeServicio(request)
    // Las tablas de suscripciones aun no estan en `types/database`: sin tipar, solo aqui.
    const supabase = tipada as unknown as SupabaseClient
    const accion = String(cuerpo.accion ?? '')
    const ahora = new Date()

    // ── LATIDO (solo token) ────────────────────────────────────────────────
    if (accion === 'leer') return await leer(supabase, ahora)
    if (accion === 'reclamar') return await reclamar(supabase, cuerpo, ahora)
    if (accion === 'soltar') return await soltar(supabase, cuerpo, ahora)
    if (accion === 'entregado') return await entregado(supabase, cuerpo)

    // ── LO DE UNA PERSONA ───────────────────────────────────────────────────
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) return json({ error: 'telegram_id invalido.' }, 400)
    const identidad = await resolverIdentidad(tipada, telegramId)
    if (!identidad) return json({ error: 'No te tengo dado de alta. Pideselo a Norman.' }, 403)

    if (accion === 'listar') {
      const permiso = permisoDeConsulta(actorDe(identidad), 'gastos')
      if (!permiso.ok || permiso.alcance !== 'todo') {
        return json({ error: 'Esa consulta es de la empresa; tu alta solo alcanza a lo tuyo.' }, 403)
      }
      return await listar(supabase, identidad, permiso.privado && esGrupo(cuerpo.chat_id, telegramId), ahora)
    }

    if (!esNorman(actorDe(identidad))) return json({ error: MENSAJE_SOLO_NORMAN }, 403)

    const idSus = Number(cuerpo.id_suscripcion)
    const mes = String(cuerpo.mes ?? '')
    if (!Number.isSafeInteger(idSus) || idSus <= 0) return json({ error: 'id_suscripcion invalido.' }, 400)
    if (!esMes(mes)) return json({ error: 'Mes invalido.' }, 400)
    if (mes > mesActual(ahora)) return json({ error: 'Ese mes todavia no llega.' }, 400)

    const rSus = await supabase
      .from('suscripciones')
      .select('id, nombre, monto, moneda, dia_cobro, id_cuenta, subcategoria, activa')
      .eq('id', idSus)
      .maybeSingle()
    if (rSus.error) {
      if (esTablaFaltante(rSus.error)) return json({ error: MENSAJE_SIN_TABLAS }, 409)
      throw rSus.error
    }
    if (!rSus.data) return json({ error: 'Esa suscripcion no existe.' }, 404)
    const s = rSus.data as unknown as Suscripcion
    s.monto = Number(s.monto)

    if (accion === 'proponer_pago') return await proponerPago(supabase, identidad, s, mes, cuerpo)
    if (accion === 'pagar') return await pagar(supabase, identidad, s, mes, cuerpo, ahora)
    if (accion === 'ligar') return await ligar(supabase, identidad, s, mes, cuerpo, ahora)
    if (accion === 'posponer') return await posponer(supabase, identidad, s, mes, ahora)
    if (accion === 'baja') return await baja(supabase, identidad, s, mes, ahora)
    return json({ error: 'Accion desconocida.' }, 400)
  } catch (e) {
    console.error('[bot/suscripciones] reviento:', e)
    return json({ error: 'Error interno.' }, 500)
  }
}

// ─── LATIDO ─────────────────────────────────────────────────────────────────

async function leer(supabase: SupabaseClient, ahora: Date) {
  const hoy = hoyEnMX(ahora)
  const mes = mesDe(hoy)
  const lectura = await leerSuscripciones(supabase, mes, hoy)
  if (!lectura.ok) {
    // Sin migracion el latido no debe gritar cada 15 minutos: lista vacia.
    if (lectura.faltanTablas) return json({ ok: true, preguntas: [], sin_tablas: true, para: NORMAN_TELEGRAM_ID })
    console.error('[bot/suscripciones] leer:', lectura.error)
    return json({ error: 'No pude leer las suscripciones.' }, 500)
  }
  const hora = horaEnMX(ahora)
  const { subs, filas, filasAnteriores } = lectura.datos
  const preguntas: { id_suscripcion: number; mes: string; tipo: string; nombre: string; texto: string }[] = []
  const pedir = (s: Suscripcion, fila: MesDeSuscripcion | null, mesFila: string) => {
    const d = debePreguntar(s, fila, hoy, hora, ahora)
    if (!d.preguntar) return
    preguntas.push({
      id_suscripcion: s.id,
      mes: mesFila,
      tipo: d.tipo,
      nombre: s.nombre,
      texto: textoDePregunta(s, mesFila, motivoDePregunta(d.tipo, fila))
    })
  }
  for (const s of subs) pedir(s, filas.get(s.id) ?? null, mes)
  // Ronda 2: un "Todavia no" (o un envio fallido) de un mes ANTERIOR no se
  // pierde al cruzar de mes: se reintenta con SU mes.
  const porId = new Map(subs.map((s) => [s.id, s]))
  for (const f of filasAnteriores) {
    const s = porId.get(f.id_suscripcion)
    if (s) pedir(s, f, f.mes)
  }
  return json({ ok: true, preguntas, para: NORMAN_TELEGRAM_ID })
}

async function reclamar(supabase: SupabaseClient, cuerpo: Cuerpo, ahora: Date) {
  const idSus = Number(cuerpo.id_suscripcion)
  const mes = String(cuerpo.mes ?? '')
  const tipo = String(cuerpo.tipo ?? '')
  if (!Number.isSafeInteger(idSus) || !esMes(mes)) return json({ error: 'Datos invalidos.' }, 400)
  if (tipo === 'nueva') {
    const { error } = await supabase
      .from('suscripcion_meses')
      .insert({ id_suscripcion: idSus, mes, estado: 'PREGUNTADA', preguntada_en: ahora.toISOString(), id_mensaje: null, reenvios: 0 })
    if (!error) return json({ ok: true, reclamado: true })
    if (error.code === '23505') return json({ ok: true, reclamado: false })
    console.error('[bot/suscripciones] reclamar:', error)
    return json({ error: 'No pude reclamar.' }, 500)
  }
  if (tipo === 'reintento') {
    const { data, error } = await supabase
      .from('suscripcion_meses')
      .update({
        estado: 'PREGUNTADA',
        preguntada_en: ahora.toISOString(),
        volver_a_preguntar: null,
        motivo_pospuesta: null,
        id_mensaje: null,
        reenvios: 0
      })
      .eq('id_suscripcion', idSus)
      .eq('mes', mes)
      .eq('estado', 'POSPUESTA')
      .lte('volver_a_preguntar', ahora.toISOString())
      .select('id_suscripcion')
    if (error) {
      console.error('[bot/suscripciones] reclamar reintento:', error)
      return json({ error: 'No pude reclamar.' }, 500)
    }
    return json({ ok: true, reclamado: (data ?? []).length === 1 })
  }
  if (tipo === 'reenvio') {
    // UNA vez: el CAS exige reenvios = 0 y lo deja en 1.
    const { data, error } = await supabase
      .from('suscripcion_meses')
      .update({ preguntada_en: ahora.toISOString(), reenvios: 1 })
      .eq('id_suscripcion', idSus)
      .eq('mes', mes)
      .eq('estado', 'PREGUNTADA')
      .is('id_mensaje', null)
      .eq('reenvios', 0)
      .lte('preguntada_en', limiteDeReenvio(ahora))
      .select('id_suscripcion')
    if (error) {
      console.error('[bot/suscripciones] reclamar reenvio:', error)
      return json({ error: 'No pude reclamar.' }, 500)
    }
    return json({ ok: true, reclamado: (data ?? []).length === 1 })
  }
  return json({ error: 'tipo invalido.' }, 400)
}

async function soltar(supabase: SupabaseClient, cuerpo: Cuerpo, ahora: Date) {
  const idSus = Number(cuerpo.id_suscripcion)
  const mes = String(cuerpo.mes ?? '')
  if (!Number.isSafeInteger(idSus) || !esMes(mes)) return json({ error: 'Datos invalidos.' }, 400)
  const { error } = await supabase
    .from('suscripcion_meses')
    .update({ estado: 'POSPUESTA', volver_a_preguntar: ahora.toISOString(), motivo_pospuesta: 'ENVIO_FALLIDO' })
    .eq('id_suscripcion', idSus)
    .eq('mes', mes)
    .eq('estado', 'PREGUNTADA')
  if (error) {
    console.error('[bot/suscripciones] soltar:', error)
    return json({ error: 'No pude soltar.' }, 500)
  }
  return json({ ok: true })
}

async function entregado(supabase: SupabaseClient, cuerpo: Cuerpo) {
  const idSus = Number(cuerpo.id_suscripcion)
  const mes = String(cuerpo.mes ?? '')
  const idMensaje = Number(cuerpo.id_mensaje)
  if (!Number.isSafeInteger(idSus) || !esMes(mes) || !Number.isSafeInteger(idMensaje)) return json({ error: 'Datos invalidos.' }, 400)
  const { error } = await supabase.from('suscripcion_meses').update({ id_mensaje: idMensaje }).eq('id_suscripcion', idSus).eq('mes', mes)
  if (error) {
    console.error('[bot/suscripciones] entregado:', error)
    return json({ error: 'No pude marcarla entregada.' }, 500)
  }
  return json({ ok: true })
}

// ─── /suscripciones ─────────────────────────────────────────────────────────

async function listar(supabase: SupabaseClient, identidad: IdentidadBot, privado: boolean, ahora: Date) {
  const hoy = hoyEnMX(ahora)
  const mes = mesDe(hoy)
  const lectura = await leerSuscripciones(supabase, mes, hoy)
  if (!lectura.ok) {
    if (lectura.faltanTablas) return json({ ok: true, texto: MENSAJE_SIN_TABLAS, pendientes: [], privado })
    console.error('[bot/suscripciones] listar:', lectura.error)
    return json({ error: 'No pude leer las suscripciones.' }, 500)
  }
  const { renglones, total, anteriores } = lectura.datos
  // Los botones "ya se pago" solo a Norman: es el unico que escribe aqui.
  const pendientes = esNorman(actorDe(identidad))
    ? [
        ...anteriores.map((a) => ({ id: a.s.id, nombre: `${a.s.nombre} (${nombreDeMes(a.fila.mes)})`, mes: a.fila.mes })),
        ...renglones.filter((r) => r.estado === 'pendiente').map((r) => ({ id: r.s.id, nombre: r.s.nombre, mes }))
      ]
    : []
  return json({ ok: true, texto: textoDeLista(renglones, mes, total, anteriores), pendientes, privado })
}

// ─── LO QUE ESCRIBE NORMAN ──────────────────────────────────────────────────

async function leerFila(supabase: SupabaseClient, idSus: number, mes: string): Promise<MesDeSuscripcion | null> {
  const { data, error } = await supabase
    .from('suscripcion_meses')
    .select(COLUMNAS_FILA)
    .eq('id_suscripcion', idSus)
    .eq('mes', mes)
    .maybeSingle()
  if (error) throw error
  return data ? aFila(data as Record<string, unknown>) : null
}

async function egresoActivo(supabase: SupabaseClient, id: string | null): Promise<boolean> {
  if (!id) return false
  const { data, error } = await supabase.from('finanzas_ledger').select('status').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as { status?: string } | null)?.status === 'ACTIVO'
}

/** La cuenta del egreso: la del catalogo si el bot la puede usar, si no la del alta de Norman. */
function cuentaDelEgreso(s: Suscripcion, identidad: IdentidadBot): { id: string; nombre: string; cambiada: boolean } {
  if (s.id_cuenta) {
    if (s.id_cuenta === identidad.idCuenta) return { id: identidad.idCuenta, nombre: identidad.nombreCuenta, cambiada: false }
    const otra = identidad.cuentas.find((c) => c.id === s.id_cuenta)
    if (otra) return { id: otra.id, nombre: otra.nombre, cambiada: false }
    return { id: identidad.idCuenta, nombre: identidad.nombreCuenta, cambiada: true }
  }
  return { id: identidad.idCuenta, nombre: identidad.nombreCuenta, cambiada: false }
}

/** El monto en pesos: el que dijo Norman, o el del catalogo si esta en MXN. USD sin pesos = null. */
function montoEnPesos(s: Suscripcion, cuerpo: Cuerpo): number | null {
  if (cuerpo.monto !== undefined && cuerpo.monto !== null && String(cuerpo.monto).trim() !== '') {
    const n = Number(cuerpo.monto)
    return Number.isFinite(n) ? n : NaN
  }
  return s.moneda === 'MXN' ? Number(s.monto) : null
}

interface CandidatoDeEgreso {
  id: string
  monto: number
  monto_texto: string
  fecha: string
  descripcion: string
}

/**
 * Ronda 2 — el doble registro entre canales. ¿Ya hay en el ledger un egreso
 * ACTIVO de Suscripciones / <subcategoria>, con fecha de ESE mes (hora de
 * Mexico), cuya descripcion menciona la suscripcion, y que no este ligado ya a
 * ningun mes? Si lo hay, Norman decide: es ese (ligar) o es otro (registrar).
 * A lo mas 3. Solo lectura.
 */
async function candidatosDeEgreso(supabase: SupabaseClient, s: Suscripcion, mes: string): Promise<CandidatoDeEgreso[]> {
  const { desde, hasta } = rangoDelMes(mes)
  // ERP-25: lectura multi-fila de un ledger, paginada.
  const filas = await fetchTodasLasFilas<{ id: string; monto: number; fecha_movimiento: string; descripcion: string | null }>(
    () =>
      supabase
        .from('finanzas_ledger')
        .select('id, monto, fecha_movimiento, descripcion')
        .eq('status', 'ACTIVO')
        .eq('categoria', CATEGORIA_SUSCRIPCIONES)
        .eq('subcategoria', s.subcategoria)
        .gte('fecha_movimiento', desde)
        .lt('fecha_movimiento', hasta)
        .ilike('descripcion', patronDeNombre(s.nombre))
        .order('fecha_movimiento'),
    'suscripciones: egreso ya capturado'
  )
  if (filas.length === 0) return []
  // Uno ya ligado a un mes (de esta o de otra suscripcion) no es candidato:
  // p. ej. octubre pagado el 2 de noviembre trae fecha de noviembre.
  const { data: ligadas, error } = await supabase
    .from('suscripcion_meses')
    .select('id_movimiento')
    .in(
      'id_movimiento',
      filas.map((f) => f.id)
    )
  if (error) throw error
  const yaLigados = new Set(((ligadas ?? []) as { id_movimiento: string | null }[]).map((l) => String(l.id_movimiento)))
  return filas
    .filter((f) => !yaLigados.has(f.id))
    .slice(0, 3)
    .map((f) => ({
      id: f.id,
      monto: Number(f.monto),
      monto_texto: pesos(Number(f.monto)),
      fecha: hoyEnMX(new Date(f.fecha_movimiento)),
      descripcion: String(f.descripcion ?? '').slice(0, 80)
    }))
}

/**
 * EL RECLAMO del mes como PAGADA: gana UNO aunque dos toques lleguen a la vez.
 * Sin fila: INSERT (la PK decide). Con fila: compare-and-swap sobre lo que se
 * leyo. Un egreso ya ligado a otro mes choca con el indice unico de
 * `id_movimiento` (23505) y tambien pierde.
 */
async function reclamarPagada(
  supabase: SupabaseClient,
  idSus: number,
  mes: string,
  previa: MesDeSuscripcion | null,
  sello: Record<string, unknown>
): Promise<boolean> {
  if (!previa) {
    const { error } = await supabase.from('suscripcion_meses').insert({ id_suscripcion: idSus, mes, ...sello })
    if (error) {
      if (error.code === '23505') return false
      throw error
    }
    return true
  }
  let cas = supabase.from('suscripcion_meses').update(sello).eq('id_suscripcion', idSus).eq('mes', mes).eq('estado', previa.estado)
  cas = previa.id_movimiento ? cas.eq('id_movimiento', previa.id_movimiento) : cas.is('id_movimiento', null)
  const { data, error } = await cas.select('id_suscripcion')
  if (error) {
    if (error.code === '23505') return false
    throw error
  }
  return (data ?? []).length === 1
}

async function proponerPago(supabase: SupabaseClient, identidad: IdentidadBot, s: Suscripcion, mes: string, cuerpo: Cuerpo) {
  const fila = await leerFila(supabase, s.id, mes)
  if (yaPagada(fila, await egresoActivo(supabase, fila?.id_movimiento ?? null))) {
    return json({ ok: true, ya_pagada: true, nombre: s.nombre, mes })
  }
  const candidatos = cuerpo.ignorar_candidatos === true ? [] : await candidatosDeEgreso(supabase, s, mes)
  const monto = montoEnPesos(s, cuerpo)
  const cuenta = cuentaDelEgreso(s, identidad)
  return json({
    ok: true,
    ya_pagada: false,
    nombre: s.nombre,
    mes,
    candidatos,
    monto_catalogo: montoConMoneda(s),
    monto: monto === null || Number.isNaN(monto) ? null : Math.round(monto * 100) / 100,
    monto_texto: monto === null || Number.isNaN(monto) ? null : pesos(monto),
    pide_pesos: monto === null,
    cuenta: cuenta.nombre,
    aviso_cuenta: cuenta.cambiada ? 'La cuenta del catalogo no la puede usar el bot; sale de tu cuenta del bot.' : null
  })
}

async function pagar(supabase: SupabaseClient, identidad: IdentidadBot, s: Suscripcion, mes: string, cuerpo: Cuerpo, ahora: Date) {
  const monto = montoEnPesos(s, cuerpo)
  if (monto === null) return json({ error: 'Esta suscripcion esta en USD: dime cuantos PESOS se cobraron.', pide_pesos: true }, 400)
  const cuenta = cuentaDelEgreso(s, identidad)
  const armada = filaDeEgreso(s, { mes, montoMxn: monto, idCuenta: cuenta.id, etiqueta: identidad.etiqueta, ahora })
  if (!armada.ok) return json({ error: armada.error }, 400)

  // La categoria tiene que estar viva en el catalogo (si no, la migracion no se aplico).
  const catalogo = await leerCatalogo(supabase as unknown as ClienteServicio)
  if (!filaEnCatalogo(armada.fila, catalogo)) {
    return json({ error: `La categoria ${CATEGORIA_SUSCRIPCIONES} / ${s.subcategoria} no esta activa en el catalogo.` }, 409)
  }

  const previa = await leerFila(supabase, s.id, mes)
  if (yaPagada(previa, await egresoActivo(supabase, previa?.id_movimiento ?? null))) {
    return json({ error: `La de ${mes} ya esta registrada como pagada.`, ya_pagada: true }, 409)
  }

  // Ronda 2: si ya hay un egreso capturado por otro canal (la web, un gasto del
  // bot), no se escribe otro sin que Norman diga "es otro" (`forzar_nuevo`).
  if (cuerpo.forzar_nuevo !== true) {
    const candidatos = await candidatosDeEgreso(supabase, s, mes)
    if (candidatos.length > 0) {
      return json(
        { error: `Ya hay un egreso de ${CATEGORIA_SUSCRIPCIONES} que menciona ${s.nombre} en ${mes}.`, duplicado_posible: true, nombre: s.nombre, candidatos },
        409
      )
    }
  }

  // 1. EL RECLAMO del mes: gana UNO, aunque dos toques lleguen a la vez.
  const sello = { estado: 'PAGADA', id_movimiento: null, monto_pagado: armada.fila.monto, resuelta_por: `telegram:${identidad.etiqueta}`, resuelta_en: ahora.toISOString() }
  if (!(await reclamarPagada(supabase, s.id, mes, previa, sello))) {
    return json({ error: 'Alguien la esta marcando al mismo tiempo; revisa /suscripciones.' }, 409)
  }

  // 2. EL EGRESO. Si falla, el reclamo se deshace: no queda nada a medias.
  const { data: creada, error: errorLedger } = await supabase.from('finanzas_ledger').insert(armada.fila).select('id').single()
  if (errorLedger || !creada) {
    console.error('[bot/suscripciones] no se pudo escribir el egreso:', errorLedger)
    if (!previa) {
      await supabase.from('suscripcion_meses').delete().eq('id_suscripcion', s.id).eq('mes', mes).eq('estado', 'PAGADA').is('id_movimiento', null)
    } else {
      await supabase
        .from('suscripcion_meses')
        .update({ estado: previa.estado, id_movimiento: previa.id_movimiento, monto_pagado: previa.monto_pagado, resuelta_por: null, resuelta_en: null })
        .eq('id_suscripcion', s.id)
        .eq('mes', mes)
        .eq('estado', 'PAGADA')
        .is('id_movimiento', null)
    }
    return json({ error: 'No pude registrar el egreso. No quedo nada a medias.' }, 500)
  }

  // 3. La fila del mes apunta al egreso. Si esto falla, el mes queda PAGADA sin
  //    id: cuenta como pagada (no se duplica) y se avisa.
  const idMov = (creada as { id: string }).id
  const { error: errorMarca } = await supabase
    .from('suscripcion_meses')
    .update({ id_movimiento: idMov })
    .eq('id_suscripcion', s.id)
    .eq('mes', mes)
  if (errorMarca) console.error('[bot/suscripciones] no pude ligar el egreso al mes:', errorMarca)

  return json({
    ok: true,
    id_movimiento: idMov,
    texto:
      `Registrado: ${s.nombre} (${mes}) — ${pesos(armada.fila.monto)} de ${cuenta.nombre}, ` +
      `${CATEGORIA_SUSCRIPCIONES} / ${s.subcategoria}.` +
      (cuenta.cambiada ? '\nLa cuenta del catalogo no la puede usar el bot: salio de tu cuenta del bot.' : '') +
      (errorMarca ? '\nOjo: el egreso entro pero no pude ligarlo al mes; el mes queda como pagado.' : '')
  })
}

/**
 * Ronda 2 — "Es este: ligarlo". El mes queda PAGADA con ESE egreso y su monto;
 * no se escribe nada en el ledger. Solo se liga un egreso que hoy sigue siendo
 * candidato (ACTIVO, Suscripciones / <subcategoria>, de ese mes, que la
 * menciona, sin ligar): un id cualquiera no.
 */
async function ligar(supabase: SupabaseClient, identidad: IdentidadBot, s: Suscripcion, mes: string, cuerpo: Cuerpo, ahora: Date) {
  const idMov = String(cuerpo.id_movimiento ?? '').trim()
  if (!idMov) return json({ error: 'Falta el egreso.' }, 400)
  const previa = await leerFila(supabase, s.id, mes)
  if (yaPagada(previa, await egresoActivo(supabase, previa?.id_movimiento ?? null))) {
    return json({ error: `La de ${mes} ya esta registrada como pagada.`, ya_pagada: true }, 409)
  }
  const candidato = (await candidatosDeEgreso(supabase, s, mes)).find((c) => c.id === idMov)
  if (!candidato) {
    return json({ error: 'Ese egreso ya no se puede ligar (se anulo, cambio, o ya esta ligado a otro mes). Revisa /suscripciones.' }, 409)
  }
  const sello = {
    estado: 'PAGADA',
    id_movimiento: candidato.id,
    monto_pagado: candidato.monto,
    resuelta_por: `telegram:${identidad.etiqueta}`,
    resuelta_en: ahora.toISOString()
  }
  if (!(await reclamarPagada(supabase, s.id, mes, previa, sello))) {
    return json({ error: 'Alguien la esta marcando al mismo tiempo; revisa /suscripciones.' }, 409)
  }
  return json({
    ok: true,
    id_movimiento: candidato.id,
    texto: `Listo: ${s.nombre} (${mes}) queda pagada con el egreso que ya estaba (${candidato.monto_texto} del ${candidato.fecha}). No escribi otro.`
  })
}

async function posponer(supabase: SupabaseClient, identidad: IdentidadBot, s: Suscripcion, mes: string, ahora: Date) {
  const volver = volverAPreguntarEn(ahora)
  const valores = {
    estado: 'POSPUESTA',
    volver_a_preguntar: volver,
    motivo_pospuesta: 'TODAVIA_NO',
    resuelta_por: `telegram:${identidad.etiqueta}`,
    resuelta_en: ahora.toISOString()
  }
  const { error } = await supabase.from('suscripcion_meses').insert({ id_suscripcion: s.id, mes, ...valores })
  if (error && error.code !== '23505') throw error
  if (error) {
    const { data, error: e2 } = await supabase
      .from('suscripcion_meses')
      .update(valores)
      .eq('id_suscripcion', s.id)
      .eq('mes', mes)
      .in('estado', ['PREGUNTADA', 'POSPUESTA'])
      .select('id_suscripcion')
    if (e2) throw e2
    if ((data ?? []).length !== 1) return json({ ok: false, error: `La de ${mes} ya estaba resuelta (pagada o dada de baja).` }, 409)
  }
  return json({ ok: true, volver_a_preguntar: volver, texto: `Va. Te vuelvo a preguntar por ${s.nombre} en 3 dias.` })
}

async function baja(supabase: SupabaseClient, identidad: IdentidadBot, s: Suscripcion, mes: string, ahora: Date) {
  const { error } = await supabase.from('suscripciones').update({ activa: false, actualizada_en: ahora.toISOString() }).eq('id', s.id)
  if (error) throw error
  const valores = { estado: 'BAJA', volver_a_preguntar: null, resuelta_por: `telegram:${identidad.etiqueta}`, resuelta_en: ahora.toISOString() }
  const ins = await supabase.from('suscripcion_meses').insert({ id_suscripcion: s.id, mes, ...valores })
  if (ins.error && ins.error.code !== '23505') throw ins.error
  if (ins.error) {
    // Si ese mes ya estaba pagado, se queda pagado: la baja es de aqui en adelante.
    const upd = await supabase.from('suscripcion_meses').update(valores).eq('id_suscripcion', s.id).eq('mes', mes).neq('estado', 'PAGADA')
    if (upd.error) throw upd.error
  }
  return json({
    ok: true,
    texto: `Listo: ${s.nombre} queda dada de baja y ya no te pregunto. Se reactiva en el ERP (Finanzas > Suscripciones).`
  })
}
