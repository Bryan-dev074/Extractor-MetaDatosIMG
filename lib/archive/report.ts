export type ProcessingMode = "clean" | "tiktok";

export interface ReportOutput {
  id: string;
  relativePath: string;
  archivePath: string;
  byteLength: number;
}

export interface ReportSkipped {
  relativePath: string;
  reason: string;
}

export interface ReportFailure {
  id?: string;
  relativePath: string;
  error: string;
}

export interface ProcessingReportSummary {
  mode: ProcessingMode;
  outputs: ReportOutput[];
  skipped: ReportSkipped[];
  failed: ReportFailure[];
}

function compareText(left: string, right: string): number {
  const a = left.normalize("NFC");
  const b = right.normalize("NFC");
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeField(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

export function formatProcessingReport(summary: ProcessingReportSummary): string {
  const outputs = [...summary.outputs].sort(
    (left, right) =>
      compareText(left.relativePath, right.relativePath) ||
      compareText(left.id, right.id),
  );
  const skipped = [...summary.skipped].sort(
    (left, right) =>
      compareText(left.relativePath, right.relativePath) ||
      compareText(left.reason, right.reason),
  );
  const failed = [...summary.failed].sort(
    (left, right) =>
      compareText(left.relativePath, right.relativePath) ||
      compareText(left.id ?? "", right.id ?? "") ||
      compareText(left.error, right.error),
  );

  const lines = [
    "REPORTE DE PROCESAMIENTO",
    `MODO\t${summary.mode === "clean" ? "LIMPIEZA" : "TIKTOK"}`,
    `RESUMEN\tOK=${outputs.length}\tOMITIDOS=${skipped.length}\tERRORES=${failed.length}`,
    "",
  ];

  for (const item of outputs) {
    lines.push(
      [
        "OK",
        escapeField(item.relativePath),
        escapeField(item.archivePath),
        String(item.byteLength),
      ].join("\t"),
    );
  }
  for (const item of skipped) {
    lines.push(
      ["OMITIDO", escapeField(item.relativePath), escapeField(item.reason)].join(
        "\t",
      ),
    );
  }
  for (const item of failed) {
    lines.push(
      ["ERROR", escapeField(item.relativePath), escapeField(item.error)].join(
        "\t",
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}
