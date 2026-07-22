import type { SupportedFormat } from "../metadata/format";

export type InputSource = "files" | "folder" | "drop" | "loose";

export interface InputImage {
  id: string;
  file: File;
  relativePath: string;
  format: SupportedFormat;
}

export interface SkippedInput {
  relativePath: string;
  reason: string;
}

export interface InputSelection {
  archiveBase: string;
  accepted: InputImage[];
  skipped: SkippedInput[];
}
