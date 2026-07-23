"use client";

import React from "react";
import type { SkippedInput } from "../lib/batch/types";

export interface SkippedFilesDisclosureProps {
  items: SkippedInput[];
}

export default function SkippedFilesDisclosure({
  items,
}: SkippedFilesDisclosureProps) {
  if (items.length === 0) return null;

  const label = `${items.length} archivo${items.length === 1 ? "" : "s"} omitido${
    items.length === 1 ? "" : "s"
  }`;

  return (
    <details className="skipped-disclosure">
      <summary>
        <span className="skipped-disclosure__title">
          <span className="skipped-disclosure__mark" aria-hidden="true">
            !
          </span>
          <span>
            <span className="eyebrow">Fuera del lote</span>
            <strong>{label}</strong>
          </span>
        </span>
        <span className="skipped-disclosure__action">
          Ver motivos
          <span className="skipped-disclosure__chevron" aria-hidden="true" />
        </span>
      </summary>
      <div className="skipped-disclosure__body">
        <p>
          Estos archivos no se procesaron. Las imágenes JPEG y PNG válidas
          permanecen en “Rutas y resultados”.
        </p>
        <ul className="skipped-disclosure__list">
          {items.map((item, index) => (
            <li key={`${item.relativePath}-${item.reason}-${index}`}>
              <code>{item.relativePath}</code>
              <span className="skipped-disclosure__reason">{item.reason}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
