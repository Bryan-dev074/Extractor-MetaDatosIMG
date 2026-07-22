export type SupportedFormat = "jpeg" | "png";

export function detectImageFormat(bytes: Uint8Array): SupportedFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }

  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= png.length && png.every((value, index) => bytes[index] === value)
    ? "png"
    : null;
}

export const extensionForFormat = (format: SupportedFormat) =>
  format === "jpeg" ? ".jpg" : ".png";
