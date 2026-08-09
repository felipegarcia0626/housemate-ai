# C4 Container Diagram — HouseMate AI

## 1. Propósito

Este documento define los principales contenedores de HouseMate AI y las relaciones entre ellos.

El objetivo es mostrar cómo se estructura internamente el sistema a nivel de aplicación, sin entrar todavía en detalles de implementación de clases, funciones o código.

La arquitectura seguirá un enfoque de **Modular Monolith**, por lo que los principales módulos de la aplicación estarán contenidos dentro de un único backend.

---

# 2. Vista general

```text
                         ┌──────────────────┐
                         │      Usuario     │
                         └────────┬─────────┘
                                  │
                   ┌──────────────┴──────────────┐
                   │                             │
                   ▼                             ▼
          ┌─────────────────┐          ┌─────────────────┐
          │     WhatsApp    │          │    Web / PWA    │
          │    Cloud API    │          │    Frontend     │
          └────────┬────────┘          └────────┬────────┘
                   │                            │
                   │ Webhook                    │ HTTPS
                   │                            │
                   └──────────────┬─────────────┘
                                  ▼
                       ┌──────────────────────┐
                       │    Backend / API     │
                       │    Modular Monolith  │
                       └──────────┬───────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
                    ▼             ▼             ▼
             ┌────────────┐ ┌────────────┐ ┌────────────┐
             │   Agent    │ │ PostgreSQL │ │   Storage  │
             │            │ │ / Supabase │ │ / Supabase │
             └─────┬──────┘ └────────────┘ └────────────┘
                   │
                   ▼
             ┌────────────┐
             │   OpenAI   │
             │    API     │
             └────────────┘
```

# 3. Contenedores

## 3.1 Frontend Web / PWA

Responsabilidad

Proporcionar la interfaz visual de HouseMate AI.

Permitirá al usuario:

consultar el dashboard;
visualizar gastos, ingresos y balances;
consultar categorías y reglas preconfiguradas;
revisar y corregir registros;
consultar facturas;
interactuar con el agente.

El frontend no será responsable de ejecutar directamente las reglas financieras ni de acceder directamente a la base de datos.

Tecnología
Next.js
React
TypeScript

## 3.2 Backend / API

Responsabilidad

Es el núcleo de la aplicación y contiene la lógica de negocio.

Será responsable de:

exponer las APIs utilizadas por el frontend;
recibir webhooks de WhatsApp;
gestionar gastos;
gestionar ingresos;
consultar el catálogo preconfigurado de categorías;
consultar y aplicar reglas de reparto preconfiguradas;
procesar facturas;
ejecutar cálculos financieros;
validar operaciones;
interactuar con la base de datos y Storage;
coordinar al agente;
enviar respuestas a los canales externos.

El backend se implementará como un Modular Monolith.

Los módulos estarán separados lógicamente dentro de la misma aplicación.

Módulos principales
Backend
├── Expenses
├── Incomes
├── Categories
├── Sharing Rules
├── Receipts
├── Dashboard
├── Agent
└── WhatsApp

El cálculo de balance no constituirá un contenedor o módulo independiente. `balance.service.ts` pertenecerá a `Expenses` y consultará gastos confirmados, `paid_by` y distribuciones.

No se implementará inicialmente un módulo independiente de autenticación, gestión de usuarios u hogares.

El contexto del usuario será determinado mediante la configuración del MVP y, para WhatsApp, mediante el identificador del remitente.

Tecnología
Next.js
TypeScript

## 3.3 Agent

Responsabilidad

Actuar como la interfaz inteligente entre el usuario y las capacidades del sistema.

El agente será responsable de:

interpretar lenguaje natural;
identificar la intención del usuario;
extraer información de los mensajes;
interpretar facturas;
determinar cuándo necesita información adicional;
seleccionar las herramientas apropiadas;
consultar información financiera;
preparar registros para confirmación;
generar respuestas en lenguaje natural.

El agente no será la fuente de verdad financiera.

No deberá realizar directamente operaciones críticas sobre los datos.

Las operaciones de negocio se ejecutarán mediante herramientas controladas por el backend.

Tecnología
OpenAI Agents SDK
Modelos de OpenAI

## 3.4 PostgreSQL

Responsabilidad

Ser la fuente de verdad de los datos estructurados de HouseMate AI.

Almacenará información como:

gastos;
ingresos;
productos;
categorías;
reglas de reparto;
distribuciones de gastos;
referencias a facturas;
información asociada al contexto del usuario.
propuestas pendientes de confirmación e identificadores de eventos procesados.

`Income` y `Expense` se almacenarán como entidades independientes. Los ingresos participarán en los resúmenes financieros, pero no en el balance de compensación entre integrantes.

El modelo de datos podrá contemplar entidades como usuarios, hogares y miembros para permitir una evolución futura, pero el MVP trabajará con un único contexto de hogar configurado.

Tecnología
PostgreSQL
Supabase

El acceso a la base de datos se realizará mediante el backend.

## 3.5 Storage

Responsabilidad

Almacenar archivos asociados a los gastos, principalmente fotografías de facturas.

La base de datos almacenará las referencias y metadatos correspondientes, mientras que los archivos permanecerán en Storage.

Tecnología
Supabase Storage

## 3.6 WhatsApp Cloud API

Responsabilidad

Proporcionar el canal conversacional de WhatsApp.

Permitirá:

recibir mensajes;
recibir imágenes;
enviar respuestas;
comunicar eventos mediante webhooks.

WhatsApp será tratado como un canal externo y no contendrá lógica de negocio de HouseMate AI.

Esto permitirá que la misma lógica pueda utilizarse desde WhatsApp y desde la aplicación web.

## 3.7 OpenAI

Responsabilidad

Proporcionar los modelos de IA utilizados por el agente.

Se utilizará para capacidades como:

comprensión de lenguaje natural;
interpretación de mensajes;
análisis de imágenes de facturas;
generación de respuestas.

OpenAI no será responsable de:

almacenar gastos;
almacenar ingresos;
mantener balances;
ejecutar reglas financieras;
mantener la fuente oficial de datos.

# 4. Relaciones entre contenedores

Usuario → Web / PWA

El usuario utiliza la aplicación para consultar información, visualizar categorías y reglas preconfiguradas y utilizar las capacidades de HouseMate AI. El MVP no ofrece CRUD de esas configuraciones.

Usuario → WhatsApp

El usuario puede registrar gastos, enviar facturas y realizar consultas mediante lenguaje natural.

Web / PWA → Backend

El frontend consume las APIs del backend mediante HTTPS.

Puede acceder directamente a casos de uso controlados para dashboard y operaciones explícitas. No contiene reglas financieras ni accede a PostgreSQL.

WhatsApp Cloud API → Backend

WhatsApp comunica los mensajes y eventos recibidos mediante webhooks.

Backend → Agent

El backend proporciona al agente el contexto necesario y expone las herramientas que este puede utilizar.

Agent → Backend

El agente solicita operaciones mediante herramientas controladas por el backend.

El backend valida y ejecuta dichas operaciones.

Backend → PostgreSQL

El backend consulta y persiste los datos estructurados de la aplicación.

Backend → Storage

El backend gestiona el almacenamiento y recuperación controlada de archivos.

Agent → OpenAI

El agente utiliza los modelos de OpenAI para interpretar información y generar respuestas.

Backend → WhatsApp Cloud API

El backend utiliza WhatsApp Cloud API para enviar respuestas al usuario.

# 5. Flujo principal de comunicación

El flujo general para una interacción conversacional es:

Usuario
│
▼
WhatsApp / Web
│
▼
Backend
│
▼
Agent
│
├── OpenAI
│
└── Tools
│
▼
Backend
│
├── PostgreSQL
│
└── Storage
│
▼
Respuesta
│
▼
WhatsApp / Web
│
▼
Usuario

# 6. Principios estructurales

## 6.1 Modular Monolith

Los componentes principales de negocio estarán dentro de una única aplicación backend.

No se utilizarán microservicios para el MVP.

## 6.2 El agente no es la fuente de verdad

El agente puede interpretar información y decidir qué herramienta utilizar, pero los datos financieros oficiales estarán almacenados en PostgreSQL.

## 6.3 Las operaciones críticas pertenecen al backend

Los cálculos, validaciones y modificaciones de información financiera serán ejecutados por lógica controlada del backend.

El LLM no deberá modificar directamente la base de datos.

El balance de compensación entre integrantes utilizará exclusivamente gastos compartidos, pagadores y distribuciones. Los ingresos solo se utilizarán para calcular resúmenes como `totalIncome` y `netAmount`.

## 6.4 Los canales están desacoplados

WhatsApp y Web/PWA son canales diferentes para acceder a las mismas capacidades del sistema.

La lógica de negocio no deberá depender de un canal específico.

## 6.5 Simplicidad para el MVP

La arquitectura debe ser suficiente para construir, probar y desplegar el MVP dentro del plazo establecido.

No se introducirán servicios independientes o infraestructura adicional mientras no exista una necesidad real que los justifique.

# 7. Decisiones fuera del alcance

Para el MVP no se utilizarán:

microservicios;
Kubernetes;
servidores dedicados;
múltiples bases de datos;
sistemas de eventos distribuidos;
infraestructura de Big Data;
aplicaciones móviles nativas independientes;
sistemas de caching complejos;
infraestructura multi-región;
sistemas avanzados de autenticación;
sistemas complejos de autorización;
gestión multi-hogar.

Estas decisiones podrán revisarse posteriormente si las necesidades del producto cambian.

# 8. Límites del documento

Este documento define los contenedores y sus relaciones.

Los siguientes aspectos se documentarán por separado:

tecnologías específicas y versiones → tech_stack.md
comportamiento y herramientas del agente → agent_architecture.md
estructura de datos → data_model.md
contratos de API → api_contract.md
seguridad → security.md

El objetivo es evitar duplicar decisiones entre documentos y mantener cada documento enfocado en una responsabilidad específica.

### Una última decisión que sí dejaría cerrada

He cambiado **"gestionar usuarios y hogares"** por el contexto configurado del MVP. Esto es importante: **no estamos renunciando a que el modelo de datos soporte esa evolución; simplemente no vamos a construir ese producto alrededor de ella ahora.**

Así, `c4_container.md` queda coherente con `c4_context.md`, `security.md` y el alcance limitado del MVP personal.
