"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  normalizeFiles,
  readDroppedItems,
} from "../lib/batch/input";
import type { InputSelection } from "../lib/batch/types";
import Dropzone from "./Dropzone";

export interface SourcePickerProps {
  onInput: (selection: InputSelection) => void | Promise<void>;
  onError?: (message: string) => void;
  disabled?: boolean;
  compact?: boolean;
}

function message(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "No se pudo leer la selección.";
}

export default function SourcePicker({
  onInput,
  onError,
  disabled = false,
  compact = false,
}: SourcePickerProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    if (folderInputRef.current) {
      (
        folderInputRef.current as HTMLInputElement & {
          webkitdirectory?: boolean;
        }
      ).webkitdirectory = true;
    }
  }, []);

  const deliver = async (operation: Promise<InputSelection>): Promise<void> => {
    setError(null);
    setReading(true);
    try {
      await onInput(await operation);
    } catch (cause) {
      const detail = message(cause);
      setError(detail);
      onError?.(detail);
    } finally {
      setReading(false);
    }
  };

  return (
    <section
      className={`source-picker ${compact ? "source-picker--compact" : ""}`}
      aria-labelledby="source-picker-title"
      aria-busy={reading}
    >
      <div className="source-picker__header">
        <div>
          <p className="eyebrow">Entrada local</p>
          <h2 id="source-picker-title">
            {compact
              ? "Añadir más imágenes o carpetas"
              : "Arrastra tus imágenes o una carpeta completa"}
          </h2>
        </div>
        <span className="privacy-proof">
          <span aria-hidden="true" />
          Sin subir archivos
        </span>
      </div>

      <Dropzone
        disabled={disabled || reading}
        onDropData={(data) => {
          if (data.items?.length) {
            return deliver(readDroppedItems(data.items));
          }
          return deliver(normalizeFiles(data.files, "drop"));
        }}
      />

      <div className="source-picker__actions">
        <button
          type="button"
          className="control control--primary"
          disabled={disabled || reading}
          onClick={() => imageInputRef.current?.click()}
        >
          Seleccionar imágenes
        </button>
        <button
          type="button"
          className="control control--secondary"
          disabled={disabled || reading}
          onClick={() => folderInputRef.current?.click()}
        >
          Seleccionar carpeta
        </button>
      </div>

      <input
        ref={imageInputRef}
        className="sr-only"
        type="file"
        multiple
        aria-label="Seleccionar imágenes del dispositivo"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) void deliver(normalizeFiles(files, "files"));
        }}
      />
      <input
        ref={folderInputRef}
        className="sr-only"
        type="file"
        multiple
        aria-label="Seleccionar una carpeta con imágenes"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) void deliver(normalizeFiles(files, "folder"));
        }}
      />

      {reading ? (
        <p className="source-picker__status" aria-live="polite">
          Leyendo estructura y firmas…
        </p>
      ) : null}
      {error ? (
        <div className="inline-alert" role="alert">
          <strong>No se pudo añadir la selección.</strong>
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}
