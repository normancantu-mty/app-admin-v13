# El bot del ERP por Telegram — Fases 1, 2 y 3 (AG-01/AG-02)

**Que hace:** Norman manda *"gaste 340 de gasolina yendo a Zacatecas"* por texto o
nota de voz. El bot ensena la fila exacta que va a escribir, y **solo escribe
despues del "va"**.

**Quien captura:** Norman. *(Lo dijo el 2026-09-12: "Kevin no va a ser la ingesta
de datos, yo lo voy a hacer".)* El alta de mas personas sigue siendo posible y es
manual; la de abajo explica como.

**Compra de insumos SI entra**, desde el 2026-09-12. Es la unica categoria con
otra forma de fila: `COMPRA_INSUMOS` con la cuenta en `id_cuenta_origen`, porque
el dinero **sale**. La confirmacion se lo dice en palabras: *"el dinero SALE de
aqui"*. La tabla que manda es `FORMA_DE_FILA` en `lib/bot-gastos.ts`, y **no se
deduce del nombre de la categoria** — deducirlo fue E-237.

**COBRANZA (Fase 2) SI entra**, desde el 2026-09-12. Norman dice *"me deposito
Gilberto cinco mil"* y el bot reparte el pago entre los pedidos abiertos, del mas
viejo al mas nuevo (FIFO), con la misma funcion que usa la pantalla. Lo que no
cabe en ningun pedido entra como abono **a cuenta**, en su propia fila.

**Tres cosas de la cobranza que conviene saber antes de usarla:**

- **El bot nunca elige a quien le abona.** El modelo devuelve el NOMBRE que oyo
  ("Gilberto"); el servidor lo empata contra la cartera viva, y si hay mas de un
  candidato **pregunta con botones**. Escribir dinero en la entidad equivocada no
  se corrige solo: hay que anular la fila y recapturar.
- **Un abono puede escribir VARIAS filas** (una por pedido que cubre, mas una por
  el sobrante), y se escriben **en un solo INSERT**. Es la unica atomicidad que
  da este sistema.
- **Solo ADMIN.** Un abono va de la cuenta del deudor a una cuenta de la matriz.
  Una identidad DST no tiene a donde mandarlo y ademas caeria en el camino de
  `ABONO_PENDIENTE`, que es una maquinaria de aprobacion que el bot no tiene.

**CONSULTAS (Fase 3) SI entran:** *"cuanto me debe Delirio"*, *"a quien le hablo
primero"*.

**Que NO hace todavia:** ventas (Fase 4, bloqueada por ERP-11).

---

## Para arrancarlo hacen falta tres cosas, y solo una la tiene que hacer Norman

### 1. El token del bot de Telegram — **esto solo lo puede hacer Norman**

Es un bot NUEVO, no el del Socio. En Telegram:

1. Abre `@BotFather`, manda `/newbot`.
2. Nombre sugerido: `Gastos Fresnillo`. Usuario: el que acepte, por ejemplo
   `gastos_fresnillo_bot`.
3. BotFather devuelve un token. Ese token va a la variable de entorno de Windows:

```
setx BOT_GASTOS_TELEGRAM_TOKEN "el-token-que-te-dio-botfather"
```

### 2. Las dependencias de Python

```
pip install -r bot/requirements.txt
```

### 3. Levantarlo

La app tiene que estar corriendo (`npm run dev`, o el despliegue). Luego:

```
python bot/bot_gastos.py
```

Variables que lee, todas del entorno:

| Variable | Que es | Donde sale |
|---|---|---|
| `BOT_GASTOS_TELEGRAM_TOKEN` | el token del bot | BotFather (paso 1) |
| `BOT_API_TOKEN` | el secreto compartido con la app | ya esta en `.env` del repo |
| `ERP_API_URL` | a donde le habla | opcional, por defecto `http://localhost:3000` |

---

## El alta de personas — a mano, y solo Norman

Nadie se auto-registra. Para dar de alta a alguien hace falta su `telegram_id`
(le escribe al bot una vez y sale en `bot/bot_gastos.log`), y una fila:

```sql
insert into public.bot_identidades (telegram_id, etiqueta, id_entidad, id_cuenta_destino)
select <telegram_id>, 'norman', e.id, c.id
  from public.entidades e
  join public.cuentas_financieras c on c.id_entidad = e.id and c.nombre = 'Efectivo'
 where e.rol = 'ADMIN';
```

- **`etiqueta`** es lo que queda en `usuario_creador = 'telegram:<etiqueta>'`.
  Minusculas, sin espacios. Es lo unico que dice **quien** de planta capturo.
- Si algun dia entra mas de una persona, todas apuntan a la **misma entidad**: la
  captura es un puesto, no una persona. No se crea rol nuevo en el ERP.
- **`id_cuenta_destino` es la cuenta POR DEFECTO, no la unica.** El boton
  *"Cambiar cuenta"* ofrece las demas cuentas de la misma entidad que no esten
  vetadas, y **cambiar de cuenta vuelve a sellar**: el "va" nunca cubre una
  cuenta distinta de la que se enseno. Existe porque el default no puede ser
  correcto — medido el 2026-09-12, los gastos activos se reparten 10/10 entre
  Cuenta personal y Efectivo.
- La base **rechaza sola** una cuenta `FULL_TAX`, una cuenta con "fresnillo" en el
  nombre, o una cuenta que no sea de esa entidad. Probado el 2026-09-12 con los
  tres casos y un control positivo.

Dado de alta hoy: **Norman** (`telegram:norman` -> CEO Admin / Efectivo).

---

## Como esta hecho, en una pagina

```
texto o voz
   |
   v  bot/transcribir_nota.py  (faster-whisper large-v3 local, cae a CPU)
   v  bot/extraer.py           (claude -p --model haiku -> UN objeto de 4 campos)
   |
   v  POST /api/bot/gasto/proponer
        - resuelve telegram_id -> entidad (bot_identidades)
        - normaliza contra la LISTA CERRADA de categorias
        - desactiva el texto que movería el pasivo fiscal
        - busca duplicado reciente
        - guarda el borrador y lo SELLA (sha256)
   |
   v  la persona lee la fila y aprieta VA  (o corrige UN campo, sin volver al LLM)
   |
   v  POST /api/bot/gasto/confirmar   { telegram_id, borrador_id, sello }
        - NO recibe ninguna fila: la busca en la base
        - recalcula el hash y lo compara contra dos sellos
        - INSERT. Entre el sello y el INSERT no hay nada que el modelo pueda tocar.
```

El abono sigue **el mismo camino**, con `bot/extraer_abono.py` (Sonnet, no Haiku:
decidir a quien corresponde un pago exige criterio, no coincidencia de palabras) y
`/api/bot/abono/proponer` + `/api/bot/abono/confirmar`.

### 🔴 El sello tiene que sobrevivir a `jsonb`, y eso se PRUEBA

El borrador se guarda en `bot_borradores.payload`, que es **`jsonb`**, y `jsonb`
**reordena las llaves de cada objeto** (por longitud, luego alfabeticamente). Un
`{"id_ticket": ..., "monto": ...}` vuelve de la base como `{"monto": ...,
"id_ticket": ...}`.

La Fase 1 nunca lo vio porque su payload es plano: puros escalares. La Fase 2
lleva un arreglo de aplicaciones por pedido, y el primer dia el sello recalculado
no empataba con el guardado: el endpoint concluia *"la propuesta cambio desde que
te la ensene"*, cancelaba el borrador y **no se podia confirmar un solo abono**.
El sintoma apuntaba a un ataque que no existia.

Por eso `canonizar()` en `lib/bot-sello.ts` es **recursivo** (llaves anidadas en
orden alfabetico, que es el criterio de RFC 8785), y por eso `tests/bot-abonos.spec.ts`
incluye el viaje de ida y vuelta con el orden REAL copiado de produccion. **Las 24
pruebas puras pasaban en verde mientras la fase era incapaz de escribir**: ninguna
hacia el viaje por la base. Un sello que tiene que sobrevivir a un almacen se
prueba contra ese almacen.

**Las tres reglas que no se negocian:**

1. Nada se escribe sin confirmacion explicita. Es la especificacion, no una precaucion.
2. El LLM no escribe en campos que el sistema interpreta: categoria de lista
   cerrada, `categoria_gasto` siempre `NULL`, y la cuenta y el autor salen de la
   identidad, no de la propuesta. **En el abono esa columna NO puede ir en `NULL`**
   —lleva la referencia— y por eso sale de una lista cerrada del servidor: es la
   misma columna que lee `v_pasivo_fiscal` para dar por pagado un impuesto.
3. Lo que no mapea entra como `SIN_CATEGORIZAR` con aviso `W14`. **Nunca se
   rechaza la captura por una etiqueta**: perder la etiqueta es barato, perder el
   gasto es lo que lleva costando desde el 2026-06-09.
