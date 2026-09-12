# El bot de gastos del ERP — Fase 1 (AG-01)

**Que hace:** Kevin (o quien este de turno en planta) manda *"gaste 340 de gasolina
yendo a Zacatecas"* por texto o nota de voz. El bot ensena la fila exacta que va a
escribir, y **solo escribe despues del "va"**.

**Que NO hace todavia:** abonos (Fase 2), consultas (Fase 3), ventas (Fase 4,
bloqueada por ERP-11). Tampoco compra de insumos: eso es `COMPRA_INSUMOS`, otra
forma de fila.

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
select <telegram_id>, 'kevin', e.id, c.id
  from public.entidades e
  join public.cuentas_financieras c on c.id_entidad = e.id and c.nombre = 'Efectivo'
 where e.rol = 'ADMIN';
```

- **`etiqueta`** es lo que queda en `usuario_creador = 'telegram:<etiqueta>'`.
  Minusculas, sin espacios. Es lo unico que dice **quien** de planta capturo.
- Las tres personas de planta apuntan a la **misma entidad** (la Matriz): la
  captura es un puesto, no una persona. No se crea rol nuevo en el ERP.
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

**Las tres reglas que no se negocian:**

1. Nada se escribe sin confirmacion explicita. Es la especificacion, no una precaucion.
2. El LLM no escribe en campos que el sistema interpreta: categoria de lista
   cerrada, `categoria_gasto` siempre `NULL`, y la cuenta y el autor salen de la
   identidad, no de la propuesta.
3. Lo que no mapea entra como `SIN_CATEGORIZAR` con aviso `W14`. **Nunca se
   rechaza la captura por una etiqueta**: perder la etiqueta es barato, perder el
   gasto es lo que lleva costando desde el 2026-06-09.
