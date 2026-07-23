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

const settledSummary: BatchSummary = {
  ...summary,
  queued: 0,
  processing: 0,
  completed: 3,
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
  it("shows an indeterminate preparation state while accepted files are registering", () => {
    render(
      <BatchToolbar
        summary={{ ...settledSummary, total: 0, completed: 0 }}
        skipped={0}
        pendingRegistrationCount={1}
        cleanReadyCount={0}
        tiktokReadyCount={0}
        tiktokBatchStatus="idle"
        archive={{ kind: "idle", mode: null, progress: 0 }}
        actions={actions()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Preparando selección" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Lote inspeccionado" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Preparación de la selección" }),
    ).not.toHaveAttribute("value");
    expect(
      screen.getByRole("button", { name: "Descargar carpeta limpia" }),
    ).toBeDisabled();
  });

  it("keeps ZIP actions disabled until their required outputs exist", () => {
    render(
      <BatchToolbar
        summary={summary}
        skipped={2}
        cleanReadyCount={0}
        tiktokReadyCount={0}
        tiktokBatchStatus="idle"
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
        tiktokBatchStatus="idle"
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

  it("prevents duplicate TikTok preparation and unlocks its ZIP only when settled", () => {
    const callbacks = actions();
    const { rerender } = render(
      <BatchToolbar
        summary={settledSummary}
        skipped={0}
        cleanReadyCount={3}
        tiktokReadyCount={1}
        tiktokBatchStatus="busy"
        archive={{ kind: "idle", mode: null, progress: 0 }}
        actions={callbacks}
      />,
    );

    const prepare = screen.getByRole("button", {
      name: "Preparando lote TikTok…",
    });
    expect(prepare).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Descargar carpeta TikTok" }),
    ).toBeDisabled();
    fireEvent.click(prepare);
    expect(callbacks.prepareTikTok).not.toHaveBeenCalled();

    rerender(
      <BatchToolbar
        summary={settledSummary}
        skipped={0}
        cleanReadyCount={3}
        tiktokReadyCount={1}
        tiktokBatchStatus="idle"
        archive={{ kind: "idle", mode: null, progress: 0 }}
        actions={callbacks}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Descargar carpeta TikTok" }),
    ).toBeDisabled();

    rerender(
      <BatchToolbar
        summary={settledSummary}
        skipped={0}
        cleanReadyCount={3}
        tiktokReadyCount={1}
        tiktokBatchStatus="settled"
        archive={{ kind: "idle", mode: null, progress: 0 }}
        actions={callbacks}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Descargar carpeta TikTok" }),
    ).toBeEnabled();
  });
});
