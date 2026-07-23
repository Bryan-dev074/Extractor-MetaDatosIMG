"use client";

import React, { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  hue: number;
}

interface Ripple {
  x: number;
  y: number;
  radius: number;
  opacity: number;
}

const HUES = [190, 250, 262, 300];
const LINK_DISTANCE = 136;
const FRAME_INTERVAL = 1000 / 30;

interface InteractiveBackgroundProps {
  paused?: boolean;
}

interface AnimationControl {
  sync(): void;
}

export default function InteractiveBackground({
  paused = false,
}: InteractiveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  const animationControlRef = useRef<AnimationControl | null>(null);
  pausedRef.current = paused;

  useEffect(() => {
    if (navigator.userAgent.includes("jsdom")) return;

    const canvasElement = canvasRef.current;
    const context2d = canvasElement?.getContext("2d", { alpha: true });
    if (!canvasElement || !context2d) return;
    const canvas: HTMLCanvasElement = canvasElement;
    const context: CanvasRenderingContext2D = context2d;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const particles: Particle[] = [];
    const ripples: Ripple[] = [];
    const pointer = { x: -10_000, y: -10_000 };
    let width = 0;
    let height = 0;
    let dpr = 1;
    let frame = 0;
    let lastFrame = 0;
    let running = !document.hidden && !pausedRef.current;

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cap = width < 720 ? 26 : 52;
      const target = Math.min(cap, Math.max(18, Math.floor((width * height) / 32_000)));
      particles.length = 0;
      for (let index = 0; index < target; index += 1) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.16,
          vy: (Math.random() - 0.5) * 0.16,
          radius: 0.7 + Math.random() * 1.25,
          hue: HUES[index % HUES.length],
        });
      }
    }

    function draw() {
      context.clearRect(0, 0, width, height);

      for (const particle of particles) {
        if (!reduceMotion && !pausedRef.current) {
          particle.x += particle.vx;
          particle.y += particle.vy;
          if (particle.x < -8) particle.x = width + 8;
          if (particle.x > width + 8) particle.x = -8;
          if (particle.y < -8) particle.y = height + 8;
          if (particle.y > height + 8) particle.y = -8;
        }
      }

      /*
       * La malla espacial evita comparar todos los pares de partículas.
       * Cada nodo solo consulta su celda y las ocho vecinas.
       */
      const cells = new Map<string, number[]>();
      particles.forEach((particle, index) => {
        const key = `${Math.floor(particle.x / LINK_DISTANCE)}:${Math.floor(
          particle.y / LINK_DISTANCE,
        )}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(index);
        else cells.set(key, [index]);
      });

      particles.forEach((particle, index) => {
        const cellX = Math.floor(particle.x / LINK_DISTANCE);
        const cellY = Math.floor(particle.y / LINK_DISTANCE);
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            const bucket = cells.get(`${cellX + offsetX}:${cellY + offsetY}`);
            if (!bucket) continue;
            for (const otherIndex of bucket) {
              if (otherIndex <= index) continue;
              const other = particles[otherIndex];
              const dx = particle.x - other.x;
              const dy = particle.y - other.y;
              const distance = Math.hypot(dx, dy);
              if (distance >= LINK_DISTANCE) continue;
              context.beginPath();
              context.strokeStyle = `hsla(${(particle.hue + other.hue) / 2}, 92%, 70%, ${
                (1 - distance / LINK_DISTANCE) * 0.17
              })`;
              context.lineWidth = 0.8;
              context.moveTo(particle.x, particle.y);
              context.lineTo(other.x, other.y);
              context.stroke();
            }
          }
        }

        const pointerDistance = Math.hypot(
          particle.x - pointer.x,
          particle.y - pointer.y,
        );
        if (pointerDistance < 170) {
          context.beginPath();
          context.strokeStyle = `hsla(${particle.hue}, 95%, 72%, ${
            (1 - pointerDistance / 170) * 0.38
          })`;
          context.moveTo(particle.x, particle.y);
          context.lineTo(pointer.x, pointer.y);
          context.stroke();
        }

        context.beginPath();
        context.fillStyle = `hsla(${particle.hue}, 95%, 74%, 0.72)`;
        context.shadowBlur = 7;
        context.shadowColor = `hsla(${particle.hue}, 95%, 65%, 0.62)`;
        context.arc(
          particle.x,
          particle.y,
          particle.radius,
          0,
          Math.PI * 2,
        );
        context.fill();
      });
      context.shadowBlur = 0;

      for (let index = ripples.length - 1; index >= 0; index -= 1) {
        const ripple = ripples[index];
        ripple.radius += 3.6;
        ripple.opacity -= 0.018;
        if (ripple.opacity <= 0) {
          ripples.splice(index, 1);
          continue;
        }
        context.beginPath();
        context.strokeStyle = `rgba(34, 211, 238, ${ripple.opacity})`;
        context.lineWidth = 1.5;
        context.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
        context.stroke();
      }
    }

    function animate(timestamp: number) {
      if (!running) return;
      if (timestamp - lastFrame >= FRAME_INTERVAL) {
        lastFrame = timestamp;
        draw();
      }
      frame = window.requestAnimationFrame(animate);
    }

    function start() {
      window.cancelAnimationFrame(frame);
      if (reduceMotion || pausedRef.current) {
        draw();
        return;
      }
      if (running) frame = window.requestAnimationFrame(animate);
    }

    function syncAnimation() {
      running = !document.hidden && !pausedRef.current;
      window.cancelAnimationFrame(frame);
      if (running) {
        start();
      } else if (!document.hidden) {
        draw();
      }
    }

    function onPointerMove(event: PointerEvent) {
      if (pausedRef.current) return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    }

    function onPointerLeave() {
      pointer.x = -10_000;
      pointer.y = -10_000;
    }

    function onClick(event: MouseEvent) {
      if (pausedRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, input, summary, label, [data-no-ripple]")) {
        return;
      }
      ripples.push({
        x: event.clientX,
        y: event.clientY,
        radius: 8,
        opacity: 0.38,
      });
      if (ripples.length > 3) ripples.shift();
    }

    function onVisibilityChange() {
      syncAnimation();
    }

    function onResize() {
      resize();
      if (reduceMotion || pausedRef.current) draw();
    }

    resize();
    start();
    animationControlRef.current = { sync: syncAnimation };
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("click", onClick);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.cancelAnimationFrame(frame);
      animationControlRef.current = null;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    animationControlRef.current?.sync();
  }, [paused]);

  return (
    <canvas
      ref={canvasRef}
      className="interactive-background"
      aria-hidden="true"
    />
  );
}
