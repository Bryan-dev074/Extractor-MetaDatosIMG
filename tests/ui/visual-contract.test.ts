// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

function declarationBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

describe("result-list visual contracts", () => {
  it("uses horizontal dense rows on desktop and stacks them on mobile", () => {
    expect(declarationBlock(".result-list--dense")).toMatch(
      /grid-template-columns\s*:\s*1fr/,
    );
    expect(declarationBlock(".result-list--dense .result-row")).toMatch(
      /grid-template-columns\s*:\s*112px\s+minmax\(0,\s*1fr\)\s+minmax\(220px,\s*0\.48fr\)/,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*760px\)[\s\S]*?\.result-list--dense \.result-row\s*\{[^}]*grid-template-columns\s*:\s*1fr/,
    );
  });

  it("bounds offscreen rendering for the 60-card result window", () => {
    const resultRow = declarationBlock(".result-row");

    expect(resultRow).toMatch(/content-visibility\s*:\s*auto/);
    expect(resultRow).toMatch(/contain-intrinsic-size\s*:/);
  });

  it("keeps result actions and disclosure summaries at least 44px tall", () => {
    expect(declarationBlock(".result-actions .control")).toMatch(
      /min-height\s*:\s*44px/,
    );
    expect(declarationBlock(".result-details summary")).toMatch(
      /min-height\s*:\s*44px/,
    );
    expect(declarationBlock(".creator-link")).toMatch(/min-height\s*:\s*44px/);
    expect(declarationBlock(".product-footer a")).toMatch(
      /min-height\s*:\s*44px/,
    );
  });
});

describe("skipped-files disclosure visual contracts", () => {
  it("keeps the summary touch-friendly and bounds the expanded list", () => {
    expect(declarationBlock(".skipped-disclosure summary")).toMatch(
      /min-height\s*:\s*44px/,
    );
    const list = declarationBlock(".skipped-disclosure__list");
    expect(list).toMatch(/max-height\s*:/);
    expect(list).toMatch(/overflow-y\s*:\s*auto/);
    expect(declarationBlock(".skipped-disclosure code,\n.skipped-disclosure__reason")).toMatch(
      /overflow-wrap\s*:\s*anywhere/,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*760px\)[\s\S]*?\.skipped-disclosure__body\s*\{[^}]*padding-left\s*:\s*0/,
    );
  });
});
