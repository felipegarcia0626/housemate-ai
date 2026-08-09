# Implementation Plan — HouseMate AI

Version: 1.0

---

# 1. Propósito

Este documento define el plan de implementación del MVP de HouseMate AI.

Su objetivo es transformar las decisiones definidas en la documentación de arquitectura en una aplicación funcional dentro del plazo máximo disponible.

El plan prioriza:

- Entregar un MVP funcional.
- Reducir riesgos técnicos tempranamente.
- Mantener el alcance controlado.
- Implementar primero las capacidades fundamentales.
- Evitar over-engineering.
- Utilizar infraestructura administrada de bajo costo.
- Permitir desarrollo incremental y validación continua.

---

# 2. Objetivo del MVP

Al finalizar la implementación, HouseMate AI deberá permitir:

1. Registrar gastos mediante lenguaje natural.
2. Registrar, consultar, editar y eliminar ingresos.
3. Consultar gastos e ingresos.
4. Consultar balances.
5. Aplicar reglas básicas de reparto.
6. Analizar fotografías de facturas.
7. Confirmar información antes de persistir cuando corresponda.
8. Consultar información financiera mediante lenguaje natural.
9. Utilizar WhatsApp como canal conversacional.
10. Utilizar Web/PWA como interfaz visual.
11. Mostrar información financiera básica mediante un dashboard.

El MVP no deberá intentar resolver todas las capacidades futuras del producto.

---

# 3. Estrategia de implementación

La implementación seguirá una estrategia incremental.

Cada fase deberá producir un resultado funcional o verificable antes de avanzar a la siguiente.

```text
Arquitectura
     ↓
Inicialización
     ↓
Base de datos
     ↓
Core financiero
     ↓
API
     ↓
Agent
     ↓
WhatsApp
     ↓
Web / PWA
     ↓
Testing
     ↓
Deployment
```

No se deberá comenzar una fase posterior si una dependencia crítica de la fase actual no funciona.

# 4. Prioridad de funcionalidades

Las funcionalidades se clasificarán según su importancia.

P0 — Imprescindibles

Sin estas funcionalidades el MVP no cumple su objetivo principal.

Crear gasto.
Consultar gastos.
Crear, consultar, editar y eliminar ingresos.
Calcular balance.
Reglas básicas de reparto.
Análisis de facturas.
Dashboard.
Edición de gastos.
Eliminación de gastos.
Categorización automática.
Agente conversacional.
Herramientas del agente.
Persistencia en PostgreSQL.
WhatsApp.
Flujo básico Web/PWA.
P1 — Importantes

Deben implementarse si el tiempo disponible lo permite.

Comparaciones simples entre períodos.
P2 — Opcionales

No deben comprometer la entrega del MVP.

Recomendaciones financieras.
Visualizaciones avanzadas.
Automatizaciones.
Mejoras sofisticadas de memoria conversacional.
Funcionalidades adicionales de configuración.

Si una funcionalidad P2 amenaza el plazo, deberá eliminarse del MVP.

# 5. Fase 0 — Preparación

Objetivo

Preparar el entorno de desarrollo y el repositorio.

Actividades
Crear repositorio.
Inicializar proyecto Next.js.
Configurar TypeScript.
Configurar variables de entorno.
Configurar Git.
Crear estructura inicial de carpetas.
Configurar linting y formatting básicos.
Configurar conexión inicial con Supabase.
Resultado esperado

La aplicación deberá:

iniciar localmente;
compilar correctamente;
conectarse a Supabase;
utilizar variables de entorno sin exponer secretos.
Criterio de terminado
npm run dev

deberá iniciar la aplicación correctamente.

# 6. Fase 1 — Base de datos

Objetivo

Implementar el modelo de datos mínimo necesario para el MVP.

Entidades principales
User
Household
HouseholdMember
Category
Expense

- created_by → miembro que creó o registró el gasto
- paid_by → miembro que realizó el pago
- category_id → categoría general opcional del gasto
  ExpenseItem
- category_id → categoría específica del item
  Income
- household_id → hogar del ingreso
- created_by → miembro que registró el ingreso
- member_id → miembro al que pertenece el ingreso
- category_id → categoría opcional
  SharingRule
  ExpenseDistribution
  Receipt
  PendingProposal
  ProcessedWhatsAppEvent
  Actividades
  Crear schema inicial.
  Crear tablas.
  Crear relaciones.
  Crear restricciones.
  Validar que `Expense.created_by` y `Expense.paid_by` correspondan a integrantes del hogar del gasto.
  Validar las referencias opcionales de `Expense.category_id` y `ExpenseItem.category_id` contra `Category`.
  Validar que `Income.created_by` y `Income.member_id` pertenezcan a `Income.household_id`, que `Income.amount` sea mayor que cero y que `Income.category_id` sea válido cuando se proporcione.
  Asignar `Receipt.household_id` desde el contexto controlado y permitir `Receipt.expense_id` nullable hasta confirmar y asociar el receipt al Expense creado del mismo hogar.
  Permitir un único receipt activo por `household_id + conversation_key`; rechazar una segunda imagen sin reemplazar el receipt `PENDING` o `FAILED` existente.
  Crear unicidad para `PendingProposal(household_id, conversation_key)` y `ProcessedWhatsAppEvent.external_event_id`.
  Validar `SUM(ExpenseItem.total_amount) <= Expense.total_amount` en creación y actualización; rechazar la operación completa si se supera.
  Crear índices necesarios.
  Crear datos iniciales.
  Configurar conexión desde el backend.
  Seed inicial

Deberá existir información mínima para poder ejecutar la aplicación inmediatamente.

Por ejemplo:

un usuario;
un hogar;
dos miembros;
categorías básicas;
reglas de reparto básicas.

El catálogo existente podrá incluir categorías como Salario, Honorarios, Venta o Reembolso. No será necesario crear otro catálogo ni una jerarquía específica para ingresos, y la categoría continuará siendo opcional para `Income`.
Criterio de terminado

Debe ser posible:

crear gasto
↓
persistir gasto
↓
consultar gasto

sin utilizar todavía el agente.

# 7. Fase 2 — Core financiero

Objetivo

Implementar la lógica de negocio independiente de la interfaz y del agente.

Módulos
Expenses
Incomes
Categories
Sharing Rules
Funcionalidades
Expenses
Crear gasto.
Obtener gasto.
Listar gastos.
Actualizar gasto.
Eliminar gasto.

`merchant` será opcional y su ausencia se persistirá como `NULL`. Los tipos de Expense deberán representarlo como `string | null`; no se utilizarán cadenas artificiales.

La creación calculará `ExpenseDistribution.amount` mediante restos mayores en centavos, con porcentajes que sumen exactamente `100.00`, asignación inicial inferior, residuos por mayor parte fraccionaria y desempate por `memberId` ascendente. El resultado deberá sumar exactamente `Expense.total_amount` y no dependerá de aritmética financiera definitiva de punto flotante.

La escritura de Expense, ExpenseItems y ExpenseDistributions se realizará atómicamente mediante una única llamada del repository a `public.fn_create_expense`, implementada como RPC PostgreSQL `SECURITY INVOKER`. No se realizarán inserts PostgREST independientes ni se introducirá una abstracción genérica de movimientos.

La actualización parcial de Expense utilizará una única llamada del repository a `public.fn_update_expense`, también `SECURITY INVOKER`. La RPC bloqueará el Expense por `id + household_id`, actualizará únicamente los campos presentes y reemplazará items o distribuciones dentro de la misma transacción cuando se proporcionen. `receiptId` permanecerá inmutable y no participará en esta operación.

`POST /api/expenses` creará directamente Expense `CONFIRMED` después de la confirmación; el MVP no implementará un flujo que cree Expense `PENDING`. Se conservará su semántica documental de eliminación física, pero no será un caso obligatorio de implementación o prueba.
Incomes
Crear ingreso.
Consultar ingresos.
Actualizar ingreso.
Eliminar ingreso físicamente.
Categories
Obtener categorías.
Calcular resúmenes por categoría atribuyendo los items categorizados a su propia categoría y la parte restante de `Expense.total_amount` a `Expense.category_id` cuando exista.

Si no existe una categoría general, la parte restante quedará sin categorizar. La suma atribuida a categorías para un gasto nunca podrá superar `Expense.total_amount`.

El `byCategory` del dashboard incluirá únicamente gastos `CONFIRMED`; las categorías de Income no se mezclarán en esa colección.
Sharing Rules
Obtener reglas.
Calcular distribución.

Categorías y reglas se cargarán mediante seed/configuración. No se implementará CRUD para ellas durante el MVP.
Balance dentro de Expenses
Implementar `balance.service.ts` dentro de `modules/expenses`.
Calcular cuánto pagó cada miembro agrupando los gastos confirmados por `Expense.paid_by`, nunca por `Expense.created_by`.
Calcular cuánto corresponde a cada miembro mediante `ExpenseDistribution`.
Exponer el resultado mediante `GET /api/balance`; el controller solo delegará al service.

Los ingresos no participarán en el balance de compensación. Los resúmenes financieros calcularán `totalIncome`, `totalSpent` y `netAmount` en el backend sin almacenar estos agregados.
Principio

Los cálculos financieros deberán realizarse mediante código determinístico.

El LLM no realizará cálculos financieros definitivos.

Criterio de terminado

Las operaciones financieras principales deberán funcionar sin depender del agente.

# 8. Fase 3 — API

Objetivo

Exponer el core financiero mediante los contratos definidos en api_contract.md.

Endpoints principales
POST /api/expenses
GET /api/expenses
GET /api/expenses/{id}
PATCH /api/expenses/{id}
DELETE /api/expenses/{id}

POST /api/incomes
GET /api/incomes
PATCH /api/incomes/{id}
DELETE /api/incomes/{id}

GET /api/categories

GET /api/sharing-rules

GET /api/balance

GET /api/dashboard/summary

POST /api/receipts/analyze

GET /api/webhooks/whatsapp
POST /api/webhooks/whatsapp
Actividades
Implementar controllers.
Implementar services.
Implementar repositories.
Implementar validaciones.
Implementar manejo de errores.
Implementar respuestas estructuradas.
Implementar idempotencia donde sea necesaria.
Persistir propuestas pendientes para confirmaciones entre solicitudes separadas.
Rechazar una nueva escritura con `PENDING_PROPOSAL_EXISTS` cuando la conversación ya tenga una propuesta, sin reemplazarla. Validar el `PendingProposal.id` al confirmar o rechazar y no ejecutar respuestas tardías sobre propuestas consumidas.
Criterio de terminado

Las operaciones P0 deberán poder probarse sin utilizar la interfaz gráfica.

# 9. Fase 4 — Agent

Objetivo

Integrar el agente con el core financiero mediante herramientas controladas.

Herramientas iniciales
Gastos
create_expense
get_expense
update_expense
delete_expense
Ingresos
create_income
get_incomes
update_income
delete_income
Consultas
get_expenses
get_expense_summary
get_balance
Categorías
get_categories
Reparto
get_sharing_rules
calculate_split
Facturas
analyze_receipt
Actividades
Configurar OpenAI.
Implementar agente.
Definir instrucciones principales.
Implementar tools.
Definir schemas de entrada.
Definir resultados estructurados.
Usar los nombres camelCase y contratos canónicos documentados en `agent_architecture.md`; hogar, creador y clave de conversación provendrán del contexto controlado.
Implementar confirmación.
Implementar manejo de información incompleta.
Implementar manejo básico del contexto conversacional.
Resolver confirmaciones mediante `PendingProposal`, sin depender de memoria en proceso.
Principio

El agente deberá:

Interpretar
↓
Seleccionar herramienta
↓
Tool
↓
Backend
↓
Resultado
↓
Agente
↓
Respuesta

No deberá acceder directamente a PostgreSQL.

`create_income`, `update_income` y `delete_income` requerirán confirmación explícita de la propuesta correspondiente antes de escribir. `get_incomes` recibirá los totales calculados por el backend.

Criterio de terminado

Deberá funcionar como mínimo:

"Hoy gasté 80 mil en una cena"
↓
Agente
↓
Interpretación
↓
Confirmación
↓
create_expense
↓
PostgreSQL

# 10. Fase 5 — WhatsApp

Objetivo

Integrar el agente con WhatsApp Cloud API.

La integración básica con Meta deberá validarse antes de invertir tiempo significativo en esta fase.

Actividades
Configurar webhook.
Validar webhook.
Recibir mensajes.
Identificar remitente.
Resolver usuario.
Resolver hogar.
Entregar mensaje al agente.
Enviar respuesta.
Procesar imágenes.
Implementar prevención de eventos duplicados.
Flujo
Usuario
↓
WhatsApp
↓
Webhook
↓
Backend
↓
Agent
↓
Tools
↓
PostgreSQL
↓
Agent
↓
WhatsApp
↓
Usuario
Criterio de terminado

Debe ser posible completar una interacción financiera básica exclusivamente mediante WhatsApp.

Ejemplo:

Usuario:
"Hoy pagué 80 mil en una cena"

HouseMate:
"Entiendo: cena por $80.000, pagada por ti.
¿La registramos?"

Usuario:
"Sí"

HouseMate:
"Listo. Registré el gasto por $80.000."

# 11. Fase 6 — Web / PWA

Objetivo

Construir la interfaz visual mínima necesaria para demostrar y utilizar el sistema.

Pantallas principales
Dashboard

Debe mostrar como mínimo:

ingresos totales;
ingresos por integrante;
gasto total;
resultado neto;
cantidad de gastos;
distribución por categoría;
balance entre miembros.
Gastos

Debe permitir:

visualizar gastos;
consultar detalle;
editar;
eliminar.
Ingresos

Debe permitir:

visualizar ingresos;
registrar;
editar;
eliminar.
Agente

Debe permitir interacción conversacional básica.

Configuración mínima

Debe permitir visualizar:

categorías;
miembros;
reglas de reparto.

No se implementará durante el MVP un sistema complejo de administración.

Criterio de terminado

Un usuario deberá poder utilizar las funcionalidades principales sin depender exclusivamente de WhatsApp.

# 12. Fase 7 — Facturas

Objetivo

Permitir registrar gastos a partir de fotografías de facturas.

Flujo
Imagen
↓
Storage
↓
OpenAI
↓
Información estructurada
↓
Agente
↓
Propuesta
↓
Usuario
↓
Confirmación
↓
create_expense

El análisis devolverá `receiptId`, `storagePath` y `processingStatus`. `Receipt.household_id` se resolverá desde el contexto y `expense_id` permanecerá en `NULL` hasta crear el gasto confirmado del mismo hogar. Si el usuario cancela, se eliminarán el receipt y su archivo.

Ante un fallo técnico, marcar `FAILED`, conservar el archivo, informar al canal y permitir un reintento explícito con el mismo `receiptId`. Ante extracción incompleta, conservar `PENDING`, el archivo y `analysis_payload`; recuperar el mismo receipt por `household_id + conversation_key`, combinar las aclaraciones permitidas mediante el mismo receipt service y marcar `PROCESSED` cuando la propuesta quede completa. Solo `PROCESSED` podrá asociarse a Expense.
Información objetivo
comercio;
fecha;
total;
productos;
cantidades;
precios;
categorías propuestas.
Criterio de terminado

Una factura legible deberá producir una propuesta de gasto revisable por el usuario.

La creación automática sin revisión no será necesaria para el MVP.

# 13. Fase 8 — Testing

Objetivo

Validar las partes críticas del sistema.

No se buscará una cobertura de pruebas exhaustiva.

La prioridad será probar las operaciones que puedan producir errores financieros o romper el flujo principal.

Tests prioritarios
Core financiero
creación de gasto;
validación de monto;
cálculo de reparto;
suma de porcentajes;
cálculo de balance;
actualización;
eliminación.
eliminación de gasto CONFIRMED cambia a CANCELLED;
solo gastos CONFIRMED participan en balance y dashboard;
Ingresos
creación válida;
validación de monto;
validación de pertenencia al hogar;
consulta;
edición;
eliminación física;
actualización de agregados después de editar o eliminar;
verificación de que no afectan el balance entre integrantes;
API
creación de gasto;
consultas;
errores de validación;
recursos inexistentes.
Agent
interpretación de gastos;
solicitud de información faltante;
confirmación;
uso correcto de herramientas;
rechazo de operaciones;
no inventar resultados.
confirmación para crear ingresos;
confirmación explícita antes de editar ingresos;
confirmación explícita antes de eliminar ingresos;
WhatsApp
recepción de mensaje;
envío de respuesta;
eventos duplicados.
persistencia y unicidad del identificador externo de WhatsApp.
Facturas
extracción correcta;
información incompleta;
factura ilegible;
discrepancias de total.
asociación del receipt después de confirmar;
cancelación elimina receipt y archivo.
fallo técnico conserva receipt `FAILED` y permite reintento con el mismo identificador;
extracción incompleta conserva receipt `PENDING` sin crear Expense;
un receipt no puede asociarse a un gasto de otro hogar.

# 14. Fase 9 — Deployment

Objetivo

Publicar una versión funcional del MVP.

Componentes
Vercel
│
├── Next.js
└── API

Supabase
├── PostgreSQL
└── Storage

OpenAI
└── API

Meta
└── WhatsApp Cloud API
Actividades
Configurar proyecto de producción.
Configurar variables de entorno.
Configurar Supabase.
Configurar Storage.
Configurar OpenAI.
Configurar WhatsApp.
Configurar webhook público.
Ejecutar pruebas finales.
Criterio de terminado

El sistema deberá poder utilizarse desde:

Web/PWA.
WhatsApp.

# 15. Orden de implementación

El orden recomendado será:

1. Inicialización
   ↓
2. Base de datos
   ↓
3. Core financiero
   ↓
4. API
   ↓
5. Agent
   ↓
6. WhatsApp
   ↓
7. Web/PWA
   ↓
8. Facturas
   ↓
9. Testing
   ↓
10. Deployment

Sin embargo, la integración técnica de WhatsApp ya fue validada previamente, por lo que no será necesario reservar una fase experimental adicional.

# 16. Dependencias

Base de datos
↓
Core financiero
↓
API
↓
Agent
↓
WhatsApp / Web

Las facturas dependen de:

Storage
↓
OpenAI
↓
Agent

El dashboard depende de:

Core financiero
↓
API
↓
Frontend

Los resúmenes del dashboard deberán verificar `totalIncome` y `netAmount`, calculados por el backend.

# 17. Priorización ante falta de tiempo

Si el plazo se reduce, las funcionalidades deberán eliminarse en este orden:

Primero eliminar
recomendaciones;
visualizaciones avanzadas;
configuraciones adicionales;
mejoras cosméticas;
automatizaciones no esenciales.
Después evaluar
edición avanzada;
análisis detallado de facturas;
comparaciones históricas.
Mantener siempre
registro de gastos;
registro, consulta, edición y eliminación de ingresos;
persistencia;
consultas;
reparto;
balance;
agente;
WhatsApp;
interfaz Web/PWA básica.

# 18. Criterio de MVP terminado

HouseMate AI será considerado funcional cuando un usuario pueda realizar exitosamente el siguiente flujo:

Este diagrama representa el flujo conversacional. Las vistas y operaciones explícitas de Web/PWA podrán delegar directamente al mismo backend sin pasar por Agent.

                Usuario
                   │
                   ▼
             WhatsApp / Web
                   │
                   ▼
                Agente
                   │
                   ▼
              Interpretación
                   │
                   ▼
             Confirmación
                   │
                   ▼
              Tool / Backend
                   │
                   ▼
              Regla de negocio
                   │
                   ▼
               PostgreSQL
                   │
                   ▼
                Balance
                   │
                   ▼
              Respuesta
                   │
                   ▼
                Usuario

Y adicionalmente:

Factura
↓
Análisis
↓
Propuesta
↓
Confirmación
↓
Gasto

Ingreso
↓
Interpretación
↓
Confirmación
↓
Tool / Backend
↓
Persistencia
↓
Resumen financiero actualizado

# 19. Criterios de calidad

Antes de considerar terminado el MVP se deberá verificar:

No existen secretos en el código.
Las operaciones financieras son determinísticas.
El agente no accede directamente a la base de datos.
Las herramientas validan sus entradas.
Los gastos no se duplican por eventos repetidos.
Los balances se calculan a partir de los gastos.
Los ingresos no modifican el balance de compensación entre integrantes.
Los totales de ingresos y el resultado neto se calculan en el backend.
WhatsApp puede recibir y enviar mensajes.
La aplicación Web/PWA puede consultar información.
Los errores críticos no rompen silenciosamente el flujo.
El sistema puede desplegarse mediante la infraestructura definida.
El proyecto puede ejecutarse siguiendo las instrucciones del repositorio.

# 20. Principio de alcance

Durante la implementación se deberá aplicar la siguiente regla:

Si una funcionalidad no es necesaria para demostrar el valor central de HouseMate AI, deberá posponerse.

No se agregarán:

microservicios;
colas;
caching complejo;
sistemas de eventos;
infraestructura adicional;
autenticación avanzada;
observabilidad empresarial;
optimizaciones prematuras;

salvo que una necesidad real del MVP lo justifique.

# 21. Uso de Codex

Codex se utilizará principalmente durante la implementación y no como sustituto de las decisiones arquitectónicas.

El flujo será:

Documentación
↓
Implementation Plan
↓
Tarea pequeña
↓
Codex
↓
Implementación
↓
Revisión
↓
Tests
↓
Siguiente tarea

Codex no deberá recibir como única instrucción:

"Construye HouseMate AI completo."

Las tareas deberán dividirse en unidades verificables.

Ejemplos:

Implementa el módulo Expenses según data_model.md.
Implementa POST /api/expenses según api_contract.md.
Implementa calculate_split según agent_architecture.md.
Implementa el webhook de WhatsApp según api_contract.md.

Cada tarea deberá incluir las restricciones relevantes de la documentación existente.

# 22. Definición de terminado por tarea

Una tarea podrá considerarse terminada cuando:

La implementación cumple el contrato definido.
No contradice la arquitectura.
La funcionalidad principal funciona.
Los casos de error relevantes están contemplados.
Existen tests cuando la operación sea crítica.
No introduce infraestructura innecesaria.
No genera deuda técnica evidente que comprometa el MVP.

# 23. Regla contra over-engineering

Durante todo el desarrollo se utilizará la siguiente regla:

Necesidad real
↓
Solución mínima adecuada
↓
Validación
↓
Solo entonces → complejidad adicional

No se implementarán abstracciones, servicios o patrones únicamente porque podrían ser útiles en el futuro.

La arquitectura debe ser suficientemente buena para el MVP, no una arquitectura hipotética para millones de usuarios.

# 24. Resultado esperado

Al finalizar el plan deberá existir un MVP desplegado de HouseMate AI capaz de:

recibir solicitudes mediante lenguaje natural;
registrar gastos;
registrar, consultar, editar y eliminar ingresos;
aplicar reglas de reparto;
calcular balances;
consultar información financiera;
analizar facturas;
interactuar mediante WhatsApp;
proporcionar una interfaz Web/PWA;
persistir la información de forma consistente.

El sistema deberá ser funcional, demostrable y mantenible sin introducir complejidad innecesaria.

### Una decisión importante

Hay una pequeña diferencia respecto al plan que habíamos planteado antes: **no agregué una fase de "prueba mínima de WhatsApp"**, porque esa ya la hicimos y comprobamos que el canal funciona. Eso nos ahorra trabajo y mantiene el plan alineado con el estado real del proyecto.

También dejé **facturas después de Web/PWA**. El análisis básico de una factura y su propuesta confirmable permanece en P0; ante falta de tiempo solo podrán recortarse detalle adicional de extracción o mejoras no exigidas por el criterio de terminado.
