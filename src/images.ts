// An image's type from its first bytes, not its file name: image generators and exports
// often save a JPEG as .png, and the Claude API checks the bytes against the type it's told.
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export function imageType(bytes: Uint8Array): ImageType | undefined {
  const at = (offset: number, ...values: number[]) => values.every((v, i) => bytes[offset + i] === v);
  const ascii = (offset: number, text: string) => at(offset, ...[...text].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return undefined;
}
