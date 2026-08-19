import { http, createConfig, fallback } from 'wagmi'
import { base } from 'wagmi/chains'
import { coinbaseWallet, injected } from 'wagmi/connectors'

export const config = createConfig({
  chains: [base],
  connectors: [
    coinbaseWallet({ appName: 'Windfall', preference: 'all' }),
    injected({ shimDisconnect: true })
  ],
  transports: {
    // publicnode for plain reads; drpc/mainnet.base.org as fallbacks (also handle eth_getLogs ≤10k blocks)
    [base.id]: fallback([http('https://base-rpc.publicnode.com'), http('https://base.drpc.org'), http('https://mainnet.base.org')])
  }
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
