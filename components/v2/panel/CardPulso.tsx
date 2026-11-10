/**
 * Tarjeta "Pulso" — junto a la de botellas, arriba del panel de la matriz.
 * Escrito el 2026-11-08 por un ejecutor del Socio. Dos preguntas de esta semana:
 * ¿que presentacion hay que reponer? y ¿a que local o distribuidor no le ha
 * llegado botella en mucho tiempo?
 *
 * Solo pinta: el calculo es `armarPulso` (`lib/pulso.ts`) y la lectura
 * `leerPulso` (`lib/pulso-leer.ts`), las mismas que usa `/pulso` del bot.
 * Server Component, sin JS de cliente. La cobranza NO va aqui: ya la pinta
 * «A quién cobrar» (`CardCobranza`) con sus dias sin abonar.
 */

import {
  LEYENDA_PULSO,
  MIN_COMPRAS_PARA_RITMO,
  SEMANAS_ALERTA_COBERTURA,
  textoSemanas,
  textoUltima,
  textoUmbral,
  textoVentana,
  UMBRAL_DIAS_SIN_SURTIR,
  uno,
  type Pulso
} from '@/lib/pulso'
import { num } from '@/lib/v2/formato'

/** Cuantos clientes con fecha se ven sin abrir el desplegable. */
const VISIBLES = 6

export function CardPulso({ datos, error }: { datos: Pulso | null; error?: string }) {
  if (!datos) {
    return (
      <section className="card" data-testid="card-pulso" style={{ marginBottom: 16 }}>
        <div className="hd">
          <div>
            <h2>Pulso</h2>
          </div>
        </div>
        <div className="aviso" data-testid="card-pulso-error">
          <b>No se pudo leer el pulso.</b>
          <span className="muted">{error || 'Error desconocido'}. El resto del panel no depende de esta tarjeta; /pulso en el bot usa la misma lectura.</span>
        </div>
      </section>
    )
  }
  const { cobertura: c, sinSurtir: s } = datos
  const reponer = c.filas.filter((f) => f.reponer)
  const visibles = s.filas.slice(0, VISIBLES)
  const resto = s.filas.slice(VISIBLES)

  const filaCliente = (f: (typeof s.filas)[number]) => (
    <tr key={f.id} style={f.atrasado ? { background: 'var(--crit-bg)' } : undefined}>
      <td>
        <b>{f.nombre}</b> <span className="chip">{f.rol === 'LOC' ? 'Local' : 'Distribuidor'}</span>
      </td>
      <td className="r">
        <b className={f.atrasado ? 'neg' : undefined}>
          {f.desdeArranque ? '≥' : ''}
          {num(f.dias ?? 0)} d
        </b>
        <div className="muted" style={{ fontSize: 11 }}>{textoUltima(f)}</div>
      </td>
      <td className="r muted" style={{ fontSize: 11.5 }}>
        {textoUmbral(f)}
        {f.atrasado ? <div className="neg">pasa por {num((f.dias ?? 0) - f.umbral)} d</div> : <div>faltan {num(f.umbral - (f.dias ?? 0) + 1)} d</div>}
      </td>
    </tr>
  )

  return (
    <section className="card" data-testid="card-pulso" style={{ marginBottom: 16 }}>
      <div className="hd">
        <div>
          <h2>Pulso: qué reponer y a quién llamar</h2>
          <div className="sub" data-testid="card-pulso-leyenda">{LEYENDA_PULSO}</div>
        </div>
        <span className={`chip${reponer.length || s.atrasados ? ' chile' : ''}`}>
          {reponer.length ? `Reponer ${reponer.map((f) => `${f.presentacion}ml`).join(', ')}` : 'Nada por reponer'} · {s.atrasados}{' '}
          {s.atrasados === 1 ? 'atrasado' : 'atrasados'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <div style={{ overflowX: 'auto' }}>
          <div className="sub" style={{ marginBottom: 4 }}>
            <b>Producto terminado en la matriz</b> · ritmo de {textoVentana(c)}
          </div>
          <table className="t" data-testid="pulso-cobertura">
            <thead>
              <tr>
                <th>Presentación</th>
                <th className="r">En matriz</th>
                <th className="r">Vende / sem</th>
                <th className="r">Alcanza</th>
              </tr>
            </thead>
            <tbody>
              {c.filas.map((f) => (
                <tr key={f.presentacion}>
                  <td>
                    <b>{f.presentacion} ml</b>
                  </td>
                  <td className="r">{num(f.stock)}</td>
                  <td className="r">{f.porSemana === null ? '—' : uno(f.porSemana)}</td>
                  <td className="r">
                    <b className={f.reponer ? 'neg' : undefined}>{textoSemanas(f, c.historiaInsuficiente)}</b>
                    {f.reponer && <div className="neg" style={{ fontSize: 11 }}>reponer</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 11 }}>
            «Reponer» = menos de {SEMANAS_ALERTA_COBERTURA} semanas al ritmo actual (umbral supuesto, no medido).
            {c.cortesiasFuera > 0 && ` ${num(c.cortesiasFuera)} cortesías también salieron y no están en el ritmo.`} No cuenta lo que
            hay en concesión en los locales.
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <div className="sub" style={{ marginBottom: 4 }}>
            <b>Días sin surtir</b> · atrasado = pasa su ritmo ({MIN_COMPRAS_PARA_RITMO}+ compras) o, sin historia, {UMBRAL_DIAS_SIN_SURTIR} días
          </div>
          <table className="t" data-testid="pulso-sin-surtir">
            <tbody>
              {s.filas.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    A ningún local ni distribuidor le ha llegado botella todavía.
                  </td>
                </tr>
              )}
              {visibles.map(filaCliente)}
            </tbody>
          </table>
          {resto.length > 0 && (
            <details>
              <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
                {resto.length} más
              </summary>
              <table className="t">
                <tbody>{resto.map(filaCliente)}</tbody>
              </table>
            </details>
          )}
          {s.nunca.length > 0 && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }} data-testid="pulso-nunca">
              Nunca surtidos ({s.nunca.length}): {s.nunca.map((f) => f.nombre).join(', ')}
            </div>
          )}
        </div>
      </div>
      <div className="fuente">transacciones_tickets · v_stock_por_cubeta · inventario_ledger (ENTRADA_CONCESION) · la misma lectura que /pulso</div>
    </section>
  )
}
