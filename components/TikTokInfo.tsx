"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export default function TikTokInfo() {
  const [open, setOpen] = useState(false);

  return (
    <div className="glass overflow-hidden" data-no-ripple>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-white/[0.02]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-fuchsia/25 to-accent-cyan/15 text-white">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16.5 3c.3 2.1 1.6 3.6 3.5 3.9v2.6c-1.3.1-2.5-.3-3.5-1v5.9c0 3.6-2.6 6.1-5.9 6.1-3 0-5.3-2.3-5.3-5.2 0-3 2.4-5.2 5.4-5.2.3 0 .6 0 .9.1v2.7c-.3-.1-.6-.1-.9-.1-1.4 0-2.5 1-2.5 2.4s1.1 2.5 2.5 2.5c1.5 0 2.6-1.1 2.6-2.9V3h2.7Z" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-sm font-semibold text-white">
            ¿Por qué TikTok baja la calidad (y no Instagram)?
          </h3>
          <p className="truncate text-xs text-white/45">
            La explicación honesta y cómo minimizarlo
          </p>
        </div>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="text-white/40">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-4 border-t border-white/5 p-4 text-sm leading-relaxed text-white/65">
              <p>
                No son los metadatos. El <strong className="text-white">“Photo Mode”</strong> de
                TikTok recomprime cada imagen <strong className="text-white">en su servidor apuntando a
                ~100&nbsp;KB por foto</strong> para que el carrusel cargue rápido en redes lentas.
                Es muchísimo más agresivo que Instagram (que permite ~1.5&nbsp;MB y gestiona el
                color), por eso en IG se ve perfecta y en TikTok no. Esa recompresión ocurre del
                lado de TikTok y <strong className="text-white">ninguna limpieza de metadatos la
                evita</strong>.
              </p>

              <div>
                <p className="mb-2 font-medium text-white/80">
                  Lo único que sí ayuda: darle a TikTok el mejor origen posible
                </p>
                <ul className="space-y-2">
                  <Tip>
                    Sube a <strong className="text-white">1080 × 1920&nbsp;px (9:16)</strong> exactos.
                    Así TikTok se salta su reescalado —la principal causa del emborronado— y solo
                    aplica su pase de compresión.
                  </Tip>
                  <Tip>
                    Usa <strong className="text-white">sRGB</strong>. TikTok no gestiona bien perfiles
                    de gama amplia (Display P3 / Adobe RGB) y los muestra apagados.
                  </Tip>
                  <Tip>
                    Parte de <strong className="text-white">alta calidad</strong>: cuanto mejor el
                    origen, más limpio queda tras su compresión obligatoria.
                  </Tip>
                  <Tip>
                    Evita subir PNG enormes: TikTok los convertirá a JPEG y recomprimirá igual.
                  </Tip>
                </ul>
              </div>

              <div className="rounded-xl border border-accent-cyan/20 bg-accent-cyan/[0.06] p-3 text-[13px] text-white/75">
                <span className="font-semibold text-accent-cyan">Botón “TikTok” en cada imagen →</span>{" "}
                genera justo eso: una copia recodificada a 1080p, en sRGB y alta calidad, lista para
                subir. (La descarga “Limpia” sigue siendo la versión sin pérdida para Instagram y
                demás.)
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-emerald/15 text-accent-emerald">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  );
}
