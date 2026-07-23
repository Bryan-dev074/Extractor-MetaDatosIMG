"use client";

import React, { useState } from "react";

interface DropzoneProps {
  onDropData: (data: DataTransfer) => void | Promise<void>;
  disabled?: boolean;
}

export default function Dropzone({ onDropData, disabled = false }: DropzoneProps) {
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`source-drop ${dragging ? "is-dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) void onDropData(event.dataTransfer);
      }}
      aria-disabled={disabled}
      aria-label="Zona para soltar imágenes o carpetas"
    >
      <span className="source-drop__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 16V4" />
          <path d="m6 10 6-6 6 6" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      </span>
      <div>
        <p className="source-drop__title">
          {dragging
            ? "Suelta para escanear"
            : "JPEG o PNG · una, varias o una carpeta"}
        </p>
        <p className="source-drop__copy">
          Se inspeccionan los bytes reales y se conservan todas las subcarpetas.
        </p>
        <div className="source-drop__tags" aria-hidden="true">
          <span>Por lotes</span>
          <span>C2PA</span>
          <span>Midjourney</span>
          <span>DALL·E</span>
          <span>Nano Banana</span>
        </div>
      </div>
    </div>
  );
}
