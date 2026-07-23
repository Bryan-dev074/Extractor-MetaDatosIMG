# Diseño: archivos omitidos compactos y selección siempre visible

## Problema confirmado

Una carpeta real de 87 archivos produjo 55 imágenes válidas y 32 archivos
omitidos. El panel de omitidos, renderizado completo antes de los resultados,
midió 2.148 px de alto y desplazó “Rutas y resultados” hasta 3.452 px en una
ventana de 720 px. Los archivos no se borraron, pero quedaron casi cinco
pantallas más abajo y parecían haber desaparecido.

Además, la vista activa depende hoy de `batch.items` o de los omitidos, aunque
`selection.accepted` ya puede contener archivos durante el traspaso al
procesador. La selección aceptada debe ser suficiente para mantener visible el
espacio de trabajo.

## Comportamiento aprobado

- Los archivos omitidos se muestran en un `<details>` cerrado por defecto.
- El resumen siempre enseña la cantidad omitida y la acción “Ver motivos”.
- Al abrirlo, la lista tiene altura máxima y desplazamiento propio; nunca vuelve
  a empujar indefinidamente los resultados.
- La sección de resultados permanece inmediatamente accesible.
- Si todos los archivos fueron omitidos, la sección de resultados explica que
  no se encontraron JPEG o PNG válidos y dirige al desplegable.
- Si existen archivos aceptados que todavía no aparecen en `batch.items`, la
  vista activa permanece montada y muestra un estado de preparación.
- Se conserva la identidad visual actual, el soporte móvil, el foco visible y
  un objetivo táctil mínimo de 44 px en el resumen desplegable.

## Componentes y flujo

`SkippedFilesDisclosure` recibe únicamente `SkippedInput[]` y se responsabiliza
del resumen, la lista y su semántica accesible. `app/page.tsx` decide entre los
estados vacío, preparando, sin compatibles y con resultados, usando
`selection.accepted` como parte de la fuente de verdad visible.

El procesamiento, la limpieza de bytes, TikTok Photo Max y la generación del
ZIP no cambian.

## Pruebas

- Prueba de componente: cerrado por defecto, contador y motivos conservados.
- Prueba de página: una selección aceptada no vuelve a la portada aunque el
  lote todavía no haya registrado sus elementos.
- Prueba de página: una carpeta completamente omitida mantiene el espacio de
  trabajo y muestra una explicación.
- Contrato CSS: lista abierta acotada con `max-height` y `overflow-y: auto`, y
  resumen de al menos 44 px.
- Suite completa, lint, TypeScript, build y reproducción en navegador con la
  carpeta mixta de 87 archivos.

## Fuera de alcance

- Persistir archivos después de una recarga manual del navegador.
- Añadir soporte de limpieza para WebP o AVIF.
- Cambiar el diseño general de la página.
