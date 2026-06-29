# SKY · Limpiador quirúrgico de metadatos de IA

Aplicación web que elimina **únicamente los rastros que identifican una imagen como "generada por IA"** (manifiestos **C2PA / Content Credentials**, metadatos **XMP / EXIF / IPTC** de Midjourney, DALL·E, Adobe Firefly, Stable Diffusion, ComfyUI, Google Imagen / Gemini / **Nano Banana**, etc.) **conservando intacto el resto del archivo** — en especial el **perfil de color ICC**, la **resolución** y los **píxeles**.

Todo el procesamiento ocurre **en el navegador (client-side)** mediante manipulación directa de los bytes de la imagen. Nada se sube a ningún servidor.

> ⚡ Stack: **Next.js 15 (App Router)** · **Tailwind CSS** · **Framer Motion** · TypeScript. Listo para **Vercel**.

---

## ✨ Características

- **Cirugía a nivel de bytes**: no se decodifica ni se recomprime la imagen. Los segmentos `DQT/DHT/SOF/SOS` (JPEG) y el chunk `IDAT` (PNG) se copian tal cual → **calidad idéntica al original, cero pérdida**.
- **Detección amplia de IA**: C2PA (JUMBF), XMP de procedencia (IPTC `DigitalSourceType`), tags EXIF (`Software`, `MakerNote`, etc.), chunks de texto PNG (`parameters` de Stable Diffusion, `workflow` de ComfyUI…) y +40 firmas de generadores.
- **Preservación de calidad**: mantiene **ICC**, **resolución/DPI**, **orientación EXIF** y dimensiones.
- **UI ultra-premium**: fondo interactivo (malla de nodos con parallax + ondas al hacer clic), efecto de **escáner láser** sobre la vista previa, micro-interacciones a 60fps y panel con el desglose de lo eliminado vs. lo preservado.
- **Privacidad total**: 0 backend, 0 subida de archivos.

---

## 🔬 ¿Qué se elimina y qué se conserva? (y por qué)

### Se ELIMINA (rastros de IA)

| Formato | Dónde vive | Acción |
|---|---|---|
| JPEG | `APP11` (JUMBF) | **Manifiesto C2PA** → se elimina siempre |
| JPEG | `APP1` (XMP) | Se elimina el paquete si contiene firmas de IA/procedencia |
| JPEG | `APP1` (EXIF) | Se ponen a **cero solo los valores** de tags con IA (`Software`, `ImageDescription`, `MakerNote`, `UserComment`, `Artist`, `XP*`…). El resto de la estructura EXIF queda intacta |
| JPEG | `APP13` (IPTC), `APPn`, `COM` | Se eliminan solo si contienen firmas de IA |
| PNG | `caBX` / `caMs` / `caSt` | **Manifiesto C2PA** → se elimina siempre |
| PNG | `tEXt` / `zTXt` / `iTXt` | Se eliminan si el keyword o el texto delatan IA (`parameters`, `prompt`, `workflow`, XMP de procedencia…) |
| PNG | `eXIf` y chunks desconocidos | Se eliminan solo si contienen firmas de IA |

### Se CONSERVA (calidad para redes sociales)

Tras investigar qué metadatos influyen en cómo se ve una imagen al subirla a redes, estos se mantienen **intactos**:

- **Perfil de color ICC** (`APP2 ICC_PROFILE` en JPEG, chunk `iCCP`/`sRGB` en PNG). **Es lo más importante**: sin el perfil correcto, plataformas y navegadores "adivinan" el color y una imagen en Display P3 / Adobe RGB se ve **lavada o desaturada**. Conservarlo evita el cambio de color.
- **Resolución / dimensiones de píxel** (`JFIF` density y EXIF `XResolution`; chunk `pHYs` en PNG). No se reescala nada.
- **Orientación EXIF** (`tag 0x0112`). Si se borrara sin rotar los píxeles, la imagen podría salir **girada** en plataformas que respetan la orientación.
- **`ColorSpace`, `YCbCrPositioning`, `gAMA`, `cHRM`, `sRGB`** y demás flags de color.
- **Los píxeles**: al no recomprimir, no hay pérdida generacional ni "borroso".

### Bonus de calidad: el C2PA pesa

Un manifiesto C2PA puede ocupar **decenas o cientos de KB**. Instagram aplica un **segundo pase de compresión** si el archivo supera ~1.5 MB; quitar el manifiesto **reduce el peso** y ayuda a evitar ese reprocesado agresivo que arruina la nitidez.

### ⚠️ Limitación honesta: marcas de agua invisibles

Las marcas de agua **a nivel de píxel** como **Google SynthID** (Imagen / Gemini / **Nano Banana**) **no son metadatos**: están incrustadas en los propios píxeles. Esta herramienta **no las toca**, porque eliminarlas implicaría alterar/recomprimir la imagen y degradar la calidad. Aquí se limpian los **metadatos**; el watermark de píxel queda fuera de alcance por diseño.

---

## 🚀 Puesta en marcha local

Requisitos: **Node.js ≥ 18.18**.

```bash
npm install
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000).

Build de producción:

```bash
npm run build
npm run start
```

---

## ▲ Despliegue en Vercel

1. Sube este repositorio a GitHub (ver abajo).
2. En [vercel.com/new](https://vercel.com/new) importa el repo `Extractor-MetaDatosIMG`.
3. Vercel detecta Next.js automáticamente — **no requiere configuración**. Pulsa **Deploy**.

No hay variables de entorno ni backend: es una app puramente client-side.

---

## ⬆️ Subir a tu repositorio de GitHub

Desde la carpeta del proyecto:

```bash
git init
git add .
git commit -m "SKY: limpiador quirúrgico de metadatos de IA"
git branch -M main
git remote add origin https://github.com/Bryan-dev074/Extractor-MetaDatosIMG.git
git push -u origin main
```

> Si el repositorio ya tenía commits y el push es rechazado, usa `git push -u origin main --force` (sobrescribe el remoto) **solo si estás seguro** de querer reemplazar su contenido.

---

## 🧱 Estructura del proyecto

```
app/
  layout.tsx            # Metadata, fuentes, tema oscuro
  page.tsx              # Orquesta el flujo (idle → escaneo → resultado)
  globals.css           # Tailwind + utilidades (glass, gradientes, scrollbar)
components/
  InteractiveBackground.tsx  # Canvas: nodos + parallax + ondas al clic
  Dropzone.tsx               # Drag & drop interactivo
  ImagePreview.tsx           # Vista previa + escáner láser quirúrgico
  MetadataReport.tsx         # Desglose eliminado vs. preservado
  DownloadButton.tsx         # Botón con animación de éxito
lib/
  cleaner.ts            # Orquestador: detecta formato y limpia
  jpeg.ts               # Parser/filtro de segmentos JPEG + cirugía EXIF
  png.ts                # Parser/filtro de chunks PNG
  signatures.ts         # +40 firmas de IA / C2PA / generadores
  bytes.ts              # Utilidades binarias
  types.ts              # Tipos compartidos
```

---

## ⚖️ Nota de uso

Esta herramienta es un limpiador de metadatos de propósito general (privacidad y compatibilidad). Úsala de forma responsable y respeta las políticas de divulgación de contenido de IA de cada plataforma y la legislación aplicable.

---

Hecho con Next.js. 100% client-side.
