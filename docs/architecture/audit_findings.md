# Audit Findings

## Purpose

Este documento registra hallazgos reales detectados durante auditorías que no necesariamente bloquean el MVP. No sustituye la documentación de arquitectura, contratos, planificación ni estructura del proyecto.

## Status definitions

- OPEN
- IN_PROGRESS
- RESOLVED
- ACCEPTED

## Findings

### FINDING-001

- **Fecha:** 2026-08-11
- **Área:** Tooling / formato
- **Descripción:** `npm run format:check` reporta problemas de formato preexistentes en múltiples archivos del repositorio. La versión de `tests/phase-3-expense-api-functional.cjs` presente en `HEAD` ya fallaba la comprobación individual de Prettier antes de incorporar la cobertura de `GET /api/expenses/{id}`. La comprobación global actual continúa reportando 47 archivos, incluidos archivos fuera del alcance de este incremento.
- **Impacto:** La validación global de formato no puede usarse como PASS del repositorio completo sin modificar deuda preexistente ajena al incremento.
- **Prioridad:** MENOR
- **Estado:** ACCEPTED
- **Origen/detección:** Auditoría de `GET /api/expenses/{id}` del 2026-08-11 mediante `npm run format:check` y comparación de Prettier contra `HEAD`.
- **Criterio de resolución:** Abordar la deuda de formato en un incremento separado y explícito, sin mezclarla con funcionalidades del MVP.
