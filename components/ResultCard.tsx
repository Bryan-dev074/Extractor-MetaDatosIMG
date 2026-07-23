"use client";

import React, { useEffect, useRef } from "react";
import { formatBytes } from "../lib/cleaner";
import type { BatchItem } from "../lib/batch/reducer";

export type TikTokItemState =
  | { status: "idle" }
  | { status: "queued" | "processing" }
  | { status: "ready"; width: number; height: number; size: number }
  | { status: "error"; error: string }
  | { status: "cancelled" };

interface ResultCardProps {
  item: BatchItem;
  previewUrl: string | null;
  tiktok: TikTokItemState;
  onPreviewVisibility(id: string, visible: boolean): void;
  onDownloadClean(id: string): void;
  onGenerateTikTok(id: string): void | Promise<void>;
  onDownloadTikTok(id: string): void;
  onDownloadTikTokPreview(id: string): void;
  onCancelTikTok(id: string): void;
  onRetry(id: string): void;
  onRemove(id: string): void;
}

const STATUS_LABELS: Record<BatchItem["status"], string> = {
  queued: "En cola",
  processing: "Inspeccionando",
  completed: "Limpieza verificada",
  error: "Requiere atención",
  cancelled: "Cancelada",
};

export default function ResultCard({
  item,
  previewUrl,
  tiktok,
  onPreviewVisibility,
  onDownloadClean,
  onGenerateTikTok,
  onDownloadTikTok,
  onDownloadTikTokPreview,
  onCancelTikTok,
  onRetry,
  onRemove,
}: ResultCardProps) {
  const rowRef = useRef<HTMLElement>(null);
  const live = item.status === "queued" || item.status === "processing";
  const completed = item.status === "completed" && item.result;
  const basename = item.relativePath.replace(/\\/g, "/").split("/").at(-1) ?? "imagen";

  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    if (typeof IntersectionObserver !== "function") {
      onPreviewVisibility(item.id, true);
      return () => onPreviewVisibility(item.id, false);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        onPreviewVisibility(item.id, entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "250px 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      onPreviewVisibility(item.id, false);
    };
  }, [item.id, onPreviewVisibility]);

  return (
    <article
      ref={rowRef}
      className={`result-row result-row--${item.status}`}
      aria-busy={live}
    >
      <div className="result-preview" aria-hidden="true">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="" loading="lazy" />
        ) : (
          <span>{item.format.toUpperCase()}</span>
        )}
      </div>

      <div className="result-main">
        <div className="result-path">
          <h3 title={item.relativePath}>{item.relativePath}</h3>
          <span className={`status-badge status-badge--${item.status}`}>
            {STATUS_LABELS[item.status]}
          </span>
        </div>

        <div className="result-evidence">
          <span>{formatBytes(item.file.size)} entrada</span>
          {completed ? (
            <>
              <span>{formatBytes(completed.cleanedSize)} salida</span>
              <span className="proof-text">Píxeles 1:1 · sin recomprimir</span>
              <span className="hash-proof">
                hash {completed.pixelPayloadHash.slice(0, 12)}
              </span>
            </>
          ) : null}
        </div>

        {item.status === "error" ? (
          <div className="result-error" role="alert">
            <strong>No se pudo limpiar {basename}.</strong>
            <span>{item.error ?? "Vuelve a intentarlo."}</span>
          </div>
        ) : null}

        {completed ? (
          <details className="result-details">
            <summary>
              Evidencia de limpieza ({completed.findings.length} hallazgos)
            </summary>
            <div>
              <p>
                {completed.qualityVerified
                  ? "La estructura crítica se releyó y el payload visual coincide."
                  : "La salida no cuenta con verificación de calidad."}
              </p>
              {completed.findings.length > 0 ? (
                <ul>
                  {completed.findings.map((finding) => (
                    <li key={finding.id}>
                      {finding.label} · {finding.source}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No se encontraron etiquetas de IA removibles.</p>
              )}
            </div>
          </details>
        ) : null}
      </div>

      <div className="result-actions">
        {completed ? (
          <>
            <button
              type="button"
              className="control control--proof"
              onClick={() => onDownloadClean(item.id)}
            >
              Descargar limpia
            </button>
            {tiktok.status === "ready" ? (
              <>
                <span className="tiktok-proof">
                  PNG sRGB · anti-parches adaptativo
                  <small>
                    {tiktok.width}×{tiktok.height} · {formatBytes(tiktok.size)}
                  </small>
                </span>
                <button
                  type="button"
                  className="control control--rose"
                  aria-label={`Descargar ${basename} para TikTok`}
                  onClick={() => onDownloadTikTok(item.id)}
                >
                  Descargar TikTok
                </button>
                <button
                  type="button"
                  className="control control--quiet"
                  aria-label={`Descargar vista previa aproximada de ${basename}`}
                  onClick={() => onDownloadTikTokPreview(item.id)}
                >
                  Vista previa JPEG
                </button>
              </>
            ) : tiktok.status === "queued" || tiktok.status === "processing" ? (
              <button
                type="button"
                className="control control--quiet"
                aria-label={`Cancelar preparación TikTok de ${basename}`}
                onClick={() => onCancelTikTok(item.id)}
              >
                {tiktok.status === "queued" ? "Cancelar TikTok en cola" : "Cancelar TikTok"}
              </button>
            ) : (
              <button
                type="button"
                className="control control--rose-secondary"
                aria-label={`Preparar ${basename} para TikTok`}
                onClick={() => void onGenerateTikTok(item.id)}
              >
                Preparar TikTok
              </button>
            )}
          </>
        ) : null}

        {item.status === "error" || item.status === "cancelled" ? (
          <button
            type="button"
            className="control control--secondary"
            onClick={() => onRetry(item.id)}
          >
            Reintentar
          </button>
        ) : null}
        <button
          type="button"
          className="control control--quiet"
          aria-label={`${live ? "Cancelar y quitar" : "Quitar"} ${basename}`}
          onClick={() => onRemove(item.id)}
        >
          {live ? "Cancelar y quitar" : "Quitar"}
        </button>

        {tiktok.status === "error" ? (
          <div className="result-error" role="alert">
            <strong>TikTok no pudo prepararse.</strong>
            <span>{tiktok.error}</span>
          </div>
        ) : null}
      </div>
    </article>
  );
}
