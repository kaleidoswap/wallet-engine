/**
 * Wallet secrets used by the unit tests — all PUBLISHED test vectors, never
 * generated secrets.
 *
 * A freshly generated mnemonic committed to a public repository is
 * indistinguishable from someone's real wallet: a reader cannot tell it is
 * disposable, a scanner flags it as high-entropy material, and people do send
 * coins to seeds they find in repositories. A recognised vector has none of
 * those problems, because its keys are already public.
 *
 * Deliberately not named for a network — a mnemonic is not network-scoped, so
 * "testnet mnemonic" would imply a guarantee it does not carry. Real
 * test-network wallets live in `test/integration/.env` (gitignored) and in
 * repository secrets.
 */

/** The BIP-39 English test vector: entropy `0x00…00`, checksum word `about`. */
export const BIP39_TEST_VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/** Valid words, invalid phrase — for asserting a wrong-length phrase is refused. */
export const TOO_SHORT_MNEMONIC = 'abandon abandon ability'

/** The NIP-19 `nsec` example with its last character flipped, so the checksum fails. */
export const INVALID_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe6'

/** A syntactically valid 64-hex private key, all `a`. Not derived from anything. */
export const HEX_KEY_ALL_A = 'a'.repeat(64)
