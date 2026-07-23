import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResultCard, {
  type TikTokItemState,
} from "../../components/ResultCard";
import type { BatchItem } from "../../lib/batch/reducer";

let observerCallback: IntersectionObserverCallback;

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = () => [];
  root = null;
  rootMargin = "250px";
  thresholds = [0];
}

function completedItem(): BatchItem {
  return {
    id: "uno",
    file: new File([Uint8Array.from([0xff, 0xd8])], "foto.jpg"),
    relativePath: "Campaña/Una ruta muy profunda/foto.jpg",
    format: "jpeg",
    status: "completed",
    progress: 1,
    result: {
      format: "jpeg",
      mime: "image/jpeg",
      cleaned: Uint8Array.from([0xff, 0xd8]),
      originalSize: 2,
      cleanedSize: 2,
      findings: [],
      preserved: [],
      isAi: false,
      notices: [],
      pixelPayloadHash: "abc",
      qualityVerified: true,
      outputExtension: ".jpg",
    },
  };
}

const idleTikTok: TikTokItemState = { status: "idle" };

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResultCard", () => {
  it("reports lazy preview visibility and exposes the complete path", () => {
    const onPreviewVisibility = vi.fn();
    const item = completedItem();
    render(
      <ResultCard
        item={item}
        previewUrl={null}
        tiktok={idleTikTok}
        onPreviewVisibility={onPreviewVisibility}
        onDownloadClean={vi.fn()}
        onGenerateTikTok={vi.fn()}
        onDownloadTikTok={vi.fn()}
        onDownloadTikTokPreview={vi.fn()}
        onCancelTikTok={vi.fn()}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    act(() => {
      observerCallback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(onPreviewVisibility).toHaveBeenCalledWith("uno", true);
    expect(screen.getByText(item.relativePath)).toHaveAttribute(
      "title",
      item.relativePath,
    );
  });

  it("uses explicit clean and TikTok states", () => {
    const item = completedItem();
    const onGenerateTikTok = vi.fn();
    const onCancelTikTok = vi.fn();
    const { rerender } = render(
      <ResultCard
        item={item}
        previewUrl={null}
        tiktok={idleTikTok}
        onPreviewVisibility={vi.fn()}
        onDownloadClean={vi.fn()}
        onGenerateTikTok={onGenerateTikTok}
        onDownloadTikTok={vi.fn()}
        onDownloadTikTokPreview={vi.fn()}
        onCancelTikTok={onCancelTikTok}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText("Píxeles 1:1 · sin recomprimir")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Preparar foto.jpg para TikTok" }),
    );
    expect(onGenerateTikTok).toHaveBeenCalledWith("uno");

    rerender(
      <ResultCard
        item={item}
        previewUrl={null}
        tiktok={{ status: "processing" }}
        onPreviewVisibility={vi.fn()}
        onDownloadClean={vi.fn()}
        onGenerateTikTok={onGenerateTikTok}
        onDownloadTikTok={vi.fn()}
        onDownloadTikTokPreview={vi.fn()}
        onCancelTikTok={onCancelTikTok}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancelar preparación TikTok de foto.jpg" }),
    );
    expect(onCancelTikTok).toHaveBeenCalledWith("uno");

    rerender(
      <ResultCard
        item={item}
        previewUrl={null}
        tiktok={{ status: "ready", width: 1536, height: 2752, size: 44 }}
        onPreviewVisibility={vi.fn()}
        onDownloadClean={vi.fn()}
        onGenerateTikTok={onGenerateTikTok}
        onDownloadTikTok={vi.fn()}
        onDownloadTikTokPreview={vi.fn()}
        onCancelTikTok={onCancelTikTok}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText("PNG sRGB · anti-parches adaptativo")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Descargar foto.jpg para TikTok" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "Descargar vista previa aproximada de foto.jpg",
      }),
    ).toBeEnabled();
  });
});
