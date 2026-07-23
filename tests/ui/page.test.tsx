import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageWorkspaceApi } from "../../hooks/useImageWorkspace";
import type { BatchItem } from "../../lib/batch/reducer";

let workspace: ImageWorkspaceApi;

vi.mock("framer-motion", () => ({
  useReducedMotion: () => false,
}));

vi.mock("../../hooks/useImageWorkspace", () => ({
  useImageWorkspace: () => workspace,
}));

import Home from "../../app/page";

function queued(index: number): BatchItem {
  return {
    id: `id-${index}`,
    file: new File([Uint8Array.from([0xff, 0xd8])], `${index}.jpg`),
    relativePath: `Raíz/Subcarpeta/${index}.jpg`,
    format: "jpeg",
    status: "queued",
    progress: 0,
  };
}

function createWorkspace(items: BatchItem[]): ImageWorkspaceApi {
  return {
    batch: {
      state: {
        generation: 1,
        order: items.map((item) => item.id),
        itemsById: Object.fromEntries(items.map((item) => [item.id, item])),
      },
      items,
      summary: {
        total: items.length,
        queued: items.length,
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
    selection: { archiveBase: "Raíz", accepted: items, skipped: [] },
    skipped: [],
    archiveBase: "Raíz",
    archive: { kind: "idle", mode: null, progress: 0 },
    tiktokById: {},
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
  };
}

afterEach(cleanup);

describe("workbench page", () => {
  it("renders at most 60 dense rows until the user asks for more", () => {
    workspace = createWorkspace(Array.from({ length: 61 }, (_, index) => queued(index + 1)));
    render(<Home />);

    expect(screen.getByText("Raíz/Subcarpeta/60.jpg")).toBeVisible();
    expect(screen.queryByText("Raíz/Subcarpeta/61.jpg")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Mostrar 60 resultados más" }),
    );
    expect(screen.getByText("Raíz/Subcarpeta/61.jpg")).toBeVisible();
  });

  it("keeps the skip link and complete processing action labels", () => {
    workspace = createWorkspace([queued(1)]);
    render(<Home />);

    expect(screen.getByRole("link", { name: "Saltar al contenido" })).toHaveAttribute(
      "href",
      "#contenido",
    );
    expect(
      screen.getByRole("button", { name: "Cancelar procesamiento" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Seleccionar carpeta" }),
    ).toBeVisible();
  });
});
