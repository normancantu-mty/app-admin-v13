# -*- coding: utf-8 -*-
"""Genera casos.jsonl (el conjunto de oro del cazador, WP-0).

Se edita ESTE archivo y se regenera: `python bot/oro/construir_casos.py`.

Convenciones de campos esperados (ver LEEME.md):
  - clave normal  = campo NUCLEO: cuenta en la comparacion estricta.
  - clave x_...   = campo EXTENDIDO: algo que el bot de hoy no modela
                    (subcategoria, evento, viaje, pagado_con...). Solo cuenta en
                    la comparacion completa.
"""
import json
import os

CASOS = []
_CONT = {}


def H(tipo, **campos):
    return {"tipo": tipo, "campos": campos}


def P(descripcion, cuando=None):
    return {"descripcion": descripcion, "cuando": cuando}


def K(cat, persona, chat, msgs, h=None, p=None, dest=None, charla=False, origen="sintetico"):
    n = _CONT.get(cat, 0) + 1
    _CONT[cat] = n
    CASOS.append({
        "id": "%s_%02d" % (cat, n),
        "categoria": cat,
        "persona": persona,
        "chat": chat,
        "mensajes": list(msgs) if isinstance(msgs, (list, tuple)) else [msgs],
        "hechos_esperados": h or [],
        "pendientes_esperados": p or [],
        "destinatario_esperado": dest,
        "es_charla": charla,
        "origen": origen,
    })


# ---------------------------------------------------------------- KEVIN COMPLETO
K("kevin_completo", "kevin", "grupo",
  "me llevé 10, vendí 6 a 450, me van a transferir, traigo 4",
  [H("salida_vendedor", quien="kevin", cantidad=10),
   H("venta", cantidad=6, precio_unitario=450, monto=2700, x_cobro="transferencia_pendiente"),
   H("inventario_vendedor", quien="kevin", cantidad=4)])
K("kevin_completo", "kevin", "grupo",
  ["me lleve 10 botellas grandes", "vendi 6 a 450 cada una", "me van a transferir el pago y me quedaron 4"],
  [H("salida_vendedor", quien="kevin", cantidad=10),
   H("venta", cantidad=6, precio_unitario=450, monto=2700, x_cobro="transferencia_pendiente"),
   H("inventario_vendedor", quien="kevin", cantidad=4)])
K("kevin_completo", "kevin", "grupo",
  "Norman me llevé 12 grandes vendí 8 a 450 me transfieren mañana y traigo 4 de regreso",
  [H("salida_vendedor", quien="kevin", cantidad=12),
   H("venta", cantidad=8, precio_unitario=450, monto=3600, x_cobro="transferencia_pendiente"),
   H("inventario_vendedor", quien="kevin", cantidad=4)],
  [P("recibir transferencia de las 8 vendidas", "mañana")], dest="norman")
K("kevin_completo", "kevin", "grupo",
  "salí con 20, vendí 15 a 450 y el cliente me paga por transferencia, me sobraron 5",
  [H("salida_vendedor", quien="kevin", cantidad=20),
   H("venta", cantidad=15, precio_unitario=450, monto=6750, x_cobro="transferencia_pendiente"),
   H("inventario_vendedor", quien="kevin", cantidad=5)])

# ---------------------------------------------------------------- KEVIN VARIANTES
K("kevin_variantes", "kevin", "grupo",
  "vendi 6 a 450 de contado, traigo el efectivo",
  [H("venta", cantidad=6, precio_unitario=450, monto=2700, x_cobro="efectivo"),
   H("efectivo_empresa", quien="kevin", monto=2700)])
K("kevin_variantes", "kevin", "grupo",
  "me llevé 10 y vendí las 10 a 450, ya me transfirieron",
  [H("salida_vendedor", quien="kevin", cantidad=10),
   H("venta", cantidad=10, precio_unitario=450, monto=4500, x_cobro="transferencia_recibida")])
K("kevin_variantes", "kevin", "grupo",
  "hoy no vendí nada, me traje las 10 de regreso",
  [H("inventario_vendedor", quien="kevin", cantidad=10)])
K("kevin_variantes", "kevin", "grupo",
  "me llevé 8 chicas, vendí 5 a 150, el cliente dijo que paga el viernes, traigo 3",
  [H("salida_vendedor", quien="kevin", cantidad=8),
   H("venta", cantidad=5, precio_unitario=150, monto=750, producto="chica", x_cobro="pendiente"),
   H("inventario_vendedor", quien="kevin", cantidad=3)],
  [P("cobrar las 5 chicas", "viernes")])
K("kevin_variantes", "kevin", "grupo",
  ["me llevé 10", "ya vendí 6 a 450"],
  [H("salida_vendedor", quien="kevin", cantidad=10),
   H("venta", cantidad=6, precio_unitario=450, monto=2700)])
K("kevin_variantes", "kevin", "grupo",
  "vendi 3 grandes a 450 y 2 mini a 60, me transfieren",
  [H("venta", cantidad=3, precio_unitario=450, monto=1350, producto="grande", x_cobro="transferencia_pendiente"),
   H("venta", cantidad=2, precio_unitario=60, monto=120, producto="mini", x_cobro="transferencia_pendiente")])

# ---------------------------------------------------------------- LOTE A MEDIAS
K("lote_a_medias", "norman", "privado",
  ["empezamos lote nuevo", "le entraron 40 kilos de chile", "y van a ser 8 dias de fermentacion"],
  [H("lote", kg_chile=40, dias_fermentacion=8)])
K("lote_a_medias", "norman", "privado",
  ["hoy arrancamos otro lote, 35 kilos de chile", "fermenta 10 dias"],
  [H("lote", kg_chile=35, dias_fermentacion=10)])
K("lote_a_medias", "kevin", "grupo",
  ["ya empezamos el lote", "metimos 50 kilos de chile jalapeño", "se queda 7 dias"],
  [H("lote", kg_chile=50, dias_fermentacion=7, x_tipo_chile="jalapeño")])
K("lote_a_medias", "norman", "privado",
  ["lote nuevo con 30 kilos", "ahorita no se cuantos dias, te digo luego"],
  [H("lote", kg_chile=30)],
  [P("decir los días de fermentación del lote nuevo", None)])
K("lote_a_medias", "trabajador", "grupo",
  ["arranque lote hoy", "42 kilos de chile", "dos tambos de 200 litros a 24 grados"],
  [H("lote", kg_chile=42, x_tandas=2)])
K("lote_a_medias", "norman", "privado",
  ["el lote L-1012 lleva 9 dias", "ya le toca envasar la semana que entra"],
  [H("lote", codigo_lote="L-1012", dias_fermentacion=9)],
  [P("envasar el lote L-1012", "semana que entra")])

# ---------------------------------------------------------------- FERMENTACION
K("fermentacion", "trabajador", "grupo",
  "tanque 2 va en el dia 5, 4.5 grados brix y 28 de temperatura",
  [H("lote", dias_fermentacion=5, x_tanque=2, x_grado=4.5, x_temperatura=28)])
K("fermentacion", "trabajador", "grupo",
  "el tambo 1 ya lleva 3 dias y burbujea bien, temperatura 26",
  [H("lote", dias_fermentacion=3, x_tanque=1, x_temperatura=26)])
K("fermentacion", "norman", "privado",
  "revise el lote L-1012, dia 9, grado 3.2, huele bien",
  [H("lote", codigo_lote="L-1012", dias_fermentacion=9, x_grado=3.2),
   H("nota", tema="huele bien")])
K("fermentacion", "trabajador", "grupo",
  "tanque 3 dia 7 grado 2.8 temp 30 se subio un poco la temperatura",
  [H("lote", dias_fermentacion=7, x_tanque=3, x_grado=2.8, x_temperatura=30),
   H("nota", tema="temperatura")])
K("fermentacion", "kevin", "grupo",
  "ya paso la fermentacion del tambo 2, dia 10, grado 2",
  [H("lote", dias_fermentacion=10, x_tanque=2, x_grado=2)])
K("fermentacion", "trabajador", "grupo",
  "lectura del tanque 1 hoy 6.1 de azucar",
  [H("lote", x_tanque=1, x_grado=6.1)])

# ---------------------------------------------------------------- ENVASADO
K("envasado", "norman", "privado",
  "hoy envasamos 24 de 750",
  [H("lote", botellas=24, formato="750")])
K("envasado", "trabajador", "grupo",
  "envasamos 40 chicas hoy sin lote abierto, no sé de cual salieron",
  [H("lote", botellas=40, formato="250")])
K("envasado", "norman", "privado",
  "del lote L-0915 salieron 40 de 250",
  [H("lote", codigo_lote="L-0915", botellas=40, formato="250")])
K("envasado", "kevin", "grupo",
  ["envasamos", "60 minis", "del lote nuevo"],
  [H("lote", botellas=60, formato="50")])
K("envasado", "trabajador", "grupo",
  "salieron 18 grandes y 30 chicas del envasado de hoy",
  [H("lote", botellas=18, formato="750"), H("lote", botellas=30, formato="250")])
K("envasado", "norman", "privado",
  "envasamos 100 minis, ahorita no tengo el lote, lo busco",
  [H("lote", botellas=100, formato="50")],
  [P("buscar el código del lote del envasado de 100 minis", None)])

# ---------------------------------------------------------------- ADITIVO
K("aditivo", "norman", "privado",
  "hoy probamos goma xantana, le pusimos 20 g al tanque 2",
  [H("aditivo", nombre="goma xantana", cantidad=20, unidad="g", x_destino="tanque 2")])
K("aditivo", "trabajador", "grupo",
  "le eché medio litro de vinagre de manzana al tambo 1 para probar",
  [H("aditivo", nombre="vinagre de manzana", cantidad=0.5, unidad="l", x_destino="tambo 1")])
K("aditivo", "norman", "privado",
  "probe con 5 gramos de acido citrico en el lote L-1012 a ver si baja el pH",
  [H("aditivo", nombre="acido citrico", cantidad=5, unidad="g", x_destino="L-1012")])
K("aditivo", "trabajador", "grupo",
  "le puse una cucharada de sal extra al tanque 3",
  [H("aditivo", nombre="sal", x_destino="tanque 3")])
K("aditivo", "norman", "privado",
  "metí 100 ml de jugo de limón al tanque 1, experimento nuevo",
  [H("aditivo", nombre="jugo de limon", cantidad=100, unidad="ml", x_destino="tanque 1")])
K("aditivo", "kevin", "grupo",
  "hoy probamos conservador sorbato de potasio 3 gramos por litro en el lote del lunes",
  [H("aditivo", nombre="sorbato de potasio", cantidad=3, unidad="g/l")])

# ---------------------------------------------------------------- VARIABLE NUEVA
K("variable_nueva", "norman", "privado",
  "quiero empezar a medir el pH de cada lote, el de hoy salió en 3.6",
  [H("variable", nombre="ph", valor=3.6)])
K("variable_nueva", "trabajador", "grupo",
  "midi la humedad de la bodega y esta en 65 por ciento",
  [H("variable", nombre="humedad bodega", valor=65)])
K("variable_nueva", "norman", "privado",
  "de ahora en adelante anotemos la turbidez, hoy salió en 12 NTU",
  [H("variable", nombre="turbidez", valor=12)])

# ---------------------------------------------------------------- NOTAS
K("nota", "norman", "privado", "el 7 salió más picoso",
  [H("nota", tema="lote 7 mas picoso")])
K("nota", "kevin", "grupo", "el cliente dice que la etiqueta se despega",
  [H("nota", tema="etiqueta se despega")])
K("nota", "trabajador", "grupo", "el tapon de la botella grande queda flojo a veces",
  [H("nota", tema="tapon flojo")])
K("nota", "norman", "privado", "a Gilberto le gustó más la de 250 que la grande, lo anoto",
  [H("nota", tema="gilberto prefiere 250")])
K("nota", "kevin", "grupo", "en la feria la gente preguntaba mucho si trae picante o no",
  [H("nota", tema="preguntan si pica")])
K("nota", "trabajador", "grupo", "el lote de ayer quedo mas clarito que los otros",
  [H("nota", tema="lote mas claro")])
K("nota", "norman", "privado", "idea: sacar una presentacion de 100ml para regalo",
  [H("nota", tema="presentacion 100ml")])
K("nota", "kevin", "grupo", "Delirio dice que la etiqueta nueva se ve mejor",
  [H("nota", tema="etiqueta nueva se ve mejor")])

# ---------------------------------------------------------------- VIAJES
K("viaje", "norman", "privado",
  "compre el vuelo a Monterrey, 3200 pesos, me llego el comprobante por correo",
  [H("gasto", monto=3200, x_subcategoria="vuelo", x_viaje="monterrey", x_comprobante=True)])
K("viaje", "norman", "privado", "pague el vuelo a CDMX 2850 con mi tarjeta, no me dieron factura",
  [H("gasto", monto=2850, x_subcategoria="vuelo", x_viaje="cdmx", x_comprobante=False, x_pagado_con="personal")])
K("viaje", "kevin", "grupo", "saqué el vuelo a Guadalajara en 1900, ahí te mando el pdf",
  [H("gasto", monto=1900, x_subcategoria="vuelo", x_viaje="guadalajara", x_comprobante=True)])
K("viaje", "norman", "privado", "hotel en Monterrey 2 noches 1800 total, tengo la factura",
  [H("gasto", monto=1800, x_subcategoria="hotel", x_viaje="monterrey", x_comprobante=True)])
K("viaje", "kevin", "grupo", "pague hotel 950 la noche, una noche, sin recibo porque era hotelito",
  [H("gasto", monto=950, x_subcategoria="hotel", x_comprobante=False)])
K("viaje", "norman", "privado", "airbnb en cdmx 3 noches me costo 4200",
  [H("gasto", monto=4200, x_subcategoria="hotel", x_viaje="cdmx")])
K("viaje", "kevin", "grupo", "gasolina 780 para ir a Zacatecas",
  [H("gasto", monto=780, categoria="Logistica_Envios", x_subcategoria="gasolina", x_viaje="zacatecas")])
K("viaje", "norman", "privado", "eché gasolina 650 y 400 mas de regreso",
  [H("gasto", monto=650, x_subcategoria="gasolina"), H("gasto", monto=400, x_subcategoria="gasolina")])
K("viaje", "trabajador", "grupo", "casetas del viaje a Durango 540 en total, tengo los tickets",
  [H("gasto", monto=540, x_subcategoria="casetas", x_viaje="durango", x_comprobante=True)])
K("viaje", "kevin", "grupo", "casetas 220 ida y 220 vuelta, no guardé los tickets",
  [H("gasto", monto=440, x_subcategoria="casetas", x_comprobante=False)])
K("viaje", "norman", "privado", "comidas del viaje 680, con ticket",
  [H("gasto", monto=680, x_subcategoria="comidas", x_comprobante=True)])
K("viaje", "kevin", "grupo", "comi en la carretera 150 y cene 220 sin ticket",
  [H("gasto", monto=150, x_subcategoria="comidas", x_comprobante=False),
   H("gasto", monto=220, x_subcategoria="comidas", x_comprobante=False)])
K("viaje", "norman", "privado", "taxi del aeropuerto al hotel 380",
  [H("gasto", monto=380, x_subcategoria="transporte local")])
K("viaje", "kevin", "grupo", "uber 120 a la planta y 135 de regreso",
  [H("gasto", monto=120, x_subcategoria="transporte local"),
   H("gasto", monto=135, x_subcategoria="transporte local")])

# ---------------------------------------------------------------- EVENTOS: SALIDAS
K("evento_salidas", "kevin", "grupo",
  "llevamos 60 botellas a la feria del chile",
  [H("evento_salida", tipo_salida="llevadas", cantidad=60, x_evento="feria del chile")])
K("evento_salidas", "kevin", "grupo",
  "ya vendimos 22 en la feria",
  [H("evento_salida", tipo_salida="vendidas", cantidad=22, x_evento="feria")])
K("evento_salidas", "kevin", "grupo",
  "regalamos 4 botellas a unos organizadores",
  [H("evento_salida", tipo_salida="regaladas", cantidad=4)])
K("evento_salidas", "trabajador", "grupo",
  "se nos rompieron 2 botellas al descargar",
  [H("evento_salida", tipo_salida="rotas", cantidad=2)])
K("evento_salidas", "kevin", "grupo",
  "para la degustacion abrimos 3 botellas de 750",
  [H("evento_salida", tipo_salida="degustacion", cantidad=3)])
K("evento_salidas", "kevin", "grupo",
  ["cerramos el dia en la feria", "llevamos 40, vendimos 25, regalamos 3, se rompio 1"],
  [H("evento_salida", tipo_salida="llevadas", cantidad=40),
   H("evento_salida", tipo_salida="vendidas", cantidad=25),
   H("evento_salida", tipo_salida="regaladas", cantidad=3),
   H("evento_salida", tipo_salida="rotas", cantidad=1)])
K("evento_salidas", "norman", "privado",
  "en el tianguis del domingo se vendieron 18 grandes y 10 chicas",
  [H("evento_salida", tipo_salida="vendidas", cantidad=18, producto="grande"),
   H("evento_salida", tipo_salida="vendidas", cantidad=10, producto="chica")])

# ---------------------------------------------------------------- EVENTOS: GASTOS
K("evento_gasto", "kevin", "grupo",
  "pague el stand de la feria 1500, con recibo",
  [H("gasto", monto=1500, x_subcategoria="stand", x_evento="feria", x_comprobante=True)])
K("evento_gasto", "kevin", "grupo",
  "hielo y vasos para la degustacion 230 pesos",
  [H("gasto", monto=230, x_subcategoria="degustacion", x_evento="feria")])
K("evento_gasto", "trabajador", "grupo",
  "ayudante del evento le pague 400 en efectivo",
  [H("gasto", monto=400, x_subcategoria="ayudante", x_evento="evento")])
K("evento_gasto", "kevin", "grupo",
  "estacionamiento de la feria 120 y comida del equipo 350",
  [H("gasto", monto=120, x_subcategoria="estacionamiento", x_evento="feria"),
   H("gasto", monto=350, x_subcategoria="comidas", x_evento="feria")])

# ---------------------------------------------------------------- EVENTOS: COMPRA DE INSUMOS EN EL EVENTO
K("evento_compra", "kevin", "grupo",
  "se nos acabaron los vasitos y compre 200 en la tienda de aqui por 85 pesos, para la degustacion de la feria",
  [H("gasto", monto=85, categoria="Insumos", x_subcategoria="vasos degustacion", x_evento="feria",
     x_pagado_con="personal")])
K("evento_compra", "trabajador", "grupo",
  "compré cinta y bolsas en el evento por 140 porque se nos acabaron",
  [H("gasto", monto=140, categoria="Insumos", x_evento="evento")])
K("evento_compra", "kevin", "grupo",
  "tuve que comprar 2 hieleras de emergencia en la feria, 560 las dos, hay ticket",
  [H("gasto", monto=560, categoria="Insumos", x_evento="feria", x_comprobante=True)])

# ---------------------------------------------------------------- EVENTOS: BALANCE
K("evento_balance", "kevin", "grupo",
  "llevamos 60, vendimos 38, regalamos 5, se rompieron 2 y regresaron 12, pero me faltan 3",
  [H("evento_salida", tipo_salida="llevadas", cantidad=60),
   H("evento_salida", tipo_salida="vendidas", cantidad=38),
   H("evento_salida", tipo_salida="regaladas", cantidad=5),
   H("evento_salida", tipo_salida="rotas", cantidad=2),
   H("evento_salida", tipo_salida="regresadas", cantidad=12),
   H("balance_evento", diferencia=3)],
  [P("revisar dónde están 3 botellas que no cuadran del evento", None)])
K("evento_balance", "trabajador", "grupo",
  "no cuadra la caja de la feria, deberia haber 4500 y solo hay 4100",
  [H("balance_evento", diferencia=400, x_evento="feria")],
  [P("revisar diferencia de $400 en la caja de la feria", None)])
K("evento_balance", "norman", "privado",
  ["Kevin dice que llevo 30 y vendio 20 y regalo 2", "pero le regresaron 5, hay 3 botellas de mas o de menos"],
  [H("evento_salida", tipo_salida="llevadas", cantidad=30),
   H("evento_salida", tipo_salida="vendidas", cantidad=20),
   H("evento_salida", tipo_salida="regaladas", cantidad=2),
   H("evento_salida", tipo_salida="regresadas", cantidad=5),
   H("balance_evento", diferencia=3)],
  [P("aclarar la diferencia de 3 botellas con Kevin", None)])

# ---------------------------------------------------------------- DINERO PERSONAL / PRESTAMOS
K("dinero", "norman", "privado",
  "pagué 850 de cajas con mi tarjeta personal, me lo reembolsa la empresa",
  [H("gasto", monto=850, descripcion="cajas", x_pagado_con="personal")],
  [P("reembolsar a Norman los 850 de cajas", None)])
K("dinero", "kevin", "grupo",
  "puse de mi bolsa 300 para la gasolina de la camioneta",
  [H("gasto", monto=300, x_subcategoria="gasolina", x_pagado_con="personal")],
  [P("reembolsar a Kevin 300 de gasolina", None)])
K("dinero", "norman", "privado",
  "compre pegamento 120 con mi dinero, luego me lo pasan",
  [H("gasto", monto=120, descripcion="pegamento", x_pagado_con="personal")])
K("dinero", "trabajador", "grupo",
  "pague de mi bolsillo la etiqueta que faltaba 180 pesos",
  [H("gasto", monto=180, descripcion="etiqueta", x_pagado_con="personal")])
K("prestamo", "trabajador", "grupo",
  "Norman te presto 2000 para que pagues las botellas, me los devuelves el lunes",
  [H("prestamo", de="trabajador", a="norman", monto=2000)],
  [P("devolver 2000 al trabajador", "lunes")], dest="norman")
K("prestamo", "kevin", "grupo",
  "Norman ahi te dejé 5 mil pesos de mi cuenta, de prestamo, cuando puedas",
  [H("prestamo", de="kevin", a="norman", monto=5000)],
  [P("devolver 5000 a Kevin", "cuando pueda")], dest="norman")
K("prestamo", "norman", "privado",
  "le devolví a Kevin los 2000 que me prestó",
  [H("devolucion_prestamo", de="norman", a="kevin", monto=2000)])
K("prestamo", "norman", "privado",
  "Fany me prestó 3000 para la nómina, se los regreso en quincena",
  [H("prestamo", de="fany", a="norman", monto=3000)],
  [P("devolver 3000 a Fany", "quincena")])
K("prestamo", "trabajador", "grupo",
  "ya me regresaste los 2000 que te preste, gracias, quedamos a mano",
  [H("devolucion_prestamo", de="norman", a="trabajador", monto=2000)], dest="norman")
K("efectivo", "kevin", "grupo",
  "traigo 3500 en efectivo de la venta del sabado, son de la empresa",
  [H("efectivo_empresa", quien="kevin", monto=3500)])
K("efectivo", "trabajador", "grupo",
  "me quedé con 1200 de efectivo de las ventas, los guardo y te los doy el lunes",
  [H("efectivo_empresa", quien="trabajador", monto=1200)],
  [P("entregar 1200 de efectivo a Norman", "lunes")])
K("efectivo", "kevin", "grupo",
  "traigo 800 pesos de la empresa en la bolsa, de lo que sobró del evento",
  [H("efectivo_empresa", quien="kevin", monto=800, x_evento="evento")])
K("cobro_prometido", "norman", "privado",
  "Delirio me dijo que el viernes me paga los 3 mil",
  [H("cobro_prometido", deudor="delirio", monto=3000, fecha="viernes")])
K("cobro_prometido", "kevin", "grupo",
  "el del aeropuerto dice que la otra semana liquida los 4200",
  [H("cobro_prometido", deudor="aeropuerto", monto=4200, fecha="otra semana")])
K("cobro_prometido", "norman", "privado",
  "Casa Verde se comprometio a pagarme 1440 el dia 25",
  [H("cobro_prometido", deudor="casa verde", monto=1440, fecha="25")])
K("cobro_prometido", "norman", "privado",
  "Dulceria Ruiz promete pagar 2500 el lunes y 2500 el lunes siguiente",
  [H("cobro_prometido", deudor="dulceria ruiz", monto=2500, fecha="lunes"),
   H("cobro_prometido", deudor="dulceria ruiz", monto=2500, fecha="lunes siguiente")])

# ---------------------------------------------------------------- PENDIENTES
K("pendiente", "norman", "privado", "mañana le hablo al de botellas",
  p=[P("hablarle al proveedor de botellas", "mañana")])
K("pendiente", "norman", "privado", "el jueves pasan por las cajas",
  p=[P("recogen las cajas", "jueves")])
K("pendiente", "kevin", "grupo", "falta pedir etiquetas, lo hago el lunes",
  p=[P("pedir etiquetas", "lunes")])
K("pendiente", "norman", "privado", "recordarme cotizar tapones con el proveedor nuevo la proxima semana",
  p=[P("cotizar tapones con proveedor nuevo", "próxima semana")])
K("pendiente", "trabajador", "grupo", "hay que limpiar el tanque 2 antes de que llegue el lote nuevo",
  p=[P("limpiar el tanque 2", "antes del lote nuevo")])
K("pendiente", "norman", "privado", "pasado mañana llevo el contrato a firmar con Gilberto",
  p=[P("llevar contrato a firmar con Gilberto", "pasado mañana")])
K("pendiente", "kevin", "grupo", "mañana paso a cobrarle a Casa Verde",
  p=[P("cobrarle a Casa Verde", "mañana")])

# ---------------------------------------------------------------- CATEGORIA
K("categoria", "norman", "privado", "gasto 1200 gas",
  [H("gasto", monto=1200, categoria="Servicios_Basicos")], origen="real")
K("categoria", "norman", "privado", "pague 480 de manychat",
  [H("gasto", monto=480, categoria="Marketing_y_Relaciones")])
K("categoria", "norman", "privado", "luz de la planta 960",
  [H("gasto", monto=960, categoria="Servicios_Basicos")])
K("categoria", "norman", "privado", "le pagué 2500 a mi contador por los honorarios del mes",
  [H("gasto", monto=2500, categoria="Nomina_y_Honorarios")])
K("categoria", "norman", "privado", "compre 5 kilos de sal y un cubo, 340",
  [H("gasto", monto=340, categoria="Insumos")])
K("categoria", "norman", "privado", "pague la cuota del seguro del auto personal 1800",
  [H("gasto", monto=1800, categoria="Gastos_Personales_Socio")])
K("categoria", "norman", "privado", "pagué la renta del coworking 1500, categoría Renta de oficina",
  [H("gasto", monto=1500, x_categoria_nueva="Renta de oficina")])
K("categoria", "norman", "privado", "compré un diploma enmarcado de certificación 650",
  [H("gasto", monto=650, x_categoria_nueva=True)])

# ---------------------------------------------------------------- MULTI HECHO
K("multi_hecho", "norman", "privado",
  "gasté 200 pesos en gasolina y vendí 2 de 750 a público",
  [H("gasto", monto=200, descripcion="gasolina"), H("venta", cantidad=2, producto="grande", comprador="publico")])
K("multi_hecho", "norman", "privado",
  "vendí 2 chicas a aeropuerto y me abonó 1000",
  [H("venta", cantidad=2, producto="chica", comprador="aeropuerto"), H("abono", deudor="aeropuerto", monto=1000)])
K("multi_hecho", "norman", "privado",
  "Se vendió una botella grande de 599 pesos, el envío fue 45 pesos",
  [H("venta", cantidad=1, monto=599, producto="grande"), H("gasto", monto=45, descripcion="envio")],
  origen="real")
K("multi_hecho", "kevin", "grupo",
  "vendí 4 grandes a 450, compré hielo 80, y traigo 6 botellas",
  [H("venta", cantidad=4, precio_unitario=450, monto=1800, producto="grande"),
   H("gasto", monto=80, descripcion="hielo"),
   H("inventario_vendedor", quien="kevin", cantidad=6)])
K("multi_hecho", "norman", "privado",
  "gaste 10 en papel, 20 en cinta y 30 en gasolina",
  [H("gasto", monto=10, descripcion="papel"), H("gasto", monto=20, descripcion="cinta"),
   H("gasto", monto=30, descripcion="gasolina")])

# ---------------------------------------------------------------- CORRECCIONES
K("correccion", "norman", "privado", ["gaste 45 de envio", "no, eran 8", "perdon, eran 80"],
  [H("gasto", monto=80, descripcion="envio")])
K("correccion", "kevin", "grupo", ["vendí 6 a 450", "no, fueron 8"],
  [H("venta", cantidad=8, precio_unitario=450)])
K("correccion", "norman", "privado", ["Delirio me abonó 3000", "no, 3500"],
  [H("abono", deudor="delirio", monto=3500)])
K("correccion", "norman", "privado", ["vendí 2 grandes a público", "fue a Casa Verde, no a público"],
  [H("venta", cantidad=2, producto="grande", comprador="casa verde")])
K("correccion", "trabajador", "grupo", ["envasamos 40 de 250", "bueno no, fueron 36"],
  [H("lote", botellas=36, formato="250")])

# ---------------------------------------------------------------- DIRIGIDO A ALGUIEN
K("dirigido", "norman", "privado",
  "Kevin ya te transferí los 450 de la gasolina",
  [H("gasto", monto=450, descripcion="gasolina")], dest="kevin")
K("dirigido", "norman", "grupo",
  "Kevin mañana pasas por 12 botellas al almacén",
  p=[P("Kevin pasa por 12 botellas al almacén", "mañana")], dest="kevin")
K("dirigido", "kevin", "grupo",
  "Norman ya deposité el efectivo de la venta, eran 2700",
  [H("efectivo_empresa", quien="kevin", monto=2700)], dest="norman")
K("dirigido", "norman", "grupo",
  "Fany por favor cotizale a Casa Verde 7 grandes",
  [H("cotizacion", cliente="casa verde", cantidad=7, producto="grande")], dest="fany")
K("dirigido", "trabajador", "grupo",
  "Norman se acabaron los tapones, ¿puedes pedir?",
  p=[P("pedir tapones", None)], dest="norman")

# ---------------------------------------------------------------- REALES (del log y de bot_borradores)
K("real", "norman", "privado", "Gasto 750 tambo para fermentacion",
  [H("gasto", monto=750, descripcion="tambo")], origen="real")
K("real", "norman", "privado", "Gastos 181 en agente de mensajería.",
  [H("gasto", monto=181, descripcion="mensajeria")], origen="real")
K("real", "norman", "privado", "Gasto de 480 many chat",
  [H("gasto", monto=480, descripcion="manychat")], origen="real")
K("real", "norman", "privado", "Compra de cubetas en $4,000 pesos. Gasto",
  [H("gasto", monto=4000, descripcion="cubetas")], origen="real")
K("real", "norman", "privado", "Compra de $360 pesos. Cosas para producción, mangueras y tubos.",
  [H("gasto", monto=360, descripcion="mangueras")], origen="real")
K("real", "norman", "privado", "david me da 2500",
  [H("abono", deudor="david", monto=2500)], origen="real")
K("real", "norman", "privado", "Recibo 10176 de aeropuerto",
  [H("abono", deudor="aeropuerto", monto=10176)], origen="real")
K("real", "norman", "privado", "Dulceria el eden me dio $5,413.00",
  [H("abono", deudor="dulceria el eden", monto=5413)], origen="real")
K("real", "norman", "privado", "Delirio acaba de abonar 11.484 pesos.",
  [H("abono", deudor="delirio", monto=11484)], origen="real")
K("real", "norman", "privado", "Venta a concesion 7 botellas grandes a Casa Verde.",
  [H("venta", cantidad=7, producto="grande", comprador="casa verde", condicion_pago="concesion")], origen="real")
K("real", "norman", "privado", "Le dimos al aeropuerto 12 grandes, 12 chicas y 48 minis, fue venta a concesion",
  [H("venta", comprador="aeropuerto", cantidad=72, condicion_pago="concesion")], origen="real")
K("real", "norman", "privado", "Cotización para Casa Verde, 7 botellas grandes.",
  [H("cotizacion", cliente="casa verde", cantidad=7, producto="grande")], origen="real")
K("real", "norman", "privado", "Cotízame para Gilberto 24 botellas grandes",
  [H("cotizacion", cliente="gilberto", cantidad=24, producto="grande")], origen="real")
K("real", "norman", "privado", "Quiero una cotización de 3 chicas para Público en general",
  [H("cotizacion", cliente="publico en general", cantidad=3, producto="chica")], origen="real")
K("real", "norman", "privado", "gasto de envio 45 pesos",
  [H("gasto", monto=45, descripcion="envio")], origen="real")
K("real", "kevin", "grupo", "gaste 300 de gasolina",
  [H("gasto", monto=300, descripcion="gasolina")], origen="real")
K("real", "norman", "privado", "Gasto 3900 insumo",
  [H("gasto", monto=3900, categoria="Insumos")], origen="real")

# ---------------------------------------------------------------- CONSULTAS (no escriben, no son charla)
K("consulta", "norman", "privado", "cuanto me debe aeropuerto", origen="real")
K("consulta", "norman", "privado", "como vamos hoy", origen="real")
K("consulta", "norman", "privado", "cuanto vendimos este mes?")
K("consulta", "kevin", "grupo", "cuanto stock tengo de grandes?")

# ---------------------------------------------------------------- CHARLA (>= 25 %)
_CHARLA = [
    ("norman", "privado", "buenos dias"),
    ("norman", "privado", "que onda", "real"),
    ("norman", "privado", "que pedo", "real"),
    ("norman", "privado", "no se", "real"),
    ("norman", "privado", "asdfgh", "real"),
    ("norman", "privado", "me escuchas?", "real"),
    ("kevin", "grupo", "jajaja esta bueno ese meme"),
    ("kevin", "grupo", "gracias Norman"),
    ("norman", "privado", "ok"),
    ("trabajador", "grupo", "sale pues"),
    ("trabajador", "grupo", "ya llegue a la planta"),
    ("kevin", "grupo", "uff que calor hoy"),
    ("kevin", "grupo", "feliz cumple Norman!!"),
    ("norman", "privado", "ando comiendo, al rato te marco"),
    ("kevin", "grupo", "que trafico gacho hay en la carretera"),
    ("trabajador", "grupo", "mande el audio pero creo que no se escucho"),
    ("norman", "privado", "si ya lo vi"),
    ("kevin", "grupo", "ya casi llego"),
    ("norman", "privado", "buen provecho"),
    ("kevin", "grupo", "descansa, nos vemos mañana"),
    ("trabajador", "grupo", "jaja no manches"),
    ("norman", "privado", "estoy en la junta, no puedo hablar"),
    ("kevin", "grupo", "esta lloviendo gacho"),
    ("norman", "privado", "saludos a tu familia"),
    ("trabajador", "grupo", "me quede sin bateria, ya estoy de vuelta"),
    ("kevin", "grupo", "chido"),
    ("norman", "privado", "orale"),
    ("kevin", "grupo", "ya vamos a comer"),
    ("kevin", "grupo", "ya van 3 dias de lluvia, no puedo con este clima"),
    ("norman", "privado", "mi cel nuevo es 492 123 4567"),
    ("trabajador", "grupo", "somos 5 en la mesa, ya vamos"),
    ("norman", "privado", "en la mañana vi 3 camionetas iguales a la tuya jaja"),
    ("kevin", "grupo", "buenas tardes jefe"),
    ("norman", "privado", "gracias por todo, igualmente"),
]
for _t in _CHARLA:
    K("charla", _t[0], _t[1], _t[2], charla=True, origen=(_t[3] if len(_t) > 3 else "sintetico"))
K("charla", "kevin", "grupo", ["hola buenos dias", "ya estoy en el almacen", "jajaja"], charla=True)
K("charla", "norman", "privado", ["buen dia", "como amaneciste", "ni me digas, mal dormido"], charla=True)
K("charla", "trabajador", "grupo", ["ya vi el partido?", "estuvo bueno", "nos vemos"], charla=True)

# Recorte a 148 casos (120-150 pedidos, >= 25 % charla). Los ids conservan su numero.
OMITIR = {
    "kevin_variantes_05", "kevin_variantes_06", "fermentacion_06", "envasado_05", "aditivo_06",
    "nota_07", "nota_08", "viaje_06", "viaje_08", "viaje_10", "viaje_12", "viaje_14",
    "evento_salidas_07", "evento_gasto_04", "dinero_04", "efectivo_03", "cobro_prometido_04",
    "pendiente_06", "pendiente_07", "categoria_05", "categoria_08", "multi_hecho_05",
    "correccion_05", "dirigido_05", "real_02", "real_03", "real_05", "real_08", "real_15",
    "real_17", "consulta_03", "consulta_04",
}
CASOS[:] = [c for c in CASOS if c["id"] not in OMITIR]

if __name__ == "__main__":
    ruta = os.path.join(os.path.dirname(os.path.abspath(__file__)), "casos.jsonl")
    with open(ruta, "w", encoding="utf-8") as f:
        for c in CASOS:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    por = {}
    for c in CASOS:
        por[c["categoria"]] = por.get(c["categoria"], 0) + 1
    print(len(CASOS), "casos;", sum(1 for c in CASOS if c["es_charla"]), "charla;",
          sum(1 for c in CASOS if c["origen"] == "real"), "reales")
    print(por)
