/**
 * ERP-83 - la receta de recuperacion va DENTRO del fallo, no en la cabeza de nadie.
 *
 * `apply_migration` del MCP sella la base y **no escribe el archivo del repo**.
 * La sesion que aplica se va creyendo que termino, y el unico detector -la prueba
 * de sincronia de ERP-73- se dispara TARDE: cuando alguien MAS intenta empujar.
 * Paso dos veces en tres dias (`20260912223650`, `20260914215544`).
 *
 * El diagnostico ya era bueno. Lo caro era el rato entre leerlo y saber que
 * teclear, y lo pagaba quien no habia aplicado nada.
 *
 * POR QUE ESTO NO ESCRIBE EL ARCHIVO SOLO, que seria lo obvio:
 * `public.migraciones_aplicadas()` devuelve version y nombre y **nunca el SQL**.
 * Es una decision de seguridad de su propia migracion (`20260912160653`): la
 * lista de migraciones de una base es informacion de reconocimiento, y su
 * contenido lo es mas. Un recuperador automatico exigiria exponer el SQL por
 * PostgREST. **Se prefiere teclear dos comandos a ensanchar esa superficie.**
 */
export function recetaDeRecuperacion(soloEnLaBase: string[]): string {
  if (soloEnLaBase.length === 0) return ''

  return soloEnLaBase
    .map((migracion) => {
      const version = migracion.split('_')[0]
      return [
        '',
        `  --- ${migracion}`,
        '      1) recupera su SQL:',
        "         SELECT array_to_string(statements, E'\n')",
        `         FROM supabase_migrations.schema_migrations WHERE version = '${version}';`,
        `      2) pegalo TAL CUAL en:  supabase/migrations/${migracion}.sql`,
        '      3) comprueba que es el mismo SQL y no uno parecido: el md5 de',
        '         statements en la base == el md5 del archivo SIN su salto final'
      ].join('\n')
    })
    .join('\n')
}
