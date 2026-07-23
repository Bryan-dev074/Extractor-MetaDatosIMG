# Compact Skipped Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mantener visibles las carpetas procesadas y convertir los archivos omitidos en un desplegable compacto.

**Architecture:** Extraer la presentación de omitidos a un componente semántico basado en `<details>`. Hacer que `selection.accepted` participe en el estado visible de la página y presentar estados vacíos explícitos sin modificar el motor de procesamiento.

**Tech Stack:** Next.js 15.5.21, React 19, TypeScript, CSS, Vitest y Testing Library.

## Global Constraints

- Conservar el diseño visual existente.
- El desplegable queda cerrado por defecto.
- La lista abierta debe tener altura acotada y desplazamiento propio.
- El resumen desplegable debe medir al menos 44 px.
- No cambiar limpieza, TikTok ni ZIP.
- Aplicar TDD: observar pruebas en rojo antes de modificar producción.

---

### Task 1: Contratos de visibilidad y omitidos

**Files:**
- Modify: `tests/ui/page.test.tsx`
- Create: `tests/ui/skipped-files-disclosure.test.tsx`
- Modify: `tests/ui/visual-contract.test.ts`

**Interfaces:**
- Consumes: `ImageWorkspaceApi.selection`, `ImageWorkspaceApi.skipped`.
- Produces: expectativas para `SkippedFilesDisclosure` y estados vacíos de `Home`.

- [ ] **Step 1: Escribir las pruebas de página en rojo**

Añadir casos que configuren `selection.accepted` sin `batch.items`, y una
selección con solo `skipped`. Esperar respectivamente “Preparando 1 imagen” y
“No se encontraron imágenes JPEG o PNG válidas”.

- [ ] **Step 2: Escribir la prueba del desplegable en rojo**

Renderizar dos `SkippedInput`, comprobar que el `<details>` no tenga `open`, que
el resumen anuncie “2 archivos omitidos” y que ambos motivos sigan en el DOM.

- [ ] **Step 3: Escribir el contrato CSS en rojo**

Comprobar que `.skipped-disclosure__list` declare `max-height` y
`overflow-y: auto`, y que `.skipped-disclosure summary` declare
`min-height: 44px`.

- [ ] **Step 4: Ejecutar el rojo**

Run:

```powershell
npm test -- tests/ui/page.test.tsx tests/ui/skipped-files-disclosure.test.tsx tests/ui/visual-contract.test.ts
```

Expected: FAIL porque el componente, los mensajes y los selectores aún no
existen.

### Task 2: Implementación compacta

**Files:**
- Create: `components/SkippedFilesDisclosure.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `items: SkippedInput[]`.
- Produces: `SkippedFilesDisclosure({ items }): React.JSX.Element | null`.

- [ ] **Step 1: Crear el componente mínimo**

Implementar un `<details className="skipped-disclosure">` sin atributo `open`,
con `<summary>`, contador, “Ver motivos” y una lista completa dentro de
`.skipped-disclosure__list`.

- [ ] **Step 2: Integrar los estados visibles**

Calcular `hasMaterial` incluyendo `workspace.selection.accepted.length`. Reemplazar
el panel expandido por `SkippedFilesDisclosure`. Cuando no haya tarjetas,
mostrar un mensaje de preparación si hay aceptadas pendientes o el mensaje de
formatos compatibles si todo fue omitido.

- [ ] **Step 3: Añadir el CSS acotado**

Reutilizar los tokens de cristal existentes. Dar al resumen `min-height: 44px`,
rotar un chevron con `[open]`, y aplicar a la lista un `max-height` responsivo y
`overflow-y: auto`.

- [ ] **Step 4: Ejecutar el verde focal**

Run:

```powershell
npm test -- tests/ui/page.test.tsx tests/ui/skipped-files-disclosure.test.tsx tests/ui/visual-contract.test.ts
```

Expected: todos los archivos focales pasan.

### Task 3: Verificación y entrega

**Files:**
- Verify: all changed production and test files

**Interfaces:**
- Consumes: aplicación terminada.
- Produces: evidencia automatizada y visual antes del push.

- [ ] **Step 1: Ejecutar verificaciones completas**

Run:

```powershell
npm test
npm run lint
npx tsc --noEmit --incremental false
npm run build
```

Expected: exit code 0 en cada comando.

- [ ] **Step 2: Reproducir en navegador**

Seleccionar `D:\ElaBela\POST\02 - Pedestales\Otros formatos`, esperar 100% y
comprobar 55 listas, 32 omitidas, desplegable cerrado y resultados visibles sin
varias pantallas de separación. Abrir el desplegable y confirmar que su lista
desplaza internamente.

- [ ] **Step 3: Revisar y sincronizar**

Ejecutar `git diff --check`, revisar el diff, crear un commit focal y hacer
`git push origin main`. Confirmar `origin/main...HEAD` como `0 0`.
