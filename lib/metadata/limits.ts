/** Browser-safe ceiling that bounds parser copies, rewrites, and verification passes. */
export const MAX_INPUT_BYTES = 256 * 1024 * 1024;

export function assertInputSize(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("Tamaño de imagen inválido.");
  }
  if (length > MAX_INPUT_BYTES) {
    throw new Error("La imagen excede el límite seguro de 256 MB.");
  }
}
