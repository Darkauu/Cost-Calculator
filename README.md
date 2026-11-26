# Cotizador de impresión 3D (FDM)

Calculadora de precios para el equipo de ventas. Se sube el modelo, se eligen 5 opciones y se obtienen tres precios: **mínimo**, **recomendado** y **premium**, cada uno con su margen. Disponible en español e inglés.

Es una página estática: no tiene servidor ni instalación, y el archivo del cliente nunca sale del navegador.

## Uso (ventas)

1. Arrastra el archivo: **STL, 3MF, OBJ o G-code**.
   - **Precio exacto:** en Bambu Studio, lamina y usa *Exportar → Exportar archivo de placa laminada* (`.gcode.3mf`), o guarda el proyecto ya laminado. Se leen el tiempo, los gramos, el material y los colores reales. Si hay más de un filamento, se marca *Multicolor* automáticamente.
   - **Precio estimado:** con un STL/OBJ/3MF sin laminar se calcula volumen, superficie, voladizos (soportes) y complejidad, y a partir de eso se estiman el peso y el tiempo.
   - **Sin archivo:** "Ingresar peso y tiempo a mano": gramos y el tiempo en tres casillas **h · m · s** (en 0 por defecto), tal como lo muestra Bambu Studio.
   - Del G-code de cada placa también se leen los **cambios de color** del AMS y los gramos de **purga y torre** (ya vienen incluidos en el peso de Bambu Studio; se muestran para ver cuánto cuesta el multicolor).
2. Elige material, cantidad, acabado (Ninguno · Lijado · Pintado · Multicolor) y entrega (Normal · Urgente). Impresora, calidad, complejidad y "otro insumo" están en **Opciones avanzadas**.
   - **Piezas en el archivo:** si la placa trae varias piezas iguales (ej. 12 llaveros), pon cuántas: el tiempo y los gramos se reparten entre ellas.
   - **Impresora:** P2S o H2C, cada una con su costo por hora.
   - **Packaging** (Sin · Básico · Regalo), **insumos por unidad** (marca cuántas argollas, imanes, tornillos… lleva cada pieza), **envío** (incluido en el precio o cobrado aparte), **método de pago** (la comisión de tarjeta se cubre subiendo el precio) y **ITBMS 7 %** (se suma al final y no cuenta como ganancia).
3. Cotiza el precio **Recomendado**. Si el cliente negocia, escribe el precio en "Precio negociado" para ver el semáforo:
   - 🟢 margen saludable · 🟡 margen bajo · 🔴 requiere aprobación (por debajo del margen mínimo).
4. **Desglose del precio:** debajo de los precios se ve en qué se va cada dólar (filamento, máquina, gastos fijos, riesgo, mano de obra, insumos, packaging, envío, comisión, ganancia e ITBMS) con barras y el margen. Se puede ver para el mínimo, el recomendado, el premium o el precio negociado.
5. Usa "Copiar cotización" para WhatsApp o correo, o "Imprimir / PDF".

En el visor 3D, las caras en naranja necesitan soporte.

## Cómo se calcula el precio

```
Material   = gramos × costo/kg × (1 + 5 % de desperdicio)
Máquina    = horas × (precio impresora ÷ vida útil + kW × USD/kWh + mantenimiento)   ← según P2S o H2C
Gastos fijos = horas × (gastos fijos del mes ÷ horas vendibles al mes)
Mano obra  = (preparación por pedido + postproceso por unidad según complejidad + acabado) × USD/h
Insumos    = acabado + Σ (insumo del catálogo × cantidad por unidad) + otro insumo por unidad
Packaging  = costo por unidad × cantidad + costo por pedido
Riesgo     = (material + máquina) × % de falla según complejidad
Costo      = suma de todo lo anterior

Ganancia   = la MAYOR entre:
             · margen objetivo según complejidad (55 % → 72 %)
             · horas de máquina × (meta mensual ÷ horas vendibles al mes)
Neto       = costo + ganancia − descuento por cantidad
             nunca por debajo del margen mínimo (35 %) ni del pedido mínimo ($5)
Precio     = (neto + envío incluido) ÷ (1 − comisión de pago), redondeado hacia arriba a $0.50
Cliente    = precio + ITBMS (si aplica) + envío cobrado aparte
Margen     = (precio − comisión − envío incluido − costo) ÷ (precio − comisión − envío incluido)
```

Así el **mínimo** sigue garantizando el margen mínimo aunque se cobre con tarjeta, se incluya el envío o se agregue packaging: la comisión y el envío no se comen la ganancia.

- **Meta mensual ($300):** se reparte entre las horas de máquina que esperas vender al mes (120 h por defecto, o sea $2.50 por hora). Las impresiones largas quedan protegidas porque nunca ocupan la impresora sin aportar a la meta.
- **Complejidad 1–5:** combina detalle fino (superficie/volumen), voladizos (% de la superficie que necesita soporte) y esbeltez (piezas altas y delgadas). Sube el tiempo, el riesgo, el postproceso y el margen. Ventas puede forzarla a mano.
- **Sin quedar caros:** si el precio por gramo supera la referencia de mercado ($0.50/g en pedidos de 30 g o más), aparece una alerta.

Ejemplos con la configuración inicial (PLA, P2S, datos exactos):

| Pieza | Costo | Mínimo | Recomendado | Premium |
|---|---|---|---|---|
| 15 g · 0.7 h · simple | $1.94 | $5.00 | $5.00 | $6.00 |
| 50 g · 2 h · simple | $3.70 | $6.00 | $9.50 | $11.50 |
| 120 g · 5 h · media | $7.54 | $12.00 | $22.00 | $26.00 |
| 300 g · 14 h · compleja | $18.15 | $28.00 | $57.00 | $68.50 |

(Sin packaging ni envío, pago en efectivo. Incluye $0.33/h de gastos fijos.)

## Administración

Botón **Administración** → PIN (por defecto **`1234`**, cámbialo en el mismo panel).

Ahí se editan las dos impresoras, la electricidad, los gastos fijos, el ITBMS, el packaging, los costos de envío, las comisiones de pago, la mano de obra, la meta mensual, los márgenes, los costos por kg de cada material y la calibración. Los cambios se guardan en ese navegador. **Para que todo el equipo use los mismos valores**, pulsa *Exportar config.json* y sube ese archivo a la raíz del repositorio. La app lo carga automáticamente.

Las listas de **filamentos, insumos, packaging, envíos y métodos de pago** se editan como tablas: *Agregar* crea una fila nueva y ✕ la quita.

Con el panel desbloqueado se ve además el detalle de tarifas (costo por hora, minutos de mano de obra) de cada cotización.

> El PIN evita cambios accidentales, pero en una página estática no oculta los costos a alguien con conocimientos técnicos.

### Valores iniciales que conviene revisar

| Parámetro | Valor | Fuente |
|---|---|---|
| Electricidad | $0.25/kWh | dato del negocio |
| PLA | $20/kg | dato del negocio |
| Meta mensual | $300 | dato del negocio |
| Precio P2S Combo | $799 | supuesto |
| Vida útil | 6000 h | supuesto |
| Consumo promedio | 0.15 kW | supuesto |
| Mano de obra | $6/h | supuesto (pon 0 si tu tiempo cuenta como ganancia) |
| Horas vendibles/mes | 120 h | supuesto |
| Otros materiales | $22–35/kg | supuesto |
| Precio H2C | $2,400 | supuesto (sin módulo láser) |
| Vida útil / consumo H2C | 8000 h · 0.25 kW | supuesto |
| Gastos fijos al mes | $40 | supuesto (internet, software, web, contador) |
| Packaging básico | $0.18/u + $0.10/pedido | supuesto (bolsa + sticker; tarjeta) |
| Packaging regalo | $0.85/u + $0.25/pedido | supuesto (caja kraft) |
| Envío | $0 · $4 · $7 · $6 | supuesto (retiro, ciudad, Oeste/Este, interior) |
| Comisión tarjeta | 4.5 % | supuesto (Yappy, efectivo y ACH en 0 %) |
| ITBMS | 7 % | tasa general de Panamá |

### Calibración

La estimación desde STL es aproximada. Para afinarla, compara 10 a 20 piezas: anota el peso y el tiempo que da la calculadora con un STL, y luego lo que da Bambu Studio al laminar el mismo modelo. Ajusta *Calibración de peso* y *Calibración de tiempo* con el promedio de real ÷ estimado.

## Publicar para el equipo (GitHub Pages)

*Settings → Pages → Deploy from a branch →* `main` / raíz. El equipo solo necesita el enlace.

Para probar en local:

```bash
npm start
```

## Desarrollo

```bash
npm install
```

```bash
npm test
```

```
index.html        interfaz
css/styles.css    estilos (tema claro/oscuro automático)
js/config.js      valores por defecto y carga de configuración
js/pricing.js     motor de precios (funciones puras)
js/geometry.js    análisis de malla, complejidad y estimación de peso/tiempo
js/parsers.js     STL, OBJ, 3MF (Bambu Studio) y G-code
js/viewer.js      visor 3D (three.js)
js/i18n.js        textos ES/EN
js/app.js         interfaz
test/             pruebas (node --test)
```

three.js y fflate se cargan desde jsDelivr con versiones fijas; `npm install` solo hace falta para las pruebas.

## Próxima etapa: gestión de impresoras (modo LAN)

Las impresoras Bambu en modo LAN exponen un broker **MQTT sobre TLS (puerto 8883)** con el código de acceso de la impresora, más FTPS para subir archivos. Un navegador no puede conectarse directo a MQTT/TLS, así que el plan es:

1. **Puente local** (un pequeño servicio Node en un PC o Raspberry Pi de la misma red) que se conecta a cada impresora y expone una API/WebSocket simple.
2. **Panel de impresoras**: estado en vivo (imprimiendo, progreso, temperaturas, AMS, errores) de cada equipo.
3. **De la cotización al trabajo**: una cotización aprobada se convierte en un trabajo en cola, se envía el `.gcode.3mf` a la impresora y se registra el tiempo y el material reales.
4. **Cierre del ciclo**: los datos reales alimentan la calibración automática y el seguimiento de la meta mensual (vendido contra meta).

La configuración ya separa la impresora como un objeto propio, para convertirla en una lista de equipos cuando lleguemos a esa etapa.
