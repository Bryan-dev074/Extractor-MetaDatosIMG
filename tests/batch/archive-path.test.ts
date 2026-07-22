import { describe, expect, it } from "vitest";
import { createArchivePath } from "@/lib/batch/archive-path";

describe("createArchivePath", () => {
  it("keeps safe nested directories and renames only the basename", () => {
    expect(createArchivePath("Campaña/Sub/foto.jpg", "clean", new Set(), ".jpg")).toBe(
      "Campaña/Sub/foto-limpio.jpg",
    );
  });

  it("removes traversal and resolves collisions case-insensitively", () => {
    const used = new Set<string>();
    expect(createArchivePath("../A/CON.jpg", "clean", used, ".jpg")).toBe("A/_CON-limpio.jpg");
    expect(createArchivePath("a/con.jpg", "clean", used, ".jpg")).toBe("a/_con-limpio (2).jpg");
    expect(createArchivePath("a/CON.jpeg", "clean", used, ".jpg")).toBe("a/_CON-limpio (3).jpg");
  });

  it("normalizes Unicode before checking full-path collisions", () => {
    const used = new Set<string>();
    expect(createArchivePath("Café/foto.png", "clean", used, ".png")).toBe(
      "Café/foto-limpio.png",
    );
    expect(createArchivePath("Cafe\u0301/FOTO.PNG", "clean", used, ".png")).toBe(
      "Café/FOTO-limpio (2).png",
    );
  });

  it.each([
    "/absoluta/foto.jpg",
    "\\absoluta\\foto.jpg",
    "\\\\servidor\\recurso\\foto.jpg",
    "C:\\fotos\\foto.jpg",
    "D:foto.jpg",
  ])("rejects absolute, UNC, or drive-prefixed paths: %s", (path) => {
    expect(() => createArchivePath(path, "clean", new Set(), ".jpg")).toThrow(/ruta.*(absoluta|unidad)/i);
  });

  it.each(["carpeta/nu\u0000l.jpg", "carpeta/con\u001ftrol.jpg", "carpeta/del\u007f.jpg"])(
    "rejects NUL and control characters: %s",
    (path) => {
      expect(() => createArchivePath(path, "clean", new Set(), ".jpg")).toThrow(/control/i);
    },
  );

  it("removes empty, current-directory, and traversal segments", () => {
    expect(createArchivePath("uno//./dos/../tres/foto.jpg", "clean", new Set(), ".jpg")).toBe(
      "uno/dos/tres/foto-limpio.jpg",
    );
  });

  it("replaces invalid characters and makes reserved or trailing-dot segments portable", () => {
    expect(
      createArchivePath('AUX./mal<nombre>|carpeta./LPT9 .jpeg', "clean", new Set(), ".jpg"),
    ).toBe("_AUX/mal_nombre__carpeta/_LPT9-limpio.jpg");
  });

  it("uses the detected clean extension and always emits PNG for TikTok", () => {
    expect(createArchivePath("foto.png", "clean", new Set(), ".jpg")).toBe(
      "foto-limpio.jpg",
    );
    expect(createArchivePath("sin-extension", "clean", new Set(), ".png")).toBe(
      "sin-extension-limpio.png",
    );
    expect(createArchivePath("foto.jpeg", "tiktok", new Set(), ".jpg")).toBe(
      "foto-tiktok.png",
    );
    expect(createArchivePath("foto.jpg", "tiktok", new Set())).toBe("foto-tiktok.png");
  });

  it("rejects missing or non-canonical clean extensions at runtime", () => {
    const callFromJavaScript = createArchivePath as unknown as (
      path: string,
      mode: string,
      used: Set<string>,
      extension?: string,
    ) => string;

    expect(() => callFromJavaScript("foto.png", "clean", new Set())).toThrow(
      /extensión.*obligatoria/i,
    );
    expect(() => callFromJavaScript("foto.png", "clean", new Set(), ".gif")).toThrow(
      /\.jpg.*\.png/i,
    );
  });

  it("preserves hidden and multi-dot basenames while changing only the output extension", () => {
    expect(createArchivePath(".oculta.png", "clean", new Set(), ".jpg")).toBe(
      ".oculta-limpio.jpg",
    );
    expect(createArchivePath("foto.final.v2.jpeg", "clean", new Set(), ".png")).toBe(
      "foto.final.v2-limpio.png",
    );
  });

  it("does not confuse equal basenames in different directories", () => {
    const used = new Set<string>();
    expect(createArchivePath("A/foto.jpg", "clean", used, ".jpg")).toBe("A/foto-limpio.jpg");
    expect(createArchivePath("B/foto.jpg", "clean", used, ".jpg")).toBe("B/foto-limpio.jpg");
  });
});
