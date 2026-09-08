import { describe, expect, it } from 'vitest'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'

const PAYMENT_HASH = '0001020304050607080900010203040506070809000102030405060708090102'
const BOLT11 =
  'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'

describe('RlnWdkAdapter.createInvoice SDK result shape', () => {
  it('derives the payment hash from the BOLT11 returned by LNInvoiceResponse', async () => {
    const adapter = new RlnWdkAdapter()
    Object.assign(adapter as any, {
      connected: true,
      account: {
        _rln: { createLNInvoice: async () => ({ invoice: BOLT11 }) },
      },
    })

    await expect(adapter.createInvoice({ amount: 1000 })).resolves.toMatchObject({
      invoice: BOLT11,
      paymentHash: PAYMENT_HASH,
    })
  })
})
