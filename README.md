# Cotizador de impresión 3D (FDM)

Calculadora de precios para el equipo de ventas. Se sube el modelo, se eligen 5 opciones y se obtienen tres precios: **mínimo**, **recomendado** y **premium**, cada uno con su margen. Disponible en español e inglés.

Es una página estática: no tiene servidor ni instalación, y el archivo del cliente nunca sale del navegador.

## Uso (ventas)

1. Arrastra el archivo: **STL, 3MF, OBJ o G-code**.
   - **Precio exacto:** en Bambu Studio, lamina y usa *Exportar → Exportar archivo de placa laminada* (`.gcode.3mf`), o guarda el proyecto ya laminado. Se leen el tiempo, los gramos, el material y los colores reales. Si hay más de un filamento, se marca *Multicolor* automáticamente.
   - **Precio estimado:** con un STL/OBJ/3MF sin laminar se calcula volumen, superficie, voladizos (soportes) y complejidad, y a partir de eso se estiman el peso y el tiempo.
   - **Sin archivo:** "Ingresar peso y tiempo a mano".
2. Elige material, cantidad, calidad, acabado (Ninguno · Lijado · Pintado · Multicolor) y entrega (Normal · Urgente).
3. Cotiza el precio **Recomendado**. Si el cliente negocia, escribe el precio en "Precio negociado" para ver el semáforo:
   - 🟢 margen saludable · 🟡 margen bajo · 🔴 requiere aprobación (por debajo del margen mínimo).
4. Usa "Copiar cotización" para WhatsApp o correo, o "Imprimir / PDF".

En el visor 3D, las caras en naranja necesitan soporte.

## Cómo se calcula el precio

```
Material   = gramos × costo/kg × (1 + 5 % de desperdicio)
Máquina    = horas × (precio impresora ÷ vida útil + kW × USD/kWh + mantenimiento)
Mano obra  = (preparación por pedido + postproceso por unidad según complejidad + acabado) × USD/h
Riesgo     = (material + máquina) × % de falla según complejidad
Costo      = suma de todo lo anterior

Ganancia   = la MAYOR entre:
             · margen objetivo según complejidad (55 % → 72 %)
             · horas de máquina × (meta mensual ÷ horas vendibles al mes)
Precio     = costo + ganancia − descuento por cantidad, redondeado hacia arriba a $0.50
             nunca por debajo del margen mínimo (35 %) ni del pedido mínimo ($5)
```

- **Meta mensual ($300):** se reparte entre las horas de máquina que esperas vender al mes (120 h por defecto, o sea $2.50 por hora). Las impresiones largas quedan protegidas porque nunca ocupan la impresora sin aportar a la meta.
- **Complejidad 1–5:** combina detalle fino (superficie/volumen), voladizos (% de la superficie que necesita soporte) y esbeltez (piezas altas y delgadas). Sube el tiempo, el riesgo, el postproceso y el margen. Ventas puede forzarla a mano.
- **Sin quedar caros:** si el precio por gramo supera la referencia de mercado ($0.50/g en pedidos de 30 g o más), aparece una alerta.

Ejemplos con la configuración inicial (PLA, datos exactos):

| Pieza | Costo | Mínimo | Recomendado | Premium |
|---|---|---|---|---|
| 15 g · 0.7 h · simple | $1.71 | $5.00 | $5.00 | $6.00 |
| 50 g · 2 h · simple | $3.03 | $5.00 | $8.50 | $10.50 |
| 120 g · 5 h · media | $5.88 | $9.50 | $18.50 | $22.50 |
| 300 g · 14 h · compleja | $13.49 | $21.00 | $48.50 | $58.50 |

## Administración

Botón **Administración** → PIN (por defecto **`1234`**, cámbialo en el mismo panel).

Ahí se editan la impresora, la electricidad, la mano de obra, la meta mensual, los márgenes, los costos por kg de cada material y la calibración. Los cambios se guardan en ese navegador. **Para que todo el equipo use los mismos valores**, pulsa *Exportar config.json* y sube ese archivo a la raíz del repositorio. La app lo carga automáticamente.

Con el panel desbloqueado se ve además el **desglose de costos** de cada cotización.

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
