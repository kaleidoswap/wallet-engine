/** Internal structural subset of @secondts/bark-react-native 0.25.0. */
export interface NativeBarkBalance {
  spendableSats: bigint
  pendingInRoundSats: bigint
  pendingExitSats: bigint
  pendingLightningSendSats: bigint
  claimableLightningReceiveSats: bigint
  pendingBoardSats: bigint
}

export interface NativeBarkWallet {
  balance(): Promise<NativeBarkBalance>
  properties(): Promise<{ network: number; fingerprint: string }>
  recoveryStatus():
    | { tag: 'NotRun' }
    | { tag: 'Failed' }
    | { tag: 'Completed'; inner: { report: { isComplete: boolean } } }
  history(): Promise<Array<{
    id: number
    status: string
    subsystemKind: string
    intendedBalanceSats: bigint
    effectiveBalanceSats: bigint
    offchainFeeSats: bigint
    createdAt: string
    completedAt?: string
    paymentHash?: string
    sentToAddresses: string[]
    receivedOnAddresses: string[]
  }>>
  newAddress(): Promise<string>
  sync(): Promise<void>
  validateArkoorAddress(address: string): Promise<boolean>
  sendArkoorPayment(address: string, amountSats: bigint): Promise<void>
  stopDaemonWait(): Promise<void>
  uniffiDestroy?(): void
}

export interface NativeBarkConfig {
  serverAddress: string
  esploraAddress: string
  daemonManualSync: boolean
}

export interface NativeBarkOpenArgs {
  datadir: string
  runDaemon: boolean
  createIfNotExists: boolean
  createWithoutServer: boolean
  skipRecovery: boolean
}

export interface NativeBarkModule {
  Network: { Bitcoin: number; Testnet: number; Signet: number; Regtest: number }
  Wallet: {
    open(network: number, mnemonic: string, config: NativeBarkConfig, args: NativeBarkOpenArgs): Promise<NativeBarkWallet>
  }
}

export async function loadBarkNative(): Promise<NativeBarkModule> {
  // Optional native peer: hosts without Bark must be able to build the engine.
  // @ts-ignore -- native peer is installed only by the React Native host.
  return import('@secondts/bark-react-native')
}
