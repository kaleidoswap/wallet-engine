import { describe, it, expect } from 'vitest'
import { scriptPubKeyFromAddress } from '../src/lib/address-script'

/**
 * The chain checks in BoltzChainSwap match a fetched transaction against the
 * lockup by SCRIPT. These vectors pin the decoder: BIP-173/350 for Bitcoin, lwk
 * and the rust-elements test suite for Liquid (confidential and not).
 */

const P2WPKH = '00145525def68633f742eb828a3eb27419ea9815f735'
const P2TR = '51203820f0626aa7d44d118bc5165a0c67714336e25aae0e3b717365b0c68748bbd4'

describe('scriptPubKeyFromAddress', () => {
  it('decodes Bitcoin bech32 and bech32m', () => {
    expect(scriptPubKeyFromAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(
      '0014751e76e8199196d454941c45d1b3a323f1433bd6'
    )
    expect(scriptPubKeyFromAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0')).toBe(
      '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    )
    expect(scriptPubKeyFromAddress('tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c')).toBe(
      '5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433'
    )
    expect(scriptPubKeyFromAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')).toBe(
      '0014751e76e8199196d454941c45d1b3a323f1433bd6'
    )
  })

  it('decodes confidential Liquid blech32 (v0) on every network', () => {
    for (const address of [
      'el1qqfst8jplt7ewd7uluf8cgk7t7yyaplauh69u9melpygzt9gsdq0uk4f9mmmgvvlhgt4c9z37kf6pn65czhmn2c3kmhp9qgcks',
      'lq1qqfst8jplt7ewd7uluf8cgk7t7yyaplauh69u9melpygzt9gsdq0uk4f9mmmgvvlhgt4c9z37kf6pn65czhmn2nekg50ms0222',
      'tlq1qqfst8jplt7ewd7uluf8cgk7t7yyaplauh69u9melpygzt9gsdq0uk4f9mmmgvvlhgt4c9z37kf6pn65czhmn2r5mgnc4d6tmr',
    ]) {
      expect(scriptPubKeyFromAddress(address)).toBe(P2WPKH)
    }
  })

  it('decodes confidential Liquid blech32m (taproot) and its unconfidential form alike', () => {
    expect(
      scriptPubKeyFromAddress(
        'el1pqgft7r4ytdenml0gaj67393sd3qkt3nxex0ut5dt3plhzwf6jaww5wpq7p3x4f75f5gch3gktgxxwu2rxm394tsw8dchxedsc6r53w75cj24fq2u2ls5'
      )
    ).toBe(P2TR)
    expect(
      scriptPubKeyFromAddress(
        'lq1pqgft7r4ytdenml0gaj67393sd3qkt3nxex0ut5dt3plhzwf6jaww5wpq7p3x4f75f5gch3gktgxxwu2rxm394tsw8dchxedsc6r53w75375l4kfvf08y'
      )
    ).toBe(P2TR)
    expect(scriptPubKeyFromAddress('ert1p8qs0qcn25l2y6yvtc5t95rr8w9pndcj64c8rkutnvkcvdp6gh02q2cqvj9')).toBe(P2TR)
    expect(scriptPubKeyFromAddress('ert1q25jaaa5xx0m596uz3gltyaqea2vptae4zgjav0')).toBe(P2WPKH)
  })

  it('rejects a corrupted checksum rather than guessing a script', () => {
    expect(() =>
      scriptPubKeyFromAddress(
        'el1pqgft7r4ytdenml0gaj67393sd3qkt3nxex0ut5dt3plhzwf6jaww5wpq7p3x4f75f5gch3gktgxxwu2rxm394tsw8dchxedsc6r53w75cj24fq2u2ls6'
      )
    ).toThrow(/checksum/)
    // Valid blech32 but a v1 program: must be blech32m (rust-elements vector).
    expect(() =>
      scriptPubKeyFromAddress(
        'el1pq0umk3pez693jrrlxz9ndlkuwne93gdu9g83mhhzuyf46e3mdzfpva0w48gqgzgrklncnm0k5zeyw8my2ypfsxguu9nrdg2pc'
      )
    ).toThrow(/checksum/)
    expect(() => scriptPubKeyFromAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj1')).toThrow()
  })

  it('rejects legacy and unknown formats', () => {
    expect(() => scriptPubKeyFromAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toThrow(/Unsupported/)
    expect(() => scriptPubKeyFromAddress('VJL64Ep3rcngP4cScRme15q9i8MCNiuqWeiG3YbtduUidVyorg7nRsgmmF714QtH3sNpWB2CqsVVciQh')).toThrow(
      /Unsupported/
    )
    expect(() => scriptPubKeyFromAddress('')).toThrow(/Unsupported/)
    expect(() => scriptPubKeyFromAddress('bcrt1qlockup')).toThrow()
  })
})
