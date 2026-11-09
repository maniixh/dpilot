const decoder = new TextDecoder();

/**
 * Turns a container log response into lines. Containers without a TTY send
 * 8-byte frame headers ([stream, 0, 0, 0, size:uint32be]) before each chunk.
 */
export function demuxLogs(bytes: Uint8Array): string[] {
  const text = isMultiplexed(bytes) ? joinFrames(bytes) : decoder.decode(bytes);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isMultiplexed(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    (bytes[0] === 0 || bytes[0] === 1 || bytes[0] === 2) &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0
  );
}

function joinFrames(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) break;
    parts.push(bytes.subarray(start, start + size));
    offset = start + size;
  }
  return parts.map((part) => decoder.decode(part, { stream: true })).join("") + decoder.decode();
}
