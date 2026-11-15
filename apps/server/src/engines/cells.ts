import type { CellValue } from "@dpilot/shared";

const PREVIEW_BYTES = 64;

function encodeBytes(bytes: Uint8Array): CellValue {
  const preview = Array.from(bytes.subarray(0, PREVIEW_BYTES), (byte) =>
    byte.toString(16).padStart(2, "0"),
  );
  return {
    bytes: {
      size: bytes.byteLength,
      hex: preview.join(""),
      truncated: bytes.byteLength > PREVIEW_BYTES,
    },
  };
}

function encodeBigint(value: bigint): number | string {
  const safe = value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER);
  return safe ? Number(value) : value.toString();
}

function stringify(value: object): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "bigint" ? inner.toString() : inner,
  );
}

/** Turns a driver value into a JSON-safe cell; integers beyond 2^53 stay exact as text. */
export function encodeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return encodeBigint(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof Uint8Array) return encodeBytes(value);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (typeof value === "object") return stringify(value);
  return String(value);
}
