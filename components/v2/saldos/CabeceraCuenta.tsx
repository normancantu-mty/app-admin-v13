/**
 * Front v2 — la cabecera de UNA cuenta (la que se esta viendo) y la tira compacta
 * de «Las demás cuentas». Escrito el 2026-10-30 por el ejecutor de saldos (lanzado
 * por el Socio).
 *
 * Regla de Norman (2026-10-30): el modal de un saldo se ENFOCA en su cuenta. La
 * cuenta abierta es la protagonista (su color de clase, su saldo grande); las demas
 * van atenuadas y chicas, y en la vista Sumado el total es contexto, no titular.
 * Solo presenta: las cifras llegan ya calculadas.
 *
 * El color de cada clase sale de `data-clase` (CSS `.vs-` al final de
 * `app/panel/v2.css`): Efectivo verde, Fresnillo azul, Gilberto ambar,
 * Transferencias chile.
 */

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CambiarModal } from '@/components/v2/modal/AbrirModal'
import { mxn } from '@/lib/v2/formato'

/** El titulo del modal con el color de la clase de la cuenta. */
export function TituloCuenta({ clase, children }: { clase: string | null; children: ReactNode }) {
  return (
    <span className="vs-tit" data-clase={clase ?? undefined}>
      <i aria-hidden="true" />
      {children}
    </span>
  )
}

export function CabeceraCuenta({
  clase,
  etiqueta = 'Saldo hoy',
  saldo,
  chips,
  children
}: {
  clase: string | null
  etiqueta?: string
  saldo: number
  /** Chips cortos (fiscalidad, solo egresos, clase). */
  chips?: ReactNode
  /** Lo que va bajo el saldo (cifras chicas, % del total...). */
  children?: ReactNode
}) {
  return (
    <div className="vs-heroe" data-clase={clase ?? undefined} data-testid="cuenta-heroe">
      <div className="vs-heroe-izq">
        <span className="vs-heroe-t">{etiqueta}</span>
        <span className={`vs-heroe-v${saldo < 0 ? ' neg' : ''}`}>{mxn(saldo)}</span>
        {chips && <span className="vs-heroe-chips">{chips}</span>}
      </div>
      {children && <div className="vs-heroe-der">{children}</div>}
    </div>
  )
}

export interface OtraCuenta {
  id: string
  nombre: string
  saldo: number
  href: string
  clase: string | null
}

/**
 * «Las demás cuentas»: una linea chica y atenuada para saltar a otra cuenta. La
 * cuenta abierta no se repite (ya es la cabecera). `como='cambiar'` dentro de un
 * modal; `'pagina'` en `/panel/finanzas` (Link con replace, sin scroll).
 */
export function OtrasCuentas({ cuentas, como }: { cuentas: OtraCuenta[]; como: 'cambiar' | 'pagina' }) {
  if (!cuentas.length) return null
  return (
    <nav className="vs-otras" aria-label="Las demás cuentas">
      <span className="vs-otras-t">Las demás cuentas</span>
      {cuentas.map((c) => {
        const cuerpo = (
          <>
            <i aria-hidden="true" />
            {c.nombre} <b className={c.saldo < 0 ? 'neg' : undefined}>{mxn(c.saldo)}</b>
          </>
        )
        return como === 'cambiar' ? (
          <span key={c.id} className="vs-otra" data-clase={c.clase ?? undefined}>
            <CambiarModal href={c.href}>{cuerpo}</CambiarModal>
          </span>
        ) : (
          <span key={c.id} className="vs-otra" data-clase={c.clase ?? undefined}>
            <Link href={c.href} replace scroll={false}>
              {cuerpo}
            </Link>
          </span>
        )
      })}
    </nav>
  )
}
