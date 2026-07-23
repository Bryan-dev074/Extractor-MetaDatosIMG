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

vi.mock("../../components/InteractiveBackground", () => ({
  default: ({ paused = false }: { paused?: boolean }) => (
    <div
      data-testid="interactive-background"
      data-paused={paused ? "true" : "false"}
    />
  ),
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
  };
}

afterEach(cleanup);

describe("workbench page", () => {
  it("renders at most 60 dense rows until the user asks for more", () => {
    workspace = createWorkspace(Array.from({ length: 61 }, (_, index) => queued(index + 1)));
    const { container } = render(<Home />);

    expect(container.querySelector(".result-list")).toHaveClass(
      "result-list--dense",
    );
    expect(screen.getByText("Raíz/Subcarpeta/60.jpg")).toBeVisible();
    expect(screen.queryByText("Raíz/Subcarpeta/61.jpg")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Mostrar 60 resultados más" }),
    );
    expect(screen.getByText("Raíz/Subcarpeta/61.jpg")).toBeVisible();
  });

  it("preserves the original showcase grid for small selections", () => {
    workspace = createWorkspace([queued(1), queued(2), queued(3)]);
    const { container } = render(<Home />);

    expect(container.querySelector(".result-list")).toHaveClass(
      "result-list--showcase",
    );
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

  it("pauses the ambient background for every heavy processing mode", () => {
    workspace = createWorkspace([queued(1)]);
    const { rerender } = render(<Home />);
    const background = () => screen.getByTestId("interactive-background");

    expect(background()).toHaveAttribute("data-paused", "true");

    workspace = createWorkspace([queued(1)]);
    workspace.batch.summary.queued = 0;
    workspace.batch.summary.completed = 1;
    workspace.archive = { kind: "running", mode: "clean", progress: 12 };
    rerender(<Home />);
    expect(background()).toHaveAttribute("data-paused", "true");

    workspace = createWorkspace([queued(1)]);
    workspace.batch.summary.queued = 0;
    workspace.batch.summary.completed = 1;
    workspace.tiktokById = { "id-1": { status: "processing" } };
    rerender(<Home />);
    expect(background()).toHaveAttribute("data-paused", "true");

    workspace = createWorkspace([queued(1)]);
    workspace.batch.summary.queued = 0;
    workspace.batch.summary.completed = 1;
    rerender(<Home />);
    expect(background()).toHaveAttribute("data-paused", "false");
  });

  it("passes TikTok batch settlement through to archive action gating", () => {
    workspace = createWorkspace([queued(1)]);
    workspace.batch.summary.queued = 0;
    workspace.batch.summary.completed = 1;
    workspace.cleanReadyCount = 1;
    workspace.tiktokReadyCount = 1;
    const { rerender } = render(<Home />);

    expect(
      screen.getByRole("button", { name: "Descargar carpeta TikTok" }),
    ).toBeDisabled();

    workspace = {
      ...workspace,
      tiktokBatchStatus: "settled",
    };
    rerender(<Home />);

    expect(
      screen.getByRole("button", { name: "Descargar carpeta TikTok" }),
    ).toBeEnabled();
  });
});
