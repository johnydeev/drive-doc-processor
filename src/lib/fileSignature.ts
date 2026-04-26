/**
 * Validación de firma binaria (magic bytes) para uploads.
 *
 * No reemplaza la validación de MIME ni el límite de tamaño — los complementa
 * para mitigar uploads que mienten el Content-Type.
 */

const SIG_PDF  = Buffer.from([0x25, 0x50, 0x44, 0x46]);                // "%PDF"
const SIG_PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SIG_JPG  = Buffer.from([0xff, 0xd8, 0xff]);
const SIG_ZIP  = Buffer.from([0x50, 0x4b, 0x03, 0x04]);                // ZIP / OOXML (xlsx)
const SIG_ZIP_EMPTY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const SIG_ZIP_SPANNED = Buffer.from([0x50, 0x4b, 0x07, 0x08]);

function startsWith(buf: Buffer, sig: Buffer): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

export function isPdf(buf: Buffer): boolean {
  return startsWith(buf, SIG_PDF);
}

export function isPng(buf: Buffer): boolean {
  return startsWith(buf, SIG_PNG);
}

export function isJpeg(buf: Buffer): boolean {
  return startsWith(buf, SIG_JPG);
}

/** OOXML (xlsx, docx, etc.) — ZIP container. NO valida que sea xlsx específicamente. */
export function isZip(buf: Buffer): boolean {
  return startsWith(buf, SIG_ZIP) || startsWith(buf, SIG_ZIP_EMPTY) || startsWith(buf, SIG_ZIP_SPANNED);
}
