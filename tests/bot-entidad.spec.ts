/**
 * AG-06 FASE 5 · PASO 5 — EL ALTA POR CHAT.
 *
 * ─── QUE SE PRUEBA AQUI Y POR QUE NO BASTA CON QUE COMPILE ──────────────────
 *
 * Dos familias, y las dos tienen su control NEGATIVO al lado:
 *
 *  1. **El permiso.** `entidades_ins_admin` dice que solo un ADMIN inserta en
 *     `entidades`, y el bot entra con `service_role`, que se salta el RLS
 *     entero. O sea que `assertPuedeDarDeAlta` no es una comodidad: es la unica
 *     comprobacion que existe en el camino del chat. Una prueba que solo
 *     verifique que un ADMIN pasa no prueba nada — hay que ver que los otros
 *     roles REBOTAN, uno por uno.
 *
 *  2. **Las tres trampas de conversion de la comision (D10).** Cada una se
 *     prueba contra una REPLICA del normalizador viejo, y la replica tiene que
 *     dar el resultado MALO. Si algun dia la replica empezara a dar lo mismo que
 *     el nuevo, la prueba de la trampa seria vacia y nadie se enteraria; asi,
 *     se pondria roja.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  avisoDeRedondeo,
  CAJA_DE_MUESTRA,
  COLUMNA_MUERTA,
  comisionesQueSePreguntan,
  enPesos,
  enPorcentaje,
  enPorcentajeDicho,
  esRolDeAlta,
  esZonaValida,
  explicarComision,
  LLAVES_ALTA,
  mensajeDeAlta,
  mensajeDeAltaHecha,
  normalizarComision,
  preguntaDeAmbiguedad,
  ROLES_DE_ALTA,
  sellarAlta,
  selloAltaCoincide,
  ZONAS,
  type PayloadAlta
} from '@/lib/bot-entidad'
import {
  assertPuedeDarDeAlta,
  generarPassword,
  LARGO_MINIMO_PASSWORD,
  puedeDarDeAlta
} from '@/lib/entidad-servidor'

const raiz = process.cwd()
const leer = (p: string) => readFileSync(join(raiz, p), 'utf8')

/**
 * ─── LA REPLICA DEL NORMALIZADOR VIEJO ──────────────────────────────────────
 *
 * Copiada palabra por palabra de `app/actions/distribuidores.ts:43-47` el
 * 2026-09-19. **No se importa a proposito**: si se importara, el dia que alguien
 * arreglara la de la app estas pruebas se volverian verdes por la razon
 * equivocada — sin que nadie hubiera revisado que el arreglo es el mismo. Esta
 * copia congela el defecto para poder demostrar que el nuevo NO lo tiene.
 */
function normalizadorViejo(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return 0
  const v = value > 1 ? value / 100 : value
  return Math.max(0, Math.min(1, Math.round(v * 10000) / 10000))
}

// ============================================================================
// 1. EL PERMISO (D14). El control negativo es la prueba entera.
// ============================================================================

test.describe('Paso 5 · solo ADMIN da de alta entidades', () => {
  test('un ADMIN pasa', () => {
    expect(puedeDarDeAlta({ idEntidad: 'e1', rol: 'ADMIN' })).toBe(true)
    expect(() => assertPuedeDarDeAlta({ idEntidad: 'e1', rol: 'admin' })).not.toThrow()
  })

  test('CONTROL NEGATIVO: los otros cinco roles REBOTAN, uno por uno', () => {
    // `service_role` deja `mi_rol()` en NULL y el RLS no se aplica: si esta
    // lista pasara, cualquiera dado de alta en el bot podria crear
    // distribuidores con la comision que quisiera.
    const rechazados = ['DST', 'LOC', 'SOCIO', 'SUB-ADMIN', '']
    for (const rol of rechazados) {
      expect(puedeDarDeAlta({ idEntidad: 'e2', rol }), `rol "${rol}" no deberia poder`).toBe(false)
      expect(() => assertPuedeDarDeAlta({ idEntidad: 'e2', rol })).toThrow(
        /Solo administracion/
      )
    }
    // Y que la lista no este vacia: una prueba que itera sobre nada pasa igual.
    expect(rechazados.length).toBe(5)
  })

  test('el rol llega de la identidad, nunca del cuerpo de la peticion', () => {
    const fuente = leer('app/api/bot/entidad/proponer/route.ts')
    // El actor se arma de `identidad`, que sale de `bot_identidades` por
    // `telegram_id`. Si alguna vez saliera de `cuerpo`, el permiso lo elegiria
    // quien llama.
    expect(fuente).toContain('rol: identidad.rolEntidad')
    expect(fuente).not.toMatch(/rol:\s*(String\()?cuerpo\./)
  })

  test('el permiso se vuelve a comprobar en el confirmar, no solo al proponer', () => {
    // Entre la propuesta y el "va" pueden pasar horas. Una defensa que solo
    // corre en la primera mitad del flujo no es una defensa.
    const fuente = leer('app/api/bot/entidad/confirmar/route.ts')
    expect(fuente).toContain('puedeDarDeAlta(actor)')
  })
})

// ============================================================================
// 2. LAS TRES TRAMPAS DE LA COMISION (D10)
// ============================================================================

test.describe('Paso 5 · trampa 1: la convencion de la base es FRACCION', () => {
  test('"20" se guarda como 0.20', () => {
    const j = normalizarComision(20)
    expect(j.ok).toBe(true)
    if (j.ok) expect(j.fraccion).toBe(0.2)
  })

  test('"0.20" tambien se guarda como 0.20: quien dicta la fraccion no se castiga', () => {
    const j = normalizarComision(0.2)
    expect(j.ok).toBe(true)
    if (j.ok) expect(j.fraccion).toBe(0.2)
  })

  test('mas de 100 se rechaza en vez de recortarse a 1', () => {
    // El viejo hacia `Math.min(1, ...)`: un 500 dictado por error se convertia
    // en silencio en una comision del 100%.
    expect(normalizadorViejo(500)).toBe(1)
    const j = normalizarComision(500)
    expect(j.ok).toBe(false)
    if (!j.ok && j.motivo === 'invalida') expect(j.error).toMatch(/100%/)
  })
})

test.describe('Paso 5 · trampa 2: el "1" no se adivina', () => {
  test('el viejo lo dejaba pasar como 100%: el producto sale gratis', () => {
    // 1 no es `> 1`, asi que no se divide. Esta linea es la razon de ser de
    // toda la rama `ambigua`.
    expect(normalizadorViejo(1)).toBe(1)
  })

  test('el nuevo NO decide: devuelve las dos lecturas para preguntarlas', () => {
    const j = normalizarComision(1)
    expect(j.ok).toBe(false)
    if (!j.ok && j.motivo === 'ambigua') {
      expect(j.opciones).toEqual([0.01, 1])
    } else {
      throw new Error('un "1" tiene que salir ambiguo')
    }
  })

  test('CONTROL NEGATIVO: el 0 y el 2 NO son ambiguos', () => {
    // Si todo numero pequeno saliera ambiguo, el flujo preguntaria siempre y la
    // pregunta dejaria de significar algo (automation bias). El 0 es "sin
    // comision" y nadie dice "dos" queriendo decir 200%.
    const cero = normalizarComision(0)
    expect(cero.ok).toBe(true)
    if (cero.ok) expect(cero.fraccion).toBe(0)

    const dos = normalizarComision(2)
    expect(dos.ok).toBe(true)
    if (dos.ok) expect(dos.fraccion).toBe(0.02)
  })

  test('la pregunta ensena las dos lecturas en pesos, no en fraccion', () => {
    const p = preguntaDeAmbiguedad('Su comision')
    expect(p).toContain('1%')
    expect(p).toContain('100%')
    expect(p).toContain(enPesos(0.01))
    expect(p).not.toContain('0.01 ')
  })
})

test.describe('Paso 5 · trampa 3: numeric(5,2) solo guarda porcentajes enteros', () => {
  test('el viejo redondeaba a CUATRO decimales y nunca se enteraba', () => {
    // Guarda 0.125, Postgres lo vuelve 0.13, y el TypeScript sigue creyendo
    // que guardo 12.5%. Quien redondea de verdad es la columna.
    expect(normalizadorViejo(12.5)).toBe(0.125)
  })

  test('el nuevo redondea a los dos decimales que la columna guarda', () => {
    const j = normalizarComision(12.5)
    expect(j.ok).toBe(true)
    if (j.ok) {
      expect(j.fraccion).toBe(0.13)
      expect(j.sobreviveElRedondeo).toBe(false)
      expect(avisoDeRedondeo(j)).toMatch(/13%/)
    }
  })

  test('el aviso dice el numero DICHO y el que queda, no dos veces el mismo', () => {
    // Salio en la prueba en vivo del 2026-09-19: el aviso usaba `enPorcentaje`
    // para los dos numeros, y `enPorcentaje` redondea a entero. El resultado
    // era "13% no cabe ... asi que quedaria 13%", un aviso que se contradice
    // solo y que parece un error del bot en vez de un limite de la columna.
    const j = normalizarComision(12.5)
    expect(j.ok).toBe(true)
    if (j.ok) {
      const aviso = avisoDeRedondeo(j) ?? ''
      expect(aviso).toContain('12.5%')
      expect(aviso).toContain('13%')
      // CONTROL NEGATIVO del control: que no diga "13% no cabe".
      expect(aviso).not.toMatch(/^⚠ 13% no cabe/)
    }
  })

  test('el porcentaje dicho se ensena sin inventarle decimales', () => {
    expect(enPorcentajeDicho(0.125)).toBe('12.5%')
    expect(enPorcentajeDicho(0.2)).toBe('20%')
    expect(enPorcentajeDicho(0.0125)).toBe('1.25%')
    // Y el que SI redondea, que es el que dice lo que se va a guardar.
    expect(enPorcentaje(0.125)).toBe('13%')
  })

  test('CONTROL NEGATIVO: un porcentaje entero NO levanta aviso', () => {
    // Si el aviso saliera siempre, dejaria de leerse.
    const j = normalizarComision(15)
    expect(j.ok).toBe(true)
    if (j.ok) {
      expect(j.sobreviveElRedondeo).toBe(true)
      expect(avisoDeRedondeo(j)).toBeNull()
    }
  })
})

// ============================================================================
// 3. CUALES COMISIONES SE PREGUNTAN (D10)
// ============================================================================

test.describe('Paso 5 · son tres las que mueven precio, y el rol decide cuales', () => {
  test('un DST lleva DOS: la suya y la de su local', () => {
    const cols = comisionesQueSePreguntan('DST').map((c) => c.columna)
    // En produccion los cinco DST tienen las dos distintas de cero. Preguntar
    // solo una deja la otra en 0 y eso es dinero mal repartido desde la primera
    // venta.
    expect(cols).toEqual(['comision_base', 'comision_hijo_local'])
  })

  test('un LOC lleva UNA', () => {
    expect(comisionesQueSePreguntan('LOC').map((c) => c.columna)).toEqual([
      'comision_base_local'
    ])
  })

  test('CONTROL NEGATIVO: la columna muerta no se pregunta en ningun rol', () => {
    for (const rol of ROLES_DE_ALTA) {
      const cols = comisionesQueSePreguntan(rol).map((c) => c.columna) as string[]
      expect(cols, `${rol} no debe preguntar ${COLUMNA_MUERTA}`).not.toContain(COLUMNA_MUERTA)
    }
    expect(COLUMNA_MUERTA).toBe('comision_logistica')
  })

  test('y se escribe 0 explicito, no se deja fuera del INSERT', () => {
    // Dejarla fuera la haria tomar el DEFAULT, que hoy es lo mismo — pero un
    // DEFAULT puede cambiar y esto no debe.
    const fuente = leer('lib/entidad-servidor.ts')
    expect(fuente).toContain('comision_logistica: 0')
  })
})

// ============================================================================
// 4. COMO SE LE ENSENA A UNA PERSONA
// ============================================================================

test.describe('Paso 5 · la comision se ensena en porcentaje Y en pesos', () => {
  test('"20% — de una caja de $600.00 se lleva $120.00"', () => {
    const t = explicarComision('Su comision', 0.2)
    expect(t).toContain('20%')
    expect(t).toContain('$600.00')
    expect(t).toContain('$120.00')
  })

  test('CONTROL NEGATIVO: la fraccion NUNCA aparece en el texto', () => {
    // `0.20` no significa nada para quien va a decir "va", y es el numero con
    // el que es facil equivocarse por un factor de cien.
    const t = explicarComision('Su comision', 0.2)
    expect(t).not.toContain('0.2')
    expect(enPorcentaje(0.3)).toBe('30%')
  })

  test('la caja de muestra es un numero redondo y visible', () => {
    expect(CAJA_DE_MUESTRA).toBe(600)
    expect(enPesos(0.15)).toBe('$90.00')
  })

  test('el mensaje del alta de un DST trae SUS DOS comisiones', () => {
    const payload = pagoDePrueba('DST')
    const m = mensajeDeAlta(payload, { nombrePadre: null, avisos: [], parecidas: [] })
    expect(m).toContain('Su comision cuando vende el')
    expect(m).toContain('Su comision cuando vende su local')
    expect(m).toContain('20%')
    expect(m).toContain('15%')
    expect(m).toContain('Efectivo (Prueba Ejecutor)')
  })

  test('el de un LOC trae UNA, y no anuncia contrasena', () => {
    const m = mensajeDeAlta(pagoDePrueba('LOC'), {
      nombrePadre: 'CEO Admin',
      avisos: [],
      parecidas: []
    })
    expect(m).toContain('Cuelga de: CEO Admin')
    expect(m).not.toContain('contrasena')
  })
})

// ============================================================================
// 5. LAS LISTAS CERRADAS (D9)
// ============================================================================

test.describe('Paso 5 · zona y rol son listas cerradas', () => {
  test('las dos zonas son las que el CHECK acepta, sin acento', () => {
    expect([...ZONAS]).toEqual(['Zacatecas', 'Foraneo'])
  })

  test('CONTROL NEGATIVO: "Foráneo" con acento NO vale', () => {
    // Es exactamente lo que devuelve una transcripcion de voz, y contra el
    // CHECK de la base no encuentra ningun precio de lista.
    expect(esZonaValida('Foráneo')).toBe(false)
    expect(esZonaValida('foraneo')).toBe(false)
    expect(esZonaValida('Zacatecas ')).toBe(false)
  })

  test('CONTROL NEGATIVO: ADMIN, SOCIO y SUB-ADMIN no se dan de alta por chat', () => {
    for (const rol of ['ADMIN', 'SOCIO', 'SUB-ADMIN', 'dst']) {
      expect(esRolDeAlta(rol), `${rol} no se crea hablando`).toBe(false)
    }
    expect(esRolDeAlta('DST')).toBe(true)
    expect(esRolDeAlta('LOC')).toBe(true)
  })

  test('el enrutador tiene PROHIBIDO extraer zona y rol', () => {
    const prompt = leer('bot/enrutador.py')
    expect(prompt).toMatch(/NUNCA pongas zona ni rol/)
  })
})

// ============================================================================
// 6. LA CONTRASENA (D11)
// ============================================================================

test.describe('Paso 5 · la contrasena la genera el servidor', () => {
  test('al menos 16 caracteres, y dos llamadas no coinciden', () => {
    const a = generarPassword()
    const b = generarPassword()
    expect(a.length).toBeGreaterThanOrEqual(LARGO_MINIMO_PASSWORD)
    expect(LARGO_MINIMO_PASSWORD).toBeGreaterThanOrEqual(16)
    expect(a).not.toBe(b)
  })

  test('un largo pedido por debajo del minimo NO lo baja', () => {
    expect(generarPassword(4).length).toBe(LARGO_MINIMO_PASSWORD)
  })

  test('CONTROL NEGATIVO: sin caracteres que se confundan al leerlos en voz alta', () => {
    // Esta contrasena se va a dictar o a copiar de la pantalla de un celular.
    let junto = ''
    for (let i = 0; i < 40; i += 1) junto += generarPassword(32)
    expect(junto).not.toMatch(/[0O1lI]/)
  })

  test('NO viaja en el borrador: se genera al confirmar', () => {
    // Meterla en el payload la dejaria en claro dentro de `bot_borradores`.
    expect([...LLAVES_ALTA]).not.toContain('password')
    const conf = leer('app/api/bot/entidad/confirmar/route.ts')
    expect(conf).toContain('generarPassword()')
    // En la propuesta solo se NOMBRA en un comentario; no se importa ni se
    // llama, que es lo que importa.
    const prop = leer('app/api/bot/entidad/proponer/route.ts')
    expect(prop).not.toContain('generarPassword(')
    // Una linea suelta `generarPassword,` es como se ve dentro de un bloque
    // de import; en un comentario el nombre va entre comillas invertidas.
    expect(prop).not.toMatch(/^\s*generarPassword,?\s*$/m)
  })

  test('y nunca se escribe en el log', () => {
    const conf = leer('app/api/bot/entidad/confirmar/route.ts')
    const lineaDeLog = /console\.info\([\s\S]*?\)/.exec(conf)?.[0] ?? ''
    expect(lineaDeLog).not.toContain('password')
    expect(lineaDeLog).toContain('[bot][alta]')
  })

  test('el mensaje final la ensena una sola vez, junto con el correo', () => {
    const m = mensajeDeAltaHecha(pagoDePrueba('DST'), 'AbCdEfGhJkMnPqRs')
    expect(m).toContain('AbCdEfGhJkMnPqRs')
    expect(m).toContain('no lo vuelvo a enseñar')
    // Y un LOC no recibe ninguna.
    expect(mensajeDeAltaHecha(pagoDePrueba('LOC'), null)).not.toContain('🔑')
  })
})

// ============================================================================
// 7. EL SELLO
// ============================================================================

test.describe('Paso 5 · el sello congela el alta entera', () => {
  test('cambiar UNA comision cambia el sello', () => {
    const a = pagoDePrueba('DST')
    const b: PayloadAlta = { ...a, comision_hijo_local: 0.99 }
    expect(sellarAlta(a)).not.toBe(sellarAlta(b))
    expect(selloAltaCoincide(b, sellarAlta(a))).toBe(false)
  })

  test('reordenar las llaves NO cambia el sello (jsonb las reordena solo)', () => {
    const a = pagoDePrueba('DST')
    const reordenado = JSON.parse(
      JSON.stringify({
        zona: a.zona,
        telefono: a.telefono,
        rol: a.rol,
        nombre: a.nombre,
        id_nodo_padre: a.id_nodo_padre,
        email: a.email,
        comision_hijo_local: a.comision_hijo_local,
        comision_base_local: a.comision_base_local,
        comision_base: a.comision_base
      })
    ) as PayloadAlta
    expect(selloAltaCoincide(reordenado, sellarAlta(a))).toBe(true)
  })

  test('las llaves selladas son exactamente las nueve del payload', () => {
    const payload = pagoDePrueba('DST')
    expect([...LLAVES_ALTA].sort()).toEqual(Object.keys(payload).sort())
  })

  test('el discriminador se mira ANTES que el sello', () => {
    // Un borrador de otra familia nunca empata el hash y caeria por la rama del
    // sello roto, que CANCELA: un error de enrutamiento borraria una captura
    // buena de alguien.
    const fuente = leer('app/api/bot/entidad/confirmar/route.ts')
    const iTipo = fuente.indexOf("guardado?.tipo !== 'alta_entidad'")
    const iSello = fuente.indexOf('selloAltaCoincide(fila, borrador.sello)')
    expect(iTipo).toBeGreaterThan(0)
    expect(iSello).toBeGreaterThan(iTipo)
  })
})

// ============================================================================
// 8. EL DUPLICADO POR NOMBRE (D12)
// ============================================================================

test.describe('Paso 5 · el duplicado se pregunta antes de crear', () => {
  test('se busca antes de las comisiones, no despues', () => {
    // Si va a resultar que ya existe, no tiene caso hacerle contestar tres
    // numeros primero.
    // Se comparan los sitios donde se LLAMAN, no donde se importan ni donde se
    // mencionan en un comentario: el orden que importa es el de ejecucion.
    const fuente = leer('app/api/bot/entidad/proponer/route.ts')
    const iDup = fuente.indexOf('await buscarParecidas(')
    const iCom = fuente.indexOf('of comisionesQueSePreguntan(')
    expect(iDup).toBeGreaterThan(0)
    expect(iCom).toBeGreaterThan(iDup)
  })

  test('la bandera de "es otro" la pone el BOT, nunca el modelo', () => {
    const bot = leer('bot/bot_gastos.py')
    expect(bot).toContain('peticion["aun_con_parecidas"] = True')
    // Y el enrutador no la conoce: no es un dato que se extraiga de una frase,
    // es un consentimiento.
    expect(leer('bot/enrutador.py')).not.toContain('aun_con_parecidas')
  })

  test('se usa la busqueda difusa que ya existe, no un criterio nuevo', () => {
    expect(leer('lib/entidad-servidor.ts')).toContain("from '@/lib/bot-nombres'")
  })
})

// ============================================================================
// 9. LA ESCRITURA
// ============================================================================

test.describe('Paso 5 · la entidad y su cuenta entran juntas', () => {
  test('por RPC, no por dos inserts con compensacion', () => {
    const fuente = leer('lib/entidad-servidor.ts')
    expect(fuente).toContain("supabase.rpc('crear_entidad_atomica'")
    // La compensacion por DELETE de la app desaparece: ERP-66 dice que un
    // DELETE denegado por RLS contesta 200 con cero filas.
    expect(fuente).not.toContain(".delete()")
  })

  test('exactamente UNA cuenta, y LIBRE', () => {
    const fuente = leer('lib/entidad-servidor.ts')
    expect(fuente).toContain('`Efectivo (${nombre})`')
    expect(fuente).toContain("tipo_fiscalidad: 'LIBRE'")
    expect(fuente).not.toContain('FULL_TAX')
  })

  test('el puente legacy se escribe por los dos lados', () => {
    // `id_nodo_padre` e `id_padre` se leen los dos para resolver al padre.
    const fuente = leer('lib/entidad-servidor.ts')
    expect(fuente).toContain('id_nodo_padre: datos.id_nodo_padre')
    expect(fuente).toContain('id_padre: datos.id_nodo_padre')
  })

  test('el usuario de Auth se borra si la RPC falla', () => {
    const fuente = leer('lib/entidad-servidor.ts')
    expect(fuente).toContain('await auth.borrar(authId)')
    // Y si el borrado tambien falla, se DICE: queda un correo ocupado.
    expect(fuente).toContain('huerfano')
  })

  test('la RPC es SECURITY INVOKER y no la puede llamar anon', () => {
    const sql = leer('supabase/migrations/20260919151846_fase5_crear_entidad_atomica.sql')
    expect(sql).toContain('SECURITY INVOKER')
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/)
    expect(sql).toMatch(/REVOKE EXECUTE[\s\S]*FROM PUBLIC, anon/)
  })
})

// ============================================================================
// utilidades
// ============================================================================

function pagoDePrueba(rol: 'DST' | 'LOC'): PayloadAlta {
  return {
    nombre: 'Prueba Ejecutor',
    rol,
    zona: 'Zacatecas',
    email: rol === 'DST' ? 'prueba@ejemplo.mx' : null,
    telefono: null,
    id_nodo_padre: null,
    comision_base: rol === 'DST' ? 0.2 : 0,
    comision_base_local: rol === 'LOC' ? 0.18 : 0,
    comision_hijo_local: rol === 'DST' ? 0.15 : 0
  }
}
