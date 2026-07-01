// zbase32 — Phil Zimmermann's human-friendly base32 alphabet, used by LND
// for `signmessage` / `verifymessage` outputs.
//
//   alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769"
//
// Encoding is the same shape as base32 (5 bits per char), but the alphabet
// is reordered so the resulting strings are easier to read and transcribe.

const ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";

const INDEX = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) m.set(ALPHABET[i], i);
  return m;
})();

export function zbase32Encode(data: Uint8Array): string {
  if (data.length === 0) return "";
  const bitCount = data.length * 8;
  const charCount = Math.ceil(bitCount / 5);
  let out = "";
  let buffer = 0;
  let bits = 0;
  let consumed = 0;
  for (let i = 0; i < data.length; i++) {
    buffer = (buffer << 8) | data[i];
    bits += 8;
    while (bits >= 5 && consumed < charCount) {
      bits -= 5;
      const idx = (buffer >>> bits) & 0x1f;
      out += ALPHABET[idx];
      consumed++;
    }
  }
  if (bits > 0 && consumed < charCount) {
    const idx = (buffer << (5 - bits)) & 0x1f;
    out += ALPHABET[idx];
  }
  return out;
}

export function zbase32Decode(text: string, byteLength?: number): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);
  const expectedBytes = byteLength ?? Math.floor((text.length * 5) / 8);
  const out = new Uint8Array(expectedBytes);
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < text.length; i++) {
    const idx = INDEX.get(text[i]);
    if (idx === undefined) {
      throw new Error(`Invalid zbase32 character at position ${i}: ${text[i]}`);
    }
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (written < expectedBytes) {
        out[written++] = (buffer >>> bits) & 0xff;
      }
    }
  }
  return out;
}
