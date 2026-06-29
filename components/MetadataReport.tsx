"use client";

import { motion } from "framer-motion";
import type { CleanResult, Finding, PreservedItem } from "@/lib/types";
import { formatBytes } from "@/lib/cleaner";

interface MetadataReportProps {
  result: CleanResult;
}

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.1 },
  },
};

const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { ease: [0.22, 1, 0.36, 1], duration: 0.5 } },
};

export default function MetadataReport({ result }: MetadataReportProps) {
  const { findings, preserved, originalSize, cleanedSize, notices, isAi } = result;
  const saved = originalSize - cleanedSize;

  return (
    <div className="space-y-5">
      {/* Resumen */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="grid grid-cols-3 gap-3"
      >
        <Stat
          label="Etiquetas de IA"
          value={`${findings.length}`}
          accent="rose"
          sub="eliminadas"
        />
        <Stat
          label="Datos de calidad"
          value={`${preserved.length}`}
          accent="emerald"
          sub="preservados"
        />
        <Stat
          label="Peso depurado"
          value={saved > 0 ? formatBytes(saved) : "0 B"}
          accent="cyan"
          sub={`${formatBytes(cleanedSize)} final`}
        />
      </motion.div>

      {/* Estado general */}
      <div
        className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm ${
          isAi
            ? "border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald"
            : "border-white/10 bg-white/5 text-white/70"
        }`}
      >
        {isAi ? <ShieldCheck /> : <Info />}
        <span className="font-medium">
          {isAi
            ? "Rastros de IA detectados y eliminados. La imagen ya no se identifica como generada por IA mediante metadatos."
            : "No se encontraron metadatos de IA. La imagen se reempaquetó sin cambios en píxeles ni color."}
        </span>
      </div>

      {/* Eliminados */}
      {findings.length > 0 && (
        <section className="glass p-5">
          <header className="mb-4 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-rose/15 text-accent-rose">
              <TrashGlyph />
            </span>
            <h3 className="font-display text-lg font-semibold text-white">
              Etiquetas de IA eliminadas
            </h3>
          </header>
          <motion.ul
            variants={container}
            initial="hidden"
            animate="show"
            className="space-y-2.5"
          >
            {findings.map((f) => (
              <FindingRow key={f.id} f={f} />
            ))}
          </motion.ul>
        </section>
      )}

      {/* Preservados */}
      <section className="glass p-5">
        <header className="mb-4 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-emerald/15 text-accent-emerald">
            <LockGlyph />
          </span>
          <h3 className="font-display text-lg font-semibold text-white">
            Datos preservados intactos
          </h3>
        </header>
        <motion.ul
          variants={container}
          initial="hidden"
          animate="show"
          className="grid gap-2.5 sm:grid-cols-2"
        >
          {preserved.map((p, i) => (
            <PreservedRow key={i} p={p} />
          ))}
        </motion.ul>
      </section>

      {/* Avisos */}
      {notices.length > 0 && (
        <div className="space-y-2">
          {notices.map((n, i) => (
            <div
              key={i}
              className="flex gap-2.5 rounded-2xl border border-accent-amber/25 bg-accent-amber/[0.07] p-4 text-xs leading-relaxed text-accent-amber/90"
            >
              <span className="mt-0.5 shrink-0">
                <WarnGlyph />
              </span>
              <p>{n}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent: "rose" | "emerald" | "cyan";
}) {
  const color =
    accent === "rose"
      ? "text-accent-rose"
      : accent === "emerald"
        ? "text-accent-emerald"
        : "text-accent-cyan";
  return (
    <motion.div variants={item} className="glass-soft p-3.5 text-center">
      <div className={`font-display text-2xl font-bold ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-white/45">
        {label}
      </div>
      <div className="text-[11px] text-white/35">{sub}</div>
    </motion.div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <motion.li
      variants={item}
      className="group flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 transition-colors hover:border-accent-rose/20 hover:bg-accent-rose/[0.04]"
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent-rose/15 text-accent-rose">
        <XGlyph />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-white">{f.label}</span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-white/45">
            {f.category}
          </span>
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-white/40">{f.source}</div>
        {f.detail && (
          <div className="mt-1 truncate font-mono text-[11px] text-white/30">
            {f.detail}
          </div>
        )}
      </div>
      {typeof f.bytes === "number" && f.bytes > 0 && (
        <span className="shrink-0 self-center font-mono text-[11px] text-accent-rose/70">
          −{formatBytes(f.bytes)}
        </span>
      )}
    </motion.li>
  );
}

function PreservedRow({ p }: { p: PreservedItem }) {
  return (
    <motion.li
      variants={item}
      className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3"
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent-emerald/15 text-accent-emerald">
        <PreservedGlyph kind={p.icon} />
      </span>
      <div className="min-w-0">
        <div className="font-medium text-white">{p.label}</div>
        <div className="text-[12px] text-white/45">{p.detail}</div>
      </div>
    </motion.li>
  );
}

/* ── Iconos ──────────────────────────────────────────────────────────────── */

function PreservedGlyph({ kind }: { kind: PreservedItem["icon"] }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "color":
      return (
        <svg {...common}>
          <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1-.3-.3-.5-.6-.5-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.7-4.5-9-10-9Z" />
        </svg>
      );
    case "resolution":
      return (
        <svg {...common}>
          <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
        </svg>
      );
    case "orientation":
      return (
        <svg {...common}>
          <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.3 2.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      );
    case "dimensions":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18M3 9h18" />
        </svg>
      );
    case "pixels":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
  }
}

function XGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
function TrashGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
function LockGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function ShieldCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M20 13c0 5-3.5 7.5-7.7 9-.2.1-.5.1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7.5-.4 1.1-.4 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
function Info() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}
function WarnGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}
