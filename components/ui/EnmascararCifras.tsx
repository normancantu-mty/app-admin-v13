'use client'

import { useEffect } from 'react'
import { ATRIBUTO, enmascararTexto, tieneCifra } from '@/lib/privacidad'

/**
 * El motor del modo privado. Se monta UNA vez en el layout del dashboard y no
 * pinta nada: trabaja sobre los nodos de texto que React ya puso.
 *
 * POR QUE ASI Y NO CON UN COMPONENTE `<Cifra>`
 * --------------------------------------------
 * Un componente exigiria tocar las ~64 llamadas a `formatCurrency` de las
 * pantallas, y **aun asi no alcanzaria** el dinero que el servidor incrusta
 * DENTRO de frases ya armadas: `lib/feed-utils.ts:215-255` y
 * `lib/dashboard-utils.ts:890-916` mandan cosas como
 * `"Gasto: Insumos - $1,000"` en un solo string. Recorriendo nodos de texto se
 * cubre el 100% de las pantallas, incluidas las que no existen todavia, con
 * cero retoque por pantalla.
 *
 * EL PRECIO, DICHO: se escribe en el DOM por debajo de React. Es seguro porque
 * solo se cambia `nodeValue` -- nunca se agregan ni se quitan nodos, que es lo
 * que de verdad rompe la reconciliacion. Cuando React repinta, el observador
 * lo detecta y vuelve a tapar.
 */

const SALTAR = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT'])

export function EnmascararCifras() {
  useEffect(() => {
    const raiz = document.documentElement

    // El original de cada nodo, y lo que YO escribi en el. Hacen falta los dos:
    // sin el segundo no se puede distinguir "React acaba de poner un valor
    // nuevo" de "este es el tapado que yo mismo puse", y al destapar se
    // restauraria un valor viejo. Es el bug silencioso de este patron.
    const originales = new WeakMap<Text, string>()
    const puestos = new WeakMap<Text, string>()

    let aplicando = false

    const recorrer = (nodo: Node, fn: (t: Text) => void) => {
      const paseador = document.createTreeWalker(nodo, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const padre = n.parentElement
          if (padre && SALTAR.has(padre.tagName)) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      let actual = paseador.nextNode()
      while (actual) {
        fn(actual as Text)
        actual = paseador.nextNode()
      }
    }

    const tapar = (n: Text) => {
      const actual = n.nodeValue ?? ''
      // Si lo que hay es exactamente lo que yo escribi, ya esta tapado.
      if (puestos.get(n) === actual) return
      // Si no, es contenido fresco de React: ese es el nuevo original.
      if (!tieneCifra(actual)) return
      const tapado = enmascararTexto(actual)
      if (tapado === actual) return
      originales.set(n, actual)
      puestos.set(n, tapado)
      n.nodeValue = tapado
    }

    const destapar = (n: Text) => {
      const actual = n.nodeValue ?? ''
      // Solo se restaura si lo que hay sigue siendo MI tapado. Si React ya lo
      // cambio, su valor manda -- el mio esta caduco.
      if (puestos.get(n) !== actual) return
      const original = originales.get(n)
      if (original == null) return
      n.nodeValue = original
      puestos.delete(n)
      originales.delete(n)
    }

    const pasada = (fn: (t: Text) => void, desde: Node = document.body) => {
      aplicando = true
      try {
        recorrer(desde, fn)
      } finally {
        observador.takeRecords()
        aplicando = false
      }
    }

    const observador = new MutationObserver((registros) => {
      if (aplicando) return
      if (raiz.getAttribute(ATRIBUTO) !== '1') return
      aplicando = true
      try {
        for (const r of registros) {
          if (r.type === 'characterData' && r.target.nodeType === Node.TEXT_NODE) {
            tapar(r.target as Text)
          }
          r.addedNodes.forEach((n) => {
            if (n.nodeType === Node.TEXT_NODE) tapar(n as Text)
            else if (n.nodeType === Node.ELEMENT_NODE) recorrer(n, tapar)
          })
        }
      } finally {
        observador.takeRecords()
        aplicando = false
      }
    })

    // El interruptor: se mira el atributo del <html>, que es lo que el boton
    // cambia. Asi el boton no necesita conocer este componente ni al reves.
    const alCambiarModo = () => {
      if (raiz.getAttribute(ATRIBUTO) === '1') {
        pasada(tapar)
        observador.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
        })
      } else {
        observador.disconnect()
        pasada(destapar)
      }
    }

    const vigilaAtributo = new MutationObserver(alCambiarModo)
    vigilaAtributo.observe(raiz, { attributes: true, attributeFilter: [ATRIBUTO] })

    alCambiarModo()

    return () => {
      vigilaAtributo.disconnect()
      observador.disconnect()
      pasada(destapar)
    }
  }, [])

  return null
}
