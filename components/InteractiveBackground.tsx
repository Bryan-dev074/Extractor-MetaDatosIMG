"use client";

import { useEffect, useRef } from "react";

/* ──────────────────────────────────────────────────────────────────────────
 * Fondo interactivo:
 *   · Malla de nodos conectados (constelación) en canvas, ~60fps.
 *   · Parallax suave que sigue el mouse.
 *   · Ondas/pulsos al hacer clic en zonas vacías (empuja los nodos cercanos).
 *   · "Auroras" de gradiente que derivan (capa CSS, ver page).
 * Todo el dibujo pesado va en canvas para no castigar el render de React.
 * ────────────────────────────────────────────────────────────────────────── */

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hue: number;
}

interface Ripple {
  x: number;
  y: number;
  radius: number;
  max: number;
  life: number; // 1 → 0
}

const PALETTE = [262, 250, 190, 300]; // violeta, índigo, cian, fucsia (HSL hue)

export default function InteractiveBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const context = canvasEl.getContext("2d", { alpha: true });
    if (!context) return;
    // Alias con tipo no-nulo para usarlos dentro de los closures (rAF/listeners),
    // donde el control-flow narrowing de TS no se conserva.
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = context;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let nodes: Node[] = [];
    const ripples: Ripple[] = [];

    // Posición real y suavizada del puntero (para parallax).
    const mouse = { x: -9999, y: -9999 };
    const parallax = { x: 0, y: 0, tx: 0, ty: 0 };

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const density = Math.min(110, Math.floor((width * height) / 16000));
      nodes = Array.from({ length: density }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.6 + 0.6,
        hue: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      }));
    }

    const LINK = 140; // distancia máxima de enlace

    function step() {
      ctx.clearRect(0, 0, width, height);

      // Suavizado del parallax.
      parallax.x += (parallax.tx - parallax.x) * 0.06;
      parallax.y += (parallax.ty - parallax.y) * 0.06;

      // Actualizar ondas.
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.radius += (rp.max - rp.radius) * 0.06;
        rp.life -= 0.012;
        if (rp.life <= 0) ripples.splice(i, 1);
      }

      // Mover nodos + reacción a ondas y al puntero.
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;

        // Rebote en bordes.
        if (n.x < 0 || n.x > width) n.vx *= -1;
        if (n.y < 0 || n.y > height) n.vy *= -1;

        // Empuje de las ondas.
        for (const rp of ripples) {
          const dx = n.x - rp.x;
          const dy = n.y - rp.y;
          const dist = Math.hypot(dx, dy) || 1;
          const band = Math.abs(dist - rp.radius);
          if (band < 60) {
            const force = ((60 - band) / 60) * rp.life * 0.9;
            n.vx += (dx / dist) * force;
            n.vy += (dy / dist) * force;
          }
        }

        // Fricción para que no se aceleren sin control.
        n.vx *= 0.985;
        n.vy *= 0.985;
        const sp = Math.hypot(n.vx, n.vy);
        if (sp > 1.4) {
          n.vx = (n.vx / sp) * 1.4;
          n.vy = (n.vy / sp) * 1.4;
        }
      }

      // Dibujar enlaces.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const ax = a.x + parallax.x * (a.r * 0.5);
        const ay = a.y + parallax.y * (a.r * 0.5);
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < LINK) {
            const bx = b.x + parallax.x * (b.r * 0.5);
            const by = b.y + parallax.y * (b.r * 0.5);
            const alpha = (1 - d / LINK) * 0.22;
            ctx.strokeStyle = `hsla(${(a.hue + b.hue) / 2}, 90%, 65%, ${alpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
        }

        // Enlace al puntero (resalta el área cercana al mouse).
        const mdx = a.x - mouse.x;
        const mdy = a.y - mouse.y;
        const md = Math.hypot(mdx, mdy);
        if (md < 180) {
          const alpha = (1 - md / 180) * 0.5;
          ctx.strokeStyle = `hsla(${a.hue}, 95%, 70%, ${alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
        }
      }

      // Dibujar nodos.
      for (const n of nodes) {
        const x = n.x + parallax.x * (n.r * 0.5);
        const y = n.y + parallax.y * (n.r * 0.5);
        ctx.beginPath();
        ctx.fillStyle = `hsla(${n.hue}, 95%, 72%, 0.9)`;
        ctx.shadowBlur = 8;
        ctx.shadowColor = `hsla(${n.hue}, 95%, 65%, 0.8)`;
        ctx.arc(x, y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // Dibujar anillos de las ondas.
      for (const rp of ripples) {
        ctx.beginPath();
        ctx.strokeStyle = `hsla(190, 95%, 70%, ${rp.life * 0.5})`;
        ctx.lineWidth = 2;
        ctx.arc(rp.x, rp.y, rp.radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = `hsla(280, 95%, 72%, ${rp.life * 0.3})`;
        ctx.lineWidth = 1;
        ctx.arc(rp.x, rp.y, rp.radius * 0.6, 0, Math.PI * 2);
        ctx.stroke();
      }

      raf = requestAnimationFrame(step);
    }

    function onMove(e: MouseEvent) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      parallax.tx = (e.clientX / width - 0.5) * 40;
      parallax.ty = (e.clientY / height - 0.5) * 40;
    }

    function onLeave() {
      mouse.x = -9999;
      mouse.y = -9999;
      parallax.tx = 0;
      parallax.ty = 0;
    }

    function onClick(e: MouseEvent) {
      // Solo reaccionar en zonas "vacías": ignorar clics sobre controles.
      const el = e.target as HTMLElement | null;
      if (el && el.closest("button, a, input, label, [data-no-ripple]")) return;
      ripples.push({
        x: e.clientX,
        y: e.clientY,
        radius: 0,
        max: 320,
        life: 1,
      });
      if (ripples.length > 6) ripples.shift();
    }

    let raf = 0;
    resize();
    if (reduce) {
      // Versión estática accesible: una sola pasada.
      step();
      cancelAnimationFrame(raf);
    } else {
      raf = requestAnimationFrame(step);
    }

    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseout", onLeave);
    window.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
      window.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
    />
  );
}
