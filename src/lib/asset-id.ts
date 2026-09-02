/** Match the engine's protocol-neutral Bitcoin asset identifier. */
export function isBtcAssetId(assetId: string | null | undefined): boolean {
  return typeof assetId === 'string' && assetId.toLowerCase() === 'btc'
}
