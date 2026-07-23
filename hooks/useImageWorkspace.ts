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

export type TikTokBatchStatus = "idle" | "busy" | "settled";

type ArchiveGenerator = (
  plan: ArchivePlan,
  options: GenerateArchiveOptions,
) => Promise<ArchiveResult>;

interface ArchiveOperation {
  epoch: number;
  controller: AbortController | null;
}

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
  tiktokBatchStatus: TikTokBatchStatus;
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
  const [tiktokBatchStatus, setTikTokBatchStatus] =
    useState<TikTokBatchStatus>("idle");
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const selectionRef = useRef(selection);
  const itemsRef = useRef(batch.items);
  const tiktokRef = useRef(tiktokById);
  const previewRef = useRef(new Map<string, string>());
  const transientUrlsRef = useRef(new Set<string>());
  const archiveEpochRef = useRef(0);
  const archiveOperationRef = useRef<ArchiveOperation | null>(null);
  const tiktokControllersRef = useRef(new Map<string, AbortController>());
  const tiktokTailRef = useRef<Promise<void>>(Promise.resolve());
  const tiktokPreparationEpochRef = useRef(0);
  const tiktokPreparationPromiseRef = useRef<Promise<void> | null>(null);
  const tiktokBatchStatusRef = useRef<TikTokBatchStatus>("idle");
  const tiktokItemEpochsRef = useRef(new Map<string, number>());
  const removedTikTokIdsRef = useRef(new Set<string>());
  const tikTokProcessorRef = useRef<TikTokProcessor | null>(null);
  const generationRef = useRef(1);
  const mountedRef = useRef(true);
  selectionRef.current = selection;
  itemsRef.current = batch.items;
  tiktokRef.current = tiktokById;

  const requestWriter = options.requestArchiveWriter ?? requestArchiveWriterDefault;
  const archiveGenerator = options.generateArchive ?? generateArchiveDefault;
  const exportTikTokOverride = options.exportTikTok;

  const updateTikTokBatchStatus = useCallback(
    (status: TikTokBatchStatus): void => {
      tiktokBatchStatusRef.current = status;
      setTikTokBatchStatus(status);
    },
    [],
  );

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
    for (const url of transientUrlsRef.current) URL.revokeObjectURL(url);
    transientUrlsRef.current.clear();
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
      archiveEpochRef.current += 1;
      archiveOperationRef.current?.controller?.abort("La vista fue cerrada.");
      archiveOperationRef.current = null;
      tiktokPreparationEpochRef.current += 1;
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
      if (added.length > 0) {
        tiktokPreparationEpochRef.current += 1;
        tiktokPreparationPromiseRef.current = null;
        updateTikTokBatchStatus("idle");
        for (const item of added) removedTikTokIdsRef.current.delete(item.id);
      }
      if (previous.accepted.length === 0 && batch.items.length === 0) {
        if (added.length > 0) batch.start(added);
      } else if (added.length > 0) {
        batch.add(added);
      }
    },
    [batch, updateTikTokBatchStatus],
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
    tiktokPreparationEpochRef.current += 1;
    tiktokPreparationPromiseRef.current = null;
    for (const controller of tiktokControllersRef.current.values()) {
      controller.abort(reason);
    }
    tiktokControllersRef.current.clear();
    tiktokTailRef.current = Promise.resolve();
  }, []);

  const reset = useCallback((): void => {
    archiveEpochRef.current += 1;
    archiveOperationRef.current?.controller?.abort(
      "El espacio de trabajo fue reiniciado.",
    );
    archiveOperationRef.current = null;
    cancelAllTikTok("El espacio de trabajo fue reiniciado.");
    revokeAllUrls();
    selectionRef.current = EMPTY_SELECTION;
    setSelection(EMPTY_SELECTION);
    tiktokRef.current = {};
    setTikTokById({});
    removedTikTokIdsRef.current = new Set(
      itemsRef.current.map((item) => item.id),
    );
    tiktokItemEpochsRef.current.clear();
    updateTikTokBatchStatus("idle");
    setPreviewUrls({});
    setArchive({ kind: "idle", mode: null, progress: 0 });
    batch.reset();
  }, [batch, cancelAllTikTok, revokeAllUrls, updateTikTokBatchStatus]);

  const remove = useCallback(
    (id: string): void => {
      tiktokPreparationEpochRef.current += 1;
      tiktokPreparationPromiseRef.current = null;
      updateTikTokBatchStatus("idle");
      removedTikTokIdsRef.current.add(id);
      tiktokItemEpochsRef.current.set(
        id,
        (tiktokItemEpochsRef.current.get(id) ?? 0) + 1,
      );
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
    [batch, removeTikTokState, revokePreview, updateTikTokBatchStatus],
  );

  const retry = useCallback(
    (id: string): void => {
      tiktokPreparationEpochRef.current += 1;
      tiktokPreparationPromiseRef.current = null;
      updateTikTokBatchStatus("idle");
      removedTikTokIdsRef.current.delete(id);
      tiktokItemEpochsRef.current.set(
        id,
        (tiktokItemEpochsRef.current.get(id) ?? 0) + 1,
      );
      tiktokControllersRef.current.get(id)?.abort(
        "La imagen limpia se volvió a procesar.",
      );
      tiktokControllersRef.current.delete(id);
      removeTikTokState(id);
      batch.retry(id);
    },
    [batch, removeTikTokState, updateTikTokBatchStatus],
  );

  const performTikTokExport = useCallback(
    async (
      item: BatchItem,
      controller: AbortController,
      scheduledGeneration: number,
    ): Promise<TikTokExportResult> => {
      if (!item.result) throw new Error("La imagen limpia todavía no está disponible.");
      const blob = new Blob([Uint8Array.from(item.result.cleaned)], {
        type: item.result.mime,
      });
      const correlation = { id: item.id, generation: scheduledGeneration };
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

  const scheduleTikTok = useCallback(
    (id: string): Promise<void> => {
      const current = tiktokRef.current[id];
      if (current?.status === "ready" || current?.status === "processing" || current?.status === "queued") {
        return Promise.resolve();
      }
      if (removedTikTokIdsRef.current.has(id)) return Promise.resolve();
      const controller = new AbortController();
      const scheduledGeneration = generationRef.current;
      const scheduledItemEpoch = tiktokItemEpochsRef.current.get(id) ?? 0;
      tiktokControllersRef.current.set(id, controller);
      setTikTokState(id, { status: "queued" });

      const operation = tiktokTailRef.current.then(async () => {
        const isCurrent = (): boolean =>
          mountedRef.current &&
          !controller.signal.aborted &&
          scheduledGeneration === generationRef.current &&
          scheduledItemEpoch === (tiktokItemEpochsRef.current.get(id) ?? 0) &&
          !removedTikTokIdsRef.current.has(id) &&
          tiktokControllersRef.current.get(id) === controller;
        try {
          if (!isCurrent()) return;
          const item = itemsRef.current.find((candidate) => candidate.id === id);
          if (!item?.result || item.status !== "completed") {
            throw new Error("Primero debe terminar la limpieza de esta imagen.");
          }
          setTikTokState(id, { status: "processing" });
          const result = await performTikTokExport(
            item,
            controller,
            scheduledGeneration,
          );
          if (!isCurrent()) return;
          setTikTokState(id, {
            status: "ready",
            result,
            width: result.width,
            height: result.height,
            size: result.png.byteLength,
          });
        } catch (error) {
          const ownsCurrentSlot =
            mountedRef.current &&
            scheduledGeneration === generationRef.current &&
            scheduledItemEpoch === (tiktokItemEpochsRef.current.get(id) ?? 0) &&
            !removedTikTokIdsRef.current.has(id) &&
            tiktokControllersRef.current.get(id) === controller;
          if (!ownsCurrentSlot) return;
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

  const generateTikTok = useCallback(
    (id: string): Promise<void> => {
      if (
        tiktokBatchStatusRef.current === "settled" &&
        tiktokRef.current[id]?.status !== "ready"
      ) {
        tiktokPreparationEpochRef.current += 1;
        tiktokPreparationPromiseRef.current = null;
        updateTikTokBatchStatus("idle");
      }
      return scheduleTikTok(id);
    },
    [scheduleTikTok, updateTikTokBatchStatus],
  );

  const prepareAllTikTok = useCallback((): Promise<void> => {
    if (
      tiktokBatchStatusRef.current === "busy" &&
      tiktokPreparationPromiseRef.current
    ) {
      return tiktokPreparationPromiseRef.current;
    }

    const preparationEpoch = tiktokPreparationEpochRef.current + 1;
    tiktokPreparationEpochRef.current = preparationEpoch;
    updateTikTokBatchStatus("busy");

    const operation = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const candidates = itemsRef.current.filter(
          (item) => item.status === "completed" && item.result?.qualityVerified,
        );
        for (const item of candidates) {
          if (preparationEpoch !== tiktokPreparationEpochRef.current) return;
          if (removedTikTokIdsRef.current.has(item.id)) continue;
          await scheduleTikTok(item.id);
          if (preparationEpoch !== tiktokPreparationEpochRef.current) return;
        }
        while (preparationEpoch === tiktokPreparationEpochRef.current) {
          const tail = tiktokTailRef.current;
          await tail;
          if (preparationEpoch !== tiktokPreparationEpochRef.current) return;
          if (
            tail === tiktokTailRef.current &&
            tiktokControllersRef.current.size === 0
          ) {
            break;
          }
        }
      } finally {
        if (
          mountedRef.current &&
          preparationEpoch === tiktokPreparationEpochRef.current
        ) {
          updateTikTokBatchStatus("settled");
        }
        if (preparationEpoch === tiktokPreparationEpochRef.current) {
          tiktokPreparationPromiseRef.current = null;
        }
      }
    })();
    tiktokPreparationPromiseRef.current = operation;
    return operation;
  }, [scheduleTikTok, updateTikTokBatchStatus]);

  const cancelTikTok = useCallback(
    (id: string): void => {
      const controller = tiktokControllersRef.current.get(id);
      if (!controller) return;
      controller.abort("La preparación TikTok fue cancelada.");
      tiktokControllersRef.current.delete(id);
      if (!removedTikTokIdsRef.current.has(id)) {
        setTikTokState(id, { status: "cancelled" });
      }
    },
    [setTikTokState],
  );

  const downloadBlob = useCallback((blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    transientUrlsRef.current.add(url);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      if (!transientUrlsRef.current.delete(url)) return;
      URL.revokeObjectURL(url);
    }, 1_500);
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
        item.status === "error" || item.status === "cancelled"
          ? [
              {
                id: item.id,
                relativePath: item.relativePath,
                error:
                  item.status === "cancelled"
                    ? "La limpieza fue cancelada."
                    : item.error ?? "Error de procesamiento.",
              },
            ]
          : [],
      );
      if (mode === "tiktok") {
        for (const item of itemsRef.current) {
          const state = tiktokRef.current[item.id];
          if (item.status === "completed" && state?.status === "error") {
            failed.push({
              id: item.id,
              relativePath: item.relativePath,
              error: state.error,
            });
          } else if (
            item.status === "completed" &&
            state?.status === "cancelled"
          ) {
            failed.push({
              id: item.id,
              relativePath: item.relativePath,
              error: "La preparación TikTok fue cancelada.",
            });
          }
        }
      }
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
      operation: ArchiveOperation,
    ): Promise<void> => {
      let requested: ArchiveWriterRequest | undefined;
      let writerHandedOff = false;
      let writerAborted = false;
      const isCurrent = (): boolean =>
        mountedRef.current &&
        archiveEpochRef.current === operation.epoch &&
        archiveOperationRef.current === operation;
      const abortUnusedWriter = async (reason: unknown): Promise<void> => {
        if (
          writerAborted ||
          writerHandedOff ||
          requested?.kind !== "writer"
        ) {
          return;
        }
        writerAborted = true;
        try {
          await requested.writer.abort(reason);
        } catch {
          // Preserve the failure that prevented the writer from being used.
        }
      };

      try {
        requested = await writerRequest;
        if (!isCurrent()) {
          await abortUnusedWriter(
            new DOMException("La operación ZIP ya no está vigente.", "AbortError"),
          );
          return;
        }
        if (requested.kind === "cancelled") {
          setArchive({ kind: "idle", mode: null, progress: 0 });
          return;
        }
        const controller = new AbortController();
        operation.controller = controller;
        setArchive({ kind: "running", mode, progress: 0 });
        const plan = buildArchivePlan(mode);
        if (plan.entries.length === 0) {
          throw new Error(`No hay salidas ${mode === "clean" ? "limpias" : "TikTok"} listas.`);
        }
        const generated = archiveGenerator(plan, {
          destination:
            requested.kind === "writer"
              ? { kind: "writer", writer: requested.writer }
              : { kind: "blob" },
          signal: controller.signal,
          onProgress: (progress) => {
            if (isCurrent() && !controller.signal.aborted) {
              setArchive({ kind: "running", mode, progress });
            }
          },
        });
        writerHandedOff = true;
        const result = await generated;
        if (!isCurrent() || controller.signal.aborted) return;
        if (result.kind === "blob") downloadBlob(result.blob, result.suggestedName);
        setArchive({ kind: "done", mode, progress: 100 });
      } catch (error) {
        await abortUnusedWriter(error);
        if (!isCurrent()) return;
        if (operation.controller?.signal.aborted) {
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
        if (isCurrent()) archiveOperationRef.current = null;
      }
    },
    [archiveGenerator, buildArchivePlan, downloadBlob],
  );

  const startArchive = useCallback(
    (mode: ProcessingMode): Promise<void> => {
      if (
        mode === "tiktok" &&
        tiktokBatchStatusRef.current !== "settled"
      ) {
        setArchive({
          kind: "error",
          mode,
          progress: 0,
          error:
            tiktokBatchStatusRef.current === "busy"
              ? "La preparación del lote TikTok todavía está en curso."
              : "Prepara el lote TikTok completo antes de descargar su ZIP.",
        });
        return Promise.resolve();
      }

      let writerRequest: Promise<ArchiveWriterRequest>;
      try {
        writerRequest = Promise.resolve(
          requestWriter(
            `${selectionRef.current.archiveBase}-${
              mode === "clean" ? "limpia" : "tiktok"
            }.zip`,
          ),
        );
      } catch (error) {
        writerRequest = Promise.reject(error);
      }

      const previous = archiveOperationRef.current;
      previous?.controller?.abort("El ZIP fue reemplazado por una nueva descarga.");
      const operation: ArchiveOperation = {
        epoch: archiveEpochRef.current + 1,
        controller: null,
      };
      archiveEpochRef.current = operation.epoch;
      archiveOperationRef.current = operation;
      setArchive({ kind: "idle", mode: null, progress: 0 });
      return finishArchive(mode, writerRequest, operation);
    },
    [finishArchive, requestWriter],
  );

  const downloadCleanArchive = useCallback(
    (): Promise<void> => startArchive("clean"),
    [startArchive],
  );

  const downloadTikTokArchive = useCallback(
    (): Promise<void> => startArchive("tiktok"),
    [startArchive],
  );

  const cancelArchive = useCallback((): void => {
    const operation = archiveOperationRef.current;
    if (!operation) return;
    if (operation.controller) {
      operation.controller.abort("El ZIP fue cancelado.");
      setArchive({ kind: "idle", mode: null, progress: 0 });
      return;
    }
    archiveEpochRef.current += 1;
    archiveOperationRef.current = null;
    setArchive({ kind: "idle", mode: null, progress: 0 });
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
    tiktokBatchStatus,
    previewUrls,
    cleanReadyCount,
    tiktokReadyCount,
    ingest,
    setPreviewVisible,
    cancelBatch: batch.cancel,
    retry,
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
