import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SourcePicker from "../../components/SourcePicker";

function jpeg(name: string, path = ""): File {
  const file = new File(
    [Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])],
    name,
    { type: "application/octet-stream", lastModified: 7 },
  );
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

afterEach(cleanup);

describe("SourcePicker", () => {
  it("offers separate image and folder controls", () => {
    render(<SourcePicker onInput={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Seleccionar imágenes" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Seleccionar carpeta" }),
    ).toBeVisible();
  });

  it("classifies by magic bytes and allows selecting the same file again", async () => {
    const onInput = vi.fn();
    render(<SourcePicker onInput={onInput} />);
    const input = screen.getByLabelText("Seleccionar imágenes del dispositivo");
    const disguised = jpeg("sin-extension.bin");

    fireEvent.change(input, { target: { files: [disguised] } });
    await waitFor(() => expect(onInput).toHaveBeenCalledTimes(1));
    expect(onInput.mock.calls[0][0].accepted[0].format).toBe("jpeg");
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { files: [disguised] } });
    await waitFor(() => expect(onInput).toHaveBeenCalledTimes(2));
  });

  it("sets webkitdirectory through the folder input ref", () => {
    render(<SourcePicker onInput={vi.fn()} />);
    const input = screen.getByLabelText("Seleccionar una carpeta con imágenes");

    expect((input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory).toBe(
      true,
    );
  });

  it("keeps the full folder-relative path", async () => {
    const onInput = vi.fn();
    render(<SourcePicker onInput={onInput} />);
    const input = screen.getByLabelText("Seleccionar una carpeta con imágenes");

    fireEvent.change(input, {
      target: { files: [jpeg("foto.jpg", "Campaña/Sub/foto.jpg")] },
    });

    await waitFor(() =>
      expect(onInput).toHaveBeenCalledWith(
        expect.objectContaining({
          archiveBase: "Campaña",
          accepted: [
            expect.objectContaining({ relativePath: "Campaña/Sub/foto.jpg" }),
          ],
        }),
      ),
    );
  });

  it("reads a recursively dropped directory instead of flattening it", async () => {
    const onInput = vi.fn();
    const file = jpeg("foto.jpg");
    const fileEntry = {
      isFile: true as const,
      isDirectory: false as const,
      name: "foto.jpg",
      file: (resolve: (value: File) => void) => resolve(file),
    };
    let readCount = 0;
    const directoryEntry = {
      isFile: false as const,
      isDirectory: true as const,
      name: "Raíz",
      createReader: () => ({
        readEntries: (resolve: (entries: unknown[]) => void) => {
          readCount += 1;
          resolve(readCount === 1 ? [fileEntry] : []);
        },
      }),
    };
    const items = {
      0: {
        kind: "file",
        getAsFile: () => null,
        webkitGetAsEntry: () => directoryEntry,
      },
      length: 1,
    };
    render(<SourcePicker onInput={onInput} />);

    fireEvent.drop(
      screen.getByLabelText("Zona para soltar imágenes o carpetas"),
      { dataTransfer: { items, files: [] } },
    );

    await waitFor(() =>
      expect(onInput).toHaveBeenCalledWith(
        expect.objectContaining({
          archiveBase: "Raíz",
          accepted: [
            expect.objectContaining({ relativePath: "Raíz/foto.jpg" }),
          ],
        }),
      ),
    );
  });
});
