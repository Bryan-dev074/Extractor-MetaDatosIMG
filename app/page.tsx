"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import InteractiveBackground from "@/components/InteractiveBackground";
import Dropzone from "@/components/Dropzone";
import ImagePreview from "@/components/ImagePreview";
import MetadataReport from "@/components/MetadataReport";
import DownloadButton from "@/components/DownloadButton";
import { cleanImage, cleanFileName, formatBytes } from "@/lib/cleaner";
import type { CleanResult } from "@/lib/types";

type Status = "idle" | "processing" | "done";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<CleanResult | null>(null);
  const [readout, setReadout] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Limpia el object URL al desmontar.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(file);
      });
      setFileName(file.name);
      setResult(null);
      setReadout([]);
      setStatus("processing");

      try {
        const res = await cleanImage(file);
        setResult(res);
        setReadout(
          res.findings.length
            ? res.findings.map((f) => f.label)
            : ["Sin etiquetas de IA · reempaquetando intacto"],
        );
        const dur = Math.min(3200, 1200 + res.findings.length * 420);
        await delay(dur);
        setStatus("done");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error al procesar la imagen.");
        setStatus("idle");
      }
    },
    [],
  );

  const download = useCallback(() => {
    if (!result) return;
    const blob = new Blob([result.cleaned as BlobPart], { type: result.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = cleanFileName(fileName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }, [result, fileName]);

  const reset = useCallback(() => {
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setResult(null);
    setStatus("idle");
    setReadout([]);
    setError(null);
    setFileName("");
  }, []);

  const working = status !== "idle";

  return (
    <main className="relative min-h-screen overflow-hidden">
      <InteractiveBackground />

      {/* Auroras de gradiente (capa CSS) */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-32 -top-40 h-[36rem] w-[36rem] animate-aurora rounded-full bg-accent-violet/20 blur-[120px]" />
        <div className="absolute -right-40 top-20 h-[34rem] w-[34rem] animate-aurora-slow rounded-full bg-accent-cyan/15 blur-[120px]" />
        <div className="absolute bottom-[-12rem] left-1/3 h-[32rem] w-[32rem] animate-aurora rounded-full bg-accent-fuchsia/15 blur-[120px]" />
      </div>

      {/* Rejilla tenue */}
      <div
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage: "radial-gradient(circle at 50% 30%, black, transparent 75%)",
        }}
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-8 sm:px-8">
        <Header />

        {/* Hero */}
        <section className="mx-auto mt-10 max-w-3xl text-center sm:mt-16">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-medium text-white/60 backdrop-blur-md">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-emerald opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-emerald" />
              </span>
              Procesamiento 100% local · tus imágenes nunca salen del navegador
            </div>
            <h1 className="font-display text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-6xl">
              Quita la etiqueta de{" "}
              <span className="text-gradient">IA</span> sin perder
              <br className="hidden sm:block" /> ni un píxel de calidad
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base text-white/55 sm:text-lg">
              Elimina de forma quirúrgica los rastros de IA —manifiestos{" "}
              <span className="text-white/80">C2PA</span>, metadatos{" "}
              <span className="text-white/80">XMP / EXIF</span> de Midjourney,
              DALL·E, Firefly, Nano Banana…— conservando intactos el{" "}
              <span className="text-white/80">perfil de color ICC</span>, la{" "}
              <span className="text-white/80">resolución</span> y los píxeles. Para que
              en redes se vea perfecta.
            </p>
          </motion.div>
        </section>

        {/* Zona de trabajo */}
        <section className="mx-auto mt-10 w-full max-w-5xl flex-1 pb-12 sm:mt-14">
          <AnimatePresence mode="wait">
            {!working ? (
              <motion.div
                key="drop"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.4 }}
                className="mx-auto max-w-2xl"
              >
                <Dropzone onFile={handleFile} />
                {error && (
                  <p className="mt-4 text-center text-sm font-medium text-accent-rose">
                    {error}
                  </p>
                )}
                <FeatureRow />
              </motion.div>
            ) : (
              <motion.div
                key="work"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5 }}
                className="grid gap-6 lg:grid-cols-2"
              >
                {/* Columna izquierda: preview + acciones */}
                <div className="space-y-4">
                  {previewUrl && (
                    <ImagePreview
                      src={previewUrl}
                      scanning={status === "processing"}
                      done={status === "done"}
                      readout={readout}
                    />
                  )}

                  {result && status === "done" && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2 }}
                      className="space-y-3"
                    >
                      <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm">
                        <span className="truncate font-mono text-white/50">
                          {cleanFileName(fileName)}
                        </span>
                        <span className="shrink-0 font-mono text-white/40">
                          {formatBytes(result.originalSize)} →{" "}
                          <span className="text-accent-emerald">
                            {formatBytes(result.cleanedSize)}
                          </span>
                        </span>
                      </div>
                      <DownloadButton onDownload={download} />
                      <button
                        data-no-ripple
                        onClick={reset}
                        className="w-full rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-3 text-sm font-medium text-white/60 transition-colors hover:border-white/20 hover:text-white"
                      >
                        Procesar otra imagen
                      </button>
                    </motion.div>
                  )}
                </div>

                {/* Columna derecha: estado / reporte */}
                <div>
                  {status === "processing" && <ScanningPanel name={fileName} />}
                  {status === "done" && result && <MetadataReport result={result} />}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        <Footer />
      </div>
    </main>
  );
}

/* ── Cabecera ────────────────────────────────────────────────────────────── */
function Header() {
  return (
    <header className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative flex h-11 w-11 items-center justify-center">
          {/* Halo rosa que late, a juego con la Kitty */}
          <motion.span
            aria-hidden
            animate={{ opacity: [0.4, 0.85, 0.4], scale: [1, 1.15, 1] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
            className="absolute -inset-1 rounded-2xl bg-accent-fuchsia/45 blur-lg"
          />
          {/* Logo: gif animado en loop con flotación sutil */}
          <motion.div
            animate={{ y: [0, -2.5, 0] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            className="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl border border-white/20 bg-white shadow-glow"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.gif"
              alt="SKY logo"
              className="h-full w-full object-contain"
            />
          </motion.div>
        </div>
        <div>
          <div className="font-display text-lg font-bold tracking-tight text-white">
            SKY
          </div>
          <div className="-mt-1 text-[11px] text-white/40">Metadata Cleaner</div>
        </div>
      </div>
      <a
        href="https://github.com/Bryan-dev074"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/70 transition-colors hover:border-white/20 hover:text-white"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.57 2.34 1.12 2.91.85.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05A9.3 9.3 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.81c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
        </svg>
        <span className="hidden sm:inline">GitHub</span>
      </a>
    </header>
  );
}

/* ── Panel mientras escanea ──────────────────────────────────────────────── */
function ScanningPanel({ name }: { name: string }) {
  return (
    <div className="glass flex h-full min-h-[260px] flex-col items-center justify-center gap-5 p-8 text-center">
      <div className="relative h-16 w-16">
        <span className="absolute inset-0 animate-spin-slow rounded-full border-2 border-transparent border-t-accent-violet border-r-accent-cyan" />
        <span className="absolute inset-2 animate-spin-slow rounded-full border-2 border-transparent border-b-accent-fuchsia [animation-direction:reverse]" />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent-cyan shadow-glow-cyan" />
        </span>
      </div>
      <div>
        <p className="font-display text-lg font-semibold text-white">
          Análisis quirúrgico en curso
        </p>
        <p className="mt-1 max-w-xs font-mono text-xs text-white/45">
          Inspeccionando segmentos · {name}
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        {["Lectura de bytes", "Detección de firmas de IA", "Purga selectiva", "Preservando ICC + resolución"].map(
          (s, i) => (
            <motion.div
              key={s}
              initial={{ opacity: 0.3 }}
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.3 }}
              className="flex items-center gap-2 text-left font-mono text-xs text-white/60"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-accent-cyan" />
              {s}
            </motion.div>
          ),
        )}
      </div>
    </div>
  );
}

/* ── Fila de características (estado idle) ────────────────────────────────── */
function FeatureRow() {
  const feats = [
    {
      title: "Cirugía a nivel de bytes",
      desc: "Sin decodificar ni recomprimir: los píxeles quedan idénticos.",
      icon: (
        <path d="M14.5 3.5 21 10 10.5 20.5 4 14zM3 21l3-1M13 6l5 5" />
      ),
    },
    {
      title: "Calidad para redes",
      desc: "Conserva ICC, resolución y orientación → sin colores lavados.",
      icon: <path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19" />,
    },
    {
      title: "Privado por diseño",
      desc: "Todo ocurre en tu dispositivo. Nada se sube a ningún servidor.",
      icon: (
        <>
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </>
      ),
    },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3, duration: 0.6 }}
      className="mt-10 grid gap-4 sm:grid-cols-3"
    >
      {feats.map((f) => (
        <div
          key={f.title}
          className="glass-soft group p-5 transition-colors hover:border-white/20"
        >
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-accent-violet/20 to-accent-cyan/15 text-accent-cyan">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {f.icon}
            </svg>
          </span>
          <h4 className="font-display text-sm font-semibold text-white">{f.title}</h4>
          <p className="mt-1 text-xs leading-relaxed text-white/50">{f.desc}</p>
        </div>
      ))}
    </motion.div>
  );
}

/* ── Pie ─────────────────────────────────────────────────────────────────── */
function Footer() {
  return (
    <footer className="mt-auto border-t border-white/5 pt-6 text-center text-xs text-white/35">
      <p>
        SKY limpia metadatos de IA preservando la calidad. No elimina marcas de agua
        invisibles a nivel de píxel (p. ej. SynthID). Procesamiento 100% en el navegador.
      </p>
    </footer>
  );
}
