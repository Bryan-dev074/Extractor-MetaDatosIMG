"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { CleanResult } from "@/lib/types";
import { cleanFileName, formatBytes } from "@/lib/cleaner";
import { optimizeForSocial, tiktokFileName } from "@/lib/optimize";

export interface BatchItem {
  id: string;
  file: File;
  name: string;
  previewUrl: string;
  status: "processing" | "done" | "error";
  result?: CleanResult;
  readout: string[];
  error?: string;
}

interface ResultCardProps {
  item: BatchItem;
  index: number;
  onDownload: (item: BatchItem) => void;
  onRemove: (id: string) => void;
}

export default function ResultCard({ item, index, onDownload, onRemove }: ResultCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [ttState, setTtState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [ttInfo, setTtInfo] = useState<string>("");

  const scanning = item.status === "processing";
  const done = item.status === "done";
  const res = item.result;

  async function handleTikTok() {
    if (!res) return;
    setTtState("working");
    try {
      const out = await optimizeForSocial(res.cleaned, res.mime);
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = tiktokFileName(item.name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setTtInfo(`${out.width}×${out.height} · ${formatBytes(out.size)}`);
      setTtState("done");
      window.setTimeout(() => setTtState("idle"), 2600);
    } catch {
      setTtState("error");
      window.setTimeout(() => setTtState("idle"), 2600);
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: index * 0.04 }}
      className="glass flex flex-col overflow-hidden"
    >
      {/* Miniatura + escáner */}
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-black/40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.previewUrl}
          alt={item.name}
          className="h-full w-full object-contain"
        />

        {/* Botón quitar */}
        <button
          data-no-ripple
          onClick={() => onRemove(item.id)}
          aria-label="Quitar"
          className="absolute right-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/70 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <CompactScanner scanning={scanning} readout={item.readout} />

        {/* Barrido de éxito */}
        <AnimatePresence>
          {done && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 1, 0] }}
              transition={{ duration: 1, ease: "easeOut" }}
              className="pointer-events-none absolute inset-0"
            >
              <motion.div
                initial={{ top: "-10%" }}
                animate={{ top: "110%" }}
                transition={{ duration: 0.9, ease: "easeOut" }}
                className="absolute left-0 right-0 h-16 bg-gradient-to-b from-transparent via-accent-emerald/40 to-transparent blur-sm"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Badge de estado */}
        <AnimatePresence>
          {done && res && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.35, type: "spring", stiffness: 260, damping: 18 }}
              className={`absolute left-2 top-2 flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold backdrop-blur-md ${
                res.isAi
                  ? "border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald"
                  : "border-white/15 bg-white/10 text-white/80"
              }`}
            >
              {res.isAi ? (
                <>
                  <Check /> {res.findings.length} etiqueta{res.findings.length !== 1 ? "s" : ""} IA
                </>
              ) : (
                <>Sin IA</>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Cuerpo */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-white" title={item.name}>
              {item.name}
            </span>
            {res && (
              <span className="shrink-0 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] uppercase text-white/45">
                {res.format}
              </span>
            )}
          </div>
          {res && (
            <div className="mt-0.5 font-mono text-[11px] text-white/40">
              {formatBytes(res.originalSize)} →{" "}
              <span className="text-accent-emerald">{formatBytes(res.cleanedSize)}</span>
            </div>
          )}
          {item.status === "error" && (
            <div className="mt-0.5 text-[12px] text-accent-rose">{item.error}</div>
          )}
          {scanning && (
            <div className="mt-0.5 font-mono text-[11px] text-accent-cyan/80">
              Escaneando metadatos…
            </div>
          )}
        </div>

        {done && res && (
          <>
            <div className="flex gap-2">
              <button
                data-no-ripple
                onClick={() => onDownload(item)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-accent-violet to-accent-cyan px-3 py-2 text-sm font-semibold text-white shadow-glow transition-transform hover:scale-[1.02] active:scale-95"
              >
                <Download /> Limpia
              </button>
              <button
                data-no-ripple
                onClick={handleTikTok}
                disabled={ttState === "working"}
                title="Versión recodificada a 1080p sRGB, optimizada para TikTok"
                className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                  ttState === "done"
                    ? "border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald"
                    : "border-white/12 bg-white/5 text-white/70 hover:border-white/25 hover:text-white"
                }`}
              >
                {ttState === "working" ? (
                  <Spinner />
                ) : ttState === "done" ? (
                  <Check />
                ) : (
                  <TikTokGlyph />
                )}
                <span className="hidden sm:inline">TikTok</span>
              </button>
            </div>

            {ttState === "done" && ttInfo && (
              <p className="-mt-1 text-center font-mono text-[10px] text-accent-emerald/80">
                Optimizada · {ttInfo}
              </p>
            )}
            {ttState === "error" && (
              <p className="-mt-1 text-center text-[10px] text-accent-rose">
                No se pudo optimizar esta imagen.
              </p>
            )}

            <button
              data-no-ripple
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center justify-center gap-1 text-xs font-medium text-white/45 transition-colors hover:text-white/80"
            >
              {expanded ? "Ocultar detalles" : "Ver detalles"}
              <motion.span animate={{ rotate: expanded ? 180 : 0 }}>
                <Chevron />
              </motion.span>
            </button>

            <AnimatePresence initial={false}>
              {expanded && <Details result={res} />}
            </AnimatePresence>
          </>
        )}
      </div>
    </motion.div>
  );
}

/* ── Detalles compactos ──────────────────────────────────────────────────── */
function Details({ result }: { result: CleanResult }) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="overflow-hidden"
    >
      <div className="space-y-3 pt-1">
        {result.findings.length > 0 && (
          <div>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-rose/80">
              <Trash /> Eliminado
            </h4>
            <ul className="space-y-1">
              {result.findings.map((f) => (
                <li key={f.id} className="flex items-start gap-1.5 text-[12px] text-white/70">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent-rose" />
                  <span className="min-w-0">
                    <span className="text-white/85">{f.label}</span>{" "}
                    <span className="font-mono text-[10px] text-white/35">· {f.source}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent-emerald/80">
            <Lock /> Preservado
          </h4>
          <ul className="space-y-1">
            {result.preserved.map((p, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-white/70">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent-emerald" />
                <span className="min-w-0">
                  <span className="text-white/85">{p.label}</span>{" "}
                  <span className="text-[11px] text-white/40">— {p.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        {result.notices.map((n, i) => (
          <p
            key={i}
            className="rounded-lg border border-accent-amber/25 bg-accent-amber/[0.07] p-2 text-[11px] leading-relaxed text-accent-amber/90"
          >
            {n}
          </p>
        ))}
      </div>
    </motion.div>
  );
}

/* ── Escáner compacto ────────────────────────────────────────────────────── */
function CompactScanner({ scanning, readout }: { scanning: boolean; readout: string[] }) {
  const [lines, setLines] = useState(0);
  useEffect(() => {
    if (!scanning) return;
    setLines(0);
    const id = setInterval(() => setLines((n) => Math.min(n + 1, readout.length)), 380);
    return () => clearInterval(id);
  }, [scanning, readout.length]);

  return (
    <AnimatePresence>
      {scanning && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="pointer-events-none absolute inset-0"
        >
          <div
            className="absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                "linear-gradient(rgba(34,211,238,0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.16) 1px, transparent 1px)",
              backgroundSize: "20px 20px",
              maskImage: "linear-gradient(180deg, transparent, black 20%, black 80%, transparent)",
            }}
          />
          <div className="absolute inset-0 bg-accent-cyan/5" />
          <motion.div
            initial={{ top: "0%" }}
            animate={{ top: ["0%", "100%", "0%"] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            className="absolute left-0 right-0"
          >
            <div className="absolute -top-8 left-0 right-0 h-16 bg-gradient-to-b from-transparent via-accent-cyan/25 to-transparent blur-md" />
            <div className="h-[2px] w-full bg-accent-cyan shadow-[0_0_14px_3px_rgba(34,211,238,0.75)]" />
          </motion.div>
          <span className="absolute left-2 top-2 h-4 w-4 border-l-2 border-t-2 border-accent-cyan/70" />
          <span className="absolute right-2 top-2 h-4 w-4 border-r-2 border-t-2 border-accent-cyan/70" />
          <span className="absolute bottom-2 left-2 h-4 w-4 border-b-2 border-l-2 border-accent-cyan/70" />
          <span className="absolute bottom-2 right-2 h-4 w-4 border-b-2 border-r-2 border-accent-cyan/70" />
          <div className="absolute bottom-2 left-2 right-2 max-h-[50%] space-y-0.5 overflow-hidden font-mono text-[10px] leading-tight">
            {readout.slice(0, lines).map((l, i) => (
              <motion.p
                key={l + i}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                className="truncate text-accent-rose/90"
              >
                <span className="text-accent-rose">✕</span>{" "}
                <span className="text-white/80">{l}</span>
              </motion.p>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Iconos ──────────────────────────────────────────────────────────────── */
function Download() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
    </svg>
  );
}
function Check() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function Trash() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
function Lock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
function TikTokGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.5 3c.3 2.1 1.6 3.6 3.5 3.9v2.6c-1.3.1-2.5-.3-3.5-1v5.9c0 3.6-2.6 6.1-5.9 6.1-3 0-5.3-2.3-5.3-5.2 0-3 2.4-5.2 5.4-5.2.3 0 .6 0 .9.1v2.7c-.3-.1-.6-.1-.9-.1-1.4 0-2.5 1-2.5 2.4s1.1 2.5 2.5 2.5c1.5 0 2.6-1.1 2.6-2.9V3h2.7Z" />
    </svg>
  );
}
