/**
 * One normalisation for `lightning:`-prefixed BOLT11 destinations.
 *
 * The spend policy and the adapters must agree on what string is decoded: if
 * the adapter strips a URI scheme the policy does not, the policy falls back
 * to the caller-supplied amount while the adapter pays the amount the invoice
 * encodes (security review 2026-10-28, finding 13).
 */

const LIGHTNING_SCHEME = /^lightning:/i

/**
 * Trim the value and drop an optional `lightning:` URI scheme, case-insensitively.
 * Whitespace between the scheme and the invoice is dropped too, so every
 * consumer sees the same bare invoice.
 */
export function stripLightningScheme(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  return LIGHTNING_SCHEME.test(trimmed) ? trimmed.slice('lightning:'.length).trim() : trimmed
}
