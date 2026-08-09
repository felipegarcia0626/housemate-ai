# Agent Architecture

## 1. Propósito

Este documento define el comportamiento, responsabilidades, herramientas y límites del agente de IA de HouseMate AI.

El agente constituye la principal interfaz inteligente del sistema, pero no reemplaza la lógica de negocio ni la persistencia de datos.

Su función principal es interpretar las solicitudes del usuario, utilizar las herramientas disponibles y facilitar la ejecución de las operaciones del sistema con la menor fricción posible.

---

# 2. Principio fundamental

El agente debe seguir una separación clara entre:

- **Interpretar**
- **Decidir**
- **Ejecutar**
- **Persistir**

El LLM puede interpretar la intención del usuario y decidir qué herramienta necesita utilizar.

El backend es responsable de validar y ejecutar las operaciones.

La base de datos es la fuente de verdad.

```text
Usuario
   │
   ▼
Agente
   │
   ├── Interpreta intención
   ├── Extrae información
   ├── Decide qué herramienta utilizar
   │
   ▼
Backend / Tools
   │
   ├── Valida
   ├── Calcula
   ├── Ejecuta
   └── Persiste
   │
   ▼
PostgreSQL
```

# 3. Objetivos del agente

El agente debe:

Reducir la fricción para registrar gastos.
Permitir interacción mediante lenguaje natural.
Interpretar información incompleta cuando sea posible.
Solicitar únicamente la información estrictamente necesaria.
Utilizar el contexto del hogar para interpretar los gastos.
Aplicar las reglas de reparto disponibles mediante herramientas controladas.
Permitir consultas financieras mediante lenguaje natural.
Analizar fotografías de facturas.
Detectar situaciones en las que necesita confirmación.
Mantener respuestas claras y concisas.

# 4. Canales

El agente debe ser independiente del canal mediante el cual interactúa el usuario.

Los canales iniciales serán:

WhatsApp
Web / PWA

Conceptualmente:

                ┌──────────────┐
                │    Agent     │
                └──────┬───────┘
                       │
             ┌─────────┴─────────┐
             │                   │
          WhatsApp            Web / PWA

La misma lógica de agente deberá poder utilizarse desde ambos canales para interacciones conversacionales. Web/PWA también podrá invocar directamente casos de uso controlados del backend para vistas y operaciones explícitas. En ambos caminos se reutilizarán los mismos services y reglas de dominio; el frontend no accederá a repositories ni PostgreSQL.

El canal no contendrá lógica de negocio.

# 5. Contexto del agente

Para responder correctamente, el agente podrá utilizar contexto proveniente de:

- usuario actual;
- hogar asociado al contexto actual;
- miembros del hogar;
- categorías;
- reglas de reparto;
- gastos existentes;
- conversación actual;
- información extraída de una factura;

El contexto deberá ser obtenido mediante mecanismos controlados.

El agente no debe asumir información financiera que no esté disponible.

# 6. Herramientas del agente

Las herramientas son la interfaz controlada entre el agente y el sistema.

El MVP utilizará un conjunto reducido de herramientas orientadas a las operaciones realmente necesarias.

## 6.1 Gestión de gastos

create_expense

Crea un gasto después de que la información necesaria haya sido validada y confirmada explícitamente por el usuario.

Entrada conceptual:

```text
merchant?
description?
totalAmount
expenseDate
paidByMemberId
categoryId?
receiptId?
items?
splits
```

La herramienta será responsable de validar la información y persistir el gasto.

`created_by` identifica al miembro que registra el gasto y se obtiene del contexto controlado; no forma parte del input de la tool. `paid_by` identifica al miembro que realizó el pago. Corresponden, respectivamente, a `createdBy` resuelto por backend y `paidByMemberId` en la tool/API.

`categoryId` representa la categoría general del gasto y corresponde a `Expense.category_id`. Cada item podrá incluir su propio `categoryId`, correspondiente a `ExpenseItem.category_id`. Un gasto simple no necesitará items para conservar su categoría general, y ambos niveles de categoría podrán coexistir.

El agente no deberá construir directamente una operación SQL.

get_expense

Obtiene información de un gasto existente.

Puede utilizarse para:

consultar un registro;
revisar información;
responder preguntas específicas.
update_expense

Permite modificar un gasto existente.

Debe utilizarse únicamente cuando el usuario solicite explícitamente una modificación y confirme la propuesta exacta del cambio.

delete_expense

Permite eliminar un gasto.

Debe requerir una confirmación explícita del usuario antes de ejecutarse.

El backend eliminará físicamente un gasto `PENDING`, cambiará un gasto `CONFIRMED` a `CANCELLED` y tratará la repetición sobre un gasto `CANCELLED` como una operación idempotente. Solo los gastos `CONFIRMED` participarán en balances y resúmenes.

## 6.2 Gestión de ingresos

create_income

Crea un ingreso después de presentar un resumen y recibir confirmación antes de persistir.

Entrada conceptual:

```text
memberId
amount
incomeDate
description
categoryId?
```

`created_by` identifica al integrante que registra el ingreso y se obtiene del contexto controlado; no forma parte del input de la tool. `memberId` identifica al integrante al que pertenece el ingreso y corresponde a `Income.member_id`. Pueden ser diferentes, pero ambos deberán pertenecer al mismo hogar. `categoryId` será opcional.

La herramienta utilizará el servicio del backend. El agente no persistirá directamente ni accederá a PostgreSQL.

get_incomes

Consulta ingresos mediante filtros de fecha, integrante y categoría. El backend devolverá los registros y `totalIncome` calculado.

Permite responder preguntas como:

- ¿Cuánto recibí este mes?
- ¿Cuánto hemos recibido entre los dos?
- ¿Cuánto recibí por honorarios?

El agente presentará el resultado estructurado y no realizará sumas financieras definitivas.

update_income

Modifica un ingreso existente mediante el backend. Podrá cambiar el integrante asociado, monto, fecha, descripción y categoría opcional, pero no el hogar ni el integrante que creó el registro.

El agente deberá identificar correctamente el ingreso, solicitar aclaración cuando exista ambigüedad y requerir confirmación explícita antes de ejecutar el cambio.

delete_income

Elimina físicamente un ingreso mediante el backend. Requerirá confirmación explícita antes de ejecutarse.

Los ingresos no tendrán items, pagador, distribuciones ni reglas de reparto. `Income` y `Expense` permanecerán como capacidades independientes y no existirá una tool genérica de movimientos financieros.

## 6.3 Consultas financieras

get_expense_summary

Obtiene información agregada sobre los gastos.

Puede utilizarse para responder preguntas como:

¿Cuánto gastamos este mes?
¿Cuánto gasté yo?
¿Cuánto gastamos en comida?
Las comparaciones entre períodos pertenecen a P1 y no son obligatorias para que esta tool cumpla el MVP.
get_expenses

Obtiene una lista de gastos filtrada.

Los filtros pueden incluir:

rango de fechas;
categoría;
integrante participante en `ExpenseDistribution`;
comercio;
tipo de gasto;
rango de valores.
get_balance

Obtiene el balance entre los miembros del hogar según los gastos registrados y las reglas de reparto aplicables. El backend utiliza `paid_by` para determinar quién pagó cada gasto; `created_by` no participa en esa determinación.

Los ingresos no participan en este balance. `get_balance` utiliza exclusivamente gastos compartidos, pagadores y distribuciones.

Los cálculos serán realizados por el backend.

El agente únicamente presenta el resultado.

## 6.4 Categorías

get_categories

Obtiene las categorías disponibles.

El agente deberá utilizar esta herramienta cuando necesite clasificar un gasto y no tenga suficiente información contextual.

## 6.5 Reglas de reparto

get_sharing_rules

Obtiene las reglas de reparto configuradas para el hogar.

Puede incluir reglas como:

50/50;
porcentaje personalizado;
gasto personal;
distribución entre determinados miembros.
calculate_split

Calcula cómo debe distribuirse un gasto entre los miembros del hogar.

La herramienta recibe la información necesaria y devuelve la distribución calculada.

El cálculo debe realizarse de forma determinística en el backend.

El LLM no debe realizar por sí mismo los cálculos financieros definitivos.

## 6.6 Facturas

analyze_receipt

Procesa una fotografía de una factura y devuelve información estructurada.

Puede identificar:

comercio;
fecha;
total;
productos;
cantidades;
precios;
posibles categorías.

La propuesta podrá incluir una categoría general para el gasto y categorías específicas para los items detectados.

El resultado debe considerarse una propuesta, no una verdad definitiva.

El usuario deberá poder revisar y confirmar la información antes de persistirla cuando exista incertidumbre relevante.

La herramienta devolverá `receiptId`, `storagePath` y `processingStatus`. El receipt tendrá `expense_id = NULL` hasta que el usuario confirme y `create_expense` lo asocie al gasto. Si el usuario cancela, el backend eliminará el receipt y su archivo de Storage.

## 6.7 Contratos canónicos de tools

Las tools utilizarán camelCase, igual que la API. `householdId`, `createdBy`, identidad del usuario y `conversationKey` siempre provendrán del contexto controlado del backend y nunca serán parámetros que el LLM pueda definir libremente. Los errores se devolverán como `{ code, message }`; como mínimo podrán informar `VALIDATION_ERROR`, `NOT_FOUND`, `HOUSEHOLD_MISMATCH`, `PENDING_PROPOSAL_EXISTS` y `PROPOSAL_NOT_AVAILABLE` cuando correspondan.

En esta sección, `ExpenseResponse`, `ExpenseListItem`, `IncomeResponse`, `CategoryResponse` y `SharingRuleResponse` representan exactamente las estructuras camelCase documentadas para sus endpoints en `api_contract.md`; las tools no crearán variantes adicionales de esos DTO.

### create_expense

Input:

```text
merchant?: string
description?: string
totalAmount: number
expenseDate: string (YYYY-MM-DD)
paidByMemberId: string
categoryId?: string | null
receiptId?: string
items?: Array<{ name: string; quantity?: number; unitPrice?: number; totalPrice: number; categoryId?: string | null }>
splits: Array<{ memberId: string; percentage: number }>
pendingProposalId: string
```

Requiere una propuesta persistida y confirmación explícita. Invoca el servicio equivalente a `POST /api/expenses`; el backend resuelve hogar, creador, source y estado. Output: `{ expense: ExpenseResponse }`, con los nombres camelCase del contrato HTTP. Puede fallar por datos inválidos, suma de items superior al total, porcentajes distintos de 100%, miembros/categorías/receipt ajenos al contexto o propuesta no disponible.

### get_expenses

Input:

```text
from?: string
to?: string
categoryId?: string
memberId?: string
merchant?: string
minAmount?: number
maxAmount?: number
```

`memberId` significa participación mediante `ExpenseDistribution`, no creador ni pagador. Invoca el servicio de `GET /api/expenses`. Output: `{ expenses: ExpenseListItem[] }`. No requiere confirmación. Puede fallar por filtros inválidos o contexto no disponible.

### update_expense

Input:

```text
id: string
merchant?: string
description?: string | null
totalAmount?: number
expenseDate?: string
paidByMemberId?: string
categoryId?: string | null
items?: Array<{ name: string; quantity?: number; unitPrice?: number; totalPrice: number; categoryId?: string | null }>
splits?: Array<{ memberId: string; percentage: number }>
pendingProposalId: string
```

Requiere confirmación explícita de la propuesta exacta. Invoca el servicio equivalente a `PATCH /api/expenses/{id}`. Output: `{ expense: ExpenseResponse }`. Aplican las reglas de reemplazo de items/distribuciones, campos inmutables y validaciones del contrato HTTP. Puede fallar por recurso inexistente, gasto cancelado, contexto incorrecto, datos inválidos o propuesta no disponible.

### delete_expense

Input: `{ id: string; pendingProposalId: string }`. Requiere confirmación explícita. Invoca el servicio equivalente a `DELETE /api/expenses/{id}`. Output interno: `{ id: string; result: "DELETED" | "CANCELLED" | "ALREADY_CANCELLED" }`; el endpoint HTTP continúa devolviendo `204`. Puede fallar por recurso inexistente, contexto incorrecto o propuesta no disponible.

### create_income

Input:

```text
memberId: string
amount: number
incomeDate: string (YYYY-MM-DD)
description: string
categoryId?: string | null
pendingProposalId: string
```

Requiere confirmación explícita. Invoca el servicio equivalente a `POST /api/incomes`. El backend resuelve `createdBy` y hogar. Output: `{ income: IncomeResponse }`. Puede fallar por monto/fecha inválidos, miembro o categoría fuera del contexto, o propuesta no disponible.

### get_incomes

Input: `{ from?: string; to?: string; memberId?: string; categoryId?: string }`. Invoca el servicio de `GET /api/incomes`. Output: `{ incomes: IncomeResponse[]; summary: { totalIncome: number } }`, calculado por backend. No requiere confirmación. Puede fallar por filtros inválidos o contexto no disponible.

### update_income

Input: `{ id: string; memberId?: string; amount?: number; incomeDate?: string; description?: string; categoryId?: string | null; pendingProposalId: string }`. Requiere confirmación explícita de la propuesta identificada. Invoca el servicio equivalente a `PATCH /api/incomes/{id}`. Output: `{ income: IncomeResponse }`. Puede fallar por recurso inexistente, contexto incorrecto, datos inválidos o propuesta no disponible.

### delete_income

Input: `{ id: string; pendingProposalId: string }`. Requiere confirmación explícita. Invoca el servicio equivalente a `DELETE /api/incomes/{id}` y elimina físicamente. Output interno: `{ id: string; result: "DELETED" }`; el endpoint HTTP devuelve `204`. Puede fallar por recurso inexistente, contexto incorrecto o propuesta no disponible.

### Tools de lectura, reparto y facturas

| Tool                  | Input                                                                                                                                                                                                    | Output                                                                                                 | Service/endpoint                                   | Confirmación                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | -------------------------------- |
| `get_expense`         | `{ id: string }`                                                                                                                                                                                         | `{ expense: ExpenseResponse }`                                                                         | Expense service / `GET /api/expenses/{id}`         | No                               |
| `get_expense_summary` | `{ from?: string; to?: string; categoryId?: string; memberId?: string }`                                                                                                                                 | `{ summary: { totalSpent: number; expenseCount: number } }`                                            | Expense/dashboard service                          | No                               |
| `get_balance`         | sin campos controlables de hogar                                                                                                                                                                         | balance estructurado                                                                                   | `expenses/balance.service.ts` / `GET /api/balance` | No                               |
| `get_categories`      | `{}`                                                                                                                                                                                                     | `{ categories: CategoryResponse[] }`                                                                   | Category service / `GET /api/categories`           | No                               |
| `get_sharing_rules`   | `{}`                                                                                                                                                                                                     | `{ rules: SharingRuleResponse[] }`                                                                     | Sharing-rule service / `GET /api/sharing-rules`    | No                               |
| `calculate_split`     | `{ amount: number; splits: Array<{ memberId: string; percentage: number }> }`                                                                                                                            | `{ amount: number; splits: Array<{ memberId: string; percentage: number; amount: number }> }`          | Sharing-rule service; sin endpoint adicional       | No                               |
| `analyze_receipt`     | `{ image: file }` para uno nuevo; `{ receiptId: string }` para reintentar un `FAILED`; o `{ receiptId: string; clarifications: { merchant?, date?, totalAmount?, items? } }` para completar un `PENDING` | `{ receiptId, storagePath, processingStatus, merchant?, date?, totalAmount?, items?, missingFields? }` | Receipt service / `POST /api/receipts/analyze`     | El análisis no; crear Expense sí |

Estas tools de lectura podrán devolver `NOT_FOUND`, `HOUSEHOLD_MISMATCH` o `VALIDATION_ERROR` según corresponda. `analyze_receipt` devolverá el fallo técnico sin inventar extracción; conservará el receipt `FAILED` para reintento. Una extracción incompleta mantendrá `PENDING`, persistirá los datos parciales en `Receipt.analysis_payload` y recuperará el mismo `receiptId` mediante el hogar y conversación controlados hasta completar o cancelar la propuesta.

En `get_expense_summary`, sin `memberId`, `totalSpent` será la suma de `Expense.total_amount` confirmado que cumpla los filtros. Con `memberId`, será la suma de `ExpenseDistribution.amount` de ese integrante para los gastos confirmados filtrados; `expenseCount` contará esos gastos una sola vez. El backend realizará ambos cálculos.

# 7. Registro conversacional de gastos

El agente debe poder interpretar mensajes naturales.

Ejemplo:

"Compré en D1 por 185 mil, de los cuales 35 mil fueron comida para el gato."

El agente debería identificar conceptualmente:

Comercio: D1
Total: 185.000
Concepto:

- Comida para gato: 35.000
- Otros productos: 150.000

Si la información disponible es suficiente, deberá preparar el registro.

Si falta información necesaria, deberá solicitarla.

La cantidad de preguntas debe mantenerse al mínimo.

# 8. Confirmación antes de persistir

El agente deberá distinguir entre:

Información suficientemente clara

Puede preparar el registro directamente y solicitar una confirmación compacta.

Ejemplo:

"Entiendo: compra en D1 por $185.000. ¿La registro así?"

Información incompleta

Debe solicitar únicamente el dato necesario.

Ejemplo:

"¿La compra fue hoy?"

Información ambigua o de alto impacto

Debe solicitar confirmación explícita antes de ejecutar la operación.

Ejemplo:

"La factura tiene productos personales y compartidos. Propongo dividirla así: $120.000 compartidos y $35.000 personales. ¿Confirmas?"

# 9. Principio de mínima fricción

El agente debe evitar convertir cada registro en un formulario conversacional.

No deberá preguntar información que:

pueda inferirse con seguridad;
ya esté disponible en el contexto;
pueda obtenerse mediante una herramienta;
no sea necesaria para completar el registro.

Ejemplo incorrecto:

¿Qué comercio?
¿Qué fecha?
¿Qué categoría?
¿Qué método de pago?
¿Quién pagó?
¿Qué porcentaje corresponde?
¿Qué descripción?

Ejemplo preferido:

Usuario:
"Compré mercado por 200 mil, pagué yo."

Agente:
"Entiendo: mercado por $200.000, pagado por ti.
¿Lo registramos 50/50 con [miembro]?"

# 10. Manejo de incertidumbre

El agente no debe inventar información para completar un registro.

Cuando exista incertidumbre relevante deberá:

identificar qué dato falta;
determinar si puede obtenerlo mediante una herramienta;
solicitarlo al usuario si es necesario;
evitar persistir información incorrecta.

La incertidumbre debe tratarse de manera diferente según su impacto.

Baja incertidumbre

Puede proponerse una clasificación.

Ejemplo:

"Parece corresponder a la categoría Alimentación. ¿Está bien?"

Alta incertidumbre

Debe solicitar aclaración antes de guardar.

Ejemplo:

"No puedo determinar si este gasto es personal o compartido. ¿Cómo quieres repartirlo?"

# 11. Análisis de facturas

El análisis de facturas tendrá dos etapas:

Imagen
│
▼
Extracción
│
▼
Interpretación
│
▼
Propuesta estructurada
│
▼
Usuario
│
▼
Confirmación
│
▼
Persistencia

La IA podrá identificar productos y proponer categorías.

Sin embargo, el resultado del modelo no deberá considerarse automáticamente definitivo.

Esto es especialmente importante cuando:

la factura es poco legible;
existen productos ambiguos;
hay descuentos;
existen productos personales y compartidos;
el total no coincide con la suma detectada.

# 12. Reparto de gastos

El agente puede interpretar cómo desea el usuario distribuir un gasto.

Ejemplo:

"Esto es mitad y mitad."

El agente puede traducirlo a una solicitud de reparto.

Sin embargo, el cálculo definitivo debe realizarse mediante calculate_split.

Ejemplo:

Usuario
│
▼
"Divídelo 70/30"
│
▼
Agente interpreta 70/30
│
▼
calculate_split
│
▼
Backend calcula
│
▼
Resultado

Esto evita errores de cálculo producidos por el LLM.

# 13. Consultas financieras

El agente deberá poder responder preguntas relacionadas con la información registrada.

Ejemplos:

¿Cuánto gastamos este mes?

¿Cuánto gasté yo?

¿Cuánto hemos gastado en restaurantes?

¿Quién ha pagado más este mes?

¿Cuánto gastamos en mercado?

¿Cuánto gastamos comparado con el mes anterior?

Esta última comparación pertenece a P1; no es obligatoria para declarar terminado el MVP.

El flujo será:

Pregunta
│
▼
Agente
│
▼
Herramienta de consulta
│
▼
Backend
│
▼
PostgreSQL
│
▼
Resultado estructurado
│
▼
Agente
│
▼
Respuesta

El agente deberá basar sus respuestas en los resultados obtenidos mediante las herramientas.

No deberá inventar valores.

Cuando presente resúmenes por categoría, utilizará el resultado estructurado del backend. No sumará por su cuenta la categoría general y las categorías de items.

Para resúmenes financieros generales, el backend devolverá `totalIncome`, `totalSpent` y `netAmount`. El agente no calculará estos agregados por sí mismo.

# 14. Recomendaciones y alertas

Las recomendaciones generadas por IA son una capacidad opcional P2 y no forman parte del criterio de terminado del MVP.

Cuando se implementen, deberán basarse en datos reales obtenidos mediante herramientas.

Ejemplos:

"Este mes han gastado 25% más en restaurantes que el mes anterior."

"El gasto en ocio aumentó respecto al promedio de los últimos meses."

Las recomendaciones no deberán presentarse como asesoría financiera profesional.

Su objetivo será ayudar al usuario a comprender sus propios patrones de gasto.

# 15. Memoria y contexto conversacional

El agente deberá mantener el contexto necesario durante una conversación.

Por ejemplo:

Usuario:
"Compré mercado por 300 mil."

Agente:
"¿Lo pagaste tú?"

Usuario:
"Sí."

Agente:
"¿Lo dividimos 50/50?"

Usuario:
"Sí."

El agente debe comprender que "sí" corresponde a la pregunta inmediatamente anterior.

Sin embargo, el historial conversacional no debe convertirse en la fuente de verdad de los gastos.

Una vez confirmado y persistido un gasto, la información oficial será la almacenada en PostgreSQL.

# 16. Idempotencia y duplicados

Las operaciones de escritura deben diseñarse para reducir el riesgo de duplicar gastos.

Esto es especialmente importante para WhatsApp, donde un mensaje podría ser procesado nuevamente.

El backend deberá utilizar identificadores de eventos o mecanismos equivalentes para evitar que una misma operación sea registrada múltiples veces.

El identificador externo del evento se persistirá en PostgreSQL con una restricción única. Un reintento reconocido no volverá a ejecutar el agente ni una tool.

La prevención de duplicados pertenece al backend, no al razonamiento del agente.

# 17. Manejo de errores

Cuando una herramienta falle:

El agente no deberá inventar un resultado.
Deberá informar al usuario que la operación no pudo completarse.
Cuando sea posible, deberá permitir reintentar.
El error técnico detallado deberá registrarse internamente.

Ejemplo:

"No pude registrar el gasto en este momento. No se guardó ningún cambio. Puedes intentarlo nuevamente."

El usuario no necesita recibir detalles internos de infraestructura.

# 18. Seguridad del agente

El agente deberá operar bajo permisos limitados.

No tendrá acceso directo a:

credenciales;
consultas SQL arbitrarias;
tablas completas sin restricciones;
operaciones administrativas;
información de otros hogares.

Las herramientas deberán validar el contexto del usuario antes de ejecutar una operación.

Por ejemplo:

Agent
│
▼
get_expenses
│
▼
Backend valida:

- contexto del usuario actual
- hogar correspondiente
- alcance de la operación
- filtros permitidos
  │
  ▼
  PostgreSQL

# 19. Herramientas que NO tendrá el agente

El agente no tendrá una herramienta genérica como:

execute_sql(query)

ni herramientas equivalentes que permitan realizar operaciones arbitrarias sobre la base de datos.

Tampoco tendrá acceso directo a credenciales o infraestructura.

Las herramientas estarán diseñadas alrededor de acciones de negocio específicas.

# 20. Arquitectura de herramientas

Las herramientas deberán seguir una estructura consistente:

Tool
├── Input validation
├── Authorization
├── Business logic
├── Database operation
└── Structured result

El agente recibirá resultados estructurados y utilizará esos resultados para generar la respuesta al usuario.

# 21. Estados de una operación conversacional

Las operaciones que impliquen cambios de información podrán seguir estados conceptuales:

INCOMPLETE
│
▼
PROPOSED
│
▼
AWAITING_CONFIRMATION
│
▼
CONFIRMED
│
▼
PERSISTED

Si el usuario rechaza una propuesta:

AWAITING_CONFIRMATION
│
▼
REJECTED

El estado definitivo deberá ser controlado por el backend.

Cuando una operación llegue a `AWAITING_CONFIRMATION`, el backend persistirá una `PendingProposal` con el hogar, una clave controlada de conversación, el tipo de operación y el payload exacto presentado. Esto cubrirá create/update/delete de Expense e Income.

La respuesta posterior del usuario resolverá la propuesta por `household_id + conversation_key`. Al confirmar se ejecutará exactamente ese payload y se eliminará la propuesta; al rechazar también se eliminará. El flujo no dependerá de memoria en proceso ni constituirá una memoria conversacional avanzada.

Si llega otra intención de escritura antes de resolver la propuesta vigente, no se reemplazará ni modificará el payload anterior. El backend devolverá `PENDING_PROPOSAL_EXISTS` y el agente pedirá resolver primero la propuesta existente.

La confirmación o rechazo se vinculará además al `PendingProposal.id` presentado. Si una respuesta tardía apunta a una propuesta ya consumida, rechazada o diferente de la vigente, el backend devolverá `PROPOSAL_NOT_AVAILABLE`; el agente informará que ya no hay una propuesta válida y no ejecutará ninguna tool de escritura.

# 22. Ejemplo completo: gasto simple

Usuario:
"Hoy pagué 80 mil en una cena con mi novia."

        ↓

Agente interpreta:

- fecha: hoy
- categoría probable: Restaurantes
- monto: 80.000
- contexto: gasto compartido
- creador del registro: usuario
- pagador: usuario

        ↓

Agente consulta reglas/contexto.

        ↓

Backend calcula reparto.

        ↓

Agente:

"Entiendo: cena de $80.000, pagada por ti y
compartida 50/50. ¿La registro?"

        ↓

Usuario:
"Sí."

        ↓

Backend valida y persiste.

        ↓

Agente:

"Listo. Registré la cena por $80.000.
Tu parte es $40.000."

# 23. Ejemplo completo: factura

Usuario
│
│ fotografía
▼
WhatsApp / Web
│
▼
Backend
│
▼
Storage
│
▼
Agent
│
▼
OpenAI
│
▼
Productos detectados
│
├── Arroz → Alimentación
├── Detergente → Aseo
├── Cerveza → Ocio
└── Comida gato → Mascotas
│
▼
Reglas de reparto
│
▼
Propuesta
│
▼
Usuario confirma
│
▼
Backend
│
▼
PostgreSQL

# 24. Límites del agente

El agente no será responsable de:

definir las reglas financieras del sistema;
realizar cálculos financieros críticos por sí mismo;
modificar directamente la base de datos;
administrar usuarios;
administrar permisos;
ejecutar SQL arbitrario;
decidir políticas de seguridad;
almacenar secretos;
actuar como fuente de verdad;
sustituir los controles del backend.

Su responsabilidad es interpretar, coordinar y comunicar.

# 25. Principios de diseño

## 25.1 El agente interpreta, el backend ejecuta

El LLM decide qué necesita hacer.

El backend determina cómo hacerlo de manera segura y consistente.

## 25.2 Herramientas pequeñas y específicas

Cada herramienta debe representar una acción de negocio clara.

Se evitarán herramientas excesivamente genéricas.

## 25.3 Confirmación antes de operaciones sensibles

Las operaciones que puedan modificar significativamente los datos requerirán confirmación explícita cuando exista riesgo de error.

## 25.4 No inventar información

Cuando el agente no tenga suficiente información deberá preguntar o utilizar una herramienta.

No debe completar datos financieros críticos mediante suposiciones.

## 25.5 Menor fricción posible

El agente debe minimizar preguntas y pasos innecesarios.

La calidad de la experiencia se mide no solo por la precisión, sino también por la facilidad de completar una operación.

## 25.6 Fuente de verdad única

Los datos persistidos en PostgreSQL representan la información oficial del sistema.

El contexto conversacional y las respuestas del modelo no sustituyen esa fuente de verdad.

# 26. Alcance del agente en el MVP

El agente deberá soportar principalmente:

registro conversacional de gastos;
registro conversacional de ingresos;
consulta, edición y eliminación de ingresos;
interpretación de gastos;
análisis de facturas;
categorización;
aplicación de reglas de reparto;
confirmación de operaciones;
consultas sobre gastos;
consultas sobre balances;
consultas agregadas;
respuestas en lenguaje natural.

Funcionalidades avanzadas como:

planificación financiera compleja;
predicciones sofisticadas;
asesoramiento financiero;
integración bancaria;
automatizaciones complejas;
agentes autónomos de larga duración;

quedan fuera del alcance del MVP.

# 27. Criterio de evolución

Antes de agregar una nueva capacidad al agente se deberá evaluar:

¿Reduce la fricción?
¿Aporta valor real al usuario?
¿Puede implementarse mediante una herramienta controlada?
¿Introduce un riesgo innecesario?
¿Es necesaria para el MVP?

Si no es necesaria para demostrar el valor central de HouseMate AI, deberá posponerse.

# 28. Resumen

El agente de HouseMate AI será una capa inteligente que conecta al usuario con las capacidades del sistema.

Su función será:

INTERPRETAR
↓
DECIDIR
↓
UTILIZAR HERRAMIENTAS
↓
RECIBIR RESULTADOS
↓
COMUNICAR

Mientras que el backend será responsable de:

VALIDAR
↓
CALCULAR
↓
AUTORIZAR
↓
EJECUTAR
↓
PERSISTIR

Esta separación permite que HouseMate AI aproveche las capacidades de IA sin convertir al LLM en una fuente de verdad ni delegar en él operaciones financieras críticas.
