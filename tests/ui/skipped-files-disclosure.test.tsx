import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SkippedFilesDisclosure from "../../components/SkippedFilesDisclosure";
import type { ImageWorkspaceApi } from "../../hooks/useImageWorkspace";

vi.mock("framer-motion", () => ({
  useReducedMotion: () => false,
}));

vi.mock("../../components/InteractiveBackground", () => ({
  default: () => <div />,
}));

const skipped = [
  {
    relativePath: "Raíz/uno.webp",
    reason: "Formato no soportado.",
  },
  {
    relativePath: "Raíz/dos.avif",
    reason: "Formato no soportado.",
  },
];

const workspace = {
  batch: {
    state: { generation: 1, order: [], itemsById: {} },
    items: [],
    summary: {
      total: 0,
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      originalBytes: 0,
      cleanedBytes: 0,
      removedBytes: 0,
    },
    ready: true,
    mode: "main-thread",
    start: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    retry: vi.fn(),
  },
  selection: { archiveBase: "Raíz", accepted: [], skipped },
  skipped,
  archiveBase: "Raíz",
  archive: { kind: "idle", mode: null, progress: 0 },
  tiktokById: {},
  tiktokBatchStatus: "idle",
  previewUrls: {},
  cleanReadyCount: 0,
  tiktokReadyCount: 0,
  ingest: vi.fn(),
  setPreviewVisible: vi.fn(),
  cancelBatch: vi.fn(),
  retry: vi.fn(),
  remove: vi.fn(),
  reset: vi.fn(),
  generateTikTok: vi.fn(async () => undefined),
  prepareAllTikTok: vi.fn(async () => undefined),
  downloadClean: vi.fn(),
  downloadTikTok: vi.fn(),
  downloadTikTokPreview: vi.fn(),
  cancelTikTok: vi.fn(),
  downloadCleanArchive: vi.fn(async () => undefined),
  downloadTikTokArchive: vi.fn(async () => undefined),
  cancelArchive: vi.fn(),
} satisfies ImageWorkspaceApi;

vi.mock("../../hooks/useImageWorkspace", () => ({
  useImageWorkspace: () => workspace,
}));

import Home from "../../app/page";

afterEach(cleanup);

describe("skipped files disclosure", () => {
  it("is closed by default while preserving every path and reason", () => {
    const { container } = render(<Home />);

    const disclosure = container.querySelector("details.skipped-disclosure");
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByText("2 archivos omitidos", { exact: false })).toBeVisible();
    expect(screen.getByText("Raíz/uno.webp")).toBeInTheDocument();
    expect(screen.getByText("Raíz/dos.avif")).toBeInTheDocument();
    expect(screen.getAllByText("Formato no soportado.")).toHaveLength(2);
  });

  it("renders nothing without skipped files", () => {
    const { container } = render(<SkippedFilesDisclosure items={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("uses singular copy for one skipped file", () => {
    render(<SkippedFilesDisclosure items={[skipped[0]]} />);

    expect(
      screen.getByText("1 archivo omitido", { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("1 archivos omitidos", { exact: false }),
    ).not.toBeInTheDocument();
  });
});
