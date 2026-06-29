"use client";

import { useCallback, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface DropzoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

const ACCEPTED = ["image/jpeg", "image/png"];

export default function Dropzone({ onFile, disabled }: DropzoneProps) {
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      setError(null);
      const file = files?.[0];
      if (!file) return;
      const okType =
        ACCEPTED.includes(file.type) || /\.(jpe?g|png)$/i.test(file.name);
      if (!okType) {
        setError("Formato no soportado. Usa JPEG o PNG.");
        return;
      }
      onFile(file);
    },
    [onFile],
  );

  return (
    <div className="w-full" data-no-ripple>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!disabled) setDrag(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          setDrag(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!disabled) handleFiles(e.dataTransfer.files);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={`group relative cursor-pointer overflow-hidden rounded-[28px] border-2 border-dashed p-10 text-center transition-colors duration-300 sm:p-16 ${
          drag
            ? "border-accent-cyan bg-accent-cyan/[0.06]"
            : "border-white/15 hover:border-accent-violet/60 hover:bg-white/[0.02]"
        } ${disabled ? "pointer-events-none opacity-50" : ""}`}
      >
        {/* Halo que reacciona al hover/drag */}
        <div
          className={`pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 ${
            drag ? "opacity-100" : "group-hover:opacity-100"
          }`}
          style={{
            background:
              "radial-gradient(420px circle at 50% 0%, rgba(139,92,246,0.16), transparent 60%)",
          }}
        />

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />

        <div className="relative z-10 flex flex-col items-center gap-5">
          <motion.div
            animate={
              drag
                ? { scale: 1.1, rotate: 0 }
                : { scale: 1, y: [0, -6, 0] }
            }
            transition={
              drag
                ? { type: "spring", stiffness: 300, damping: 18 }
                : { duration: 4, repeat: Infinity, ease: "easeInOut" }
            }
            className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-accent-violet/25 to-accent-cyan/15 shadow-glow"
          >
            <UploadGlyph active={drag} />
            <span className="absolute -inset-2 rounded-3xl bg-accent-violet/20 opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100" />
          </motion.div>

          <div className="space-y-2">
            <h3 className="font-display text-xl font-semibold text-white sm:text-2xl">
              {drag ? "Suelta para escanear" : "Arrastra tu imagen aquí"}
            </h3>
            <p className="text-sm text-white/55">
              o{" "}
              <span className="font-medium text-accent-cyan underline-offset-4 group-hover:underline">
                haz clic para seleccionar
              </span>{" "}
              · JPEG o PNG · 100% local, nada se sube a un servidor
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {["C2PA", "Midjourney", "DALL·E", "Firefly", "Nano Banana"].map((t) => (
              <span
                key={t}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/50"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 text-center text-sm font-medium text-accent-rose"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

function UploadGlyph({ active }: { active: boolean }) {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={active ? "text-accent-cyan" : "text-white"}
    >
      <path d="M12 16V4" />
      <path d="m6 10 6-6 6 6" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}
