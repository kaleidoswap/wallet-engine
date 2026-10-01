import type { WalletLike, OnchainWalletLike, Config, WalletOpenArgs } from '@secondts/bark-react-native'

/** SDK objects stay internal; the backend converts every public result. */
export type NativeBarkWallet = WalletLike & { uniffiDestroy?(): void }
export type NativeBarkOnchain = OnchainWalletLike & { uniffiDestroy?(): void }
export type NativeBarkBalance = Awaited<ReturnType<WalletLike['balance']>>
export type NativeBarkConfig = Config
export type NativeBarkOpenArgs = WalletOpenArgs
export interface NativeBarkModule {
  Network: { Bitcoin: number; Testnet: number; Signet: number; Regtest: number }
  Wallet: { open(network: number, mnemonic: string, config: Config, args: WalletOpenArgs): Promise<NativeBarkWallet> }
  OnchainWallet: { default_(network: number, mnemonic: string, config: Config, dataDir: string): Promise<NativeBarkOnchain> }
  validateArkAddress(address: string): boolean
  extractTxFromPsbt(psbt: string): string
}

export async function loadBarkNative(): Promise<NativeBarkModule> {
  return import('@secondts/bark-react-native')
}
