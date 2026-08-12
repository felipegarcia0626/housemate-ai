# API Contract — HouseMate AI

Version: 1.0

---

# 1. Propósito

Este documento define los contratos HTTP del backend de HouseMate AI para el MVP.

La API expone únicamente las operaciones necesarias para:

- gastos;
- ingresos;
- categorías;
- reglas de reparto;
- consultas financieras;
- dashboard;
- integración con el agente;
- recepción de eventos de WhatsApp.

La API no expone directamente operaciones sobre tablas ni permite consultas SQL arbitrarias.

## 2.5 Estado de implementación

Los siguientes endpoints del contrato ya están implementados en el repositorio y validados mediante sus harnesses funcionales:

- `GET /api/categories`
- `GET /api/expenses`
- `GET /api/expenses/{id}`
- `POST /api/expenses`
- `PATCH /api/expenses/{id}`
- `DELETE /api/expenses/{id}`
- `GET /api/incomes`
- `PATCH /api/incomes/{id}`
- `GET /api/sharing-rules`
- `GET /api/balance`
- `GET /api/dashboard/summary`

Los demás endpoints descritos en este contrato son objetivos del MVP y permanecen pendientes de implementación HTTP hasta que exista un Route Handler correspondiente.

Durante el MVP no se implementará un sistema formal de autenticación mediante login, sesiones, JWT u OAuth.

El backend trabajará con un contexto de usuario y hogar previamente configurado.

---

# 2. Convenciones generales

## 2.1 Base URL

Durante desarrollo:

```text
/api
```

En producción, la URL concreta dependerá del proveedor de despliegue.

## 2.2 Formato

Las solicitudes y respuestas utilizarán JSON salvo en endpoints destinados específicamente a archivos.

Content-Type: application/json

## 2.3 Identificadores

Los recursos utilizarán identificadores únicos.

Ejemplo:

{
"id": "uuid"
}

El frontend y el agente no deberán depender de identificadores autoincrementales internos.

## 2.4 Fechas

Las fechas y timestamps deberán utilizar formatos estándar.

Ejemplo:

2026-08-07

para fechas de gasto y:

2026-08-07T15:30:00Z

para timestamps.

# 3. Contexto del usuario

Durante el MVP no existirá autenticación formal.

El backend trabajará con un contexto de usuario determinado por la configuración de la aplicación.

Para WhatsApp, el identificador del remitente permitirá asociar la interacción con el usuario correspondiente.

Conceptualmente:

WhatsApp sender
↓
Usuario configurado
↓
Hogar configurado
↓
Operación

En la aplicación Web/PWA se utilizará el contexto configurado para el MVP.

El cliente no deberá enviar libremente un user_id para modificar el contexto de una operación.

El backend será responsable de determinar el contexto utilizado para ejecutar cada operación.

# 4. Contexto del hogar

Las operaciones financieras se ejecutarán dentro del contexto de un hogar.

Durante el MVP existirá un único hogar configurado.

El backend deberá validar que:

el contexto del usuario sea válido;
el hogar corresponda al contexto actual;
los recursos utilizados pertenezcan al mismo hogar;
los miembros utilizados en una operación pertenezcan al hogar correspondiente.

No se implementarán durante el MVP:

creación de hogares;
selección de hogar;
invitaciones;
gestión avanzada de miembros;
múltiples hogares activos;
permisos avanzados.

El diseño deberá permitir incorporar estas capacidades posteriormente sin modificar el contrato fundamental de las operaciones financieras.

# 5. Respuestas

Las respuestas exitosas deberán devolver información estructurada.

Ejemplo:

{
"data": {
"id": "expense-id",
"totalAmount": 185000
}
}

Los errores utilizarán una estructura consistente:

{
"error": {
"code": "VALIDATION_ERROR",
"message": "The expense amount must be greater than zero."
}
}

Los mensajes de error destinados al usuario deberán ser claros y no deberán exponer detalles internos de infraestructura.

# 6. Códigos HTTP

La API utilizará códigos HTTP convencionales.

| Código | Uso                             |
| ------ | ------------------------------- |
| 200    | Operación exitosa               |
| 201    | Recurso creado                  |
| 204    | Operación exitosa sin contenido |
| 400    | Solicitud inválida              |
| 404    | Recurso no encontrado           |
| 409    | Conflicto / duplicado           |
| 422    | Error de validación             |
| 500    | Error interno                   |

No se utilizarán 401 Unauthorized ni 403 Forbidden como parte de un flujo de autenticación formal durante el MVP.

# 7. Expenses

## 7.1 Crear gasto

POST /api/expenses

Request (`application/json`):

{
"merchant": "D1",
"description": "Compra de mercado",
"totalAmount": 185000,
"expenseDate": "2026-08-07",
"paidByMemberId": "member-id",
"categoryId": "category-id",
"receiptId": "receipt-id",
"items": [
{
"name": "Arroz",
"quantity": 2,
"unitPrice": 5000,
"totalPrice": 10000,
"categoryId": "category-food"
}
],
"splits": [
{
"memberId": "member-1",
"percentage": 50
},
{
"memberId": "member-2",
"percentage": 50
}
]
}

Campos obligatorios:

- `totalAmount`: número mayor que cero;
- `expenseDate`: fecha `YYYY-MM-DD` válida;
- `paidByMemberId`: identificador del integrante que pagó;
- `splits`: arreglo no vacío cuya suma de porcentajes sea 100%.

Campos opcionales:

- `merchant`: string o `null`; puede omitirse o enviarse explícitamente como `null`, y en ambos casos se persiste y devuelve como `null`;
- `description`: string;
- `categoryId`: string o `null`;
- `receiptId`: string;
- `items`: arreglo; si se omite, el gasto no tendrá items.

Cada item requiere `name` y `totalPrice`. `quantity`, `unitPrice` y `categoryId` son opcionales. `totalPrice` deberá ser mayor que cero. La suma de `items[].totalPrice` no podrá superar `totalAmount`; si la supera, se rechazará la solicitud completa con `422 VALIDATION_ERROR`. No se aplicarán recortes ni prorrateos automáticos.

El `categoryId` de nivel superior corresponde a `Expense.category_id` y representa la categoría general del gasto. Cada `items[].categoryId` corresponde a `ExpenseItem.category_id` y representa la categoría específica del item. Ambos niveles pueden coexistir.

En los items, `totalPrice` corresponde a `ExpenseItem.total_amount`. Se conserva `totalPrice` como nombre del contrato HTTP existente y `total_amount` como convención del modelo persistente.

El backend determinará `createdBy` a partir del miembro asociado al contexto actual; el cliente no podrá utilizar este campo para cambiar libremente el autor del registro.

`merchant` es opcional de extremo a extremo. Su ausencia se representa como `null`, nunca mediante una cadena vacía ni un nombre artificial.

La correspondencia con el modelo de datos será:

```text
createdBy       ↔ Expense.created_by
paidByMemberId ↔ Expense.paid_by
categoryId      ↔ Expense.category_id
totalAmount     ↔ Expense.total_amount
expenseDate     ↔ Expense.expense_date
items           ↔ ExpenseItem[]
items[].totalPrice ↔ ExpenseItem.total_amount
splits          ↔ ExpenseDistribution[]
```

`createdBy` identifica al miembro que registró el gasto y `paidByMemberId` al miembro que realizó el pago. Pueden ser diferentes.

`currency` no será un campo de entrada del MVP. El backend asignará `COP` desde la configuración fija y lo persistirá en `Expense.currency`.

`receiptId` será opcional. Cuando exista, el backend validará que el receipt `PROCESSED` pertenezca al contexto y lo asociará al gasto creado.

El cliente no podrá enviar `id`, `householdId`, `createdBy`, `status`, `source`, `createdAt` ni `updatedAt`. El backend resolverá `household_id`, `created_by` y `source` desde el contexto controlado, creará el Expense directamente como `CONFIRMED` y generará las filas de `ExpenseDistribution` a partir de `splits`.

Los montos de las distribuciones se calcularán en centavos mediante restos mayores: parte entera inferior de cada asignación exacta, centavos residuales por parte fraccionaria descendente y desempate por `memberId` ascendente. Los porcentajes deberán sumar exactamente `100.00` y los montos resultantes deberán sumar exactamente `totalAmount`. No se utilizarán resultados financieros definitivos basados en punto flotante.

La persistencia de Expense, items y distribuciones será una única operación atómica mediante la RPC PostgreSQL específica `public.fn_create_expense`. El repository realizará una sola llamada RPC; no ejecutará inserts PostgREST independientes.

Response:

{
"data": {
"id": "expense-id",
"createdBy": "member-created-by",
"paidByMemberId": "member-id",
"merchant": "D1",
"totalAmount": 185000,
"expenseDate": "2026-08-07",
"status": "CONFIRMED",
"category": {
"id": "category-id",
"name": "Alimentación"
},
"items": [],
"splits": [
{
"memberId": "member-1",
"percentage": 50,
"amount": 92500
},
{
"memberId": "member-2",
"percentage": 50,
"amount": 92500
}
]
}
}

El backend deberá:

validar los datos recibidos;
resolver y validar que el miembro que registra el gasto pertenezca al hogar;
validar que el pagador pertenezca al hogar;
validar que las categorías existan;
validar que los miembros del reparto pertenezcan al hogar;
validar los porcentajes;
validar que la suma de los totales de items no supere `totalAmount`;
ejecutar los cálculos correspondientes;
persistir el gasto.

El endpoint no realizará directamente lógica de interpretación de lenguaje natural.

Si la RPC confirma la creación pero la hidratación posterior no puede completarse, el endpoint responde `202` con:

```json
{
  "error": {
    "code": "CREATED_NOT_HYDRATED",
    "message": "El Expense fue creado pero no pudo cargarse.",
    "expenseId": "expense-id"
  }
}
```

Esta respuesta confirma que el Expense existe; `expenseId` es el único identificador expuesto y no se incluyen detalles internos de persistencia.

## 7.2 Listar gastos

GET /api/expenses

Filtros opcionales:

from
to
categoryId
memberId
merchant
minAmount
maxAmount

Ejemplo:

GET /api/expenses?from=2026-08-01&to=2026-08-07&categoryId=food

Response:

{
"data": [
{
"id": "expense-id",
"merchant": "D1",
"totalAmount": 185000,
"expenseDate": "2026-08-07",
"category": {
"id": "food",
"name": "Alimentación"
}
}
]
}

Los resultados deberán corresponder únicamente a gastos `CONFIRMED` del hogar asociado al contexto actual. `CANCELLED` no aparecerá en este listado financiero.

`memberId` filtra los gastos en los que el integrante participa mediante `ExpenseDistribution.household_member_id`. No filtra por creador ni por pagador. Esta misma semántica será utilizada por `get_expenses` y el servicio de gastos.

## 7.3 Obtener gasto

GET /api/expenses/{id}

Response:

{
"data": {
"id": "expense-id",
"createdBy": "member-created-by",
"paidByMemberId": "member-id",
"merchant": "D1",
"description": "Compra de mercado",
"totalAmount": 185000,
"expenseDate": "2026-08-07",
"status": "CONFIRMED",
"category": {
"id": "food",
"name": "Alimentación"
},
"items": [
{
"name": "Arroz",
"totalPrice": 10000,
"category": {
"id": "food",
"name": "Alimentación"
}
}
],
"splits": []
}
}

El backend deberá verificar que el gasto pertenezca al hogar correspondiente. Este endpoint de detalle podrá devolver `CONFIRMED` o `CANCELLED` para permitir revisión e idempotencia administrativa; el estado se incluirá en `data.status`.

## 7.4 Actualizar gasto

PATCH /api/expenses/{id}

Solo podrán actualizarse gastos `CONFIRMED` pertenecientes al hogar actual. Un gasto `CANCELLED` no podrá modificarse.

Request parcial:

```json
{
  "merchant": "D1",
  "description": "Compra de mercado y productos para el hogar",
  "totalAmount": 200000,
  "expenseDate": "2026-08-07",
  "paidByMemberId": "member-id",
  "categoryId": "food",
  "items": [
    {
      "name": "Arroz",
      "quantity": 2,
      "unitPrice": 5000,
      "totalPrice": 10000,
      "categoryId": "food"
    }
  ],
  "splits": [
    {
      "memberId": "member-1",
      "percentage": 50
    },
    {
      "memberId": "member-2",
      "percentage": 50
    }
  ]
}
```

Todos los campos son opcionales, pero deberá enviarse al menos uno. `merchant`, `categoryId` y `description` podrán enviarse como `null` para retirar su valor. `items`, cuando se proporcione, reemplazará completamente los `ExpenseItem` existentes. `splits`, cuando se proporcione, reemplazará completamente las filas `ExpenseDistribution` y el backend recalculará sus montos mediante la misma regla de restos mayores definida para POST.

Si cambia `totalAmount`, también deberá enviarse `splits` para recalcular la distribución. Si `items` no se envía, los existentes se conservarán y su suma se validará contra el nuevo total. Si se envía, `SUM(items[].totalPrice) <= totalAmount`; una infracción rechazará toda la operación con `422 VALIDATION_ERROR`.

`paidByMemberId` podrá cambiar el pagador, pero no modificará automáticamente la distribución. Todos los miembros y categorías enviados deberán pertenecer o estar disponibles en el contexto actual.

Son inmutables y no se aceptarán en el request: `id`, `householdId`, `createdBy`, `receiptId`, `currency`, `status`, `source`, `createdAt` y `updatedAt`. Las correspondencias camelCase ↔ modelo serán las mismas definidas para POST.

Response `200`:

```json
{
  "data": {
    "id": "expense-id",
    "createdBy": "member-created-by",
    "paidByMemberId": "member-id",
    "merchant": "D1",
    "description": "Compra de mercado y productos para el hogar",
    "totalAmount": 200000,
    "expenseDate": "2026-08-07",
    "category": {
      "id": "food",
      "name": "Alimentación"
    },
    "status": "CONFIRMED",
    "items": [],
    "splits": []
  }
}
```

Si PostgreSQL confirma la actualización y devuelve el UUID, pero la lectura posterior del agregado falla o devuelve `null`, el backend devolverá el error sanitizado `UPDATED_NOT_HYDRATED` junto con `expenseId`. Este error significa que la actualización fue confirmada y no deberá presentarse ni reintentarse como si la escritura hubiera fallado.

## 7.5 Eliminar gasto

DELETE /api/expenses/{id}

La eliminación deberá requerir una confirmación previa cuando la operación sea ejecutada mediante el agente.

Si el gasto está `PENDING`, el backend podrá eliminarlo físicamente. Si está `CONFIRMED`, cambiará su estado a `CANCELLED`. Si ya está `CANCELLED`, la operación será idempotente. Solo los gastos `CONFIRMED` participarán en balances, dashboard y consultas financieras. El flujo actual no crea Expense `PENDING`; esa rama queda reservada y no es un caso obligatorio del MVP.

El caso de uso interno tendrá el contrato:

```text
deleteExpense(context, expenseId): Promise<ExpenseDeleteResult>
```

`ExpenseDeleteResult` contiene el mismo `id` solicitado y uno de estos resultados: `DELETED`, `CANCELLED` o `ALREADY_CANCELLED`. La decisión se ejecuta dentro de `public.fn_delete_expense` bajo bloqueo por Expense y hogar. Un recurso inexistente y uno perteneciente a otro hogar producen `NOT_FOUND` sin revelar información adicional. Un Expense `PENDING` con Receipt asociado no se elimina: la FK `RESTRICT` rechaza atómicamente la operación y el backend responde con un error de validación sanitizado.

Response:

204 No Content

# 8. Incomes

## 8.1 Crear ingreso

POST /api/incomes

Request:

```json
{
  "memberId": "member-id",
  "amount": 1500000,
  "incomeDate": "2026-08-08",
  "description": "Pago de honorarios",
  "categoryId": "category-id"
}
```

`categoryId` será opcional. El backend resolverá `createdBy` desde el contexto controlado; el cliente no podrá proporcionarlo libremente para cambiar el autor del registro.

Correspondencia con el modelo:

```text
createdBy  ↔ Income.created_by
memberId   ↔ Income.member_id
incomeDate ↔ Income.income_date
categoryId ↔ Income.category_id
```

Response:

```json
{
  "data": {
    "id": "income-id",
    "createdBy": "member-created-by",
    "memberId": "member-id",
    "amount": 1500000,
    "incomeDate": "2026-08-08",
    "description": "Pago de honorarios",
    "categoryId": "category-id"
  }
}
```

El backend validará que `memberId`, `amount`, `incomeDate` y `description` estén presentes; que `amount` sea mayor que cero; que la fecha sea válida; que los integrantes pertenezcan al hogar; y que la categoría esté disponible en el catálogo del contexto configurado cuando se proporcione.

La respuesta exitosa utiliza `201 Created` y expone únicamente `id`, `createdBy`, `memberId`, `amount`, `incomeDate`, `description` y `categoryId`. `categoryId` es `string | null`; no se hidrata una categoría y no se exponen `householdId`, `createdAt` ni `updatedAt`.

## 8.2 Consultar ingresos

GET /api/incomes

Filtros opcionales:

```text
from
to
memberId
categoryId
```

Response:

```json
{
  "data": [
    {
      "id": "income-id",
      "createdBy": "member-created-by",
      "memberId": "member-id",
      "amount": 1500000,
      "incomeDate": "2026-08-08",
      "description": "Pago de honorarios",
      "categoryId": null
    }
  ],
  "summary": {
    "totalIncome": 1500000
  }
}
```

El backend realizará la suma y devolverá exclusivamente ingresos del hogar asociado al contexto actual.

Cada elemento de `data` expone únicamente `id`, `createdBy`, `memberId`, `amount`, `incomeDate`, `description` y `categoryId`. `categoryId` es `string | null`; este listado no hidrata un objeto de categoría. `householdId`, `createdAt` y `updatedAt` no forman parte del contrato público. `amount` y `summary.totalIncome` se serializan como números JSON.

## 8.3 Actualizar ingreso

PATCH /api/incomes/{id}

Podrá modificar `memberId`, `amount`, `incomeDate`, `description` y `categoryId`. No podrá modificar `id`, `household_id` ni `created_by`.

Request parcial, con al menos un campo:

```json
{
  "memberId": "member-id",
  "amount": 1700000,
  "incomeDate": "2026-08-08",
  "description": "Pago de honorarios corregido",
  "categoryId": null
}
```

Response `200`:

```json
{
  "data": {
    "id": "income-id",
    "createdBy": "member-id",
    "memberId": "member-id",
    "amount": 1500000,
    "incomeDate": "2026-08-08",
    "description": "Pago de honorarios",
    "categoryId": "category-id"
  }
}
```

El DTO público contiene únicamente `id`, `createdBy`, `memberId`, `amount`, `incomeDate`, `description` y `categoryId`. `categoryId` es `string | null`; no se hidrata una categoría. `amount` se serializa como número JSON y ningún `bigint` atraviesa la frontera HTTP. `householdId`, `createdAt` y `updatedAt` son campos internos y no se exponen. La Route proyecta explícitamente este DTO.

El backend validará nuevamente el monto, la fecha, la categoría opcional, la pertenencia del integrante y que el ingreso pertenezca al hogar actual. La operación actualizará `updated_at`.

## 8.4 Eliminar ingreso

DELETE /api/incomes/{id}

El backend validará que el ingreso pertenezca al hogar y contexto actual. La eliminación será física y devolverá:

```text
204 No Content
```

Cuando se ejecute mediante el agente, requerirá confirmación explícita. No se implementará soft delete, historial ni recuperación.

No se expondrá `GET /api/incomes/{id}` durante el MVP.

# 9. Categories

## 9.1 Obtener categorías

GET /api/categories

Response:

{
"data": [
{
"id": "food",
"name": "Alimentación"
},
{
"id": "cleaning",
"name": "Aseo"
},
{
"id": "pets",
"name": "Mascotas"
}
]
}

# 10. Sharing Rules

## 10.1 Obtener reglas de reparto

GET /api/sharing-rules

Response:

{
"data": [
{
"id": "rule-1",
"name": "50/50",
"type": "PERCENTAGE",
"splits": [
{
"memberId": "member-1",
"percentage": 50
},
{
"memberId": "member-2",
"percentage": 50
}
]
}
]
}

# 11. Balance

## 11.1 Obtener balance

GET /api/balance

Response:

{
"data": {
"members": [
{
"memberId": "member-1",
"paid": 100000,
"share": 50000,
"balance": 50000
},
{
"memberId": "member-2",
"paid": 0,
"share": 50000,
"balance": -50000
}
]
}
}

Los balances deberán ser calculados por el backend a partir de los gastos confirmados. El valor `paid` de cada miembro se determinará mediante `Expense.paid_by`, correspondiente a `paidByMemberId`, y no mediante `Expense.created_by`.

No deberán almacenarse como valores financieros independientes.

Los ingresos no serán consultados ni incluidos por `GET /api/balance`. Este endpoint representa exclusivamente la compensación derivada de gastos compartidos y sus distribuciones.

# 12. Dashboard

## 12.1 Obtener resumen

GET /api/dashboard/summary

Filtros opcionales:

from
to

Response:

{
"data": {
"totalIncome": 1500000,
"totalSpent": 850000,
"netAmount": 650000,
"expenseCount": 12,
"memberIncome": [
{
"memberId": "member-1",
"amount": 1500000
}
],
"byCategory": [
{
"categoryId": "food",
"categoryName": "Alimentación",
"amount": 450000
}
]
}
}

Los indicadores deberán calcularse a partir de los datos financieros almacenados.

`totalIncome` se calculará como `SUM(Income.amount)`. `totalSpent` utilizará los gastos confirmados y `netAmount` será `totalIncome - totalSpent`. `memberIncome` se calculará agrupando por `Income.member_id` y contendrá una fila por integrante con ingresos en el período.

Estos agregados serán calculados por el backend y no se almacenarán como valores derivados.

Para `byCategory`, cada item categorizado aportará su total a la categoría del item. La parte restante de `Expense.total_amount` se atribuirá a la categoría general del gasto cuando exista; de lo contrario quedará sin categorizar. La suma atribuida a categorías para un gasto nunca podrá superar `Expense.total_amount`.

`byCategory` representa exclusivamente gasto confirmado por categoría. No incluye `Income.category_id` ni combina ingresos con gastos. Los ingresos se reflejan en `totalIncome`, `netAmount` y, cuando se solicite por integrante, en `memberIncome`.

# 13. Receipts

## 13.1 Analizar factura

POST /api/receipts/analyze

Para un análisis nuevo, el endpoint recibirá una imagen de factura como multipart, la almacenará en Storage, resolverá `householdId` y `conversationKey` desde el contexto controlado, creará un `Receipt` con `household_id` y `conversation_key` asignados y `expense_id = NULL`, y solicitará su análisis. El cliente no podrá proporcionar libremente esos valores.

Si esa conversación ya tiene un receipt activo (`PENDING` o `FAILED`, sin Expense), el endpoint devolverá `409 ACTIVE_RECEIPT_EXISTS`, conservará el receipt anterior y no almacenará una segunda imagen.

Para reintentar un análisis técnicamente fallido, el mismo endpoint aceptará un request JSON con `{ "receiptId": "receipt-id" }`, sin una nueva imagen. Solo podrá reutilizarse un receipt `FAILED` del hogar actual; el backend reutilizará su `storagePath`, cambiará su estado a `PENDING` e invocará nuevamente el servicio de análisis.

Para completar una extracción incompleta, aceptará `{ "receiptId": "receipt-id", "clarifications": { ... } }` sobre un receipt `PENDING` del hogar y conversación actuales. `clarifications` solo podrá contener `merchant`, `date`, `totalAmount` e `items` con la misma forma de la respuesta de análisis. El backend combinará esos valores con `analysis_payload`, volverá a validar la extracción y devolverá el mismo `receiptId`; no creará todavía el Expense.

El resultado será una propuesta estructurada.

Ejemplo:

{
"data": {
"receiptId": "receipt-id",
"storagePath": "receipts/receipt-id.jpg",
"processingStatus": "PROCESSED",
"merchant": "D1",
"date": "2026-08-07",
"totalAmount": 185000,
"items": [
{
"name": "Arroz",
"quantity": 2,
"unitPrice": 5000,
"totalPrice": 10000
}
]
}
}

El análisis no implica automáticamente la creación de un gasto.

La creación de Expense deberá realizarse mediante `POST /api/expenses` después de la validación y confirmación necesarias, enviando el `receiptId` devuelto. El backend asociará entonces `Receipt.expense_id` al gasto creado.

Antes de asociar, el backend validará que `Receipt.household_id` coincida con el hogar actual y con `Expense.household_id`, que `expense_id` continúe en `NULL` y que el estado sea `PROCESSED`.

Si el usuario cancela la propuesta, el backend eliminará el registro `Receipt` y el archivo indicado por `storagePath`. Una extracción incompleta devolverá `200` con el mismo `receiptId`, `processingStatus: "PENDING"`, los datos parciales y la indicación de campos faltantes; persistirá esos datos en `analysis_payload`, conservará el archivo y permitirá que la respuesta posterior recupere el receipt por el hogar y conversación controlados. No creará un Expense. Cuando se complete la propuesta, el servicio actualizará el payload y marcará el receipt como `PROCESSED`.

Un fallo técnico devolverá el error estructurado correspondiente, marcará el receipt como `FAILED` y conservará el archivo para un reintento explícito. El canal informará que el análisis no pudo completarse y ofrecerá reintentar. El mismo `receiptId` podrá reutilizarse únicamente mediante el reintento descrito; no podrá asociarse a un gasto mientras permanezca `FAILED`.

# 14. WhatsApp Webhook

## 14.1 Verificación del webhook

GET /api/webhooks/whatsapp

Este endpoint será utilizado por Meta para verificar la configuración del webhook.

## 14.2 Recibir eventos

POST /api/webhooks/whatsapp

Responsabilidades:

recibir mensajes;
recibir imágenes;
identificar el remitente;
determinar el contexto correspondiente;
entregar la interacción al agente;
responder rápidamente a la plataforma;
evitar procesamiento duplicado cuando el mismo evento sea recibido nuevamente.

El webhook no deberá contener lógica financiera.

# 15. Separación Controller → Service → Repository

Los endpoints deberán mantener una separación básica:

Controller
│
▼
Service
│
▼
Repository
│
▼
PostgreSQL
Controller

Responsable de:

recibir la solicitud;
validar formato básico;
resolver el contexto actual;
devolver la respuesta HTTP.
Service

Responsable de:

reglas de negocio;
cálculos;
coordinación de operaciones;
validaciones de negocio.
Repository

Responsable de:

acceso a datos;
consultas;
inserciones;
actualizaciones;
eliminaciones.

Esto evita colocar lógica de negocio directamente dentro de los endpoints.

# 16. Contrato entre agente y herramientas

Las herramientas del agente deberán utilizar estructuras tipadas y explícitas.

Ejemplo conceptual:

{
"name": "calculate_split",
"description": "Calculates the distribution of an expense between household members.",
"input": {
"amount": 100000,
"splits": [
{
"memberId": "member-1",
"percentage": 50
},
{
"memberId": "member-2",
"percentage": 50
}
]
}
}

Resultado:

{
"amount": 100000,
"splits": [
{
"memberId": "member-1",
"percentage": 50,
"amount": 50000
},
{
"memberId": "member-2",
"percentage": 50,
"amount": 50000
}
]
}

El agente utilizará estos resultados para continuar la conversación.

Las herramientas internas del agente no necesariamente corresponderán uno a uno con endpoints HTTP.

Las operaciones conversacionales que requieren confirmación persistirán una `PendingProposal` interna con hogar, `conversationKey`, tipo de operación y payload exacto. Una confirmación posterior consumirá esa propuesta; no dependerá de memoria del proceso ni requerirá un endpoint HTTP adicional.

Si ya existe una propuesta para `householdId + conversationKey`, una nueva operación de escritura devolverá `409 PENDING_PROPOSAL_EXISTS` sin reemplazarla. La confirmación o rechazo se resolverá usando también el identificador interno de la propuesta presentada. Si el identificador ya fue consumido, rechazado o no coincide con la propuesta vigente, se devolverá `409 PROPOSAL_NOT_AVAILABLE` y no se ejecutará ninguna tool de escritura.

# 17. Validaciones críticas

El backend deberá validar como mínimo:

Gastos
monto mayor que cero;
fecha válida;
contexto de hogar válido;
miembro creador perteneciente al hogar;
pagador perteneciente al hogar;
categorías válidas;
categoría general del gasto válida cuando se proporcione;
categorías de items válidas cuando se proporcionen;
la suma de `ExpenseItem.total_amount` no supera `Expense.total_amount`;
miembros del reparto pertenecientes al hogar;
porcentajes válidos;
suma de porcentajes igual a 100%.
Ingresos
monto mayor que cero;
fecha válida;
contexto de hogar válido;
miembro creador perteneciente al hogar;
miembro asociado perteneciente al hogar;
categoría disponible para el contexto configurado cuando se proporcione;
recurso perteneciente al hogar para actualización o eliminación.
Consultas
contexto de usuario válido;
acceso al hogar correspondiente;
filtros válidos;
fechas coherentes.
Facturas
formato de archivo permitido;
tamaño máximo;
procesamiento válido;
asociación correcta con el contexto actual.
receipt nuevo asociado al `household_id` controlado;
reintento limitado a un receipt `FAILED` del mismo hogar;

# 18. Idempotencia

Las operaciones provenientes de canales externos deberán considerar la posibilidad de recibir eventos duplicados.

Especialmente para WhatsApp, el backend deberá utilizar identificadores de eventos o mecanismos equivalentes para evitar registrar dos veces la misma operación.

El identificador externo se persistirá como `ProcessedWhatsAppEvent.external_event_id` con restricción única. Si el identificador ya existe, el webhook reconocerá el reintento sin volver a entregar el evento al agente ni repetir efectos financieros.

La reserva del identificador se realizará mediante una inserción atómica. Un conflicto de unicidad se tratará como entrega duplicada y recibirá una respuesta exitosa sin reprocesamiento.

La prevención de duplicados pertenece al backend y no al agente.

# 19. Operaciones fuera del MVP

No se crearán endpoints para funcionalidades que no forman parte del MVP.

Quedan fuera inicialmente:

/api/budgets
/api/payments
/api/bank-accounts
/api/bank-transactions
/api/savings-goals

Esto evita construir una API especulativa.

# 20. Resumen de endpoints del MVP

| Método | Endpoint                 | Propósito                           |
| ------ | ------------------------ | ----------------------------------- |
| POST   | `/api/expenses`          | Crear gasto                         |
| GET    | `/api/expenses`          | Listar gastos                       |
| GET    | `/api/expenses/{id}`     | Obtener gasto                       |
| PATCH  | `/api/expenses/{id}`     | Actualizar gasto                    |
| DELETE | `/api/expenses/{id}`     | Eliminar gasto                      |
| POST   | `/api/incomes`           | Crear ingreso                       |
| GET    | `/api/incomes`           | Consultar ingresos y total agregado |
| PATCH  | `/api/incomes/{id}`      | Actualizar ingreso                  |
| DELETE | `/api/incomes/{id}`      | Eliminar ingreso físicamente        |
| GET    | `/api/categories`        | Obtener categorías                  |
| GET    | `/api/sharing-rules`     | Obtener reglas de reparto           |
| GET    | `/api/balance`           | Obtener balance                     |
| GET    | `/api/dashboard/summary` | Obtener datos del dashboard         |
| POST   | `/api/receipts/analyze`  | Analizar factura                    |
| GET    | `/api/webhooks/whatsapp` | Verificar webhook                   |
| POST   | `/api/webhooks/whatsapp` | Recibir eventos de WhatsApp         |

Las herramientas internas del agente no necesariamente corresponderán uno a uno con estos endpoints.

# 21. Principios del contrato

La API deberá respetar los siguientes principios:

## 21.1 API mínima

Solo se implementarán endpoints necesarios para el MVP.

## 21.2 Contexto controlado

Las operaciones siempre se ejecutarán dentro del contexto de usuario y hogar determinado por el backend.

Web/PWA puede consumir estos contratos directamente para vistas y operaciones explícitas. El agente continúa siendo la interfaz conversacional principal y ambos canales reutilizan los mismos services del dominio.

## 21.3 Sin autenticación formal en el MVP

No se implementarán login, JWT, OAuth, sesiones ni mecanismos equivalentes durante esta etapa.

## 21.4 El cliente no define libremente su contexto

El cliente no podrá cambiar arbitrariamente el usuario o hogar asociado a una operación mediante un user_id o household_id enviado en la solicitud.

## 21.5 El backend valida

Toda información proveniente del frontend, WhatsApp, agente o servicios externos deberá validarse antes de ejecutar operaciones.

## 21.6 El agente no accede directamente a la base de datos

Las operaciones del agente se realizarán mediante herramientas controladas.

## 21.7 El dominio no depende del canal

La lógica financiera será independiente de si la solicitud proviene de WhatsApp o Web/PWA.

# 22. Evolución futura

Cuando el proyecto requiera autenticación formal, podrá incorporarse un mecanismo de autenticación sin modificar el contrato fundamental de las operaciones de negocio.

La futura autenticación deberá encargarse de establecer de forma segura el contexto del usuario.

La lógica de gastos, balances, reglas de reparto y demás operaciones financieras deberá permanecer independiente del mecanismo concreto de autenticación.

Las funcionalidades futuras como múltiples hogares, presupuestos o integraciones bancarias deberán introducirse mediante nuevos contratos únicamente cuando formen parte del alcance del producto.

### Qué cambiamos realmente

La modificación es deliberadamente pequeña en concepto:

**Antes:**

```text
Login/token
   ↓
Usuario autenticado
   ↓
Autorización
   ↓
Hogar
   ↓
Operación

Ahora:

Contexto configurado
   ↓
Usuario
   ↓
Hogar
   ↓
Operación

Y para WhatsApp:

WhatsApp sender
       ↓
Usuario
       ↓
Hogar
       ↓
Agente / API
       ↓
Backend
```
