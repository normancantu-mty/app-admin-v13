/**
 * La cabecera interna con la que `proxy.ts` le dice al render de ESTA peticion
 * que ya verifico la sesion (valor: el `sub` del JWT). Escrito el 2026-10-30 por
 * el ejecutor de velocidad del Front v2.
 *
 * Es de confianza solo porque `proxy.ts` la BORRA de toda peticion entrante
 * (su `matcher` abarca todo lo que no es estatico) y solo la vuelve a poner
 * despues de `auth.getClaims()`. Una ruta que no pasa por la puerta protegida
 * (p. ej. `/api/...`) no la trae, y `getCurrentUser` vuelve a `getUser()`.
 */
export const CABECERA_SESION_VERIFICADA = 'x-erp-sesion-verificada'

