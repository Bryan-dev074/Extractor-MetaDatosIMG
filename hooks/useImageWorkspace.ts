"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  generateArchive as generateArchiveDefault,
  planArchive,
  requestArchiveWriter as requestArchiveWriterDefault,
  assertRetainedByteBudget,
  type ArchivePlan,
  type ArchiveResult,
  type ArchiveWriterRequest,
  type GenerateArchiveOptions,
} from "../lib/archive/zip";
import type { ProcessingMode } from "../lib/archive/report";
import type { BatchItem } from "../lib/batch/reducer";
import {
  createTikTokProcessor,
  type TikTokProcessor,
} from "../lib/batch/worker-pool";
import type {
  InputImage,
  InputSelection,
  SkippedInput,
} from "../lib/batch/types";
import type { TikTokExportResult } from "../lib/tiktok/export";
import {
  useBatchProcessor,
  type BatchProcessorApi,
  type UseBatchProcessorOptions,
} from "./useBatchProcessor";

const FALLBACK_ARCHIVE_BASE = "imagenes-procesadas";

export type TikTokWorkspaceItem =
  | { status: "idle" }
  | { status: "queued" | "processing" }
  | {
      status: "ready";
      result: TikTokExportResult;
      width: number;
      height: number;
      size: number;
    }
  | { status: "error"; error: string }
  | { status: "cancelled" };

export type ArchiveWorkspaceState =
  | { kind: "idle"; mode: null; progress: 0 }
  | { kind: "running"; mode: ProcessingMode; progress: number }
  | { kind: "error"; mode: ProcessingMode; progress: number; error: string }
  | { kind: "done"; mode: ProcessingMode; progress: 100 };

type ArchiveGenerator = (
  plan: ArchivePlan,
  options: GenerateArchiveOptions,
) => Promise<ArchiveResult>;

export interface ImageWorkspaceOptions {
  batchOptions?: UseBatchProcessorOptions;
  batchApi?: BatchProcessorApi;
  requestArchiveWriter?: (suggestedName: string) => Promise<ArchiveWriterRequest>;
  generateArchive?: ArchiveGenerator;
  exportTikTok?: (
    input: Blob,
    signal: AbortSignal,
    correlation: { id: string; generation: number },
  ) => Promise<TikTokExportResult>;
}

export interface ImageWorkspaceApi {
  batch: BatchProcessorApi;
  selection: InputSelection;
  skipped: SkippedInput[];
  archiveBase: string;
  archive: ArchiveWorkspaceState;
  tiktokById: Record<string, TikTokWorkspaceItem>;
  previewUrls: Record<string, string>;
  cleanReadyCount: number;
  tiktokReadyCount: number;
  ingest(selection: InputSelection): void;
  setPreviewVisible(id: string, visible: boolean): void;
  cancelBatch(): void;
  retry(id: string): void;
  remove(id: string): void;
  reset(): void;
  generateTikTok(id: string): Promise<void>;
  cancelTikTok(id: string): void;
  prepareAllTikTok(): Promise<void>;
  downloadClean(id: string): void;
  downloadTikTok(id: string): void;
  downloadTikTokPreview(id: string): void;
  downloadCleanArchive(): Promise<void>;
  downloadTikTokArchive(): Promise<void>;
  cancelArchive(): void;
}

const EMPTY_SELECTION: InputSelection = {
  archiveBase: FALLBACK_ARCHIVE_BASE,
  accepted: [],
  skipped: [],
};

function compareText(left: string, right: string): number {
  const a = left.normalize("NFC");
  const b = right.normalize("NFC");
  return a < b ? -1 : a > b ? 1 : 0;
}

function commonRoot(
  accepted: InputImage[],
  skipped: SkippedInput[],
): string {
  const paths = [
    ...accepted.map((item) => item.relativePath),
    ...skipped.map((item) => item.relativePath),
  ];
  if (paths.length === 0) return FALLBACK_ARCHIVE_BASE;
  let root: string | undefined;
  for (const path of paths) {
    const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length < 2) return FALLBACK_ARCHIVE_BASE;
    if (root === undefined) root = segments[0].normalize("NFC");
    else if (root !== segments[0].normalize("NFC")) return FALLBACK_ARCHIVE_BASE;
  }
  return root ?? FALLBACK_ARCHIVE_BASE;
}

export function mergeInputSelections(
  current: InputSelection,
  incoming: InputSelection,
): InputSelection {
  const accepted = [...current.accepted];
  const skipped = [...current.skipped, ...incoming.skipped];
  const seen = new Set(accepted.map((item) => item.id));

  for (const item of incoming.accepted) {
    if (seen.has(item.id)) {
      skipped.push({
        relativePath: item.relativePath,
        reason: "Archivo duplicado: ya se agregó esta misma imagen.",
      });
      continue;
    }
    seen.add(item.id);
    accepted.push(item);
  }

  accepted.sort(
    (left, right) =>
      compareText(left.relativePath, right.relativePath) ||
      compareText(left.id, right.id),
  );
  skipped.sort(
    (left, right) =>
      compareText(left.relativePath, right.relativePath) ||
      compareText(left.reason, right.reason),
  );
  assertRetainedByteBudget(accepted.map((item) => item.file.size));

  return {
    archiveBase: commonRoot(accepted, skipped),
    accepted,
    skipped,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "No se pudo completar la operación.";
}

function outputName(path: string, suffix: "limpio" | "tiktok", extension: string): string {
  const basename = path.replace(/\\/g, "/").split("/").at(-1) ?? "imagen";
  const dot = basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  return `${stem}-${suffix}${extension}`;
}

export function useImageWorkspace(
  options: ImageWorkspaceOptions = {},
): ImageWorkspaceApi {
  const internalBatch = useBatchProcessor(options.batchOptions);
  const batch = options.batchApi ?? internalBatch;
  const [selection, setSelection] = useState<InputSelection>(EMPTY_SELECTION);
  const [archive, setArchive] = useState<ArchiveWorkspaceState>({
    kind: "idle",
    mode: null,
    progress: 0,
  });
  const [tiktokById, setTikTokById] = useState<
    Record<string, TikTokWorkspaceItem>
  >({});
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const selectionRef = useRef(selection);
  const itemsRef = useRef(batch.items);
  const tiktokRef = useRef(tiktokById);
  const previewRef = useRef(new Map<string, string>());
  const transientUrlRef = useRef<string | null>(null);
  const archiveControllerRef = useRef<AbortController | null>(null);
  const tiktokControllersRef = useRef(new Map<string, AbortController>());
  const tiktokTailRef = useRef<Promise<void>>(Promise.resolve());
  const tikTokProcessorRef = useRef<TikTokProcessor | null>(null);
  const generationRef = useRef(1);
  const mountedRef = useRef(true);
  selectionRef.current = selection;
  itemsRef.current = batch.items;
  tiktokRef.current = tiktokById;

  const requestWriter = options.requestArchiveWriter ?? requestArchiveWriterDefault;
  const archiveGenerator = options.generateArchive ?? generateArchiveDefault;
  const exportTikTokOverride = options.exportTikTok;

  const setTikTokState = useCallback(
    (id: string, state: TikTokWorkspaceItem): void => {
      const next = { ...tiktokRef.current, [id]: state };
      tiktokRef.current = next;
      setTikTokById(next);
    },
    [],
  );

  const removeTikTokState = useCallback((id: string): void => {
    if (!Object.hasOwn(tiktokRef.current, id)) return;
    const { [id]: _removed, ...next } = tiktokRef.current;
    tiktokRef.current = next;
    setTikTokById(next);
  }, []);

  const revokePreview = useCallback((id: string): void => {
    const url = previewRef.current.get(id);
    if (!url) return;
    URL.revokeObjectURL(url);
    previewRef.current.delete(id);
    setPreviewUrls((current) => {
      if (!Object.hasOwn(current, id)) return current;
      const { [id]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const revokeAllUrls = useCallback((): void => {
    for (const url of previewRef.current.values()) URL.revokeObjectURL(url);
    previewRef.current.clear();
    if (transientUrlRef.current) {
      URL.revokeObjectURL(transientUrlRef.current);
      transientUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    const valid = new Set(batch.items.map((item) => item.id));
    for (const id of previewRef.current.keys()) {
      if (!valid.has(id)) revokePreview(id);
    }
  }, [batch.items, revokePreview]);

  useEffect(() => {
    mountedRef.current = true;
    const controllers = tiktokControllersRef.current;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      archiveControllerRef.current?.abort("La vista fue cerrada.");
      for (const controller of controllers.values()) {
        controller.abort("La vista fue cerrada.");
      }
      controllers.clear();
      tikTokProcessorRef.current?.destroy();
      tikTokProcessorRef.current = null;
      revokeAllUrls();
    };
  }, [revokeAllUrls]);

  const ingest = useCallback(
    (incoming: InputSelection): void => {
      const previous = selectionRef.current;
      const merged =
        previous.accepted.length === 0 && previous.skipped.length === 0
          ? mergeInputSelections(EMPTY_SELECTION, incoming)
          : mergeInputSelections(previous, incoming);
      selectionRef.current = merged;
      setSelection(merged);

      const previousIds = new Set(previous.accepted.map((item) => item.id));
      const added = merged.accepted.filter((item) => !previousIds.has(item.id));
      if (previous.accepted.length === 0 && batch.items.length === 0) {
        if (added.length > 0) batch.start(added);
      } else if (added.length > 0) {
        batch.add(added);
      }
    },
    [batch],
  );

  const setPreviewVisible = useCallback(
    (id: string, visible: boolean): void => {
      if (!visible) {
        revokePreview(id);
        return;
      }
      if (previewRef.current.has(id)) return;
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (!item || typeof URL?.createObjectURL !== "function") return;
      const url = URL.createObjectURL(item.file);
      previewRef.current.set(id, url);
      setPreviewUrls((current) => ({ ...current, [id]: url }));
    },
    [revokePreview],
  );

  const cancelAllTikTok = useCallback((reason: string): void => {
    generationRef.current += 1;
    for (const controller of tiktokControllersRef.current.values()) {
      controller.abort(reason);
    }
    tiktokControllersRef.current.clear();
    tiktokTailRef.current = Promise.resolve();
  }, []);

  const reset = useCallback((): void => {
    archiveControllerRef.current?.abort("El espacio de trabajo fue reiniciado.");
    archiveControllerRef.current = null;
    cancelAllTikTok("El espacio de trabajo fue reiniciado.");
    revokeAllUrls();
    selectionRef.current = EMPTY_SELECTION;
    setSelection(EMPTY_SELECTION);
    tiktokRef.current = {};
    setTikTokById({});
    setPreviewUrls({});
    setArchive({ kind: "idle", mode: null, progress: 0 });
    batch.reset();
  }, [batch, cancelAllTikTok, revokeAllUrls]);

  const remove = useCallback(
    (id: string): void => {
      revokePreview(id);
      tiktokControllersRef.current.get(id)?.abort("La imagen fue eliminada.");
      tiktokControllersRef.current.delete(id);
      removeTikTokState(id);
      const nextAccepted = selectionRef.current.accepted.filter(
        (item) => item.id !== id,
      );
      const next = {
        ...selectionRef.current,
        accepted: nextAccepted,
        archiveBase: commonRoot(nextAccepted, selectionRef.current.skipped),
      };
      selectionRef.current = next;
      setSelection(next);
      batch.remove(id);
    },
    [batch, removeTikTokState, revokePreview],
  );

  const performTikTokExport = useCallback(
    async (item: BatchItem, controller: AbortController): Promise<TikTokExportResult> => {
      if (!item.result) throw new Error("La imagen limpia todavía no está disponible.");
      const blob = new Blob([Uint8Array.from(item.result.cleaned)], {
        type: item.result.mime,
      });
      const correlation = { id: item.id, generation: generationRef.current };
      if (exportTikTokOverride) {
        return exportTikTokOverride(blob, controller.signal, correlation);
      }
      if (!tikTokProcessorRef.current) {
        tikTokProcessorRef.current = createTikTokProcessor();
      }
      return tikTokProcessorRef.current.export(blob, correlation, controller.signal);
    },
    [exportTikTokOverride],
  );

  const generateTikTok = useCallback(
    (id: string): Promise<void> => {
      const current = tiktokRef.current[id];
      if (current?.status === "ready" || current?.status === "processing" || current?.status === "queued") {
        return Promise.resolve();
      }
      const controller = new AbortController();
      const scheduledGeneration = generationRef.current;
      tiktokControllersRef.current.set(id, controller);
      setTikTokState(id, { status: "queued" });

      const operation = tiktokTailRef.current.then(async () => {
        if (controller.signal.aborted || scheduledGeneration !== generationRef.current) {
          return;
        }
        const item = itemsRef.current.find((candidate) => candidate.id === id);
        if (!item?.result || item.status !== "completed") {
          throw new Error("Primero debe terminar la limpieza de esta imagen.");
        }
        setTikTokState(id, { status: "processing" });
        try {
          const result = await performTikTokExport(item, controller);
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            scheduledGeneration !== generationRef.current
          ) {
            return;
          }
          setTikTokState(id, {
            status: "ready",
            result,
            width: result.width,
            height: result.height,
            size: result.png.byteLength,
          });
        } catch (error) {
          if (!mountedRef.current || scheduledGeneration !== generationRef.current) return;
          setTikTokState(
            id,
            controller.signal.aborted
              ? { status: "cancelled" }
              : { status: "error", error: errorMessage(error) },
          );
        } finally {
          if (tiktokControllersRef.current.get(id) === controller) {
            tiktokControllersRef.current.delete(id);
          }
        }
      });
      tiktokTailRef.current = operation.catch(() => undefined);
      return operation;
    },
    [performTikTokExport, setTikTokState],
  );

  const prepareAllTikTok = useCallback(async (): Promise<void> => {
    const candidates = itemsRef.current.filter(
      (item) => item.status === "completed" && item.result?.qualityVerified,
    );
    for (const item of candidates) {
      await generateTikTok(item.id);
    }
  }, [generateTikTok]);

  const cancelTikTok = useCallback(
    (id: string): void => {
      const controller = tiktokControllersRef.current.get(id);
      if (!controller) return;
      controller.abort("La preparación TikTok fue cancelada.");
      setTikTokState(id, { status: "cancelled" });
    },
    [setTikTokState],
  );

  const downloadBlob = useCallback((blob: Blob, name: string): void => {
    if (transientUrlRef.current) URL.revokeObjectURL(transientUrlRef.current);
    const url = URL.createObjectURL(blob);
    transientUrlRef.current = url;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      if (transientUrlRef.current !== url) return;
      URL.revokeObjectURL(url);
      transientUrlRef.current = null;
    }, 0);
  }, []);

  const downloadClean = useCallback(
    (id: string): void => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (!item?.result?.qualityVerified) return;
      downloadBlob(
        new Blob([Uint8Array.from(item.result.cleaned)], { type: item.result.mime }),
        outputName(item.relativePath, "limpio", item.result.outputExtension),
      );
    },
    [downloadBlob],
  );

  const downloadTikTok = useCallback(
    (id: string): void => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      const state = tiktokRef.current[id];
      if (!item || state?.status !== "ready") return;
      downloadBlob(
        new Blob([Uint8Array.from(state.result.png)], { type: "image/png" }),
        outputName(item.relativePath, "tiktok", ".png"),
      );
    },
    [downloadBlob],
  );

  const downloadTikTokPreview = useCallback(
    (id: string): void => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      const state = tiktokRef.current[id];
      if (!item || state?.status !== "ready") return;
      downloadBlob(
        new Blob([Uint8Array.from(state.result.preview)], { type: "image/jpeg" }),
        outputName(item.relativePath, "tiktok", "-vista-previa.jpg"),
      );
    },
    [downloadBlob],
  );

  const buildArchivePlan = useCallback(
    (mode: ProcessingMode): ArchivePlan => {
      const outputs =
        mode === "clean"
          ? itemsRef.current.flatMap((item) =>
              item.status === "completed" && item.result?.qualityVerified
                ? [
                    {
                      id: item.id,
                      relativePath: item.relativePath,
                      bytes: item.result.cleaned,
                      qualityVerified: true,
                      outputExtension: item.result.outputExtension,
                    },
                  ]
                : [],
            )
          : itemsRef.current.flatMap((item) => {
              const state = tiktokRef.current[item.id];
              return state?.status === "ready"
                ? [
                    {
                      id: item.id,
                      relativePath: item.relativePath,
                      bytes: state.result.png,
                      outputExtension: ".png" as const,
                    },
                  ]
                : [];
            });
      const failed = itemsRef.current.flatMap((item) =>
        item.status === "error"
          ? [
              {
                id: item.id,
                relativePath: item.relativePath,
                error: item.error ?? "Error de procesamiento.",
              },
            ]
          : [],
      );
      return planArchive(
        {
          archiveBase: selectionRef.current.archiveBase,
          outputs,
          skipped: selectionRef.current.skipped,
          failed,
        },
        mode,
      );
    },
    [],
  );

  const finishArchive = useCallback(
    async (
      mode: ProcessingMode,
      writerRequest: Promise<ArchiveWriterRequest>,
    ): Promise<void> => {
      try {
        const requested = await writerRequest;
        if (requested.kind === "cancelled") {
          setArchive({ kind: "idle", mode: null, progress: 0 });
          return;
        }
        const controller = new AbortController();
        archiveControllerRef.current = controller;
        setArchive({ kind: "running", mode, progress: 0 });
        const plan = buildArchivePlan(mode);
        if (plan.entries.length === 0) {
          throw new Error(`No hay salidas ${mode === "clean" ? "limpias" : "TikTok"} listas.`);
        }
        const result = await archiveGenerator(plan, {
          destination:
            requested.kind === "writer"
              ? { kind: "writer", writer: requested.writer }
              : { kind: "blob" },
          signal: controller.signal,
          onProgress: (progress) => {
            if (!controller.signal.aborted) {
              setArchive({ kind: "running", mode, progress });
            }
          },
        });
        if (controller.signal.aborted) return;
        if (result.kind === "blob") downloadBlob(result.blob, result.suggestedName);
        setArchive({ kind: "done", mode, progress: 100 });
      } catch (error) {
        const controller = archiveControllerRef.current;
        if (controller?.signal.aborted) {
          setArchive({ kind: "idle", mode: null, progress: 0 });
        } else {
          setArchive({
            kind: "error",
            mode,
            progress: 0,
            error: errorMessage(error),
          });
        }
      } finally {
        archiveControllerRef.current = null;
      }
    },
    [archiveGenerator, buildArchivePlan, downloadBlob],
  );

  const downloadCleanArchive = useCallback((): Promise<void> => {
    const writer = requestWriter(`${selectionRef.current.archiveBase}-limpia.zip`);
    return finishArchive("clean", writer);
  }, [finishArchive, requestWriter]);

  const downloadTikTokArchive = useCallback((): Promise<void> => {
    const writer = requestWriter(`${selectionRef.current.archiveBase}-tiktok.zip`);
    return finishArchive("tiktok", writer);
  }, [finishArchive, requestWriter]);

  const cancelArchive = useCallback((): void => {
    archiveControllerRef.current?.abort("El ZIP fue cancelado.");
  }, []);

  const cleanReadyCount = useMemo(
    () =>
      batch.items.filter(
        (item) => item.status === "completed" && item.result?.qualityVerified,
      ).length,
    [batch.items],
  );
  const tiktokReadyCount = useMemo(
    () =>
      Object.values(tiktokById).filter((state) => state.status === "ready").length,
    [tiktokById],
  );

  return {
    batch,
    selection,
    skipped: selection.skipped,
    archiveBase: selection.archiveBase,
    archive,
    tiktokById,
    previewUrls,
    cleanReadyCount,
    tiktokReadyCount,
    ingest,
    setPreviewVisible,
    cancelBatch: batch.cancel,
    retry: batch.retry,
    remove,
    reset,
    generateTikTok,
    cancelTikTok,
    prepareAllTikTok,
    downloadClean,
    downloadTikTok,
    downloadTikTokPreview,
    downloadCleanArchive,
    downloadTikTokArchive,
    cancelArchive,
  };
}
