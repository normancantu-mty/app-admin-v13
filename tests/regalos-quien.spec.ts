import { test, expect } from '@playwright/test'
import { buscarQuien, etiquetaQuien, listaDeQuienes, normalizarQuien, quienExacto } from '@/lib/regalos-quien'

/** La lista cerrada de quien regala. Escrito el 2026-11-25 por el ejecutor del Socio. Nombres de prueba. */
test.describe('regalos-quien (pura)', () => {
  const lista = listaDeQuienes([
    { nombre: '  Casa   Verde ', rol: 'LOC' },
    { nombre: 'casa verde', rol: 'LOC' },
    { nombre: 'Casa Verde', rol: 'DST' },
    { nombre: 'Luis', rol: 'DST' },
    { nombre: 'Zutano', rol: 'SOCIO' },
    { nombre: 'CEO Admin', rol: 'ADMIN' },
    { nombre: '', rol: 'LOC' }
  ])

  test('equipo + DST y LOC; nada mas; los repetidos se distinguen', () => {
    expect(lista.map((q) => q.nombre)).toEqual(['Norman', 'Kevin', 'Cristian', 'Gilberto', 'Luis', 'Casa Verde', 'Casa Verde (distribuidor)', 'Luis (distribuidor)'])
    expect(lista.map(etiquetaQuien).slice(4)).toEqual(['Luis (equipo)', 'Casa Verde (local)', 'Casa Verde (distribuidor)', 'Luis (distribuidor)'])
  })

  test('al escribir solo vale el nombre completo (o Cris)', () => {
    expect(quienExacto('CASA VERDÉ', lista)?.nombre).toBe('Casa Verde')
    expect(quienExacto('cris', lista)?.nombre).toBe('Cristian')
    for (const t of ['casa', 'Zutano', 'CEO Admin', '', null]) expect(quienExacto(t, lista)).toBeNull()
  })

  test('tocayo exacto: se pregunta, y el tipo desempata', () => {
    expect(buscarQuien('Luis', lista)).toMatchObject({ ok: false, motivo: 'ambiguo' })
    expect(buscarQuien('casa verde', lista)).toMatchObject({ ok: false, motivo: 'ambiguo' })
    expect(buscarQuien('Casa Verde (distribuidor)', lista)).toMatchObject({ ok: true, quien: { tipo: 'distribuidor' } })
    expect(buscarQuien('Casa Verde (local)', lista)).toMatchObject({ ok: true, quien: { nombre: 'Casa Verde', tipo: 'local' } })
    expect(buscarQuien('Luis distribuidor', lista)).toMatchObject({ ok: true, quien: { nombre: 'Luis (distribuidor)' } })
    expect(buscarQuien('Luis (equipo)', lista)).toMatchObject({ ok: true, quien: { nombre: 'Luis', tipo: 'equipo' } })
    expect(buscarQuien('casa', lista)).toMatchObject({ ok: false, motivo: 'desconocido' })
    expect(normalizarQuien('Cris')).toBe('Cristian')
    expect(normalizarQuien('Norman')).toBe('Norman')
  })
})
