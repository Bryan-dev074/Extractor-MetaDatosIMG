import { describe, expect, it } from "vitest";
import {
  formatProcessingReport,
  type ProcessingReportSummary,
} from "@/lib/archive/report";
import { planArchive, type ArchiveOutput } from "@/lib/archive/zip";

function output(overrides: Partial<ArchiveOutput> = {}): ArchiveOutput {
  return {
    id: "id-1",
    relativePath: "Raíz/Sub/foto.jpg",
    bytes: Uint8Array.of(1, 2, 3),
    outputExtension: ".jpg",
    qualityVerified: true,
    ...overrides,
  };
}

describe("formatProcessingReport", () => {
  it("reports successful, skipped and failed paths deterministically", () => {
    const summary: ProcessingReportSummary = {
      mode: "clean",
      outputs: [
        {
          id: "b",
          relativePath: "Raíz/zeta.jpg",
          archivePath: "Raíz/zeta-limpio.jpg",
          byteLength: 2,
        },
        {
          id: "a",
          relativePath: "Raíz/ábaco.jpg",
          archivePath: "Raíz/ábaco-limpio.jpg",
          byteLength: 1,
        },
      ],
      skipped: [
        { relativePath: "Raíz/omitida.jpg", reason: "Formato no soportado" },
      ],
      failed: [
        { id: "f", relativePath: "Raíz/rota.jpg", error: "JPEG truncado" },
      ],
    };

    const report = formatProcessingReport(summary);

    expect(report).toContain("OK\tRaíz/zeta.jpg\tRaíz/zeta-limpio.jpg\t2");
    expect(report).toContain("OMITIDO\tRaíz/omitida.jpg\tFormato no soportado");
    expect(report).toContain("ERROR\tRaíz/rota.jpg\tJPEG truncado");
    expect(report.indexOf("Raíz/zeta.jpg")).toBeLessThan(
      report.indexOf("Raíz/ábaco.jpg"),
    );
    expect(report.endsWith("\n")).toBe(true);
  });

  it("escapes report fields without producing ambiguous rows", () => {
    const report = formatProcessingReport({
      mode: "clean",
      outputs: [],
      skipped: [
        {
          relativePath: "Raíz/a\\b\tc.jpg",
          reason: "línea 1\r\nlínea 2",
        },
      ],
      failed: [],
    });

    expect(report).toContain(
      "OMITIDO\tRaíz/a\\\\b\\tc.jpg\tlínea 1\\r\\nlínea 2\n",
    );
    expect(report.split("\n").filter((line) => line.startsWith("OMITIDO"))).toHaveLength(1);
  });
});

describe("planArchive", () => {
  it("preserves nested paths and uses the detected clean extension", () => {
    const plan = planArchive(
      {
        archiveBase: "Raíz",
        outputs: [output()],
        skipped: [],
        failed: [],
      },
      "clean",
    );

    expect(plan.entries[0].path).toBe("Raíz/Sub/foto-limpio.jpg");
    expect(plan.report.path).toBe("Raíz/_reporte-procesamiento.txt");
  });

  it("sorts by NFC source path and then stable id before resolving collisions", () => {
    const first = output({
      id: "b",
      relativePath: "Raíz/cafe\u0301.png",
      bytes: Uint8Array.of(2),
    });
    const second = output({
      id: "a",
      relativePath: "Raíz/café.png",
      outputExtension: ".png",
      bytes: Uint8Array.of(1),
    });

    const plan = planArchive(
      {
        archiveBase: "Raíz",
        outputs: [first, second],
        skipped: [],
        failed: [],
      },
      "clean",
    );

    expect(plan.entries.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: "a", path: "Raíz/café-limpio.png" },
      { id: "b", path: "Raíz/café-limpio.jpg" },
    ]);
  });

  it("requires verified clean bytes but always names TikTok output as PNG", () => {
    expect(() =>
      planArchive(
        {
          archiveBase: "Raíz",
          outputs: [output({ qualityVerified: false })],
          skipped: [],
          failed: [],
        },
        "clean",
      ),
    ).toThrow(/calidad/i);

    const plan = planArchive(
      {
        archiveBase: "Raíz",
        outputs: [
          output({
            qualityVerified: false,
            outputExtension: undefined,
          }),
        ],
        skipped: [],
        failed: [],
      },
      "tiktok",
    );
    expect(plan.entries[0].path).toBe("Raíz/Sub/foto-tiktok.png");
  });
});
