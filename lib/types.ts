export type ImageFormat = "jpeg" | "png";

export type FindingCategory =
  | "C2PA / Content Credentials"
  | "Generador de IA"
  | "Datos de generación"
  | "Provenance / XMP"
  | "Marcador genérico de IA";

/** Una etiqueta de IA detectada (y, casi siempre, eliminada). */
export interface Finding {
  id: string;
  category: FindingCategory;
  /** Título corto y legible, p. ej. "Manifiesto C2PA". */
  label: string;
  /** Dónde vivía el dato, p. ej. "JPEG · APP11 (JUMBF)" o "EXIF · Software". */
  source: string;
  /** Fragmento/valor encontrado (truncado). */
  detail?: string;
  /** Bytes eliminados, si se conocen. */
  bytes?: number;
  removed: boolean;
}

/** Un dato relevante para la calidad que se mantuvo intacto. */
export interface PreservedItem {
  label: string;
  detail: string;
  /** Clave de icono para la UI. */
  icon: "color" | "resolution" | "orientation" | "pixels" | "dimensions" | "generic";
}

export interface CleanResult {
  format: ImageFormat;
  mime: string;
  /** Bytes de la imagen ya limpia, listos para descargar. */
  cleaned: Uint8Array;
  originalSize: number;
  cleanedSize: number;
  findings: Finding[];
  preserved: PreservedItem[];
  /** True si se detectó al menos un rastro de IA. */
  isAi: boolean;
  /** Avisos (p. ej. marcas de agua invisibles que no son metadatos). */
  notices: string[];
}
