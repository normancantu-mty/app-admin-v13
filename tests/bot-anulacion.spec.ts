import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  anulacionCanonica,
  avisoDeCascada,
  describirFinanzas,
  esAdminDelBot,
  filtroDeAnulables,
  mensajeDeRecaptura,
  MOVIMIENTOS_OFRECIDOS,
  normalizarDescripcionNueva,
  ordenarAnulables,
  puedeEditarDescripcion,
  sellarAnulacion,
  selloAnulacionCoincide,
  textoDeLaLista,
  type ActorDelBot,
  type PayloadAnulacion
} from '@/lib/bot-anulacion'
import { assertAnnullmentAllowed, LOCKED_RECORD_ERROR } from '@/lib/anulacion-servidor'
import { VENTANA_EDICION_HORAS, VENTANA_EDICION_MS } from '@/lib/constants'
import type { PayloadGasto } from '@/lib/bot-gastos'

/**
 * AG-06 FASE 5 — ANULAR Y CORREGIR DESDE EL CHAT.
 *
 * ─── POR QUE ESTE ARCHIVO ES DISTINTO DE LOS DEMAS DEL BOT ──────────────────
 *
 * El bot entra con `service_role`. `service_role` **se salta todo el RLS**, y
 * de paso deja `mi_rol()` en NULL, que es la primera linea de
 * `tg_vigilar_update_no_admin`:
 *
 *     IF mi_rol() IS NULL OR mi_rol() = 'ADMIN' THEN RETURN NEW;
 *
 * O sea que los tres candados de la base —solo `status`, solo `ACTIVO ->
 * ANULADO`, solo dentro de 12 h— **no se aplican cuando llama el bot**. No es
 * que sean la segunda linea de defensa: para este camino no son ninguna.
 *
 * Por eso cada regla replicada en TypeScript se prueba aqui **con su control
 * negativo**: una prueba que solo puede dar verde no mide nada. Lo que hay que
 * demostrar no es que la operacion permitida funcione — es que la PROHIBIDA se
 * rechace.
 */

const RAIZ = join(__dirname, '..')

const ADMIN: ActorDelBot = { rol: 'ADMIN', autor: 'telegram:Norman' }
const DST: ActorDelBot = { rol: 'DST', autor: 'telegram:Gilberto' }

const AHORA = new Date('2026-09-19T18:00:00.000Z')
const HACE_UNA_HORA = new Date(AHORA.getTime() - 60 * 60 * 1000).toISOString()
const HACE_DOS_DIAS = new Date(AHORA.getTime() - 48 * 60 * 60 * 1000).toISOString()

test.describe('AG-06 Fase 5 · la lista de lo anulable', () => {
  test('ADMIN no lleva filtro: ni de autor ni de ventana', () => {
    const f = filtroDeAnulables(ADMIN, AHORA)
    expect(f.soloDeAutor).toBeNull()
    expect(f.desdeISO).toBeNull()
    expect(esAdminDelBot(ADMIN)).toBe(true)
  })

  test('un no-ADMIN solo ve lo suyo, y solo dentro de la ventana', () => {
    const f = filtroDeAnulables(DST, AHORA)
    expect(f.soloDeAutor).toBe('telegram:Gilberto')
    expect(f.desdeISO).not.toBeNull()
    // La ventana es la CONSTANTE, no un 12 escrito a mano. D3 pide importarla
    // justo para que cambiarla en un sitio la cambie en los dos.
    expect(new Date(f.desdeISO!).getTime()).toBe(AHORA.getTime() - VENTANA_EDICION_MS)
  })

  test('CONTROL NEGATIVO · el filtro no puede ser mas ancho que la guarda', () => {
    // ─── LA PRUEBA QUE DE VERDAD IMPORTA ───────────────────────────────────
    // La lista decide QUE BOTONES SE PINTAN; `assertAnnullmentAllowed` decide
    // que se escribe. Si la lista fuera mas ancha, el bot ofreceria botones que
    // al pulsarse contestan "no autorizado" — palabra por palabra, el defecto
    // que D-E25 existe para no repetir. Aqui se comparan las dos.
    const guarda = (row: { usuario_creador: string | null; fecha_movimiento: string }) => {
      try {
        assertAnnullmentAllowed(row, { email: DST.autor, rol: DST.rol })
        return true
      } catch {
        return false
      }
    }
    const filtro = filtroDeAnulables(DST, new Date())
    const dentro = (row: { usuario_creador: string | null; fecha_movimiento: string }) =>
      row.usuario_creador === filtro.soloDeAutor && row.fecha_movimiento >= filtro.desdeISO!

    const casos = [
      { usuario_creador: 'telegram:Gilberto', fecha_movimiento: new Date().toISOString() },
      { usuario_creador: 'telegram:Norman', fecha_movimiento: new Date().toISOString() },
      {
        usuario_creador: 'telegram:Gilberto',
        fecha_movimiento: new Date(Date.now() - VENTANA_EDICION_MS - 60_000).toISOString()
      },
      { usuario_creador: null, fecha_movimiento: new Date().toISOString() }
    ]
    for (const caso of casos) {
      expect(
        dentro(caso),
        `la lista y la guarda discrepan sobre ${JSON.stringify(caso)}`
      ).toBe(guarda(caso))
    }

    // Y el control del control: la guarda TIENE que estar rechazando algo, o
    // esta comparacion seria "true === true" cuatro veces.
    expect(casos.filter(guarda).length, 'la guarda no rechazo nada: no se probo nada').toBe(1)
  })

  test('ADMIN si pasa la guarda donde el DST no', () => {
    expect(() =>
      assertAnnullmentAllowed(
        { usuario_creador: 'otra persona', fecha_movimiento: HACE_DOS_DIAS },
        { email: ADMIN.autor, rol: 'ADMIN' }
      )
    ).not.toThrow()
    expect(() =>
      assertAnnullmentAllowed(
        { usuario_creador: 'otra persona', fecha_movimiento: HACE_DOS_DIAS },
        { email: DST.autor, rol: 'DST' }
      )
    ).toThrow(/only annul records created by your own user/)
    expect(() =>
      assertAnnullmentAllowed(
        { usuario_creador: DST.autor, fecha_movimiento: HACE_DOS_DIAS },
        { email: DST.autor, rol: 'DST' }
      )
    ).toThrow(LOCKED_RECORD_ERROR)
  })

  test('la lista se ordena del mas nuevo al mas viejo, y se corta en ocho', () => {
    const filas = Array.from({ length: 20 }, (_, i) =>
      describirFinanzas({
        id: `id-${i}`,
        fecha_movimiento: new Date(AHORA.getTime() - i * 3600_000).toISOString(),
        tipo_movimiento: 'GASTO_OPERATIVO',
        monto: 100 + i,
        categoria: 'Gasolina',
        descripcion: `viaje ${i}`,
        id_ticket: null
      })
    )
    const ordenadas = ordenarAnulables(filas)
    expect(ordenadas[0].id).toBe('id-0')
    expect(ordenadas[ordenadas.length - 1].id).toBe('id-19')
    expect(ordenadas.slice(0, MOVIMIENTOS_OFRECIDOS)).toHaveLength(8)
  })

  test('el 8 de la consulta y el de la constante no pueden divergir', () => {
    // `lib/bot-anulables.ts` escribe `.limit(8)` LITERAL en vez de la
    // constante, y no es descuido: el centinela de ERP-25 lee el codigo fuente
    // y un `.limit(<identificador>)` no se puede verificar desde el texto —
    // esa constante podria valer 5000. Es la misma decision que
    // `VENTANA_EDICION_HORAS` duplicada en el trigger, con el mismo precio: una
    // prueba que falle el dia que se separen.
    const fuente = readFileSync(join(RAIZ, 'lib', 'bot-anulables.ts'), 'utf-8')
    const limites = [...fuente.matchAll(/\.limit\((\d+)\)/g)].map((m) => Number(m[1]))
    expect(limites.length, 'se esperaban los dos limit de los dos ledgers').toBe(2)
    for (const n of limites) {
      expect(n, 'el limit de la consulta se separo de MOVIMIENTOS_OFRECIDOS').toBe(
        MOVIMIENTOS_OFRECIDOS
      )
    }
    expect(fuente, 'el limit tiene que seguir siendo literal para ERP-25').not.toContain(
      '.limit(MOVIMIENTOS_OFRECIDOS)'
    )
  })

  test('sin movimientos, el mensaje dice POR QUE, no solo que no hay', () => {
    // Un "no encontre nada" a un DST cuyo gasto tiene trece horas es un mensaje
    // correcto y completamente inutil: la persona vuelve a intentarlo.
    expect(textoDeLaLista([], DST)).toContain(String(VENTANA_EDICION_HORAS))
    expect(textoDeLaLista([], ADMIN)).not.toContain(String(VENTANA_EDICION_HORAS))
  })

  test('con /corregir la lista pregunta con el verbo correcto', () => {
    // Salio en la prueba en vivo del 2026-09-19: la lista es la misma para los
    // dos caminos y estaba cableada a "Cual anulo?". Quien pidio corregir un
    // concepto leia la palabra "anulo" y se echaba para atras.
    const uno = [{ tabla: 'finanzas_ledger', id: 'x', fecha: '2026-09-19',
                   detalle: '19-sep — $1.00', valores: null,
                   arrastraVenta: false }] as unknown as Parameters<typeof textoDeLaLista>[0]

    expect(textoDeLaLista(uno, ADMIN, 'corregir')).toContain('Cual corrijo?')
    expect(textoDeLaLista(uno, ADMIN, 'corregir')).not.toContain('Cual anulo?')
    expect(textoDeLaLista([], ADMIN, 'corregir')).toContain('que corregir')

    // CONTROL NEGATIVO: sin decir nada, y diciendo 'anular', sigue diciendo
    // anulo. El verbo no se le puede quedar pegado al camino equivocado.
    expect(textoDeLaLista(uno, ADMIN)).toContain('Cual anulo?')
    expect(textoDeLaLista(uno, ADMIN, 'anular')).toContain('Cual anulo?')
    expect(textoDeLaLista([], ADMIN, 'anular')).toContain('que anular')
  })

  test('CONTROL NEGATIVO: `accion` no puede cambiar lo que se escribe', () => {
    // Es texto, y nada mas que texto. Si algun dia decidiera el `modo`, un
    // cuerpo mentiroso convertiria un "corregir" en un "anular" de verdad.
    const fuente = readFileSync(
      join(__dirname, '..', 'app', 'api', 'bot', 'anular', 'proponer', 'route.ts'),
      'utf8'
    )
    // `cuerpo.accion` solo puede aparecer en la linea que arma el texto. Se
    // cuentan LINEAS, no ocurrencias: en esa linea sale dos veces, una para
    // validarla y otra para pasarla.
    const lineasConAccion = fuente
      .split('\n')
      .filter((l) => l.includes('cuerpo.accion') && !l.trimStart().startsWith('//'))
    expect(lineasConAccion).toHaveLength(1)
    expect(lineasConAccion[0]).toContain('textoDeLaLista(')
    expect(fuente).toContain('textoDeLaLista(lista, actor, esAccionDeLista(cuerpo.accion)')
    // El modo sigue saliendo de `cuerpo.modo`, no de `cuerpo.accion`.
    expect(fuente).toContain('cuerpo.modo')
  })
})

test.describe('AG-06 Fase 5 · el aviso de cascada (D4)', () => {
  test('una fila suelta no avisa de ninguna venta', () => {
    expect(avisoDeCascada({ idTicket: null, filasFinanzas: 0, filasInventario: 0 })).toBeNull()
  })

  test('una fila de venta avisa, y con el conteo real', () => {
    const aviso = avisoDeCascada({
      idTicket: '9cd58af9-1111-4222-8333-444455556666',
      filasFinanzas: 3,
      filasInventario: 5
    })
    expect(aviso).toContain('TCK-9cd58af9')
    expect(aviso).toContain('3 fila(s) de dinero')
    expect(aviso).toContain('5 de inventario')
    expect(aviso).toContain('venta ENTERA')
  })

  test('CONTROL NEGATIVO · el aviso no puede inventarse los numeros', () => {
    // Un "N filas" estimado seria peor que no avisar: suena a que alguien lo
    // verifico. Si el conteo es cero, el texto tiene que decir cero.
    const aviso = avisoDeCascada({
      idTicket: '9cd58af9-1111-4222-8333-444455556666',
      filasFinanzas: 0,
      filasInventario: 0
    })
    expect(aviso).toContain('0 fila(s) de dinero')
    expect(aviso).not.toMatch(/varias|algunas|N filas/i)
  })

  test('el detalle de una fila de venta lo dice desde la lista', () => {
    const m = describirFinanzas({
      id: 'x',
      fecha_movimiento: HACE_UNA_HORA,
      tipo_movimiento: 'INGRESO_VENTA',
      monto: 69,
      categoria: null,
      descripcion: 'Venta TCK-9cd58af9',
      id_ticket: '9cd58af9-1111-4222-8333-444455556666'
    })
    expect(m.detalle).toContain('de una VENTA')
    expect(m.id_ticket).not.toBeNull()
  })
})

test.describe('AG-06 Fase 5 · la unica edicion real (D6)', () => {
  const FILA_SUELTA = { id_ticket: null, status: 'ACTIVO' }

  test('un ADMIN edita el concepto de una fila suelta', () => {
    expect(puedeEditarDescripcion(ADMIN, FILA_SUELTA).ok).toBe(true)
  })

  test('CONTROL NEGATIVO · un no-ADMIN NO edita nada', () => {
    // Es la regla 1 del trigger `tg_vigilar_update_no_admin` traducida: para
    // todo rol que no sea ADMIN, un UPDATE solo puede cambiar `status`. Con
    // `service_role` ese trigger se rinde, asi que esta funcion es la unica que
    // queda de pie. Si esta prueba se pone verde al reves, la regla desaparecio.
    const juicio = puedeEditarDescripcion(DST, FILA_SUELTA)
    expect(juicio.ok).toBe(false)
    expect(juicio.motivo).toContain('lo anulo y lo recapturamos')
  })

  test('CONTROL NEGATIVO · ni un ADMIN edita el renglon de una venta', () => {
    const juicio = puedeEditarDescripcion(ADMIN, {
      id_ticket: '9cd58af9-1111-4222-8333-444455556666',
      status: 'ACTIVO'
    })
    expect(juicio.ok).toBe(false)
    expect(juicio.motivo).toContain('folio')
  })

  test('CONTROL NEGATIVO · una fila ya anulada no se edita', () => {
    expect(puedeEditarDescripcion(ADMIN, { id_ticket: null, status: 'ANULADO' }).ok).toBe(false)
  })

  test('el concepto nuevo pasa SIEMPRE por el filtro fiscal', () => {
    // `v_pasivo_fiscal` LEE este texto para decidir si hubo un pago de
    // impuesto. Un concepto editado sin filtrar puede inventar un pago de IVA
    // que nadie hizo, y el numero saldria en la pantalla de impuestos sin que
    // exista la fila que lo respalda.
    const limpio = normalizarDescripcionNueva('pago de gasolina')
    expect(limpio.ok).toBe(true)
    if (limpio.ok) {
      expect(limpio.texto).toBe('pago de gasolina')
      expect(limpio.avisos).toHaveLength(0)
    }
  })

  test('CONTROL NEGATIVO · un concepto con disparador fiscal se desactiva Y se avisa', () => {
    const sucio = normalizarDescripcionNueva('pago de IVA del trimestre')
    expect(sucio.ok).toBe(true)
    if (sucio.ok) {
      expect(sucio.texto, 'el texto tenia que quedar distinto del dictado').not.toBe(
        'pago de IVA del trimestre'
      )
      expect(sucio.original).toBe('pago de IVA del trimestre')
      expect(sucio.avisos.length, 'desactivarlo en silencio es peor que no hacerlo').toBeGreaterThan(
        0
      )
    }
  })

  test('CONTROL NEGATIVO · un concepto vacio no se acepta', () => {
    expect(normalizarDescripcionNueva('   ').ok).toBe(false)
    expect(normalizarDescripcionNueva(null).ok).toBe(false)
  })
})

test.describe('AG-06 Fase 5 · el sello de la anulacion', () => {
  const RECAPTURA: PayloadGasto = {
    tipo_movimiento: 'GASTO_OPERATIVO',
    categoria: 'Gasolina',
    categoria_gasto: null,
    descripcion: 'viaje a Zacatecas',
    monto: 340,
    fecha_movimiento: '2026-09-18',
    id_cuenta_destino: 'cuenta-1',
    id_cuenta_origen: null,
    usuario_creador: 'telegram:Norman',
    status: 'ACTIVO'
  }

  const BASE: PayloadAnulacion = {
    modo: 'recapturar',
    tabla: 'finanzas',
    id_movimiento: 'fila-1',
    id_ticket: null,
    usuario_creador: 'telegram:Norman',
    recaptura: RECAPTURA,
    descripcion_nueva: null
  }

  // Auditoria 2026-11-04: 2026-11-04T03:00Z son las 21:00 del dia 3 en Mexico.
  test('la correccion ensena el dia de Mexico, no el de UTC', () => {
    const movimiento = describirFinanzas({
      id: 'fila-1',
      fecha_movimiento: '2026-11-04T03:00:00.000Z',
      tipo_movimiento: 'GASTO_OPERATIVO',
      monto: 340,
      categoria: 'Gasolina',
      descripcion: 'viaje',
      id_ticket: null
    })
    const nueva = { ...RECAPTURA, fecha_movimiento: '2026-11-04T03:00:00.000Z' }
    const alcance = { idTicket: null, filasFinanzas: 0, filasInventario: 0 }
    expect(mensajeDeRecaptura(movimiento, nueva, alcance).split('DESPUES:')[1]).toContain('03/11/2026')
  })

  test('el sello empata consigo mismo', () => {
    expect(selloAnulacionCoincide(BASE, sellarAnulacion(BASE))).toBe(true)
  })

  test('CONTROL NEGATIVO · cambiar la fila que se toca cambia el sello', () => {
    // Es la propiedad entera de este endpoint: entre el mensaje que se enseno y
    // el "va", el uuid no puede cambiar. Si el sello no lo cubriera, un id
    // distinto en el confirmar anularia otra fila enseñando este mensaje.
    const otra = { ...BASE, id_movimiento: 'fila-2' }
    expect(selloAnulacionCoincide(otra, sellarAnulacion(BASE))).toBe(false)
  })

  test('CONTROL NEGATIVO · cambiar el modo cambia el sello', () => {
    const otro = { ...BASE, modo: 'anular' as const }
    expect(selloAnulacionCoincide(otro, sellarAnulacion(BASE))).toBe(false)
  })

  test('CONTROL NEGATIVO · cambiar un campo ANIDADO de la recaptura cambia el sello', () => {
    // `recaptura` es un objeto dentro del payload. Un sello que solo fijara el
    // nivel de arriba dejaria el monto de la fila nueva fuera de la proteccion,
    // que es exactamente lo que no puede pasar.
    const caro = { ...BASE, recaptura: { ...RECAPTURA, monto: 34000 } }
    expect(selloAnulacionCoincide(caro, sellarAnulacion(BASE))).toBe(false)
  })

  test('reordenar las llaves anidadas NO cambia el sello (RFC 8785)', () => {
    // `jsonb` reordena las llaves de los objetos al guardarlos. Si la
    // canonizacion no fuera recursiva, el payload volveria de la base con otro
    // hash y el endpoint concluiria "la propuesta cambio" — cancelando un
    // borrador legitimo cada vez.
    const revuelta = {
      status: RECAPTURA.status,
      monto: RECAPTURA.monto,
      descripcion: RECAPTURA.descripcion,
      categoria: RECAPTURA.categoria,
      usuario_creador: RECAPTURA.usuario_creador,
      fecha_movimiento: RECAPTURA.fecha_movimiento,
      tipo_movimiento: RECAPTURA.tipo_movimiento,
      id_cuenta_origen: RECAPTURA.id_cuenta_origen,
      id_cuenta_destino: RECAPTURA.id_cuenta_destino,
      categoria_gasto: RECAPTURA.categoria_gasto
    } as PayloadGasto
    expect(anulacionCanonica({ ...BASE, recaptura: revuelta })).toBe(anulacionCanonica(BASE))
    expect(selloAnulacionCoincide({ ...BASE, recaptura: revuelta }, sellarAnulacion(BASE))).toBe(
      true
    )
  })
})

test.describe('AG-06 Fase 5 · los centinelas de los endpoints', () => {
  const CONFIRMAR = readFileSync(
    join(RAIZ, 'app', 'api', 'bot', 'anular', 'confirmar', 'route.ts'),
    'utf-8'
  )
  const PROPONER = readFileSync(
    join(RAIZ, 'app', 'api', 'bot', 'anular', 'proponer', 'route.ts'),
    'utf-8'
  )

  test('el discriminador se mira ANTES que el sello', () => {
    // Un borrador de otra familia nunca empata el hash, asi que caeria por la
    // rama del sello roto — que CANCELA el borrador. Cancelar la captura de
    // alguien por un error de enrutamiento es un dano real.
    const iTipo = CONFIRMAR.indexOf("guardado?.tipo !== 'anulacion'")
    const iSello = CONFIRMAR.indexOf('selloAnulacionCoincide(fila, borrador.sello)')
    expect(iTipo, 'no se encontro el discriminador').toBeGreaterThan(0)
    expect(iSello, 'no se encontro la comprobacion del sello').toBeGreaterThan(0)
    expect(iTipo, 'el tipo tiene que comprobarse antes que el sello').toBeLessThan(iSello)
  })

  test('el sello roto CANCELA el borrador', () => {
    const rama = CONFIRMAR.slice(
      CONFIRMAR.indexOf('selloAnulacionCoincide(fila, borrador.sello)'),
      CONFIRMAR.indexOf('El sello no empata')
    )
    expect(rama).toContain("estado: 'CANCELADO'")
  })

  test('la autorizacion se rehace en el confirmar, no solo al proponer', () => {
    // La ventana de 12 h se cierra sola mientras el mensaje espera en el
    // celular de alguien. Sin esta segunda pasada, proponer a las 11:59 y picar
    // "va" a las 12:01 escribiria igual.
    expect(CONFIRMAR).toContain('buscarEnLaLista(supabase, actor, fila.tabla, fila.id_movimiento)')
    expect(PROPONER).toContain('buscarEnLaLista(supabase, actor, tabla, idMovimiento)')
  })

  test('el log lleva el borrador y el telegram_id, y NUNCA el token', () => {
    // `tg_forzar_autor` solo honra `usuario_creador` en INSERT: un UPDATE por
    // `service_role` entra a `auditoria_logs` como `usuario = 'sistema'`. Este
    // renglon es el unico rastro de quien anulo.
    const linea = CONFIRMAR.slice(CONFIRMAR.indexOf("'[bot][anulacion]"))
    expect(linea).toContain('borrador=%s')
    expect(linea).toContain('telegram_id=%s')
    for (const prohibido of ['BOT_API_TOKEN', 'authorization', 'token']) {
      expect(linea.slice(0, 600).toLowerCase()).not.toContain(prohibido.toLowerCase())
    }
  })

  test('CONTROL NEGATIVO · el centinela caza un orden invertido', () => {
    const impostor = "if (!selloAnulacionCoincide(fila, borrador.sello)) {}\nif (guardado?.tipo !== 'anulacion') {}"
    expect(impostor.indexOf("guardado?.tipo !== 'anulacion'")).toBeGreaterThan(
      impostor.indexOf('selloAnulacionCoincide(fila, borrador.sello)')
    )
  })
})
