# Historial en la nube (Firebase)

Cada cotización que se copia, se imprime o se guarda con **Guardar en historial** queda en Firestore. En **Historial** se marca como **PO** (con el precio final pagado y la fecha) o como **Perdida**. El resumen del mes muestra cotizaciones, PO, conversión, ventas y, para el admin, la ganancia real contra la meta mensual.

Plan gratis (Spark): alcanza de sobra para el volumen de Vertex. Ver https://firebase.google.com/pricing.

## 1. Crear el proyecto (una vez, con la cuenta de Google del negocio)

1. https://console.firebase.google.com → **Crear proyecto** (por ejemplo `vertex-cotizador`). Google Analytics no hace falta.
2. **Compilación → Authentication → Comenzar → Método de acceso → Google →** Habilitar.
3. **Authentication → Configuración → Dominios autorizados →** agregar `darkauu.github.io`.
4. **Compilación → Firestore Database → Crear base de datos:**
   - Edición: **Standard** (la Enterprise es la compatible con MongoDB; no hace falta).
   - ID de la base de datos: deja **`(default)`**.
   - Ubicación: **`nam5 (United States)`** u otra de EE. UU. (no se puede cambiar después).
   - Si pregunta por las reglas, elige **modo producción** (si no pregunta, sigue).
5. **Firestore → Reglas →** pegar el contenido de [`firestore.rules`](../firestore.rules) → **Publicar**.

## 2. Dar acceso al equipo

En **Firestore → Datos → Iniciar colección** → ID de colección `members`. Por cada persona, un documento:

- **ID del documento:** su correo de Google, en minúsculas (por ejemplo `alejandro@gmail.com`).
- Campo `role` (string): `admin` o `seller`.
- Campo `name` (string): el nombre que aparecerá como vendedor.

El primer admin se crea así a mano. Quien no esté en `members` puede iniciar sesión, pero no ve ni guarda nada.

| | Ventas (`seller`) | Admin |
|---|---|---|
| Guardar cotizaciones | ✓ | ✓ |
| Ver el historial y marcar PO / Perdida | ✓ | ✓ |
| Ver costos y ganancia real | | ✓ |
| Borrar cotizaciones o cambiar el equipo | | ✓ |

## 3. Conectar la calculadora

1. **Configuración del proyecto** (engranaje) → **Tus apps → Web (`</>`)** → registrar la app → copiar el bloque `firebaseConfig`.
2. En la calculadora: **Administración → Nube (historial)** → pegar el bloque → **Guardar**.
3. **Exportar config.json** y subirlo a la raíz del repositorio, para que todo el equipo quede conectado.
4. Recargar la página → **Iniciar sesión** (arriba a la derecha).

La configuración web de Firebase no es secreta: lo que protege los datos son las reglas de `firestore.rules`.

## Qué se guarda

- `quotes/{número}`: número, fecha, vendedor, cliente y contacto, piezas (cantidad, precio por pieza, descuento), preparación, gastos adicionales, subtotal, total por método de pago, precios mínimo/recomendado/premium, precio negociado, margen del recomendado, estado, precio final y fecha de la PO, notas.
- `quotes/{número}/private/costs` (solo admin): costo de producción, gastos adicionales, comisión, desglose de costos y ganancia al precio recomendado. Con esto se calcula la ganancia real de cada PO con su precio final.
