import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BatchToolbar, {
  type BatchToolbarActions,
} from "../../components/BatchToolbar";
import type { BatchSummary } from "../../lib/batch/reducer";

const summary: BatchSummary = {
  total: 4,
  queued: 1,
  processing: 1,
  completed: 1,
  failed: 1,
  cancelled: 0,
  originalBytes: 1200,
  cleanedBytes: 1000,
  removedBytes: 200,
};

function actions(): BatchToolbarActions {
  return {
    cancelBatch: vi.fn(),
    reset: vi.fn(),
    prepareTikTok: vi.fn(),
    downloadCleanArchive: vi.fn(),
    downloadTikTokArchive: vi.fn(),
    cancelArchive: vi.fn(),
  };
}

afterEach(cleanup);

describe("BatchToolbar", () => {
  it("keeps ZIP actions disabled until their required outputs exist", () => {
    render(
      <BatchToolbar
        summary={summary}
        skipped={2}
        cleanReadyCount={0}
        tiktokReadyCount={0}
        archive={{ kind: "idle", mode: null, progress: 0 }}
        actions={actions()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Descargar carpeta limpia" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Descargar carpeta TikTok" }),
    ).toBeDisabled();
  });

  it("renders semantic progress, true counters, and cancellable work", () => {
    const callbacks = actions();
    render(
      <BatchToolbar
        summary={summary}
        skipped={2}
        cleanReadyCount={1}
        tiktokReadyCount={0}
        archive={{ kind: "running", mode: "clean", progress: 41 }}
        actions={callbacks}
      />,
    );

    expect(screen.getByRole("progressbar", { name: "Progreso del lote" })).toHaveValue(2);
    expect(screen.getByText("En cola 1")).toBeVisible();
    expect(screen.getByText("Activas 1")).toBeVisible();
    expect(screen.getByText("Omitidas 2")).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "Progreso del archivo ZIP" }),
    ).toHaveValue(41);

    fireEvent.click(screen.getByRole("button", { name: "Cancelar ZIP" }));
    expect(callbacks.cancelArchive).toHaveBeenCalledOnce();
  });
});
