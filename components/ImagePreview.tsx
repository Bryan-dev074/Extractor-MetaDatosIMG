"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";

interface ImagePreviewProps {
  src: string;
  scanning: boolean;
  done: boolean;
  /** Etiquetas detectadas, para el "readout" del escáner. */
  readout: string[];
}

export default function ImagePreview({
  src,
  scanning,
  done,
  readout,
}: ImagePreviewProps) {
  // Stream incremental de líneas del readout durante el escaneo.
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    if (!scanning) {
      setVisibleLines(readout.length);
      return;
    }
    setVisibleLines(0);
    const id = setInterval(() => {
      setVisibleLines((n) => Math.min(n + 1, readout.length));
    }, 420);
    return () => clearInterval(id);
  }, [scanning, readout.length]);

  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-black/40">
      {/* Imagen */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Vista previa de la imagen"
        className="block max-h-[460px] w-full object-contain"
      />

      {/* Capa de barrido + grid + láser durante el escaneo */}
      <AnimatePresence>
        {scanning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0"
          >
            {/* Rejilla técnica */}
            <div
              className="absolute inset-0 opacity-40"
              style={{
                backgroundImage:
                  "linear-gradient(rgba(34,211,238,0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.18) 1px, transparent 1px)",
                backgroundSize: "26px 26px",
                maskImage:
                  "linear-gradient(180deg, transparent, black 20%, black 80%, transparent)",
              }}
            />

            {/* Tinte de escaneo */}
            <div className="absolute inset-0 bg-accent-cyan/5" />

            {/* Línea láser que sube y baja */}
            <motion.div
              initial={{ top: "0%" }}
              animate={{ top: ["0%", "100%", "0%"] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
              className="absolute left-0 right-0"
            >
              <div className="relative">
                {/* Resplandor difuso */}
                <div className="absolute -top-12 left-0 right-0 h-24 bg-gradient-to-b from-transparent via-accent-cyan/30 to-transparent blur-md" />
                {/* Filo del láser */}
                <div className="h-[2px] w-full bg-accent-cyan shadow-[0_0_18px_4px_rgba(34,211,238,0.8)]" />
                {/* Reflejo superior */}
                <div className="h-[1px] w-full bg-white/70" />
              </div>
            </motion.div>

            {/* Esquinas de "mira" */}
            <Corners />

            {/* Readout de metadatos detectados */}
            <div className="absolute bottom-3 left-3 right-3 max-h-[55%] overflow-hidden">
              <div className="space-y-1 font-mono text-[11px] leading-relaxed">
                <p className="text-accent-cyan/90">
                  <span className="text-white/40">▸</span> ESCANEANDO METADATOS…
                </p>
                <AnimatePresence>
                  {readout.slice(0, visibleLines).map((line, i) => (
                    <motion.p
                      key={line + i}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="text-accent-rose/90"
                    >
                      <span className="text-accent-rose">✕</span> PURGANDO ·{" "}
                      <span className="text-white/80">{line}</span>
                    </motion.p>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Barrido verde de éxito */}
      <AnimatePresence>
        {done && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0] }}
            transition={{ duration: 1.1, ease: "easeOut" }}
            className="pointer-events-none absolute inset-0"
          >
            <motion.div
              initial={{ top: "-10%" }}
              animate={{ top: "110%" }}
              transition={{ duration: 1, ease: "easeOut" }}
              className="absolute left-0 right-0 h-24 bg-gradient-to-b from-transparent via-accent-emerald/40 to-transparent blur-sm"
            />
            <div className="absolute inset-0 ring-2 ring-inset ring-accent-emerald/40" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sello "LIMPIA" tras finalizar */}
      <AnimatePresence>
        {done && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ delay: 0.5, type: "spring", stiffness: 260, damping: 18 }}
            className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full border border-accent-emerald/40 bg-accent-emerald/15 px-3 py-1 text-xs font-semibold text-accent-emerald backdrop-blur-md"
          >
            <CheckGlyph /> Limpia
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Corners() {
  const base =
    "absolute h-6 w-6 border-accent-cyan/80";
  return (
    <>
      <span className={`${base} left-3 top-3 border-l-2 border-t-2`} />
      <span className={`${base} right-3 top-3 border-r-2 border-t-2`} />
      <span className={`${base} bottom-3 left-3 border-b-2 border-l-2`} />
      <span className={`${base} bottom-3 right-3 border-b-2 border-r-2`} />
    </>
  );
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
