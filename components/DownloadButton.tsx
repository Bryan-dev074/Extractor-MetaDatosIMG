"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface DownloadButtonProps {
  onDownload: () => void;
}

export default function DownloadButton({ onDownload }: DownloadButtonProps) {
  const [done, setDone] = useState(false);

  function handleClick() {
    onDownload();
    setDone(true);
    window.setTimeout(() => setDone(false), 2600);
  }

  return (
    <motion.button
      data-no-ripple
      onClick={handleClick}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      className={`group relative flex w-full items-center justify-center gap-2.5 overflow-hidden rounded-2xl px-6 py-4 font-display text-base font-semibold text-white transition-shadow ${
        done ? "shadow-glow-emerald" : "shadow-glow"
      }`}
    >
      {/* Fondo degradado animado */}
      <span
        className={`absolute inset-0 transition-colors duration-500 ${
          done
            ? "bg-gradient-to-r from-accent-emerald to-emerald-500"
            : "bg-gradient-to-r from-accent-violet via-accent-indigo to-accent-cyan"
        }`}
      />
      {/* Brillo de barrido en hover */}
      {!done && (
        <span className="sheen absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:animate-shimmer group-hover:opacity-100" />
      )}

      <span className="relative z-10 flex items-center gap-2.5">
        <AnimatePresence mode="wait" initial={false}>
          {done ? (
            <motion.span
              key="ok"
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 320, damping: 16 }}
              className="flex items-center gap-2.5"
            >
              <CheckCircle />
              ¡Imagen limpia descargada!
            </motion.span>
          ) : (
            <motion.span
              key="dl"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2.5"
            >
              <DownloadGlyph />
              Descargar imagen limpia
            </motion.span>
          )}
        </AnimatePresence>
      </span>

      {/* Confeti sutil al completar */}
      <AnimatePresence>
        {done && <Sparkles />}
      </AnimatePresence>
    </motion.button>
  );
}

function Sparkles() {
  const bits = Array.from({ length: 10 });
  return (
    <span className="pointer-events-none absolute inset-0">
      {bits.map((_, i) => {
        const angle = (i / bits.length) * Math.PI * 2;
        return (
          <motion.span
            key={i}
            initial={{ opacity: 1, x: "50%", y: "50%", scale: 0 }}
            animate={{
              opacity: 0,
              x: `calc(50% + ${Math.cos(angle) * 90}px)`,
              y: `calc(50% + ${Math.sin(angle) * 40}px)`,
              scale: 1,
            }}
            transition={{ duration: 0.9, ease: "easeOut" }}
            className="absolute h-1.5 w-1.5 rounded-full bg-white"
          />
        );
      })}
    </span>
  );
}

function DownloadGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}
function CheckCircle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}
