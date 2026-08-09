# Architecture Overview

Version: 1.0

---

# 1. Objetivo

Este documento describe la arquitectura general de HouseMate AI.

Su propósito es servir como guía para todas las decisiones técnicas del proyecto y proporcionar una visión compartida sobre cómo interactúan los diferentes componentes del sistema.

La arquitectura deberá cumplir los principios definidos en el Project Vision y el PRD.

---

# 2. Objetivos arquitectónicos

La arquitectura deberá priorizar:

- Simplicidad.
- Bajo costo operativo.
- Escalabilidad progresiva.
- Alta mantenibilidad.
- Bajo acoplamiento.
- Reutilización.
- Experiencia conversacional.
- Dominio desacoplado de la IA.

---

# 3. Principios arquitectónicos

## PA-001

El dominio representa el núcleo del sistema.

Toda decisión técnica deberá proteger la independencia del dominio.

---

## PA-002

El agente constituye la interfaz principal del sistema.

Las interfaces tradicionales son únicamente canales alternativos.

---

## PA-003

Los canales nunca contendrán lógica de negocio.

Su única responsabilidad será traducir solicitudes hacia el dominio.

El agente será la interfaz conversacional principal. Web/PWA podrá consumir directamente casos de uso controlados del mismo backend para vistas y operaciones explícitas, sin duplicar lógica de negocio.

---

## PA-004

La IA interpreta.

El dominio decide.

---

## PA-005

Toda operación importante del negocio deberá ejecutarse mediante herramientas (Tools).

Nunca directamente desde el modelo.

---

## PA-006

Los proveedores externos podrán reemplazarse sin modificar el dominio.

---

## PA-007

Los balances siempre serán calculados.

Nunca almacenados.

---

## PA-008

La arquitectura deberá favorecer servicios administrados antes que infraestructura propia.

---

# 4. Estilo arquitectónico

HouseMate AI utilizará una arquitectura de Monolito Modular.

La aplicación estará organizada en módulos independientes dentro de un único despliegue.

Cada módulo tendrá responsabilidades claramente definidas y dependerá únicamente de contratos públicos.

Esta decisión busca reducir la complejidad operacional durante el MVP sin comprometer la posibilidad de evolucionar hacia una arquitectura distribuida en el futuro.

---

# 5. Componentes principales

El sistema estará compuesto por los siguientes componentes de alto nivel:

## Usuario

Interactúa mediante:

- WhatsApp
- Aplicación Web
- PWA

---

## Canales

Responsables de recibir solicitudes del usuario.

No contienen lógica del negocio.

---

## Agente

Responsable de:

- Comprender lenguaje natural.
- Mantener contexto.
- Seleccionar herramientas.
- Solicitar aclaraciones.
- Generar respuestas.

El agente nunca accede directamente a la base de datos.

---

## Tools Layer

Expone capacidades del dominio.

Ejemplos:

- Registrar gasto.
- Registrar ingreso.
- Consultar ingresos.
- Editar ingreso.
- Eliminar ingreso.
- Consultar balances.
- Analizar factura.
- Obtener categorías.

Las herramientas representan casos de uso del negocio.

---

## Dominio

Implementa:

- Reglas de negocio.
- Validaciones.
- Casos de uso.
- Consistencia.
- Gestión independiente de gastos e ingresos.

Representa la única fuente de verdad del comportamiento del sistema.

`Expense` e `Income` serán entidades independientes. No se introducirá una entidad base o abstracción genérica de movimientos financieros para el MVP.

El balance de compensación entre integrantes se calculará exclusivamente a partir de gastos compartidos. Los ingresos participarán solamente en los resúmenes financieros generales.

El cálculo residirá en `balance.service.ts` dentro del módulo `expenses` y utilizará `Expense.paid_by` y `ExpenseDistribution`. Los controllers solo delegarán la operación.

---

## Infraestructura

Incluye:

- Persistencia.
- Identificación del usuario.
- Storage.
- Integraciones.
- APIs externas.

El dominio nunca dependerá directamente de esta capa.

---

# 6. Flujo general

El siguiente flujo representa una interacción conversacional. En un caso de uso explícito de Web/PWA, el canal podrá invocar directamente el backend y continuar desde la herramienta/caso de uso, reutilizando el mismo dominio sin pasar por el agente.

1.

El usuario envía un mensaje.

↓

2.

El canal entrega la solicitud al agente.

↓

3.

El agente interpreta la intención.

↓

4.

El agente identifica qué herramienta necesita.

↓

5.

La herramienta ejecuta el caso de uso correspondiente.

↓

6.

El dominio aplica las reglas de negocio.

↓

7.

La infraestructura realiza la persistencia cuando sea necesario.

↓

8.

La respuesta regresa al agente.

↓

9.

El agente genera una respuesta natural para el usuario.

---

# 7. Atributos de calidad priorizados

1. Simplicidad.
2. Mantenibilidad.
3. Escalabilidad.
4. Testabilidad.
5. Bajo costo.
6. Bajo acoplamiento.
7. Observabilidad.

---

# 8. Restricciones

Durante el MVP deberán respetarse las siguientes restricciones.

- Un único repositorio.
- Un único backend.
- Una única base de datos.
- Sin microservicios.
- Sin mensajería distribuida.
- Sin Kubernetes.
- Sin infraestructura propia.

---

# 9. Decisiones tecnológicas

Las decisiones tecnológicas específicas se documentan en:

tech_stack.md

Este documento únicamente describe la arquitectura.

---

# 10. Documentos relacionados

- Project Vision
- PRD
- Tech Stack
- Data Model (`data_model.md`)
- Agent Architecture
- API Contract (`api_contract.md`)
