import { describe, expect, it } from "vitest";
import { createArchivePath } from "@/lib/batch/archive-path";

describe("createArchivePath", () => {
  it("keeps safe nested directories and renames only the basename", () => {
    expect(createArchivePath("Campaña/Sub/foto.jpg", "clean", new Set())).toBe(
      "Campaña/Sub/foto-limpio.jpg",
    );
  });

  it("removes traversal and resolves collisions case-insensitively", () => {
    const used = new Set<string>();
    expect(createArchivePath("../A/CON.jpg", "clean", used)).toBe("A/_CON-limpio.jpg");
    expect(createArchivePath("a/con.jpg", "clean", used)).toBe("a/_con-limpio (2).jpg");
    expect(createArchivePath("a/CON.jpeg", "clean", used)).toBe("a/_CON-limpio (3).jpg");
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
    expect(() => createArchivePath(path, "clean", new Set())).toThrow(/ruta.*(absoluta|unidad)/i);
  });

  it.each(["carpeta/nu\u0000l.jpg", "carpeta/con\u001ftrol.jpg", "carpeta/del\u007f.jpg"])(
    "rejects NUL and control characters: %s",
    (path) => {
      expect(() => createArchivePath(path, "clean", new Set())).toThrow(/control/i);
    },
  );

  it("removes empty, current-directory, and traversal segments", () => {
    expect(createArchivePath("uno//./dos/../tres/foto.jpg", "clean", new Set())).toBe(
      "uno/dos/tres/foto-limpio.jpg",
    );
  });

  it("replaces invalid characters and makes reserved or trailing-dot segments portable", () => {
    expect(
      createArchivePath('AUX./mal<nombre>|carpeta./LPT9 .jpeg', "clean", new Set()),
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
  });

  it("does not confuse equal basenames in different directories", () => {
    const used = new Set<string>();
    expect(createArchivePath("A/foto.jpg", "clean", used)).toBe("A/foto-limpio.jpg");
    expect(createArchivePath("B/foto.jpg", "clean", used)).toBe("B/foto-limpio.jpg");
  });
});
