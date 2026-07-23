# Extractor MetaData IMG

Aplicación local en el navegador para revisar y limpiar metadatos seleccionados de imágenes. Está pensada para conservar la calidad del archivo limpio y preparar una variante opcional para TikTok Photo Max.

## Qué admite y cómo decide

- Solo acepta **JPEG y PNG**. El formato se identifica por sus *magic bytes*, no por la extensión; por eso una extensión falsa no engaña al procesador.
- Rechaza entradas truncadas, ambiguas, malformadas o que superen los límites seguros. Un APNG válido puede limpiarse sin pérdida junto con sus chunks de animación; TikTok Photo Max lo rechaza porque su exportación es PNG estático.
- El modo **Limpia** elimina las familias de metadatos de IA/procedencia que reconoce: manifiestos C2PA/JUMBF, XMP de procedencia, campos EXIF/IPTC y texto PNG asociados a generadores o flujos de IA. Conserva las estructuras y datos de imagen que no corresponden a esas firmas.
- No promete detectar ni borrar toda posible señal de IA. Marcas de agua en los píxeles, como SynthID, no son metadatos y permanecen fuera de alcance.

## Calidad y privacidad

En modo **Limpia** no hay recodificación: se conserva el payload de píxeles verificado, junto con las estructuras de color y dimensiones admitidas. Esto evita pérdida generacional, pero cada red social puede aplicar su propia compresión al publicar.

Todo el análisis, limpieza, cola y creación de archivos ocurre en el navegador. Las imágenes no se envían a un servidor por esta aplicación.

## Carpetas, lotes y ZIP

Puedes elegir imágenes, una carpeta completa o arrastrar una carpeta con subcarpetas. La aplicación normaliza rutas relativas seguras, conserva el árbol al exportar y resuelve nombres duplicados de forma determinista.

- Cada lote puede descargarse como `-limpia.zip` o `-tiktok.zip`.
- El ZIP incluye la estructura procesada y un reporte de procesamiento reproducible.
- Cuando el navegador ofrece un escritor de archivos, solicita el destino antes de procesar el ZIP y escribe directamente. Si esa API no existe, usa una descarga Blob con una reserva de memoria conservadora.
- Se valida el límite ZIP32 (cantidad de entradas, nombres y tamaños). Para archivos grandes, memoria limitada o un rechazo preventivo, procesa lotes más pequeños.

Límites principales: **256 MiB por archivo** y presupuesto conservador para los bytes retenidos y para el ZIP Blob. No se intenta forzar una exportación que pueda agotar memoria.

## TikTok Photo Max

TikTok puede recodificar las imágenes después de subirlas; ninguna herramienta puede garantizar cómo se verá la versión servida por TikTok. La opción **TikTok** crea una exportación independiente para darle una fuente más adecuada:

- mantiene las dimensiones nativas ya orientadas, sin ampliar la imagen;
- crea un PNG estático en sRGB;
- aplica cambios adaptativos de como máximo **±1** por canal solo en zonas opacas y suaves elegibles, con delta agregado exactamente cero;
- entrega una vista previa JPEG aproximada con calidad 75 para inspección; la descarga de TikTok es siempre PNG.

El modo TikTok modifica esos píxeles elegibles intencionalmente. Para la ruta sin cambios de píxeles, usa **Limpia**.

## Desarrollo

Requiere Node.js **20.9 o superior**.

```bash
npm ci
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000). Comandos disponibles:

```bash
npm test
npm run lint
npx tsc --noEmit --incremental false
npm run build
npm run start
```

## Estructura

```text
app/                 # App Router, metadatos y estilos globales
components/          # Interfaz de selección, lotes y resultados
hooks/               # Estado y coordinación del procesamiento
lib/metadata/        # Validación y limpieza estricta JPEG/PNG
lib/batch/           # Rutas, cola y workers cancelables
lib/archive/         # Reporte y ZIP determinista
lib/tiktok/          # PNG sRGB y ajuste adaptativo Photo Max
workers/             # Worker de imágenes
tests/               # Pruebas unitarias, integración y evidencia
```

## Uso responsable

Esta aplicación es una herramienta de privacidad y compatibilidad de archivos. Respeta las reglas de divulgación de contenido y las políticas de cada plataforma.
