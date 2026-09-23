/**
 * AG-06 FASE 5 — EL ALTA DE UN DISTRIBUIDOR O UN LOCAL. La propuesta.
 *
 * Mismo molde que los otros cinco `proponer`: token -> telegram_id seguro ->
 * identidad -> se arma lo que se va a escribir -> se SELLA -> se guarda el
 * borrador -> se contesta con el mensaje y el sello.
 *
 * ─── PERO ESTE ENDPOINT PREGUNTA MAS QUE LOS DEMAS, Y NO POR CAPRICHO ───────
 *
 * Un alta tiene cuatro cosas que **no se pueden adivinar de una nota de voz**:
 *
 *   `rol` ......... decide que comisiones existen (D10) y si hay usuario de
 *                   acceso. Va por boton.
 *   `zona` ........ decide el precio de TODAS sus ventas. El texto tiene que
 *                   ser `Zacatecas` o `Foraneo` exacto y sin acento, porque asi
 *                   esta en `listas_precios`. Va por boton (D9).
 *   comisiones .... son tres las que mueven precio, y cuales se preguntan
 *                   depende del rol. Ver `comisionesQueSePreguntan`.
 *   el duplicado .. `entidades.nombre` **no tiene `UNIQUE`**. Dos "Juan" no se
 *                   notan hasta que se le abona al equivocado (D12).
 *
 * Por eso este endpoint contesta `hay_que_elegir` varias veces antes de llegar
 * a un borrador: cada vuelta resuelve UN hueco, y el bot pinta los botones que
 * el servidor declaro. Ninguna de esas listas la inventa el modelo.
 *
 * ─── Y SOLO ADMIN ───────────────────────────────────────────────────────────
 *
 * `entidades_ins_admin` no va a aplicarse: el bot entra con `service_role` y el
 * RLS se salta entero. Quien dice que no es `assertPuedeDarDeAlta`, en
 * TypeScript, y se comprueba **aqui y otra vez en el `confirmar`**.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import {
  buscarParecidas,
  puedeDarDeAlta,
  type ActorDeAlta
} from '@/lib/entidad-servidor'
import {
  avisoDeRedondeo,
  comisionesQueSePreguntan,
  esRolDeAlta,
  esZonaValida,
  mensajeDeAlta,
  normalizarComision,
  OPCIONES_DE_AMBIGUEDAD,
  nombreDelRol,
  preguntaDeAmbiguedad,
  preguntaDeDuplicado,
  ROLES_DE_ALTA,
  sellarAlta,
  ZONAS,
  type PayloadAlta,
  type RolDeAlta,
  type Zona
} from '@/lib/bot-entidad'

export const dynamic = 'force-dynamic'

/** Un correo que se escribe solo: no vale la pena mas que esto, porque quien
 * decide de verdad si el correo existe es el servidor de Auth al crearlo. */
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      nombre?: unknown
      rol?: unknown
      zona?: unknown
      email?: unknown
      telefono?: unknown
      id_nodo_padre?: unknown
      comisiones?: unknown
      // Lo pone el bot cuando la persona ya vio la lista de parecidas y dijo
      // que de todos modos. Nunca lo pone el modelo.
      aun_con_parecidas?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }

    const actor: ActorDeAlta = { idEntidad: identidad.idEntidad, rol: identidad.rolEntidad }

    // ── EL PERMISO, ANTES QUE NADA (D14) ──────────────────────────────────
    // Se comprueba aqui y NO se confia en que el bot no ofrezca el boton: el
    // endpoint es alcanzable con el token, y el token lo tiene el proceso del
    // bot entero, no una persona.
    if (!puedeDarDeAlta(actor)) {
      return NextResponse.json(
        { error: 'Solo administracion da de alta distribuidores y locales.' },
        { status: 403 }
      )
    }

    const nombre = String(cuerpo.nombre ?? '').trim()
    if (nombre.length < 2) {
      return NextResponse.json(
        { error: 'Como se llama? Dime el nombre completo.' },
        { status: 422 }
      )
    }

    // ── 1. EL ROL, POR BOTON ──────────────────────────────────────────────
    if (!esRolDeAlta(cuerpo.rol)) {
      return NextResponse.json({
        ok: true,
        hay_que_elegir: true,
        campo: 'rol',
        mensaje: `${nombre}: es distribuidor o local?`,
        opciones: ROLES_DE_ALTA.map((r) => ({ valor: r, etiqueta: nombreDelRol(r) }))
      })
    }
    const rol: RolDeAlta = cuerpo.rol

    // ── 2. LA ZONA, POR BOTON (D9) ────────────────────────────────────────
    if (!esZonaValida(cuerpo.zona)) {
      return NextResponse.json({
        ok: true,
        hay_que_elegir: true,
        campo: 'zona',
        // Se dice lo que la zona decide, porque no es un dato administrativo:
        // es el precio de todas sus ventas.
        mensaje: `En que zona queda? Esto decide la lista de precios con la que le voy a vender.`,
        opciones: ZONAS.map((z) => ({ valor: z, etiqueta: z }))
      })
    }
    const zona: Zona = cuerpo.zona

    // ── 3. EL DUPLICADO POR NOMBRE (D12) ──────────────────────────────────
    // Antes de preguntar comisiones: si va a resultar que ya existe, no tiene
    // caso hacerle contestar tres numeros primero.
    if (cuerpo.aun_con_parecidas !== true) {
      const juicio = await buscarParecidas(supabase, nombre)
      if (juicio.hayParecido) {
        return NextResponse.json({
          ok: true,
          hay_que_elegir: true,
          campo: 'duplicado',
          mensaje: preguntaDeDuplicado(
            nombre,
            juicio.parecidas.map((p) => `${p.nombre} (${p.rol})`)
          ),
          opciones: [
            { valor: 'si', etiqueta: 'Es otro, creala' },
            { valor: 'no', etiqueta: 'Mejor no' }
          ]
        })
      }
    }

    // ── 4. EL CORREO, SOLO SI ES DST (D11) ────────────────────────────────
    const email = String(cuerpo.email ?? '').trim().toLowerCase() || null
    if (rol === 'DST' && !email) {
      return NextResponse.json({
        ok: true,
        hay_que_elegir: false,
        campo: 'email',
        // La contrasena NO se pide. Se genera. Ver `generarPassword`.
        mensaje:
          `Cual es el correo con el que va a entrar ${nombre}? ` +
          `La contrasena se la genero yo y te la enseno una vez.`
      })
    }
    if (email && !CORREO.test(email)) {
      return NextResponse.json({ error: `"${email}" no me parece un correo.` }, { status: 422 })
    }

    // ── 5. LAS COMISIONES QUE MUEVEN PRECIO (D10) ─────────────────────────
    const dichas = (cuerpo.comisiones ?? {}) as Record<string, unknown>
    const valores: Record<string, number> = {
      comision_base: 0,
      comision_base_local: 0,
      // La columna muerta nunca se pregunta y nunca sale de 0. Ver COLUMNA_MUERTA.
      comision_hijo_local: 0
    }
    const avisos: string[] = []

    for (const pedida of comisionesQueSePreguntan(rol)) {
      const cruda = dichas[pedida.columna]
      if (cruda === undefined || cruda === null || String(cruda).trim() === '') {
        return NextResponse.json({
          ok: true,
          hay_que_elegir: false,
          campo: pedida.columna,
          mensaje: pedida.pregunta
        })
      }

      const juicio = normalizarComision(cruda)

      // LA TRAMPA DEL "1". No se adivina: se pregunta con dos botones, porque
      // la diferencia entre las dos lecturas es que el producto se regale.
      if (!juicio.ok && juicio.motivo === 'ambigua') {
        return NextResponse.json({
          ok: true,
          hay_que_elegir: true,
          campo: pedida.columna,
          mensaje: preguntaDeAmbiguedad(pedida.etiqueta),
          // D10/D11: las dos salidas viven en `lib/bot-entidad.ts`, donde una
          // prueba puede exigirles que ninguna vuelva a salir `ambigua`.
          opciones: OPCIONES_DE_AMBIGUEDAD
        })
      }
      if (!juicio.ok) {
        return NextResponse.json({ error: juicio.error }, { status: 422 })
      }

      valores[pedida.columna] = juicio.fraccion
      // LA TRAMPA DEL `numeric(5,2)`. Si el numero dictado no sobrevive la
      // columna, se dice ANTES del "va" — no despues, cuando Postgres ya
      // redondeo en silencio.
      const aviso = avisoDeRedondeo(juicio)
      if (aviso) avisos.push(aviso)
    }

    // ── 6. EL PADRE ───────────────────────────────────────────────────────
    // Un LOC cuelga de quien lo da de alta si es un DST; como aqui solo dan de
    // alta los ADMIN, cuelga de la matriz salvo que digan otra cosa. Se resuelve
    // el nombre solo para poder enseñarlo antes del "va".
    const idPadre = String(cuerpo.id_nodo_padre ?? '').trim() || null
    let nombrePadre: string | null = null
    if (idPadre) {
      const { data: padre } = await supabase
        .from('entidades')
        .select('nombre')
        .eq('id', idPadre)
        .maybeSingle()
      if (!padre) {
        return NextResponse.json({ error: 'No encontre a quien lo cuelgo.' }, { status: 422 })
      }
      nombrePadre = padre.nombre
    }

    const payload: PayloadAlta = {
      nombre,
      rol,
      zona,
      email,
      telefono: String(cuerpo.telefono ?? '').trim() || null,
      id_nodo_padre: idPadre,
      comision_base: valores.comision_base,
      comision_base_local: valores.comision_base_local,
      comision_hijo_local: valores.comision_hijo_local
    }

    const mensaje = mensajeDeAlta(payload, {
      nombrePadre,
      avisos,
      parecidas: cuerpo.aun_con_parecidas === true ? ['(dijiste que es otro)'] : []
    })

    // ── Un solo borrador PENDIENTE por persona ──────────────────────────────
    // `bot_borradores_uno_pendiente` es un UNIQUE parcial sobre `telegram_id`
    // con `estado = 'PENDIENTE'`: proponer algo nuevo TIENE que cancelar lo
    // anterior, o el insert revienta con 23505. Mismo criterio que los cinco
    // `proponer` de las fases 3 y 4, y por la misma razon: con dos borradores
    // abiertos un "va" es ambiguo.
    await supabase
      .from('bot_borradores')
      .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
      .eq('telegram_id', telegramId)
      .eq('estado', 'PENDIENTE')

    const sello = sellarAlta(payload)

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        sello,
        estado: 'PENDIENTE',
        payload: {
          // El discriminador, que en el `confirmar` se mira ANTES del sello.
          tipo: 'alta_entidad',
          fila: payload,
          meta: { id_entidad: identidad.idEntidad, nombrePadre, avisos }
        } as unknown as never
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no pude guardar el borrador de alta:', error)
      return NextResponse.json({ error: 'No pude prepararlo. No cree nada.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje,
      rol,
      avisos
    })
  } catch (e) {
    console.error('[bot] entidad/proponer reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
