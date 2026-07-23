import React from "react";

export default function TikTokInfo() {
  return (
    <details className="tiktok-info">
      <summary>
        <span className="tiktok-info__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M16.5 3c.3 2.1 1.6 3.6 3.5 3.9v2.6c-1.3.1-2.5-.3-3.5-1v5.9c0 3.6-2.6 6.1-5.9 6.1-3 0-5.3-2.3-5.3-5.2 0-3 2.4-5.2 5.4-5.2.3 0 .6 0 .9.1v2.7c-.3-.1-.6-.1-.9-.1-1.4 0-2.5 1-2.5 2.4s1.1 2.5 2.5 2.5c1.5 0 2.6-1.1 2.6-2.9V3h2.7Z" />
          </svg>
        </span>
        <span>
          <strong>Qué hace exactamente TikTok Photo Max</strong>
          <small>La explicación honesta y cómo minimiza los parches</small>
        </span>
        <svg className="tiktok-info__chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="tiktok-info__body">
        <p>
          Mantiene las dimensiones nativas, convierte la salida a PNG sRGB y aplica
          cambios adaptativos de como máximo un nivel por canal solo en zonas
          opacas y suaves.
        </p>
        <p>
          También crea una vista previa JPEG aproximada para inspección. TikTok
          todavía puede volver a recomprimir la imagen al publicarla; ninguna
          herramienta local puede impedir esa decisión de la plataforma.
        </p>
        <div className="tiktok-info__note">
          <strong>Dos salidas, dos objetivos.</strong> La descarga limpia conserva
          exactamente los píxeles para tu archivo maestro; Photo Max crea una copia
          separada y preparada para el flujo de TikTok.
        </div>
      </div>
    </details>
  );
}
