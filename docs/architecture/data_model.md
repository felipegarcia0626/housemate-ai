# Data Model — HouseMate AI

Version: 1.0

---

# 1. Propósito

Este documento define el modelo conceptual y lógico de datos de HouseMate AI para el MVP.

Su objetivo es establecer:

- Las entidades principales.
- Las relaciones entre entidades.
- Las reglas de integridad más importantes.
- La información necesaria para registrar y consultar gastos.
- La información necesaria para registrar y consultar ingresos.
- La estructura necesaria para soportar reglas de reparto.
- La información necesaria para procesar facturas.

El modelo deberá mantener una separación clara entre:

- Datos financieros.
- Configuración.
- Archivos.
- Información generada o interpretada por IA.

El modelo deberá ser suficientemente flexible para evolucionar hacia múltiples usuarios, hogares y módulos financieros adicionales, pero sin implementar dichas funcionalidades durante el MVP.

---

# 2. Principios del modelo

## DM-001 — PostgreSQL es la fuente de verdad

Los datos financieros oficiales deberán almacenarse en PostgreSQL.

La IA, WhatsApp y otros servicios externos no serán fuentes de verdad.

---

## DM-002 — Los balances se calculan

Los balances no se almacenarán como valores independientes.

Se calcularán a partir de los gastos y sus distribuciones.

Esto evita inconsistencias entre el balance almacenado y las transacciones reales.

---

## DM-003 — El gasto es la entidad financiera principal

El gasto representa la transacción registrada por el usuario.

Puede contener:

- Información general de la compra.
- Productos adquiridos.
- Categorías.
- Distribución entre integrantes.
- Referencia a una factura.

---

## DM-004 — Las reglas de reparto son configuración

Las reglas de reparto no forman parte directamente del gasto.

Representan configuraciones reutilizables que pueden aplicarse a diferentes gastos.

---

## DM-005 — Los datos interpretados por IA deben poder verificarse

Cuando la IA extraiga información de una factura o de un mensaje, el resultado deberá pasar por el flujo de confirmación antes de convertirse en información financiera definitiva.

---

## DM-006 — Los archivos y los datos estructurados estarán separados

Las imágenes de facturas se almacenarán en Supabase Storage.

PostgreSQL almacenará únicamente sus referencias y metadatos relevantes.

---

# 3. Modelo conceptual

Las principales entidades del MVP son:

```text
                    ┌───────────────┐
                    │    Contexto   │
                    │    Usuario    │
                    └───────┬───────┘
                            │
                            │
                            ▼
                    ┌───────────────┐
                    │     Gasto     │
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
        ┌───────────┐ ┌────────────┐ ┌──────────────┐
        │ Productos │ │ Categoría  │ │   Factura    │
        └───────────┘ └────────────┘ └──────────────┘
                            │
                            │
                            ▼
                    ┌───────────────┐
                    │ Regla de      │
                    │ reparto       │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Distribución  │
                    │ del gasto     │
                    └───────────────┘
```

El término "Contexto Usuario" representa el contexto desde el cual se registran y consultan los gastos.

Durante el MVP existirá un único contexto de hogar.

El modelo no deberá depender estructuralmente de que exista únicamente un usuario.

`Expense` e `Income` serán entidades independientes. No existirá una entidad base compartida ni una tabla genérica de movimientos financieros.

Además del flujo de gastos mostrado, `Household` tendrá ingresos asociados mediante `Income.household_id`, y cada ingreso pertenecerá a un integrante mediante `Income.member_id`.

# 4. Entidades principales

## 4.1 User

Representa a una persona que utiliza HouseMate AI.

MVP

No se implementará un sistema completo de autenticación.

Sin embargo, se recomienda mantener un identificador lógico que permita asociar los datos con el usuario que los genera.

En el caso de WhatsApp, el identificador podrá estar relacionado con el número de teléfono utilizado por el canal.

Atributos conceptuales
User
├── id
├── display_name
├── external_identifier
└── created_at
Notas
external_identifier permite asociar al usuario con un identificador externo sin acoplar el modelo directamente a WhatsApp.
No se almacenarán contraseñas durante el MVP.
La autenticación formal podrá incorporarse posteriormente.

# 5. Household

Representa el contexto financiero compartido por un grupo de usuarios.

MVP

El sistema trabajará inicialmente con un único hogar.

No se implementarán durante el MVP:

creación de hogares;
invitaciones;
selección de hogar;
administración de miembros;
permisos avanzados.

La entidad se mantiene conceptualmente porque los gastos compartidos necesitan un contexto común.

Atributos conceptuales
Household
├── id
├── name
└── created_at

# 6. HouseholdMember

Relaciona usuarios con un hogar.

MVP

La relación podrá existir en el modelo de datos, pero no se desarrollará una funcionalidad completa para administrarla.

Atributos conceptuales
HouseholdMember
├── id
├── household_id
├── user_id
├── display_name
└── created_at
Restricciones
household_id → Household.id
user_id → User.id

Un mismo usuario podrá pertenecer a un hogar.

El modelo no deberá impedir futuras relaciones con múltiples hogares, aunque esa funcionalidad quede fuera del MVP.

# 7. Expense

Representa un gasto registrado por el usuario.

Es la entidad financiera principal del sistema.

Atributos
Expense
├── id
├── household_id
├── created_by
├── paid_by
├── category_id
├── merchant
├── total_amount
├── currency
├── expense_date
├── description
├── status
├── source
├── created_at
└── updated_at
Campos principales
created_by

Identifica al integrante del hogar que creó o registró el gasto.

paid_by

Identifica al integrante del hogar que realizó el pago. Puede ser diferente de `created_by` y es el campo utilizado para determinar quién adelantó el dinero en el cálculo de balances.

Relaciones

```text
created_by → HouseholdMember.id
paid_by    → HouseholdMember.id
```

Ambos integrantes deberán pertenecer al hogar indicado por `household_id`.

category_id

Referencia opcional a la categoría general del gasto.

```text
category_id → Category.id
```

Un gasto simple podrá utilizar `Expense.category_id` sin necesidad de crear registros `ExpenseItem`.

merchant

Nombre del establecimiento donde se realizó la compra.

Es opcional. Cuando el usuario no informe un comercio o este no pueda determinarse, se almacenará `NULL`. No se utilizarán cadenas vacías ni valores artificiales como `"Desconocido"` o `"Sin comercio"` para representar su ausencia.

Ejemplo:

D1
Éxito
Carulla
total_amount

Valor total del gasto.

Se almacenará como tipo numérico adecuado para valores monetarios.

No deberá utilizarse float para almacenar dinero.

currency

Moneda del gasto.

Para el MVP se utilizará principalmente:

COP

Se mantiene el campo para permitir expansión futura.

Durante el MVP, el backend asignará `COP` desde configuración; la API y el agente no podrán modificar libremente `currency`. Income no incorpora un campo de moneda en su modelo mínimo y sus montos también se interpretarán exclusivamente como COP durante el MVP.

expense_date

Fecha en la que ocurrió el gasto.

Debe ser independiente de created_at.

description

Descripción opcional del gasto.

Ejemplo:

Compra de mercado
status

Estado del registro.

Estados mínimos:

PENDING
CONFIRMED
CANCELLED

El gasto no deberá considerarse parte de los balances mientras no esté confirmado.

source

Origen del registro.

Valores posibles:

WEB
WHATSAPP
RECEIPT

Esto permitirá conocer cómo se originó el registro sin acoplar la lógica financiera al canal.

# 8. ExpenseItem

Representa un producto o concepto individual dentro de un gasto.

Es especialmente importante para el análisis de facturas.

Atributos
ExpenseItem
├── id
├── expense_id
├── name
├── quantity
├── unit_price
├── total_amount
├── category_id
└── created_at

`ExpenseItem.category_id` referencia `Category.id` y representa la categoría específica del producto o concepto. Puede coexistir con la categoría general definida en `Expense.category_id`.

Ejemplo

Una factura:

Pan 5.000
Leche 4.500
Comida para gato 35.000

se representa como:

Expense
└── ExpenseItem
├── Pan
├── Leche
└── Comida para gato

# 9. Category

Representa la categoría financiera de un gasto o producto.

Ejemplos
Alimentación
Restaurantes
Transporte
Mascotas
Servicios
Entretenimiento
Salud
Otros
Atributos
Category
├── id
├── name
├── description
└── created_at

Las categorías constituirán un catálogo preconfigurado mediante seed/configuración y consultable desde la aplicación. El MVP no requiere CRUD de categorías.

Una misma entidad `Category` podrá ser referenciada opcionalmente por ingresos. No se creará un catálogo o jerarquía independiente para categorías de ingresos.

Durante el MVP de un único hogar, `Category` funcionará como el catálogo configurado y disponible para ese contexto. No se añadirá una estructura adicional de propiedad de categorías para incorporar ingresos.

# 10. Income

Representa una entrada de dinero que pertenece a un integrante del hogar.

`Income` es una entidad independiente de `Expense`. No contiene items, pagador, distribuciones ni reglas de reparto.

Atributos

```text
Income
├── id
├── household_id
├── created_by
├── member_id
├── amount
├── income_date
├── description
├── category_id
├── created_at
└── updated_at
```

Relaciones

```text
household_id → Household.id
created_by   → HouseholdMember.id
member_id    → HouseholdMember.id
category_id  → Category.id
```

`created_by` identifica al integrante que registró el ingreso y se obtiene del contexto controlado. `member_id` identifica al integrante al que pertenece el ingreso. Pueden ser diferentes, pero ambos deberán pertenecer al hogar indicado por `household_id`.

`category_id` será opcional. `amount` deberá ser mayor que cero y `income_date` representará la fecha en que se recibió el ingreso.

Los ingresos se persistirán después de la confirmación correspondiente. No se agregarán estados, drafts, recurrencia, auditoría adicional ni entidades auxiliares.

# 11. SharingRule

Representa una regla reutilizable para determinar cómo se distribuye un gasto entre los integrantes del hogar.

Las reglas se cargarán mediante seed/configuración. El MVP permite consultarlas y aplicarlas, pero no requiere CRUD de reglas.

Ejemplos
50 / 50
70 / 30
100 / 0

También podrá utilizarse una regla basada en porcentajes.

Atributos
SharingRule
├── id
├── household_id
├── name
├── description
├── created_at
└── updated_at

# 12. SharingRuleMember

Representa la participación de un integrante dentro de una regla de reparto.

Atributos
SharingRuleMember
├── id
├── sharing_rule_id
├── household_member_id
└── percentage
Restricciones

La suma de los porcentajes de una regla deberá ser exactamente:

100%

Ejemplo:

Regla: 60 / 40

Felipe 60%
Pareja 40%
----------------

Total 100%

# 13. ExpenseDistribution

Representa cuánto del gasto corresponde a cada integrante.

Esta entidad es importante porque la regla utilizada para un gasto puede cambiar posteriormente.

Por esta razón, el gasto deberá almacenar su distribución efectiva y no depender únicamente de la regla utilizada.

Atributos
ExpenseDistribution
├── id
├── expense_id
├── household_member_id
├── amount
└── percentage
Ejemplo

Para un gasto de:

**100.000 COP**

con una distribución:

60 / 40

se almacenará:

Felipe 60.000 60%
Pareja 40.000 40%

El balance podrá calcularse posteriormente utilizando estas distribuciones.

# 14. Receipt

Representa la información asociada a una factura o comprobante.

La imagen física no se almacenará en PostgreSQL.

Atributos
Receipt
├── id
├── household_id
├── conversation_key
├── expense_id (nullable)
├── storage_path
├── original_filename
├── mime_type
├── uploaded_at
├── processing_status
└── analysis_payload (nullable JSON)
processing_status

Estados mínimos:

PENDING
PROCESSED
FAILED

`expense_id` permanecerá en `NULL` mientras la imagen se analiza y el usuario revisa la propuesta. El análisis identificará el registro mediante `Receipt.id` (`receiptId`) y `storage_path`.

`household_id` referencia `Household.id` y se asignará desde el contexto controlado al crear el receipt. Esta relación permite validar la propiedad del receipt mientras `expense_id` sea `NULL`. Al asociarlo con un gasto, `Receipt.household_id` deberá coincidir con `Expense.household_id`.

`conversation_key` se resolverá desde el canal/contexto controlado y permitirá recuperar el receipt durante una aclaración posterior sin usar memoria del proceso. `analysis_payload` conservará únicamente la extracción estructurada parcial o completa y, cuando corresponda, la lista `missingFields`; no constituye información financiera confirmada.

Solo podrá existir un receipt activo sin Expense por `household_id + conversation_key`. Para esta regla, activo significa `expense_id IS NULL` y estado `PENDING` o `FAILED`. Si llega otra imagen antes de completar, cancelar o asociar el receipt activo, el backend conservará el existente y rechazará el nuevo análisis con conflicto.

Después de confirmar y crear el gasto, `Receipt.expense_id` se actualizará con el identificador de `Expense`. Si el usuario cancela la propuesta, el backend eliminará el registro `Receipt` y su archivo de Storage. No se agregarán estados adicionales.

Si el análisis falla técnicamente, el receipt quedará en `FAILED` y se conservarán el registro y el archivo para permitir un reintento explícito con el mismo `receiptId`. El reintento volverá a `PENDING` antes de invocar el análisis; si vuelve a fallar, permanecerá en `FAILED`. Un receipt `FAILED` no podrá asociarse a un gasto.

Si el análisis termina pero la extracción es incompleta, el receipt permanecerá en `PENDING`, conservará el archivo, `analysis_payload` y el mismo `receiptId` mientras el agente solicita los datos faltantes. La respuesta posterior recuperará el receipt mediante `household_id + conversation_key` y actualizará ese payload. Cuando la propuesta quede completa, pasará a `PROCESSED`; solo un receipt `PROCESSED` podrá asociarse a un Expense confirmado.

# 15. AI Extraction

La información interpretada por la IA no deberá convertirse automáticamente en información financiera definitiva.

Cuando se procese una factura, el agente podrá producir una estructura temporal similar a:

AI Extraction
├── merchant
├── date
├── total
├── items
│ ├── name
│ ├── quantity
│ ├── price
│ └── category
└── confidence

Durante el MVP no es necesario crear una tabla independiente para cada extracción.

El resultado podrá mantenerse temporalmente durante el flujo de confirmación.

Una vez confirmado por el usuario, la información relevante se persistirá en las entidades financieras correspondientes.

## 15.1 PendingProposal

Conserva la propuesta exacta presentada al usuario entre solicitudes separadas. No representa un movimiento financiero ni una fuente de verdad definitiva.

```text
PendingProposal
├── id
├── household_id
├── conversation_key
├── operation_type
├── payload
├── status
├── created_at
└── updated_at
```

`conversation_key` identifica de forma controlada la conversación o canal dentro del hogar. `operation_type` se limitará a `CREATE_EXPENSE`, `UPDATE_EXPENSE`, `DELETE_EXPENSE`, `CREATE_INCOME`, `UPDATE_INCOME` y `DELETE_INCOME`. `payload` conservará los datos propuestos y los identificadores necesarios para ejecutar exactamente la operación presentada.

El estado mínimo persistido será `AWAITING_CONFIRMATION`. Al confirmar o rechazar, la propuesta se consume y elimina. Solo podrá existir una propuesta pendiente por `household_id + conversation_key`.

Si llega una nueva operación de escritura mientras ya existe una propuesta pendiente para la misma clave, el backend rechazará la nueva operación con un conflicto y conservará intacta la propuesta anterior. El agente deberá pedir al usuario confirmar o rechazar primero esa propuesta. No se sobrescribirá el payload pendiente.

Una confirmación o rechazo incluirá internamente el `PendingProposal.id` que fue presentado. El backend solo ejecutará el payload si ese identificador continúa siendo la propuesta pendiente de `household_id + conversation_key`. Si ya fue consumida, rechazada o no coincide, no ejecutará ninguna operación y responderá que la propuesta ya no está disponible. Esto evita que una confirmación tardía ejecute otra operación.

## 15.2 ProcessedWhatsAppEvent

Registra la deduplicación mínima de eventos de WhatsApp.

```text
ProcessedWhatsAppEvent
├── id
├── external_event_id
└── processed_at
```

`external_event_id` será obligatorio y tendrá una restricción `UNIQUE`. Un reintento con el mismo identificador no volverá a ejecutar el agente ni una operación financiera.

El webhook intentará reservar el identificador mediante una inserción atómica. Un conflicto de unicidad identificará el evento como duplicado. Si un procesamiento posterior falla, se registrará el error y el usuario podrá reenviar la operación como un nuevo mensaje; no se agregará un workflow de reintentos al MVP.

# 16. Relaciones principales

User
│
▼
HouseholdMember
│
▼
Household
│
├───────────────┐
│ │
▼ ▼
Expense SharingRule
│ │
├───────┐ ▼
│ │ SharingRuleMember
▼ │
ExpenseItem
│
▼
Category

Expense.category_id → Category.id
ExpenseItem.category_id → Category.id

Expense
│
├── ExpenseDistribution
│
└── Receipt

Household
│
└── Receipt (antes y después de asociarlo a Expense)

Household
│
└── Income
├── created_by → HouseholdMember
├── member_id → HouseholdMember
└── category_id → Category (opcional)

# 17. Integridad financiera

El modelo deberá garantizar las siguientes reglas.

## 17.1 Total del gasto

Expense.total_amount > 0

La suma de los items deberá cumplir:

```text
SUM(ExpenseItem.total_amount) <= Expense.total_amount
```

El backend validará esta regla al crear un gasto y cada vez que un PATCH modifique el total o reemplace los items. Si se supera el total del gasto, rechazará toda la operación como error de validación; no truncará, limitará ni prorrateará valores.

## 17.2 Distribución

Para un gasto confirmado:

SUM(ExpenseDistribution.amount)
=

Expense.total_amount

Los montos de `ExpenseDistribution` se calcularán mediante el método de restos mayores en centavos:

1. Los porcentajes se validarán individualmente y deberán sumar exactamente `100.00`.
2. `Expense.total_amount` se convertirá a centavos enteros.
3. Para cada integrante se calculará la asignación exacta `total_centavos × porcentaje / 100` usando aritmética decimal exacta.
4. La asignación inicial será la parte entera inferior de cada resultado.
5. Los centavos residuales se asignarán, uno por uno, en orden descendente de parte fraccionaria.
6. Los empates se resolverán por `HouseholdMember.id` (`memberId`) en orden ascendente.

El resultado se persistirá con dos decimales y deberá sumar exactamente `Expense.total_amount`. Los cálculos financieros definitivos no utilizarán resultados intermedios de punto flotante.

Ejemplo: para `10.01` con porcentajes `50.00 / 50.00`, las asignaciones exactas son `500.5 / 500.5` centavos. Después de asignar `500 / 500`, el centavo residual corresponde al `memberId` menor. Los montos finales serán `5.01 / 5.00` y sumarán `10.01`.

Para tres partes iguales se representarán los porcentajes con la escala persistente aprobada, por ejemplo `33.33 / 33.33 / 33.34`; no se almacenarán porcentajes periódicos con precisión superior a `NUMERIC(5,2)`.

## 17.3 Porcentajes

Para una regla de reparto:

SUM(SharingRuleMember.percentage)
=

100

## 17.4 Valores monetarios

Los valores monetarios deberán utilizar tipos numéricos adecuados para evitar errores de precisión.

No se utilizarán valores de tipo float para almacenar dinero.

## 17.5 Estados

Solo los gastos confirmados participarán en:

balances;
estadísticas;
tendencias;
consultas financieras.

Un gasto `PENDING` podrá eliminarse físicamente porque todavía no forma parte de la información financiera oficial. Eliminar un gasto `CONFIRMED` cambiará su estado a `CANCELLED`. Una eliminación sobre un gasto ya `CANCELLED` no producirá cambios adicionales.

El flujo actual del MVP no crea registros Expense en estado `PENDING`: las propuestas se conservan en `PendingProposal` y `POST /api/expenses` persiste el gasto como `CONFIRMED` después de la confirmación. `PENDING` queda reservado documentalmente para compatibilidad con un posible flujo futuro; su semántica de eliminación se mantiene, pero no constituye un caso obligatorio de implementación o prueba del MVP.

Los balances, dashboard, estadísticas y consultas financieras utilizarán exclusivamente gastos `CONFIRMED`; los gastos `PENDING` y `CANCELLED` quedarán excluidos.

## 17.6 Ingresos

Para cada ingreso:

```text
Income.amount > 0
```

`Income.created_by` y `Income.member_id` deberán pertenecer a `Income.household_id`. `Income.category_id`, cuando exista, deberá referenciar una categoría válida.

# 18. Cálculo de balances

Los balances no serán almacenados.

Se calcularán a partir de:

Gastos confirmados
│
▼
Distribuciones
│
▼
Monto pagado por integrante, determinado mediante Expense.paid_by
│
▼
Balance

Ejemplo:

Total de gastos:

Felipe pagó 300.000
Pareja pagó 100.000

Total 400.000

Si el reparto esperado es 50/50:

Participación esperada:

Felipe 200.000
Pareja 200.000

Entonces:

Felipe:
**300.000 - 200.000 = +100.000**

Pareja:
**100.000 - 200.000 = -100.000**

El sistema puede determinar que la pareja debe compensar a Felipe por:

**100.000 COP**

La lógica exacta de cálculo se implementará en el dominio y no en el agente. `Expense.created_by` no se utilizará para determinar quién pagó.

Los ingresos no participarán en este cálculo. Registrar, editar o eliminar un ingreso no modificará el balance de compensación entre integrantes.

# 19. Dashboard

El dashboard no tendrá tablas propias para almacenar indicadores derivados.

Los siguientes valores serán calculados a partir de los datos financieros:

total de ingresos;
total gastado;
resultado neto;
gasto por categoría;
ingreso por integrante;
evolución temporal (P1, no obligatoria para el MVP);
distribución de gastos;
balance entre integrantes;
cantidad de gastos confirmados.

Para calcular el gasto por categoría sin duplicar montos:

- cada `ExpenseItem` categorizado aportará su `total_amount` a `ExpenseItem.category_id`;
- la parte restante de `Expense.total_amount`, después de restar los totales de los items categorizados, se atribuirá a `Expense.category_id` cuando exista;
- si no existe `Expense.category_id`, la parte restante quedará sin categorizar;
- la suma atribuida a categorías para un gasto nunca podrá superar `Expense.total_amount`.

Si un gasto no tiene items categorizados, todo su `total_amount` se atribuirá a `Expense.category_id` cuando exista.

El campo de salida `byCategory` del dashboard representará exclusivamente gasto confirmado por categoría. `Income.category_id` no se mezclará en esa colección; las categorías de ingresos se utilizarán únicamente al filtrar o resumir ingresos.

Los resúmenes financieros generales calcularán:

```text
totalIncome = SUM(Income.amount)
totalSpent  = SUM(Expense.total_amount confirmado)
netAmount   = totalIncome - totalSpent
```

Por integrante, `memberIncome` se calculará agrupando `Income.amount` por `Income.member_id` y formará parte del resumen del dashboard. Estos agregados no se almacenarán.

Cuando sea necesario optimizar consultas, se podrán incorporar posteriormente:

índices;
vistas;
materialized views;
estrategias de agregación.

No se implementarán durante el MVP sin una necesidad demostrada.

# 20. Consultas mediante lenguaje natural

Las consultas realizadas al agente utilizarán PostgreSQL como fuente de información.

Ejemplo:

Usuario:
"¿Cuánto gastamos en restaurantes este mes?"

Flujo:

Usuario
↓
Agent
↓
Tool
↓
Consulta controlada
↓
PostgreSQL
↓
Resultado
↓
Agent
↓
Respuesta

El agente no deberá construir ni ejecutar consultas SQL arbitrarias directamente sobre la base de datos.

Las herramientas deberán controlar las operaciones permitidas.

# 21. Facturas

El procesamiento de facturas seguirá el siguiente flujo:

Fotografía
↓
Storage
↓
Agent / AI
↓
Extracción
↓
Clasificación
↓
Propuesta
↓
Confirmación del usuario
↓
Expense
↓
ExpenseItem
↓
ExpenseDistribution

La información obtenida mediante IA se considera provisional hasta que el usuario confirme el registro.

# 22. Identificadores

Las entidades utilizarán identificadores internos únicos.

Se recomienda utilizar UUID para las entidades principales.

Esto evita depender de identificadores secuenciales expuestos públicamente y facilita futuras integraciones.

Los identificadores externos, como el identificador de WhatsApp, deberán mantenerse separados de los identificadores internos.

# 23. Auditoría mínima

El MVP no implementará un sistema completo de auditoría.

Las entidades principales deberán incluir:

created_at
updated_at

cuando corresponda.

Esto será suficiente para conocer cuándo se creó o modificó un registro durante el MVP.

Un sistema detallado de historial de cambios podrá incorporarse posteriormente si existe una necesidad real.

# 24. Datos fuera del MVP

No se implementarán tablas funcionales para:

presupuestos;
metas de ahorro;
pagos;
cuentas bancarias;
transacciones bancarias;
múltiples hogares;
suscripciones;
inversiones;
productos financieros.

El modelo podrá evolucionar posteriormente para incorporar estas capacidades.

# 25. Decisiones de diseño

DM-DEC-001

PostgreSQL será la fuente de verdad financiera.

DM-DEC-002

Los balances serán calculados y no almacenados.

DM-DEC-003

Las distribuciones efectivas de un gasto se almacenarán independientemente de la regla utilizada.

DM-DEC-004

Las reglas de reparto serán reutilizables.

DM-DEC-005

Las fotografías de facturas se almacenarán en Supabase Storage.

DM-DEC-006

Los datos extraídos por IA requerirán confirmación antes de convertirse en información financiera definitiva.

DM-DEC-007

El MVP no implementará un sistema completo de autenticación ni autorización.

DM-DEC-008

El MVP trabajará con un único contexto de hogar.

DM-DEC-009

Los indicadores del dashboard serán derivados de las transacciones existentes.

DM-DEC-010

El modelo deberá permitir evolución futura sin implementar funcionalidades fuera del MVP.

# 26. Evolución futura

El modelo podrá extenderse posteriormente para soportar:

múltiples hogares;
múltiples usuarios;
autenticación;
permisos;
presupuestos;
metas de ahorro;
integraciones bancarias;
pagos;
monedas adicionales;
nuevos tipos de transacciones.

Estas extensiones no deberán introducirse durante el MVP salvo que sean necesarias para completar una funcionalidad definida en el PRD.

# 27. Documentos relacionados

Project Vision
Product Requirements Document
Architecture Overview
C4 Context
C4 Container
Tech Stack
Agent Architecture
API Contract (`api_contract.md`)
Security

### Una precisión importante

Dejé `User`, `Household` y `HouseholdMember` en el **modelo conceptual**, pero no como funcionalidades que tengamos que construir ahora. Esto nos da una estructura coherente para el caso de uso de gastos compartidos sin obligarnos a desarrollar autenticación, invitaciones, permisos, selección de hogares, etc.

Los ingresos forman parte del MVP mediante la entidad independiente `Income`, sin modificar `Expense` ni introducir una jerarquía compartida entre ambos.

Con esto, los cuatro documentos quedan bastante bien alineados:

**`architecture_overview` → principios y estructura general**  
**`c4_context` → sistema y dependencias externas**  
**`c4_container` → componentes internos del monolito**  
**`tech_stack` → tecnologías concretas**  
**`data_model` → datos y relaciones**

Así evitamos seguir repitiendo arquitectura en cada archivo y, sobre todo, evitamos que el diseño técnico empiece a generar funcionalidades que el MVP no necesita.

# 28. Physical Persistence Specification

Esta sección convierte el modelo conceptual aprobado en la especificación física obligatoria para las migraciones de la Fase 1. No modifica el dominio ni agrega funcionalidades.

## 28.1 Convención física

- Motor: PostgreSQL administrado por Supabase.
- Schema: `public`. El MVP no utilizará schemas adicionales.
- Tablas: nombres plurales en `snake_case` con prefijo `tb_`.
- Columnas, constraints, índices, funciones y triggers: `snake_case`.
- Identificadores internos: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`.
- Fechas de negocio: `DATE`.
- Timestamps: `TIMESTAMPTZ` en UTC.
- `created_at`, `uploaded_at` y `processed_at`: `NOT NULL DEFAULT now()`.
- `updated_at`: `NOT NULL DEFAULT now()` y actualización automática mediante trigger.
- Montos monetarios: `NUMERIC(14,2)`; nunca `FLOAT`, `REAL` o `DOUBLE PRECISION`.
- Porcentajes: `NUMERIC(5,2)`.
- Cantidades de items: `NUMERIC(12,3)`.
- Texto sin límite funcional documentado: `TEXT`.
- Payload estructurado: `JSONB`.
- Todas las FK usan `ON UPDATE NO ACTION`, porque los UUID internos son inmutables.
- No se utiliza `BOOLEAN` en el esquema inicial porque ninguna entidad aprobada contiene un atributo binario persistente.

Los siguientes tipos enum de PostgreSQL serán definidos en `public`:

| Tipo | Valores permitidos |
| --- | --- |
| `expense_status` | `PENDING`, `CONFIRMED`, `CANCELLED` |
| `expense_source` | `WEB`, `WHATSAPP`, `RECEIPT` |
| `receipt_processing_status` | `PENDING`, `PROCESSED`, `FAILED` |
| `pending_operation_type` | `CREATE_EXPENSE`, `UPDATE_EXPENSE`, `DELETE_EXPENSE`, `CREATE_INCOME`, `UPDATE_INCOME`, `DELETE_INCOME` |
| `pending_proposal_status` | `AWAITING_CONFIRMATION` |

`SharingRule.type` no se persiste. El contrato expone `type: PERCENTAGE` como una constante del único tipo de regla soportado por el MVP; no representa una columna adicional del modelo.

## 28.2 Inventario físico de tablas

### 28.2.1 `public.tb_users`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_users` |
| `display_name` | `TEXT` | NOT NULL | — | — |
| `external_identifier` | `TEXT` | NOT NULL | — | UNIQUE `uq_tb_users_external_identifier` |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |

### 28.2.2 `public.tb_households`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_households` |
| `name` | `TEXT` | NOT NULL | — | — |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |

### 28.2.3 `public.tb_household_members`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_household_members` |
| `household_id` | `UUID` | NOT NULL | — | FK |
| `user_id` | `UUID` | NOT NULL | — | FK |
| `display_name` | `TEXT` | NOT NULL | — | — |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |

Constraints adicionales:

- `uq_tb_household_members_household_user UNIQUE (household_id, user_id)` impide representar dos veces al mismo usuario dentro del mismo hogar.
- `uq_tb_household_members_household_id UNIQUE (household_id, id)` permite FK compuestas que garanticen pertenencia al hogar.

### 28.2.4 `public.tb_categories`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_categories` |
| `name` | `TEXT` | NOT NULL | — | UNIQUE `uq_tb_categories_name` |
| `description` | `TEXT` | NULL | — | — |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |

`Category` es el catálogo preconfigurado global del único contexto del MVP; no se agrega `household_id`.

### 28.2.5 `public.tb_sharing_rules`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_sharing_rules` |
| `household_id` | `UUID` | NOT NULL | — | FK |
| `name` | `TEXT` | NOT NULL | — | — |
| `description` | `TEXT` | NULL | — | — |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | trigger de actualización |

Constraints adicionales:

- `uq_tb_sharing_rules_household_name UNIQUE (household_id, name)`.
- `uq_tb_sharing_rules_household_id UNIQUE (household_id, id)` para validaciones compuestas.

### 28.2.6 `public.tb_sharing_rule_members`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_sharing_rule_members` |
| `sharing_rule_id` | `UUID` | NOT NULL | — | FK |
| `household_member_id` | `UUID` | NOT NULL | — | FK |
| `percentage` | `NUMERIC(5,2)` | NOT NULL | — | `CHECK (percentage >= 0 AND percentage <= 100)` |

`uq_tb_sharing_rule_members_rule_member UNIQUE (sharing_rule_id, household_member_id)` permite una sola participación por integrante y regla.

### 28.2.7 `public.tb_expenses`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_expenses` |
| `household_id` | `UUID` | NOT NULL | — | FK |
| `created_by` | `UUID` | NOT NULL | — | FK compuesta con `household_id` |
| `paid_by` | `UUID` | NOT NULL | — | FK compuesta con `household_id` |
| `category_id` | `UUID` | NULL | — | FK |
| `merchant` | `TEXT` | NULL | — | — |
| `total_amount` | `NUMERIC(14,2)` | NOT NULL | — | `CHECK (total_amount > 0)` |
| `currency` | `VARCHAR(3)` | NOT NULL | `'COP'` | `CHECK (currency = 'COP')` |
| `expense_date` | `DATE` | NOT NULL | — | — |
| `description` | `TEXT` | NULL | — | — |
| `status` | `expense_status` | NOT NULL | `'CONFIRMED'` | — |
| `source` | `expense_source` | NOT NULL | — | — |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | trigger de actualización |

`uq_tb_expenses_household_id UNIQUE (household_id, id)` permite validar físicamente que un Receipt y su Expense pertenezcan al mismo hogar.

La migración versionada `0003_expense_write_access.sql` cambió `merchant` a `TEXT NULL`. La migración inicial `0001_initial_persistence.sql` conserva históricamente su definición original `merchant TEXT NOT NULL` y no fue modificada retroactivamente.

### 28.2.8 `public.tb_expense_items`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_expense_items` |
| `expense_id` | `UUID` | NOT NULL | — | FK |
| `name` | `TEXT` | NOT NULL | — | — |
| `quantity` | `NUMERIC(12,3)` | NULL | — | `CHECK (quantity IS NULL OR quantity > 0)` |
| `unit_price` | `NUMERIC(14,2)` | NULL | — | `CHECK (unit_price IS NULL OR unit_price >= 0)` |
| `total_amount` | `NUMERIC(14,2)` | NOT NULL | — | `CHECK (total_amount > 0)` |
| `category_id` | `UUID` | NULL | — | FK |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |

`quantity` y `unit_price` son opcionales en el contrato. `total_amount`, correspondiente a `items[].totalPrice`, es el valor financiero definitivo del item. No se impone `quantity * unit_price = total_amount`.

### 28.2.9 `public.tb_expense_distributions`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_expense_distributions` |
| `expense_id` | `UUID` | NOT NULL | — | FK |
| `household_member_id` | `UUID` | NOT NULL | — | FK |
| `amount` | `NUMERIC(14,2)` | NOT NULL | — | `CHECK (amount >= 0)` |
| `percentage` | `NUMERIC(5,2)` | NOT NULL | — | `CHECK (percentage >= 0 AND percentage <= 100)` |

`uq_tb_expense_distributions_expense_member UNIQUE (expense_id, household_member_id)` garantiza una sola distribución por gasto e integrante. El nombre conceptual y físico conserva `ExpenseDistribution`; no existe `ExpenseSplit`.

### 28.2.10 `public.tb_incomes`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_incomes` |
| `household_id` | `UUID` | NOT NULL | — | FK |
| `created_by` | `UUID` | NOT NULL | — | FK compuesta con `household_id` |
| `member_id` | `UUID` | NOT NULL | — | FK compuesta con `household_id` |
| `amount` | `NUMERIC(14,2)` | NOT NULL | — | `CHECK (amount > 0)` |
| `income_date` | `DATE` | NOT NULL | — | — |
| `description` | `TEXT` | NOT NULL | — | — |
| `category_id` | `UUID` | NULL | — | FK |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | trigger de actualización |

No contiene moneda, estado, items, `paid_by`, distribuciones ni reglas de reparto.

### 28.2.11 `public.tb_receipts`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_receipts` |
| `household_id` | `UUID` | NOT NULL | — | FK |
| `conversation_key` | `TEXT` | NOT NULL | — | — |
| `expense_id` | `UUID` | NULL | — | FK compuesta con `household_id` |
| `storage_path` | `TEXT` | NOT NULL | — | — |
| `original_filename` | `TEXT` | NOT NULL | — | — |
| `mime_type` | `TEXT` | NOT NULL | — | — |
| `uploaded_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |
| `processing_status` | `receipt_processing_status` | NOT NULL | `'PENDING'` | — |
| `analysis_payload` | `JSONB` | NULL | — | — |

Constraint `ck_tb_receipts_processed_association`:

```text
expense_id IS NULL OR processing_status = 'PROCESSED'
```

No se agregan `created_at` o `updated_at`: el modelo aprobado define `uploaded_at` para esta entidad.

### 28.2.12 `public.tb_pending_proposals`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_pending_proposals` |
| `household_id` | `UUID` | NOT NULL | — | FK |
| `conversation_key` | `TEXT` | NOT NULL | — | — |
| `operation_type` | `pending_operation_type` | NOT NULL | — | — |
| `payload` | `JSONB` | NOT NULL | — | — |
| `status` | `pending_proposal_status` | NOT NULL | `'AWAITING_CONFIRMATION'` | — |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | trigger de actualización |

La propuesta se elimina al confirmar o rechazar; no se persisten otros estados.

### 28.2.13 `public.tb_processed_whatsapp_events`

| Columna | Tipo | NULL | Default | Restricciones |
| --- | --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | PK `pk_tb_processed_whatsapp_events` |
| `external_event_id` | `TEXT` | NOT NULL | — | UNIQUE `uq_tb_processed_whatsapp_events_external_event_id` |
| `processed_at` | `TIMESTAMPTZ` | NOT NULL | `now()` | — |

## 28.3 Foreign keys y comportamiento referencial

| Constraint | Origen | Destino | ON DELETE | ON UPDATE |
| --- | --- | --- | --- | --- |
| `fk_tb_household_members_household` | `tb_household_members.household_id` | `tb_households.id` | `RESTRICT` | `NO ACTION` |
| `fk_tb_household_members_user` | `tb_household_members.user_id` | `tb_users.id` | `RESTRICT` | `NO ACTION` |
| `fk_tb_sharing_rules_household` | `tb_sharing_rules.household_id` | `tb_households.id` | `RESTRICT` | `NO ACTION` |
| `fk_tb_sharing_rule_members_rule` | `tb_sharing_rule_members.sharing_rule_id` | `tb_sharing_rules.id` | `CASCADE` | `NO ACTION` |
| `fk_tb_sharing_rule_members_member` | `tb_sharing_rule_members.household_member_id` | `tb_household_members.id` | `RESTRICT` | `NO ACTION` |
| `fk_tb_expenses_household` | `tb_expenses.household_id` | `tb_households.id` | `RESTRICT` | `NO ACTION` |
| `fk_tb_expenses_created_by_household` | `tb_expenses.(household_id, created_by)` | `tb_household_members.(household_id, id)` | `RESTRICT` | `NO ACTION` |
| `fk_tb_expenses_paid_by_household` | `tb_expenses.(household_id, paid_by)` | `tb_household_members.(household_id, id)` | `RESTRICT` | `NO ACTION` |
| `fk_tb_expenses_category` | `tb_expenses.category_id` | `tb_categories.id` | `SET NULL` | `NO ACTION` |
| `fk_tb_expense_items_expense` | `tb_expense_items.expense_id` | `tb_expenses.id` | `CASCADE` | `NO ACTION` |
| `fk_tb_expense_items_category` | `tb_expense_items.category_id` | `tb_categories.id` | `SET NULL` | `NO ACTION` |
| `fk_tb_expense_distributions_expense` | `tb_expense_distributions.expense_id` | `tb_expenses.id` | `CASCADE` | `NO ACTION` |
| `fk_tb_expense_distributions_member` | `tb_expense_distributions.household_member_id` | `tb_household_members.id` | `RESTRICT` | `NO ACTION` |
| `fk_tb_incomes_household` | `tb_incomes.household_id` | `tb_households.id` | `RESTRICT` | `NO ACTION` |
| `fk_tb_incomes_created_by_household` | `tb_incomes.(household_id, created_by)` | `tb_household_members.(household_id, id)` | `RESTRICT` | `NO ACTION` |
| `fk_tb_incomes_member_household` | `tb_incomes.(household_id, member_id)` | `tb_household_members.(household_id, id)` | `RESTRICT` | `NO ACTION` |
| `fk_tb_incomes_category` | `tb_incomes.category_id` | `tb_categories.id` | `SET NULL` | `NO ACTION` |
| `fk_tb_receipts_household` | `tb_receipts.household_id` | `tb_households.id` | `RESTRICT` | `NO ACTION` |
| `fk_tb_receipts_expense_household` | `tb_receipts.(household_id, expense_id)` | `tb_expenses.(household_id, id)` | `RESTRICT` | `NO ACTION` |
| `fk_tb_pending_proposals_household` | `tb_pending_proposals.household_id` | `tb_households.id` | `RESTRICT` | `NO ACTION` |

`CASCADE` se limita a componentes inseparables de su agregado: items y distribuciones de un Expense, y miembros de una SharingRule. Los datos financieros, identidades, receipts y propuestas no se eliminan indirectamente al eliminar su hogar o miembro.

Un Expense físicamente eliminable no podrá eliminarse mientras tenga un Receipt asociado. El flujo controlado deberá eliminar primero el Receipt y su archivo. Los Expense `CONFIRMED` no se eliminan físicamente: el service de Fase 2 cambia su estado a `CANCELLED`.

## 28.4 Unicidades e índices

Las PK y constraints `UNIQUE` crean sus propios índices. No se duplicarán con índices de rendimiento equivalentes.

### Unicidades de integridad

- `uq_tb_users_external_identifier` sobre `tb_users(external_identifier)`.
- `uq_tb_household_members_household_user` sobre `tb_household_members(household_id, user_id)`.
- `uq_tb_household_members_household_id` sobre `tb_household_members(household_id, id)`.
- `uq_tb_categories_name` sobre `tb_categories(name)`.
- `uq_tb_sharing_rules_household_name` sobre `tb_sharing_rules(household_id, name)`.
- `uq_tb_sharing_rules_household_id` sobre `tb_sharing_rules(household_id, id)`.
- `uq_tb_sharing_rule_members_rule_member` sobre `tb_sharing_rule_members(sharing_rule_id, household_member_id)`.
- `uq_tb_expenses_household_id` sobre `tb_expenses(household_id, id)`.
- `uq_tb_expense_distributions_expense_member` sobre `tb_expense_distributions(expense_id, household_member_id)`.
- `uq_tb_processed_whatsapp_events_external_event_id` sobre `tb_processed_whatsapp_events(external_event_id)`.
- Índice único parcial `uq_tb_pending_proposals_active_conversation` sobre `tb_pending_proposals(household_id, conversation_key) WHERE status = 'AWAITING_CONFIRMATION'`.
- Índice único parcial `uq_tb_receipts_active_conversation` sobre `tb_receipts(household_id, conversation_key) WHERE expense_id IS NULL AND processing_status IN ('PENDING', 'FAILED')`.

### Índices de rendimiento

| Índice | Columnas |
| --- | --- |
| `idx_tb_household_members_user_id` | `tb_household_members(user_id)` |
| `idx_tb_sharing_rules_household_id` | `tb_sharing_rules(household_id)` |
| `idx_tb_sharing_rule_members_member_id` | `tb_sharing_rule_members(household_member_id)` |
| `idx_tb_expenses_household_date` | `tb_expenses(household_id, expense_date DESC)` |
| `idx_tb_expenses_household_status_date` | `tb_expenses(household_id, status, expense_date DESC)` |
| `idx_tb_expenses_paid_by_date` | `tb_expenses(paid_by, expense_date DESC)` |
| `idx_tb_expenses_category_id` | `tb_expenses(category_id)` |
| `idx_tb_expense_items_expense_id` | `tb_expense_items(expense_id)` |
| `idx_tb_expense_items_category_id` | `tb_expense_items(category_id)` |
| `idx_tb_expense_distributions_member_id` | `tb_expense_distributions(household_member_id)` |
| `idx_tb_incomes_household_date` | `tb_incomes(household_id, income_date DESC)` |
| `idx_tb_incomes_household_member_date` | `tb_incomes(household_id, member_id, income_date DESC)` |
| `idx_tb_incomes_household_category_date` | `tb_incomes(household_id, category_id, income_date DESC)` |
| `idx_tb_receipts_household_conversation` | `tb_receipts(household_id, conversation_key)` |
| `idx_tb_receipts_expense_id` | `tb_receipts(expense_id)` |

## 28.5 Invariantes y responsable de validación

Clasificación:

- **A — PostgreSQL:** la migración de Fase 1 protege la invariante mediante PK, FK, UNIQUE, CHECK o constraint trigger.
- **B — Dominio:** el service de Fase 2 protege la regla operacional; PostgreSQL no la ejecuta por sí solo.

| Invariante | Clase | Mecanismo |
| --- | --- | --- |
| IDs internos únicos | A | PK UUID |
| `Expense.total_amount > 0` | A | CHECK |
| `Income.amount > 0` | A | CHECK |
| Items con `total_amount > 0` | A | CHECK |
| Montos y porcentajes de distribuciones no negativos | A | CHECK |
| Porcentajes individuales entre 0 y 100 | A | CHECK |
| Categorías referenciadas existen | A | FK; las categorías opcionales aceptan NULL |
| `Expense.created_by` pertenece al mismo household | A | FK compuesta |
| `Expense.paid_by` pertenece al mismo household | A | FK compuesta |
| `Income.created_by` pertenece al mismo household | A | FK compuesta |
| `Income.member_id` pertenece al mismo household | A | FK compuesta |
| Receipt y Expense pertenecen al mismo household | A | FK compuesta |
| Receipt solo se asocia cuando está `PROCESSED` | A | CHECK |
| Un receipt activo por hogar y conversación | A | índice único parcial |
| Una propuesta pendiente por hogar y conversación | A | índice único parcial |
| Idempotencia de evento WhatsApp | A | UNIQUE de `external_event_id` |
| Un integrante por distribución de Expense | A | UNIQUE |
| `SUM(ExpenseItem.total_amount) <= Expense.total_amount` | A | constraint trigger diferido |
| Distribuciones de Expense `CONFIRMED` suman `Expense.total_amount` | A | constraint trigger diferido |
| Integrante de ExpenseDistribution pertenece al hogar del Expense | A | constraint trigger diferido |
| Participantes de SharingRule pertenecen al hogar de la regla | A | constraint trigger diferido |
| Porcentajes de una SharingRule suman exactamente 100 | A | constraint trigger diferido |
| `PENDING` se elimina, `CONFIRMED` pasa a `CANCELLED`, `CANCELLED` es idempotente | B | Expense service de Fase 2 |
| Income se elimina físicamente | B | Income service de Fase 2 |
| Confirmar/rechazar consume la propuesta correcta de forma atómica | B | Agent/service y transacción de Fase 2; el índice evita propuestas simultáneas |
| Reserva atómica de eventos antes de ejecutar el agente | B | WhatsApp repository/service de fase posterior; UNIQUE resuelve la carrera |
| Los ingresos no afectan el balance entre integrantes | B | `balance.service.ts` consulta exclusivamente Expense y ExpenseDistribution |
| Solo Expense `CONFIRMED` participa en balances y dashboard | B | consultas de services de Fase 2 y dashboard |
| Agregación por categoría no supera `Expense.total_amount` | B | service aplica items primero y limita la parte restante al total del Expense |

Las reglas de clase A también podrán validarse anticipadamente en los services para devolver errores de dominio comprensibles, pero PostgreSQL seguirá siendo la última barrera de integridad.

## 28.6 Triggers de Fase 1

### `fn_set_updated_at`

Función `BEFORE UPDATE` que asigna `NEW.updated_at = now()`. Se conecta mediante:

- `trg_tb_expenses_set_updated_at`.
- `trg_tb_incomes_set_updated_at`.
- `trg_tb_sharing_rules_set_updated_at`.
- `trg_tb_pending_proposals_set_updated_at`.

No representa auditoría avanzada; únicamente mantiene el timestamp aprobado.

### `fn_validate_expense_item_total`

Constraint trigger `DEFERRABLE INITIALLY DEFERRED` que valida al terminar la transacción:

```text
COALESCE(SUM(tb_expense_items.total_amount), 0) <= tb_expenses.total_amount
```

Se ejecuta después de insertar, actualizar o eliminar ExpenseItem y después de modificar `Expense.total_amount`. Debe validar tanto el `expense_id` anterior como el nuevo cuando un item cambie de Expense. Un CHECK ordinario no puede agregar otras filas; el carácter diferido permite reemplazar todos los items dentro de una misma transacción.

### `fn_validate_expense_distributions`

Constraint trigger `DEFERRABLE INITIALLY DEFERRED` que, para cada Expense `CONFIRMED` afectado, valida:

```text
COALESCE(SUM(tb_expense_distributions.amount), 0) = tb_expenses.total_amount
```

También comprueba, mediante consulta a Expense y HouseholdMember, que cada `household_member_id` pertenezca al hogar del Expense. Se ejecuta después de insertar, actualizar o eliminar distribuciones y después de modificar `Expense.total_amount`, `Expense.status` o `Expense.household_id`. Debe validar los Expense anterior y nuevo cuando cambie `expense_id`.

Un CHECK no puede sumar filas ni comparar la pertenencia a través de dos relaciones. El trigger es diferido para permitir crear el Expense y todas sus distribuciones dentro de una sola transacción.

### `fn_validate_sharing_rule_members`

Constraint trigger `DEFERRABLE INITIALLY DEFERRED` que valida:

```text
SUM(tb_sharing_rule_members.percentage) = 100.00
```

También comprueba que todos los integrantes pertenezcan al hogar de la SharingRule. Se ejecuta después de insertar, actualizar o eliminar participaciones y después de modificar `SharingRule.household_id`. Debe validar las reglas anterior y nueva cuando cambie `sharing_rule_id`.

Un CHECK ordinario no puede agregar varias filas ni seguir ambas relaciones. La ejecución diferida permite insertar todas las participaciones de una regla dentro de la misma transacción.

No se crearán triggers para invariantes que ya quedan resueltas mediante FK, CHECK o índices únicos, ni para ejecutar transiciones de negocio propias de Fase 2.

## 28.7 Escritura atómica del agregado Expense

La creación de `Expense`, sus `ExpenseItem` opcionales y sus `ExpenseDistribution` se realizará mediante una única función PostgreSQL invocada como RPC por `expense.repository.ts`. No se utilizarán inserciones PostgREST independientes ni un estado `PENDING` transitorio.

Contrato físico aprobado:

```text
public.fn_create_expense(
  p_household_id UUID,
  p_created_by UUID,
  p_paid_by UUID,
  p_category_id UUID,
  p_receipt_id UUID,
  p_merchant TEXT,
  p_total_amount NUMERIC(14,2),
  p_expense_date DATE,
  p_description TEXT,
  p_source public.expense_source,
  p_items JSONB,
  p_distributions JSONB
) RETURNS UUID
```

- `p_category_id`, `p_receipt_id`, `p_merchant` y `p_description` aceptan `NULL`.
- `p_items` contiene cero o más objetos con `name`, `quantity`, `unitPrice`, `totalAmount` y `categoryId`; los campos opcionales se representan con `NULL`.
- `p_distributions` contiene uno o más objetos con `householdMemberId`, `amount` y `percentage`. `amount` llega ya calculado mediante la regla determinista de restos mayores.
- La función asigna `currency = 'COP'`, `status = 'CONFIRMED'` y genera los identificadores y timestamps mediante los defaults físicos existentes.
- La función inserta el Expense, los items y las distribuciones dentro de la transacción única de la llamada RPC y devuelve el UUID del Expense creado.
- Cuando `p_receipt_id` se proporciona, la función valida que el Receipt pertenezca al mismo hogar y tenga estado `PROCESSED`, y actualiza `Receipt.expense_id` con el Expense recién creado dentro de la misma transacción. Un Receipt inexistente, ajeno al hogar o con cualquier estado distinto de `PROCESSED` rechazará toda la RPC sin persistir cambios parciales.
- La asociación opcional del Receipt forma parte de la misma unidad atómica que Expense, ExpenseItems y ExpenseDistributions; no se realizará mediante una llamada PostgREST posterior.
- La función será `SECURITY INVOKER`, utilizará nombres de objetos calificados con `public` y no constituirá una abstracción genérica de movimientos financieros.
- El service realizará las validaciones de dominio y el cálculo determinista antes de invocar al repository. La función y los constraints/triggers diferidos existentes serán la última barrera de integridad.
- `service_role` recibirá únicamente los permisos de escritura y ejecución necesarios para esta función. La RPC no será accesible desde el cliente ni desde el agente.

La función fue creada mediante la migración versionada `0003_expense_write_access.sql`; las migraciones anteriores no fueron modificadas retroactivamente.

## 28.8 Seed determinista

El seed se ejecutará dentro de una única transacción y en el orden descrito. Usará `INSERT ... ON CONFLICT (id) DO UPDATE` con los mismos valores definidos aquí, por lo que podrá ejecutarse varias veces sin duplicar filas y restaurará los datos base deterministas.

Timestamp común para todos los registros del seed:

```text
2026-01-01 00:00:00+00
```

### Orden 1 — Household

| id | name |
| --- | --- |
| `00000000-0000-4000-8000-000000000001` | `Hogar Demo` |

### Orden 2 — Users

| id | display_name | external_identifier |
| --- | --- | --- |
| `00000000-0000-4000-8000-000000000011` | `Felipe` | `seed-user-felipe` |
| `00000000-0000-4000-8000-000000000012` | `Pareja` | `seed-user-pareja` |

Se utilizan dos User porque los dos HouseholdMember representan identidades distintas y `user_id` es obligatorio.

### Orden 3 — HouseholdMembers

| id | household_id | user_id | display_name |
| --- | --- | --- | --- |
| `00000000-0000-4000-8000-000000000021` | `00000000-0000-4000-8000-000000000001` | `00000000-0000-4000-8000-000000000011` | `Felipe` |
| `00000000-0000-4000-8000-000000000022` | `00000000-0000-4000-8000-000000000001` | `00000000-0000-4000-8000-000000000012` | `Pareja` |

### Orden 4 — Categories

| id | name | description |
| --- | --- | --- |
| `00000000-0000-4000-8000-000000000031` | `Alimentación` | `Compras de alimentos` |
| `00000000-0000-4000-8000-000000000032` | `Otros` | `Registros sin categoría específica` |
| `00000000-0000-4000-8000-000000000033` | `Salario` | `Ingresos salariales` |
| `00000000-0000-4000-8000-000000000034` | `Honorarios` | `Ingresos por servicios profesionales` |

Este catálogo mínimo permite probar gastos, categoría residual, ingresos sin categoría e ingresos categorizados sin crear una jerarquía separada.

### Orden 5 — SharingRule

| id | household_id | name | description |
| --- | --- | --- | --- |
| `00000000-0000-4000-8000-000000000041` | `00000000-0000-4000-8000-000000000001` | `50 / 50` | `Distribución equitativa entre los dos integrantes` |

### Orden 6 — SharingRuleMembers

| id | sharing_rule_id | household_member_id | percentage |
| --- | --- | --- | --- |
| `00000000-0000-4000-8000-000000000051` | `00000000-0000-4000-8000-000000000041` | `00000000-0000-4000-8000-000000000021` | `50.00` |
| `00000000-0000-4000-8000-000000000052` | `00000000-0000-4000-8000-000000000041` | `00000000-0000-4000-8000-000000000022` | `50.00` |

El trigger diferido de porcentajes se evalúa al cerrar la transacción, después de insertar ambos integrantes. El seed no crea gastos, ingresos, receipts, propuestas ni eventos ficticios.

## 28.9 Pruebas SQL de Fase 1

La Fase 1 no incorporó un test runner ni dependencias nuevas. Las comprobaciones existen como `tests/phase-1-integrity.sql` y `tests/phase-1-seed-idempotency.sql`; ambos scripts fueron ejecutados y validados contra PostgreSQL/Supabase mediante `psql`.

El script de integridad deberá ejecutarse dentro de `BEGIN ... ROLLBACK` y comprobar:

- existencia de schema, enums, tablas, columnas, tipos, defaults, PK, FK, CHECK, UNIQUE, índices y triggers;
- aceptación de un conjunto válido mínimo;
- rechazo de UUID externos inexistentes;
- rechazo de `created_by`, `paid_by` o `member_id` pertenecientes a otro hogar;
- rechazo de montos no positivos;
- rechazo de categorías inexistentes;
- rechazo de suma de items superior al total del Expense;
- rechazo de distribuciones incompletas o con integrantes de otro hogar;
- rechazo de reglas que no sumen 100% o incluyan integrantes de otro hogar;
- rechazo de Receipt asociado a Expense de otro hogar;
- rechazo de Receipt no `PROCESSED` asociado a Expense;
- rechazo de un segundo receipt activo para el mismo hogar y conversación;
- rechazo de una segunda propuesta pendiente para el mismo hogar y conversación;
- rechazo de un `external_event_id` duplicado;
- actualización automática de `updated_at`.

Los errores esperados se comprobarán con bloques PostgreSQL `DO ... EXCEPTION`. El script finalizará con `ROLLBACK` y no dejará datos de prueba.

La idempotencia del seed se comprobará ejecutándolo dos veces y verificando por los UUID fijos que existan exactamente un hogar, dos usuarios, dos integrantes, cuatro categorías, una regla y dos participaciones con suma `100.00`.

Las siguientes reglas no se probarán como invariantes SQL en Fase 1 porque corresponden a services de Fase 2:

- transición de eliminación de Expense según su estado;
- eliminación física de Income;
- consumo transaccional de PendingProposal;
- reserva del evento antes de ejecutar el agente;
- exclusión de Income del balance entre integrantes;
- filtros y agregaciones financieras del backend.

Las pruebas SQL requieren una instancia PostgreSQL/Supabase disponible. Las comprobaciones estáticas de TypeScript, lint, formato y build no sustituyen la ejecución real de las migraciones.

## 28.10 Compatibilidad y alcance

Esta especificación mantiene:

- `Expense` e `Income` como entidades independientes;
- `ExpenseDistribution` como nombre aprobado;
- el flujo `Agent → Tool → Service → Repository → PostgreSQL`;
- acceso a la base de datos únicamente desde backend mediante el cliente administrativo;
- `SUPABASE_SERVICE_ROLE_KEY` exclusivamente en servidor;
- balances entre integrantes basados solo en Expense confirmado, `paid_by` y ExpenseDistribution;
- Income únicamente en resúmenes financieros generales;
- receipts, propuestas y eventos como persistencia mínima de continuidad e idempotencia.

No incorpora RLS, autenticación formal, soft delete, auditoría avanzada, eventos, colas, Redis, microservicios, nuevos endpoints ni nuevas entidades. La migración, seed y pruebas SQL se crearán únicamente después de aprobar esta especificación.
