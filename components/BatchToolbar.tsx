"use client";

import React from "react";
import { formatBytes } from "../lib/cleaner";
import type { BatchSummary } from "../lib/batch/reducer";
import type {
  ArchiveWorkspaceState,
  TikTokBatchStatus,
} from "../hooks/useImageWorkspace";

export interface BatchToolbarActions {
  cancelBatch(): void;
  reset(): void;
  prepareTikTok(): void | Promise<void>;
  downloadCleanArchive(): void | Promise<void>;
  downloadTikTokArchive(): void | Promise<void>;
  cancelArchive(): void;
}

interface BatchToolbarProps {
  summary: BatchSummary;
  skipped: number;
  cleanReadyCount: number;
  tiktokReadyCount: number;
  tiktokBatchStatus: TikTokBatchStatus;
  archive: ArchiveWorkspaceState;
  actions: BatchToolbarActions;
}

export default function BatchToolbar({
  summary,
  skipped,
  cleanReadyCount,
  tiktokReadyCount,
  tiktokBatchStatus,
  archive,
  actions,
}: BatchToolbarProps) {
  const live = summary.queued + summary.processing;
  const settled = live === 0;
  const completedPercent =
    summary.total === 0
      ? 0
      : Math.round(
          ((summary.completed + summary.failed + summary.cancelled) / summary.total) *
            100,
        );
  const archiveRunning = archive.kind === "running";
  const tiktokBatchBusy = tiktokBatchStatus === "busy";

  return (
    <section className="batch-toolbar" aria-labelledby="batch-progress-title">
      <div className="batch-toolbar__progress">
        <div className="batch-toolbar__heading">
          <div>
            <p className="eyebrow">Inspección del lote</p>
            <h2 id="batch-progress-title">
              {live > 0 ? "Procesando en el dispositivo" : "Lote inspeccionado"}
            </h2>
          </div>
          <strong className="progress-value">{completedPercent}%</strong>
        </div>
        <progress
          aria-label="Progreso del lote"
          max={summary.total || 1}
          value={summary.completed + summary.failed + summary.cancelled}
        />
        <div className="batch-counters" aria-live="polite">
          <span>En cola {summary.queued}</span>
          <span>Activas {summary.processing}</span>
          <span>Listas {summary.completed}</span>
          <span>Con error {summary.failed}</span>
          <span>Canceladas {summary.cancelled}</span>
          <span>Omitidas {skipped}</span>
          <span>{formatBytes(summary.cleanedBytes)} de salida limpia</span>
        </div>
      </div>

      <div className="output-rails">
        <article className="output-rail output-rail--clean">
          <div className="output-rail__copy">
            <span className="lane-label">Limpia</span>
            <strong>Píxeles 1:1</strong>
            <small>Sin recomprimir · {cleanReadyCount} listas</small>
          </div>
          <button
            type="button"
            className="control control--proof"
            disabled={!settled || cleanReadyCount === 0 || archiveRunning}
            onClick={() => void actions.downloadCleanArchive()}
          >
            Descargar carpeta limpia
          </button>
        </article>

        <article className="output-rail output-rail--tiktok">
          <div className="output-rail__copy">
            <span className="lane-label">TikTok</span>
            <strong>PNG sRGB</strong>
            <small>Anti-parches adaptativo · {tiktokReadyCount} listas</small>
          </div>
          <div className="output-rail__actions">
            <button
              type="button"
              className="control control--rose-secondary"
              disabled={
                !settled ||
                cleanReadyCount === 0 ||
                archiveRunning ||
                tiktokBatchBusy
              }
              aria-busy={tiktokBatchBusy}
              onClick={() => void actions.prepareTikTok()}
            >
              {tiktokBatchBusy
                ? "Preparando lote TikTok…"
                : "Preparar lote TikTok"}
            </button>
            <button
              type="button"
              className="control control--rose"
              disabled={
                tiktokBatchStatus !== "settled" ||
                tiktokReadyCount === 0 ||
                archiveRunning
              }
              onClick={() => void actions.downloadTikTokArchive()}
            >
              Descargar carpeta TikTok
            </button>
          </div>
        </article>
      </div>

      <div className="batch-toolbar__controls">
        {live > 0 ? (
          <button
            type="button"
            className="control control--secondary"
            onClick={actions.cancelBatch}
          >
            Cancelar procesamiento
          </button>
        ) : null}
        <button
          type="button"
          className="control control--quiet"
          onClick={actions.reset}
        >
          Vaciar mesa
        </button>
      </div>

      {archiveRunning ? (
        <div className="archive-progress" aria-live="polite">
          <div>
            <span>
              Escribiendo ZIP {archive.mode === "clean" ? "limpio" : "TikTok"}
            </span>
            <strong>{Math.round(archive.progress)}%</strong>
          </div>
          <progress
            aria-label="Progreso del archivo ZIP"
            max={100}
            value={archive.progress}
          />
          <button
            type="button"
            className="control control--quiet"
            onClick={actions.cancelArchive}
          >
            Cancelar ZIP
          </button>
        </div>
      ) : null}

      {archive.kind === "error" ? (
        <div className="inline-alert" role="alert">
          <strong>No se pudo crear el ZIP.</strong>
          <span>{archive.error}</span>
        </div>
      ) : null}
    </section>
  );
}
