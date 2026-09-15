/**
 * Wallet secrets used by the unit tests.
 *
 * Every one of these is a **published test vector**, not a generated secret,
 * and that is deliberate. A freshly generated mnemonic committed to a public
 * repository is indistinguishable from someone's real wallet: a reader cannot
 * tell it is disposable, a secret scanner flags it as high-entropy material,
 * and people do send coins to seeds they find in repositories. A vector that
 * everyone recognises carries none of that — its keys are already public, so
 * there is nothing to leak and nothing to mistake.
 *
 * Deliberately NOT named for a network. A mnemonic is not network-scoped — the
 * same seed derives mainnet keys as readily as testnet ones — so calling it a
 * "testnet mnemonic" would imply a safety property it does not have. What makes
 * it safe is that it is published, which is what the names here say.
 *
 * Real test-network wallets live in `test/integration/.env` (gitignored) and in
 * repository secrets. Nothing in this file ever holds funds.
 */

/**
 * The BIP-39 English test vector — entropy `0x00…00`, checksum word `about`.
 * Published in the BIP-39 specification and in effectively every wallet's test
 * suite.
 */
export const BIP39_TEST_VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/**
 * Three words of the vector: valid words, invalid phrase. For asserting that a
 * wordlist check rejects a wrong-length phrase rather than accepting it.
 */
export const TOO_SHORT_MNEMONIC = 'abandon abandon ability'

/**
 * The NIP-19 `nsec` example with its last character flipped, so the bech32
 * checksum fails. For asserting that an invalid nsec is refused rather than
 * silently treated as a passphrase.
 */
export const INVALID_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe6'

/** A syntactically valid 64-hex private key, all `a`. Not derived from anything. */
export const HEX_KEY_ALL_A = 'a'.repeat(64)
