# Project Structure — HouseMate AI

Version: 1.0

---

# 1. Propósito

Este documento define la estructura física del repositorio de HouseMate AI.

Su objetivo es establecer una organización clara para el código, facilitar el desarrollo incremental y mantener separadas las responsabilidades principales del sistema.

La estructura deberá ser suficientemente simple para el MVP y podrá evolucionar a medida que aumente la complejidad real del proyecto.

---

# 2. Principios

La estructura del proyecto seguirá los siguientes principios:

- Modularidad.
- Bajo acoplamiento.
- Separación de responsabilidades.
- Simplicidad.
- Facilidad de navegación.
- Reutilización razonable.
- Compatibilidad con el modular monolith definido en la arquitectura.
- Evitar abstracciones innecesarias.

La estructura no deberá anticipar problemas que todavía no existen.

---

# 3. Estructura general

La estructura inicial será:

```text
housemate-ai/
│
├── app/
│   ├── api/
│   ├── dashboard/
│   └── ...
│
├── modules/
│   ├── expenses/
│   ├── incomes/
│   ├── categories/
│   ├── sharing-rules/
│   ├── dashboard/
│   ├── receipts/
│   ├── agent/
│   └── whatsapp/
│
├── infrastructure/
│   ├── database/
│   ├── storage/
│   ├── openai/
│   └── whatsapp/
│
├── database/
│   ├── migrations/
│   └── seeds/
│
├── tests/
│
├── docs/
│
├── public/
│
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

La estructura podrá modificarse durante la implementación si la complejidad real del código demuestra que una organización diferente resulta más adecuada.

# 4. app/

Contendrá las rutas y elementos propios de Next.js.

Ejemplo:

app/
├── api/
│ ├── expenses/
│ ├── incomes/
│ ├── categories/
│ ├── sharing-rules/
│ ├── balance/
│ ├── dashboard/
│ ├── receipts/
│ └── webhooks/
│ └── whatsapp/
│
├── dashboard/
│
├── expenses/
│
├── chat/
│
└── page.tsx
Responsabilidad

Esta carpeta representa principalmente la capa de presentación y entrada de la aplicación.

No deberá contener reglas financieras complejas.

Las rutas deberán delegar las operaciones en los módulos correspondientes.

El primer Route Handler implementado es `app/api/categories/route.ts`, que expone `GET /api/categories` y delega en `modules/categories/category.service.ts` sin acceder directamente a persistencia ni resolver contexto de hogar.

Web/PWA podrá consumir directamente estas rutas para vistas y operaciones explícitas, sin contener lógica de negocio ni acceder a repositories.

`app/api/_lib/http-context.ts` adapta las variables server-side del MVP al módulo `modules/context`, sin leer identidad desde requests ni acceder directamente a Supabase.

`app/api/expenses/route.ts` expone `GET /api/expenses`, construye únicamente los filtros HTTP documentados, obtiene el hogar mediante el adaptador de contexto controlado y delega el listado en `modules/expenses/expense.service.ts`.

# 5. modules/

Contendrá los módulos funcionales del dominio.

Cada módulo representa una capacidad del negocio.

modules/
├── context/
├── expenses/
├── incomes/
├── categories/
├── sharing-rules/
├── dashboard/
├── receipts/
├── agent/
└── whatsapp/

`modules/context` valida la configuración server-side del hogar y actor Web/PWA y consulta exclusivamente hogares e integrantes para devolver contexto controlado. No implementa autenticación ni reemplaza las validaciones de los módulos financieros.

# 6. Módulo expenses

Responsable de la gestión de gastos.

Ejemplo:

modules/
└── expenses/
├── expense.service.ts
├── expense.repository.ts
├── balance.service.ts
├── expense.types.ts
└── expense.validation.ts

Responsabilidades:

Crear gastos.
Consultar gastos.
Actualizar gastos.
Eliminar gastos.
Validar información relacionada con gastos.
Calcular el balance de compensación mediante gastos confirmados, `paid_by` y `ExpenseDistribution`.

El core implementado de Balance separa repository, validación, tipos, service y cálculo puro. El repository restringe miembros y Expenses `CONFIRMED` al hogar controlado y recupera las distribuciones persistidas; el cálculo usa centavos enteros, incluye integrantes sin actividad y no crea persistencia propia.

`expense.service.ts` validará la entrada y calculará los montos de distribución mediante restos mayores en centavos. `expense.repository.ts` realizará una única llamada a la RPC PostgreSQL específica `public.fn_create_expense` para persistir atómicamente Expense, ExpenseItems y ExpenseDistributions. No ejecutará inserts PostgREST independientes ni existirá una abstracción genérica de movimientos financieros.

Para actualización, el mismo service aplicará la semántica PATCH y recalculará distribuciones cuando corresponda; el repository realizará una única llamada a `public.fn_update_expense`. La RPC bloqueará y actualizará el agregado de forma transaccional, sin escrituras PostgREST independientes y sin modificar Receipt.

Para eliminación, `expense.service.ts` validará contexto e identificador y devolverá `DELETED`, `CANCELLED` o `ALREADY_CANCELLED`. `expense.repository.ts` realizará una única llamada a `public.fn_delete_expense`; la RPC decidirá la transición bajo bloqueo y no modificará Receipt.

`merchant` será `string | null` en los tipos de Expense y se persistirá como `NULL` cuando no esté disponible.

La lógica financiera relevante deberá permanecer dentro del módulo o de servicios de dominio relacionados.

# 7. Módulo incomes

Responsable de la gestión independiente de ingresos.

```text
modules/
└── incomes/
    ├── income.service.ts
    ├── income.repository.ts
    ├── income.types.ts
    └── income.validation.ts
```

Responsabilidades:

Crear ingresos.
Consultar ingresos y obtener totales calculados por el backend.
Actualizar ingresos.
Eliminar ingresos físicamente.
Validar el contexto de hogar, integrantes, monto, fecha y categoría opcional.

El incremento de lectura implementado limita `listIncomes` a los filtros `from`, `to`, `memberId` y `categoryId`. El repository aplica siempre el hogar controlado y el orden `income_date DESC`, `created_at DESC`, `id ASC`; el service valida el contexto y los filtros, comprueba la pertenencia de `memberId` y suma `totalIncome` en centavos enteros sobre los registros devueltos.

Para actualización, `income.service.ts` aplica la semántica PATCH y valida integrante y categoría cuando se proporcionan. `income.repository.ts` actualiza una única fila mediante PostgREST con filtro obligatorio `id + household_id`, devuelve la representación hidratada y no permite modificar hogar, creador, identificador ni timestamps.

Para eliminación, `income.service.ts` valida el contexto y el identificador. `income.repository.ts` elimina físicamente mediante una única operación PostgREST con filtro obligatorio `id + household_id`; devuelve `DELETED` y trata un ingreso inexistente o de otro hogar como `NOT_FOUND`, sin RPC ni soft delete.

El módulo no contendrá items, pagadores, distribuciones ni reglas de reparto. No existirá una carpeta o abstracción genérica de movimientos financieros compartida con `expenses`.

# 8. Módulo categories

Responsable del catálogo de categorías utilizado por gastos e ingresos.

Ejemplo:

modules/
└── categories/
├── category.service.ts
├── category.repository.ts
└── category.types.ts

Responsabilidades:

Obtener categorías.

Las categorías se cargarán mediante seed/configuración. El MVP no implementará CRUD de categorías.

La lectura implementada utiliza `category.service.ts` y `category.repository.ts` para consultar mediante PostgREST el catálogo global preconfigurado. El resultado expone únicamente `id` y `name`, sin filtros de hogar, RPC ni permisos adicionales.

No deberá contener lógica relacionada con la persistencia específica de Supabase fuera del repository correspondiente.

# 9. Módulo sharing-rules

Responsable de las reglas de reparto.

Ejemplo:

modules/
└── sharing-rules/
├── sharing-rule.service.ts
├── sharing-rule.repository.ts
├── sharing-rule.types.ts
└── split-calculator.ts

Responsabilidades:

Obtener reglas.
Validar reglas.
Calcular distribuciones.
Aplicar porcentajes.
Determinar la participación de cada miembro.

Las reglas serán preconfiguradas; el módulo no implementará CRUD durante el MVP.

Los cálculos deberán ser determinísticos.

La lectura implementada filtra reglas y participaciones por el hogar controlado. `calculateSplit` produce una distribución sin persistirla ni elegir reglas automáticamente, y `split-calculator.ts` centraliza el mismo algoritmo de restos mayores utilizado por Expense. Balance permanece separado y consume distribuciones ya persistidas.

# 10. Módulo dashboard

Responsable de preparar información agregada para el dashboard.

Ejemplo:

modules/
└── dashboard/
├── dashboard.types.ts
├── dashboard.validation.ts
├── dashboard.repository.ts
├── dashboard.service.ts
└── dashboard-calculator.ts

No deberá almacenar información financiera duplicada.

Los valores deberán calcularse a partir de los datos existentes.

El core implementado consulta Income y Expenses `CONFIRMED` mediante lecturas PostgREST independientes, siempre aisladas por el hogar controlado y con filtros inclusivos `from`/`to`. El calculador puro produce los seis agregados aprobados en centavos enteros; `byCategory` combina items categorizados, remanente de la categoría general y el bucket `null`/`null` sin persistir resultados. No garantiza un snapshot transaccional único y permanece separado de Balance, Sharing Rules y ExpenseDistribution.

# 11. Módulo receipts

Responsable del procesamiento de facturas.

Ejemplo:

modules/
└── receipts/
├── receipt.service.ts
├── receipt.repository.ts
├── receipt.types.ts
└── receipt.validation.ts

Responsabilidades:

Recibir referencias a imágenes.
Coordinar el análisis de facturas.
Validar resultados.
Preparar información estructurada.
Asociar una factura con un gasto.
Persistir y consultar receipts por `household_id`, incluso mientras `expense_id` sea nulo.

El análisis mediante IA será delegado a la infraestructura correspondiente.

# 12. Módulo agent

Responsable de la interacción entre el agente y las capacidades del sistema.

Ejemplo:

modules/
└── agent/
├── agent.service.ts
├── agent.types.ts
├── pending-proposal.repository.ts
├── prompts/
│ └── system-prompt.ts
└── tools/
├── create-expense.tool.ts
├── get-expense.tool.ts
├── update-expense.tool.ts
├── delete-expense.tool.ts
├── create-income.tool.ts
├── get-incomes.tool.ts
├── update-income.tool.ts
├── delete-income.tool.ts
├── get-expenses.tool.ts
├── get-expense-summary.tool.ts
├── get-balance.tool.ts
├── get-categories.tool.ts
├── get-sharing-rules.tool.ts
├── calculate-split.tool.ts
└── analyze-receipt.tool.ts
Responsabilidad

El módulo deberá:

interpretar solicitudes;
administrar la interacción con el modelo;
registrar las herramientas disponibles;
proporcionar contexto controlado;
procesar resultados;
generar respuestas.

El agente no accederá directamente a repositories o a la base de datos.

Las tools deberán utilizar los servicios del sistema.

Las tools de ingresos seguirán la misma regla: `Agent → Tool → Income Service → Income Repository`. Ninguna accederá directamente a PostgreSQL.

# 13. Módulo whatsapp

Responsable de la lógica específica del canal WhatsApp.

Ejemplo:

modules/
└── whatsapp/
├── whatsapp.service.ts
├── processed-whatsapp-event.repository.ts
├── whatsapp.types.ts
└── whatsapp.mapper.ts

Responsabilidades:

Interpretar eventos recibidos desde WhatsApp.
Transformarlos al formato interno.
Enviar mensajes.
Procesar información específica del canal.
Reservar de forma atómica `ProcessedWhatsAppEvent.external_event_id` mediante el repository antes de entregar el evento al agente.

La lógica financiera no deberá implementarse aquí.

# 14. infrastructure/

Contendrá implementaciones específicas de proveedores externos y mecanismos técnicos.

infrastructure/
├── database/
├── storage/
├── openai/
└── whatsapp/

# 15. infrastructure/database

Contendrá la conexión y mecanismos de acceso a PostgreSQL/Supabase.

Ejemplo:

infrastructure/
└── database/
├── client.ts
└── ...

Los repositories podrán utilizar esta infraestructura para acceder a la base de datos.

El resto de la aplicación no deberá depender directamente de detalles específicos de conexión.

# 16. infrastructure/storage

Responsable de la interacción con Supabase Storage.

Ejemplo:

infrastructure/
└── storage/
├── storage.client.ts
└── storage.service.ts

Responsabilidades:

Subir archivos.
Obtener referencias.
Eliminar archivos cuando corresponda.

# 17. infrastructure/openai

Responsable de la integración con OpenAI.

Ejemplo:

infrastructure/
└── openai/
├── openai.client.ts
└── openai.service.ts

Esta capa encapsulará la comunicación con OpenAI.

El resto del sistema no deberá depender directamente de detalles específicos del SDK cuando no sea necesario.

# 18. infrastructure/whatsapp

Responsable de la comunicación técnica con WhatsApp Cloud API.

Ejemplo:

infrastructure/
└── whatsapp/
├── whatsapp.client.ts
└── whatsapp.service.ts

Esta separación permite que:

modules/whatsapp

maneje el comportamiento del canal mientras:

infrastructure/whatsapp

maneja la comunicación con el proveedor externo.

# 19. database/

Contendrá artefactos relacionados con la estructura de la base de datos.

database/
├── migrations/
└── seeds/
migrations

Contendrá los cambios versionados del schema.

seeds

Contendrá datos iniciales necesarios para desarrollo y pruebas.

No deberá utilizarse para almacenar lógica de negocio.

# 20. tests/

Contendrá las pruebas automatizadas.

La estructura podrá reflejar los módulos principales:

tests/
├── expenses/
├── incomes/
├── sharing-rules/
├── agent/
├── api/
└── integration/

No será obligatorio crear pruebas para cada archivo.

`tests/phase-3-category-api-functional.cjs` valida el contrato HTTP de Category mediante el Route Handler, Service y Repository reales con un cliente Supabase controlado, sin agregar un framework de pruebas.

`tests/phase-3-http-context-functional.cjs` valida resolución server-side, formato, existencia, pertenencia, aislamiento y sanitización del contexto HTTP mediante Service y Repository reales con un cliente Supabase controlado.

`tests/phase-3-expense-api-functional.cjs` valida el contrato, filtros, contexto controlado, aislamiento y sanitización de `GET /api/expenses` mediante Route Handler, Service y Repository reales con un cliente Supabase controlado.

La prioridad será cubrir:

cálculos financieros;
operaciones de gastos;
operaciones de ingresos;
herramientas del agente;
APIs críticas;
integraciones importantes.

# 21. docs/

Contendrá la documentación del proyecto.

Ejemplo:

docs/
└── architecture/
├── architecture_overview.md
├── c4_context.md
├── c4_container.md
├── data_model.md
├── tech_stack.md
├── security.md
├── api_contract.md
├── agent_architecture.md
├── implementation_plan.md
└── project_structure.md

La documentación arquitectónica existente deberá mantenerse como fuente de referencia para las decisiones técnicas.

# 22. Dependencias entre capas

La dirección general de dependencias será:

app
│
▼
modules
│
▼
infrastructure

Por ejemplo:

API Route
↓
Expense Service
↓
Expense Repository
↓
Database Infrastructure
↓
Supabase

Para el agente:

API / WhatsApp
↓
Agent
↓
Tool
↓
Service
↓
Repository
↓
Database

# 23. Regla de dependencia

Los módulos de negocio no deberán importar directamente detalles de proveedores externos cuando pueda evitarse razonablemente.

Ejemplo incorrecto:

expense.service.ts
↓
Supabase SDK

Preferido:

expense.service.ts
↓
expense.repository.ts
↓
database client
↓
Supabase

La separación deberá utilizarse cuando aporte claridad.

No se crearán abstracciones adicionales únicamente para cumplir un patrón arquitectónico.

# 24. Regla para nuevos módulos

No se deberá crear un nuevo módulo únicamente porque exista una nueva tabla.

Un módulo deberá representar una capacidad funcional del sistema.

Por ejemplo:

Expense

es un módulo válido porque representa una capacidad del negocio.

Una tabla auxiliar pequeña no necesariamente necesita convertirse en un módulo independiente.

# 25. Regla para nuevos archivos

Antes de crear un nuevo archivo se deberá evaluar:

¿Tiene una responsabilidad diferente?
¿Facilita realmente la navegación?
¿Evita duplicación?
¿Tiene posibilidades razonables de crecer?

Si la respuesta es no, puede mantenerse dentro de un archivo existente.

# 26. Regla contra over-engineering

No se deberán introducir inicialmente:

Clean Architecture completa.
Hexagonal Architecture completa.
CQRS.
Event Sourcing.
Mediator.
Dependency Injection framework.
múltiples capas artificiales.
múltiples repositories para una misma operación.
abstracciones para proveedores que todavía no necesitan ser reemplazados.

La estructura podrá evolucionar si la complejidad real del proyecto lo justifica.

# 27. Variables de entorno

Los secretos y configuraciones sensibles deberán mantenerse fuera del código.

Ejemplo:

.env.local

No deberá incluirse en Git.

Se proporcionará:

.env.example

con los nombres de las variables necesarias pero sin valores secretos.

Ejemplo:

DATABASE_URL=
OPENAI_API_KEY=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=

# 28. README

El README.md deberá contener como mínimo:

descripción del proyecto;
requisitos;
instalación;
configuración de variables de entorno;
ejecución local;
ejecución de tests;
estructura general;
instrucciones básicas de deployment.

No deberá duplicar toda la documentación arquitectónica.

# 29. Evolución futura

La estructura permitirá evolucionar hacia una arquitectura más compleja si el producto lo requiere.

Por ejemplo:

MVP

Monolito Modular
↓
Mayor complejidad
↓
Separación de módulos
↓
Servicios independientes

Esta evolución no deberá realizarse anticipadamente.

La arquitectura deberá evolucionar como respuesta a necesidades reales.

# 30. Resumen

La estructura de HouseMate AI se basa en:

Next.js
│
├── app/
│
├── modules/
│ ├── expenses
│ ├── incomes
│ ├── categories
│ ├── sharing-rules
│ ├── dashboard
│ ├── receipts
│ ├── agent
│ └── whatsapp
│
├── infrastructure/
│ ├── database
│ ├── storage
│ ├── openai
│ └── whatsapp
│
├── database/
│ ├── migrations
│ └── seeds
│
├── tests/
│
└── docs/

Esta estructura proporciona una separación suficiente para mantener el proyecto organizado sin introducir complejidad innecesaria.

El principio principal es:

Organizar el código según responsabilidades reales del sistema, no según patrones arquitectónicos aplicados de forma preventiva.

La implementación actual ya incluye la persistencia inicial, sus migraciones y pruebas SQL, además de la lectura y creación de Expense dentro de `modules/expenses`. Las capacidades restantes se incorporarán en las ubicaciones definidas por esta estructura conforme avance el plan de implementación.
