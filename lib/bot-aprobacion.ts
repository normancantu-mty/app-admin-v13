/**
 * FASE 9 (D94 + D98) — LA PUERTA DE TODO `/confirmar`: QUIEN PUEDE DAR EL VA.
 *
 * Antes de la Fase 9 cada ruta `confirmar` repetia dos lineas: "el borrador es
 * tuyo" y "esta PENDIENTE". Con los grupos hay tres casos, y viven aqui para
 * que las nueve rutas decidan IGUAL:
 *
 *   1. `directo`  — el dueno del borrador da VA y no requiere aprobacion
 *                   (Norman, un DST): se escribe, como siempre.
 *   2. `esperar`  — el dueno da VA pero su identidad `requiere_aprobacion`
 *                   (Kevin): **no se escribe nada**; el borrador pasa a
 *                   `ESPERA_APROBACION` y a Norman le llega por privado.
 *   3. `aprobar`  — un aprobador (ADMIN sin marca) que NO es el dueno aprieta
 *                   Aprobar sobre un borrador en `ESPERA_APROBACION`: se escribe
 *                   con la identidad del AUTOR (es su captura: su etiqueta en
 *                   `usuario_creador`, su entidad, sus cuentas) y el sello
 *                   intacto. Si el borrador cambio, el sello no empata y no se
 *                   escribe — igual que siempre.
 *
 * Cualquier otra combinacion se rechaza. En particular: el VA de B sobre el
 * borrador PENDIENTE de A (mismo grupo) es 403 — **la identidad es la persona,
 * no el chat** (D94).
 *
 * `decidirPuerta` es PURA (`tests/bot-fase9-permisos.spec.ts`).
 */

import { NextResponse } from 'next/server'
import type { ClienteServicio, IdentidadBot } from '@/lib/bot-servidor'
import { resolverIdentidad } from '@/lib/bot-servidor'
import { esAprobador, entidadesAlcanzables, type ActorBot, type Alcance } from '@/lib/bot-permisos'

export type ModoPuerta = 'directo' | 'esperar' | 'aprobar'

export type DecisionPuerta =
  | { ok: true; modo: ModoPuerta }
  | { ok: false; status: number; error: string }

export interface HechosDeLaPuerta {
  estado: string
  /** `bot_borradores.telegram_id`: la persona que propuso. */
  dueno: number
  /** La persona que aprieta el boton. */
  quien: number
  quienRol: string
  quienRequiereAprobacion: boolean
}

export function decidirPuerta(h: HechosDeLaPuerta): DecisionPuerta {
  const aprobador = esAprobador({ rol: h.quienRol, requiereAprobacion: h.quienRequiereAprobacion })
  if (h.estado === 'PENDIENTE') {
    if (h.dueno !== h.quien) return { ok: false, status: 403, error: 'Ese borrador no es tuyo.' }
    return { ok: true, modo: h.quienRequiereAprobacion ? 'esperar' : 'directo' }
  }
  if (h.estado === 'ESPERA_APROBACION') {
    if (h.dueno === h.quien) {
      return { ok: false, status: 409, error: 'Ya esta esperando el Aprobar de Norman.' }
    }
    if (!aprobador) {
      return { ok: false, status: 403, error: 'Aprobar lo que propone otro lo hace solo Norman.' }
    }
    return { ok: true, modo: 'aprobar' }
  }
  return { ok: false, status: 409, error: `Ese borrador ya esta ${h.estado.toLowerCase()}.` }
}

/**
 * Quien puede apagar un borrador (FASE 9, D98). PENDIENTE: solo el dueno, como
 * siempre. ESPERA_APROBACION: el dueno (se arrepintio) o un aprobador (es el
 * Rechazar de Norman). **Pura.**
 */
export function puedeCancelar(h: HechosDeLaPuerta): boolean {
  if (h.dueno === h.quien) return true
  return (
    h.estado === 'ESPERA_APROBACION' &&
    esAprobador({ rol: h.quienRol, requiereAprobacion: h.quienRequiereAprobacion })
  )
}

// ─── EL LADO DEL SERVIDOR ───────────────────────────────────────────────────

export interface BorradorEnPuerta {
  id: string
  telegram_id: number
  estado: string
  chat_id?: number | null
}

export type PuertaAbierta =
  | { ok: true; modo: ModoPuerta; autor: IdentidadBot }
  | { ok: false; respuesta: NextResponse }

/**
 * Decide la puerta y devuelve la identidad con la que la ruta sigue: la del
 * AUTOR del borrador. En `directo`/`esperar` es la misma persona que aprieta;
 * en `aprobar` se relee por `borrador.telegram_id` (si ya no esta dado de
 * alta, no se escribe).
 */
export async function abrirPuerta(
  supabase: ClienteServicio,
  quien: IdentidadBot,
  borrador: BorradorEnPuerta
): Promise<PuertaAbierta> {
  const d = decidirPuerta({
    estado: borrador.estado,
    dueno: Number(borrador.telegram_id),
    quien: quien.telegramId,
    quienRol: quien.rolEntidad,
    quienRequiereAprobacion: quien.requiereAprobacion
  })
  if (!d.ok) return { ok: false, respuesta: NextResponse.json({ error: d.error }, { status: d.status }) }
  if (d.modo !== 'aprobar') return { ok: true, modo: d.modo, autor: quien }
  const autor = await resolverIdentidad(supabase, Number(borrador.telegram_id))
  if (!autor) {
    return {
      ok: false,
      respuesta: NextResponse.json(
        { error: 'Quien lo propuso ya no esta dado de alta. No escribo nada.' },
        { status: 409 }
      )
    }
  }
  return { ok: true, modo: 'aprobar', autor }
}

export function actorDe(identidad: IdentidadBot): ActorBot {
  return { rol: identidad.rolEntidad, requiereAprobacion: identidad.requiereAprobacion }
}

/** Los `telegram_id` de los aprobadores (ADMIN sin marca), para avisarles. */
export async function aprobadoresDelBot(supabase: ClienteServicio): Promise<number[]> {
  const { data } = await supabase
    .from('bot_identidades')
    .select('telegram_id, requiere_aprobacion, entidades!inner(rol)')
    .eq('activo', true)
    .eq('requiere_aprobacion', false)
  return (data ?? [])
    .filter((f) => (f as unknown as { entidades: { rol: string | null } }).entidades?.rol === 'ADMIN')
    .map((f) => Number(f.telegram_id))
}

/** El nombre con que el bot llama a alguien: su etiqueta, capitalizada. */
export function nombreDeEtiqueta(etiqueta: string): string {
  const e = String(etiqueta ?? '').replace(/[_-]+/g, ' ').trim()
  return e.replace(/\b([a-z])/g, (m) => m.toUpperCase()) || '(sin nombre)'
}

/**
 * El VA de Kevin: el borrador pasa a `ESPERA_APROBACION` y **no se escribe
 * nada**. Se llama DESPUES de comprobar los dos sellos (lo que espera es
 * exactamente lo que se enseno) y ANTES de cualquier escritura.
 */
export async function pasarAEspera(
  supabase: ClienteServicio,
  borradorId: string,
  autor: IdentidadBot,
  /** "un gasto", "una venta"... El texto completo de la propuesta lo reenvia el bot. */
  queEs: string
): Promise<NextResponse> {
  const { error } = await supabase
    .from('bot_borradores')
    .update({ estado: 'ESPERA_APROBACION' })
    .eq('id', borradorId)
    .eq('estado', 'PENDIENTE')
  if (error && (error as { code?: string }).code !== 'ENSAYO') {
    console.error('[bot] no pude pasar a espera', borradorId, error)
    return NextResponse.json({ error: 'No pude mandarlo a aprobar. No escribi nada.' }, { status: 500 })
  }
  const nombre = nombreDeEtiqueta(autor.etiqueta)
  return NextResponse.json({
    ok: false,
    espera_aprobacion: true,
    borrador_id: borradorId,
    avisar_a: await aprobadoresDelBot(supabase),
    propuesto_por: nombre,
    mensaje: `Listo, ${nombre}. No lo escribo todavia: se lo mande a Norman para que lo apruebe.`,
    mensaje_aprobador: `${nombre} propone ${queEs} y espera tu Aprobar.`
  })
}

/**
 * FASE 9 (D96/D99): las entidades que alcanza una identidad, leidas con la
 * MISMA regla que `mis_entidades()` (la propia + hijos por `id_padre` o
 * `id_nodo_padre`). No se llama al rpc porque el cliente del bot es de
 * servicio y `mis_entidades()` lee `auth.uid()`. `null` = todas (ADMIN).
 */
export async function redDe(
  supabase: ClienteServicio,
  identidad: IdentidadBot,
  alcance: Alcance
): Promise<Set<string> | null> {
  if (alcance === 'todo') return null
  const { data } = await supabase.from('entidades').select('id, id_padre, id_nodo_padre')
  return entidadesAlcanzables(alcance, identidad.idEntidad, data ?? [])
}

/** El alcance de lo que un actor puede tocar al proponer: ADMIN todo, DST su red, resto lo propio. */
export function alcanceDeCaptura(identidad: IdentidadBot): Alcance {
  if (identidad.rolEntidad === 'ADMIN') return 'todo'
  return identidad.rolEntidad === 'DST' ? 'red' : 'propio'
}

/**
 * FASE 9 (D97): la cuenta de la MATRIZ a la que entra el abono de un DST. Un DST
 * no tiene cuentas de la matriz en su alta; se usa la cuenta por defecto del
 * aprobador (Norman). Norman lo aprueba antes de que cuente, y en la pantalla
 * de aprobaciones puede verlo igual que un abono capturado en la app.
 */
export async function cuentaDeLaMatrizParaAbono(
  supabase: ClienteServicio
): Promise<{ id: string; nombre: string } | null> {
  const { data } = await supabase
    .from('bot_identidades')
    .select('id_cuenta_destino, creado_en, entidades!inner(rol), cuentas_financieras!inner(nombre)')
    .eq('activo', true)
    .eq('requiere_aprobacion', false)
    .order('creado_en', { ascending: true })
  const fila = (data ?? []).find(
    (f) => (f as unknown as { entidades: { rol: string | null } }).entidades?.rol === 'ADMIN'
  ) as unknown as { id_cuenta_destino: string; cuentas_financieras: { nombre: string | null } } | undefined
  if (!fila) return null
  return { id: fila.id_cuenta_destino, nombre: fila.cuentas_financieras?.nombre ?? '(cuenta de la matriz)' }
}
