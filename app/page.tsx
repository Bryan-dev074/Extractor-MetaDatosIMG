"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "framer-motion";
import BatchToolbar from "../components/BatchToolbar";
import InteractiveBackground from "../components/InteractiveBackground";
import ResultCard, {
  type TikTokItemState,
} from "../components/ResultCard";
import SourcePicker from "../components/SourcePicker";
import TikTokInfo from "../components/TikTokInfo";
import { useImageWorkspace } from "../hooks/useImageWorkspace";

const INITIAL_ROWS = 60;
const IDLE_TIKTOK: TikTokItemState = { status: "idle" };

export default function Home() {
  const workspace = useImageWorkspace();
  const reduceMotion = useReducedMotion();
  const [visibleRows, setVisibleRows] = useState(INITIAL_ROWS);
  const hasMaterial =
    workspace.batch.items.length > 0 || workspace.skipped.length > 0;
  const shownItems = workspace.batch.items.slice(0, visibleRows);

  useEffect(() => {
    if (!hasMaterial) setVisibleRows(INITIAL_ROWS);
  }, [hasMaterial]);

  const liveCount =
    workspace.batch.summary.queued + workspace.batch.summary.processing;
  const tiktokBusy = Object.values(workspace.tiktokById).some(
    (state) => state.status === "queued" || state.status === "processing",
  );
  const pauseAmbientMotion =
    liveCount > 0 || workspace.archive.kind === "running" || tiktokBusy;
  const resultSummary = useMemo(
    () =>
      `${workspace.batch.summary.completed} listas, ${workspace.batch.summary.failed} con error, ${workspace.skipped.length} omitidas`,
    [
      workspace.batch.summary.completed,
      workspace.batch.summary.failed,
      workspace.skipped.length,
    ],
  );

  return (
    <>
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>
      <InteractiveBackground paused={pauseAmbientMotion} />
      <div className="visual-backdrop" aria-hidden="true">
        <span className="aurora aurora--violet" />
        <span className="aurora aurora--cyan" />
        <span className="aurora aurora--fuchsia" />
        <span className="grid-overlay" />
      </div>
      <div
        className="app-shell"
        data-reduced-motion={reduceMotion ? "true" : "false"}
      >
        <header className="product-header">
          <a className="product-mark" href="#" aria-label="Extractor MetaData, inicio">
            <span className="product-mark__glyph" aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.gif" alt="" />
            </span>
            <span>
              <strong>Extractor MetaData</strong>
              <small>Calidad intacta · privacidad total</small>
            </span>
          </a>
          <div className="header-actions">
            <span className="header-proof">
              <span className="header-proof__signal" aria-hidden="true" />
              100% local
            </span>
            <a
              className="creator-link"
              href="https://github.com/Bryan-dev074"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GithubGlyph />
              <span className="creator-link__prefix">Creado por</span>{" "}
              <strong>Bryan-dev074</strong>
            </a>
          </div>
        </header>

        <main id="contenido" className="workbench">
          <section className="workbench-intro" aria-labelledby="page-title">
            <p className="local-pill">
              <span aria-hidden="true" />
              Procesamiento 100% local · tus imágenes nunca salen del navegador
            </p>
            <h1 id="page-title">
              Quita la etiqueta de <span>IA</span> sin perder
              <br className="desktop-break" /> ni un píxel de calidad
            </h1>
            <p className="hero-copy">
              Limpia imágenes sueltas o una carpeta completa con todas sus
              subcarpetas. Eliminamos rastros de IA de forma quirúrgica, conservando
              intactos el perfil de color, la resolución y los píxeles. Para TikTok,
              Photo Max prepara además un PNG sRGB adaptativo sin cambiar el tamaño.
            </p>
          </section>

          {!hasMaterial ? (
            <div className="empty-workbench">
              <SourcePicker
                onInput={workspace.ingest}
                disabled={!workspace.batch.ready}
              />
              <OutputLegend />
              <TikTokInfo />
              <FeatureRow />
            </div>
          ) : (
            <div className="active-workbench">
              <BatchToolbar
                summary={workspace.batch.summary}
                skipped={workspace.skipped.length}
                cleanReadyCount={workspace.cleanReadyCount}
                tiktokReadyCount={workspace.tiktokReadyCount}
                tiktokBatchStatus={workspace.tiktokBatchStatus}
                archive={workspace.archive}
                actions={{
                  cancelBatch: workspace.cancelBatch,
                  reset: workspace.reset,
                  prepareTikTok: workspace.prepareAllTikTok,
                  downloadCleanArchive: workspace.downloadCleanArchive,
                  downloadTikTokArchive: workspace.downloadTikTokArchive,
                  cancelArchive: workspace.cancelArchive,
                }}
              />

              <aside className="add-source-panel">
                <SourcePicker
                  compact
                  onInput={workspace.ingest}
                  disabled={!workspace.batch.ready}
                />
              </aside>

              {workspace.skipped.length > 0 ? (
                <section className="skipped-panel" aria-labelledby="skipped-title">
                  <div>
                    <p className="eyebrow">Fuera del lote</p>
                    <h2 id="skipped-title">
                      {workspace.skipped.length} archivo
                      {workspace.skipped.length === 1 ? "" : "s"} omitido
                      {workspace.skipped.length === 1 ? "" : "s"}
                    </h2>
                  </div>
                  <ul>
                    {workspace.skipped.map((item, index) => (
                      <li key={`${item.relativePath}-${index}`}>
                        <code>{item.relativePath}</code>
                        <span>{item.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section
                className="results-panel"
                aria-labelledby="results-title"
                aria-busy={liveCount > 0 || tiktokBusy}
              >
                <div className="results-panel__heading">
                  <div>
                    <p className="eyebrow">Prueba por archivo</p>
                    <h2 id="results-title">Rutas y resultados</h2>
                  </div>
                  <p className="results-summary" aria-live="polite">
                    {resultSummary}
                  </p>
                </div>

                <div
                  className={`result-list ${
                    workspace.batch.items.length >= 4
                      ? "result-list--dense"
                      : "result-list--showcase"
                  }`}
                >
                  {shownItems.map((item) => {
                    const tiktok =
                      (workspace.tiktokById[item.id] as TikTokItemState | undefined) ??
                      IDLE_TIKTOK;
                    return (
                      <ResultCard
                        key={item.id}
                        item={item}
                        previewUrl={workspace.previewUrls[item.id] ?? null}
                        tiktok={tiktok}
                        onPreviewVisibility={workspace.setPreviewVisible}
                        onDownloadClean={workspace.downloadClean}
                        onGenerateTikTok={workspace.generateTikTok}
                        onDownloadTikTok={workspace.downloadTikTok}
                        onDownloadTikTokPreview={workspace.downloadTikTokPreview}
                        onCancelTikTok={workspace.cancelTikTok}
                        onRetry={workspace.retry}
                        onRemove={workspace.remove}
                      />
                    );
                  })}
                </div>

                {visibleRows < workspace.batch.items.length ? (
                  <button
                    type="button"
                    className="control control--secondary load-more"
                    onClick={() => setVisibleRows((count) => count + INITIAL_ROWS)}
                  >
                    Mostrar 60 resultados más
                  </button>
                ) : null}
              </section>

              <TikTokInfo />
            </div>
          )}
        </main>

        <footer className="product-footer">
          <p>
            JPEG y PNG · limpieza estructural local · las marcas incrustadas en
            píxeles no son metadatos.
          </p>
          <a
            href="https://github.com/Bryan-dev074"
            target="_blank"
            rel="noopener noreferrer"
          >
            Bryan-dev074
          </a>
        </footer>
      </div>
    </>
  );
}

function OutputLegend() {
  return (
    <section className="output-legend" aria-label="Dos tipos de salida">
      <article>
        <span className="legend-icon legend-icon--clean" aria-hidden="true">
          <ShieldGlyph />
        </span>
        <span className="lane-label">Limpia</span>
        <strong>Píxeles 1:1</strong>
        <small>Sin recomprimir · metadatos fuera, calidad intacta</small>
      </article>
      <article>
        <span className="legend-icon legend-icon--tiktok" aria-hidden="true">
          <TikTokGlyph />
        </span>
        <span className="lane-label">TikTok</span>
        <strong>PNG sRGB</strong>
        <small>Anti-parches adaptativo · tamaño nativo</small>
      </article>
    </section>
  );
}

function FeatureRow() {
  const features = [
    {
      icon: <ByteGlyph />,
      title: "Cirugía a nivel de bytes",
      description: "Sin decodificar ni recomprimir: los píxeles quedan idénticos.",
    },
    {
      icon: <FolderGlyph />,
      title: "Carpetas completas",
      description: "Conserva nombres, rutas y subcarpetas dentro del ZIP final.",
    },
    {
      icon: <LockGlyph />,
      title: "Privado por diseño",
      description: "Todo ocurre en tu dispositivo. Nada se sube a un servidor.",
    },
  ];

  return (
    <section className="feature-row" aria-label="Ventajas">
      {features.map((feature) => (
        <article key={feature.title}>
          <span aria-hidden="true">{feature.icon}</span>
          <h2>{feature.title}</h2>
          <p>{feature.description}</p>
        </article>
      ))}
    </section>
  );
}

function GithubGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.57 2.34 1.12 2.91.85.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05A9.3 9.3 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.81c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

function ShieldGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 3 4.5 6v5.5c0 4.6 2.9 7.7 7.5 9.5 4.6-1.8 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="m8.5 12 2.2 2.2 4.8-5" />
    </svg>
  );
}

function TikTokGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <path
        fill="currentColor"
        stroke="none"
        d="M16.5 3c.3 2.1 1.6 3.6 3.5 3.9v2.6c-1.3.1-2.5-.3-3.5-1v5.9c0 3.6-2.6 6.1-5.9 6.1-3 0-5.3-2.3-5.3-5.2 0-3 2.4-5.2 5.4-5.2.3 0 .6 0 .9.1v2.7c-.3-.1-.6-.1-.9-.1-1.4 0-2.5 1-2.5 2.4s1.1 2.5 2.5 2.5c1.5 0 2.6-1.1 2.6-2.9V3h2.7Z"
      />
    </svg>
  );
}

function ByteGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M14.5 3.5 21 10 10.5 20.5 4 14zM3 21l3-1M13 6l5 5" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M3 7.5h6l2-2h10v13H3z" />
      <path d="M3 9.5h18" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
