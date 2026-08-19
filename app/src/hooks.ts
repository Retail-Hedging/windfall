import { useQuery } from '@tanstack/react-query'
import { decodeEventLog, encodeEventTopics, formatUnits, getAbiItem, type Address, type Hex } from 'viem'
import { useAccount, usePublicClient, useReadContract, useReadContracts } from 'wagmi'
import { ADDRESSES, CHAIN_ID, USDC_DECIMALS, aavePoolAbi, erc20Abi, prizePoolAbi, vaultAbi } from './config'

export const VAULT_DEPLOY_BLOCK = 50154354n
const BLOCKSCOUT = 'https://base.blockscout.com/api'
const SD59X18 = 1e18

// ---------- Account balances ----------

export function useAccountData() {
  const { address } = useAccount()
  const enabled = !!address
  const q = useReadContracts({
    contracts: [
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'balanceOf', args: [address ?? '0x0000000000000000000000000000000000000000'] },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'maxWithdraw', args: [address ?? '0x0000000000000000000000000000000000000000'] },
      { address: ADDRESSES.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address ?? '0x0000000000000000000000000000000000000000'] },
      { address: ADDRESSES.usdc, abi: erc20Abi, functionName: 'allowance', args: [address ?? '0x0000000000000000000000000000000000000000', ADDRESSES.vault] },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'totalSupply' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'totalAssets' }
    ],
    query: { enabled, refetchInterval: 15_000 }
  })
  const r = q.data
  const shares = (r?.[0]?.result as bigint | undefined) ?? 0n
  const withdrawable = (r?.[1]?.result as bigint | undefined) ?? 0n
  const usdcBalance = (r?.[2]?.result as bigint | undefined) ?? 0n
  const allowance = (r?.[3]?.result as bigint | undefined) ?? 0n
  const totalSupply = (r?.[4]?.result as bigint | undefined) ?? 0n
  const totalAssets = (r?.[5]?.result as bigint | undefined) ?? 0n
  const shareOfVault = totalSupply > 0n ? Number(shares) / Number(totalSupply) : 0
  return { address, shares, withdrawable, usdcBalance, allowance, totalSupply, totalAssets, shareOfVault, isLoading: q.isLoading, refetch: q.refetch }
}

// ---------- Prize pool / tiers / odds ----------

export interface TierInfo {
  tier: number
  label: string
  prizeSizeWei: bigint
  prizeCount: number
  tierOdds: number // probability this tier is awarded in a draw
  perDrawChance: number // your chance of winning ≥1 prize of this tier in a draw
}

/** Aave v3 USDC supply APY on Base (from currentLiquidityRate, ray = 1e27) */
export function useAaveApy() {
  const q = useReadContract({
    address: ADDRESSES.aavePool,
    abi: aavePoolAbi,
    functionName: 'getReserveData',
    args: [ADDRESSES.usdc],
    query: { refetchInterval: 120_000 }
  })
  const rate = q.data ? Number(q.data.currentLiquidityRate) / 1e27 : 0 // APR
  const apy = rate > 0 ? Math.pow(1 + rate / 31_536_000, 31_536_000) - 1 : 0
  return { apr: rate, apy, isLoading: q.isLoading }
}

export function usePrizeInfo(shareOfVault: number, opts?: { vaultTotalAssets?: bigint; apy?: number; ethUsd?: number }) {
  const base = useReadContracts({
    contracts: [
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'numberOfTiers' },
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'getOpenDrawId' },
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'getLastAwardedDrawId' },
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'drawPeriodSeconds' }
    ],
    query: { refetchInterval: 60_000 }
  })
  const numTiers = Number(base.data?.[0]?.result ?? 0)
  const openDrawId = Number(base.data?.[1]?.result ?? 0)
  const lastAwardedDrawId = Number(base.data?.[2]?.result ?? 0)
  const drawPeriodSeconds = Number(base.data?.[3]?.result ?? 86400)

  const closesAt = useReadContract({
    address: ADDRESSES.prizePool,
    abi: prizePoolAbi,
    functionName: 'drawClosesAt',
    args: [openDrawId],
    query: { enabled: openDrawId > 0 }
  })
  const lastClosedAt = useReadContract({
    address: ADDRESSES.prizePool,
    abi: prizePoolAbi,
    functionName: 'drawClosesAt',
    args: [lastAwardedDrawId],
    query: { enabled: lastAwardedDrawId > 0 }
  })

  // Vault's share of the whole prize pool over the last 7 draws (approximation of the accrual window)
  const startDraw = Math.max(1, lastAwardedDrawId - 6)
  const endDraw = Math.max(1, lastAwardedDrawId)
  const contrib = useReadContracts({
    contracts: [
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'getVaultPortion', args: [ADDRESSES.vault, startDraw, endDraw] },
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'getContributedBetween', args: [ADDRESSES.vault, startDraw, endDraw] },
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'getTotalContributedBetween', args: [startDraw, endDraw] }
    ],
    query: { enabled: lastAwardedDrawId > 0, refetchInterval: 60_000 }
  })
  const actualPortion = contrib.data?.[0]?.result !== undefined ? Number(contrib.data[0].result as bigint) / SD59X18 : 0
  const vaultContribWei = (contrib.data?.[1]?.result as bigint | undefined) ?? 0n
  const totalContribWei = (contrib.data?.[2]?.result as bigint | undefined) ?? 0n
  const drawsInWindow = endDraw - startDraw + 1

  // Projected portion for a vault whose yield hasn't been liquidated into the pool yet:
  // our expected daily contribution (TVL × APY / 365 × 90%) vs the pool's actual daily contributions.
  let projectedPortion = 0
  const tvlUsd = opts?.vaultTotalAssets ? Number(formatUnits(opts.vaultTotalAssets, USDC_DECIMALS)) : 0
  if (opts?.apy && opts?.ethUsd && tvlUsd > 0 && totalContribWei > 0n) {
    const ourDailyUsd = (tvlUsd * opts.apy) / 365 * 0.9
    const poolDailyUsd = (Number(formatUnits(totalContribWei, 18)) / drawsInWindow) * opts.ethUsd
    projectedPortion = ourDailyUsd / (poolDailyUsd + ourDailyUsd)
  }
  const isProjected = actualPortion === 0 && projectedPortion > 0
  const vaultPortion = actualPortion > 0 ? actualPortion : projectedPortion

  const tierIdx = Array.from({ length: numTiers }, (_, i) => i)
  const tiers = useReadContracts({
    contracts: tierIdx.flatMap((t) => [
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'getTierPrizeSize', args: [t] } as const,
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'getTierPrizeCount', args: [t] } as const,
      { address: ADDRESSES.prizePool, abi: prizePoolAbi, functionName: 'getTierOdds', args: [t, numTiers] } as const
    ]),
    query: { enabled: numTiers > 0, refetchInterval: 60_000 }
  })

  const info: TierInfo[] = tierIdx.map((t) => {
    const size = (tiers.data?.[t * 3]?.result as bigint | undefined) ?? 0n
    const count = Number(tiers.data?.[t * 3 + 1]?.result ?? 0)
    const odds = Number((tiers.data?.[t * 3 + 2]?.result as bigint | undefined) ?? 0n) / SD59X18
    const pOne = odds * vaultPortion * shareOfVault
    const perDrawChance = count > 0 ? 1 - Math.pow(1 - Math.min(pOne, 1), count) : 0
    const isCanary = t >= numTiers - 2
    const label = t === 0 ? 'Grand prize' : isCanary ? 'Micro prize' : `Tier ${t}`
    return { tier: t, label, prizeSizeWei: size, prizeCount: count, tierOdds: odds, perDrawChance }
  })

  // chance of winning at least one prize of any tier in a draw
  const anyPrizeChance = 1 - info.reduce((acc, t) => acc * (1 - t.perDrawChance), 1)

  return {
    numTiers,
    openDrawId,
    lastAwardedDrawId,
    drawPeriodSeconds,
    drawClosesAt: closesAt.data ? Number(closesAt.data) : undefined,
    lastDrawClosedAt: lastClosedAt.data ? Number(lastClosedAt.data) : undefined,
    vaultPortion,
    actualPortion,
    projectedPortion,
    isProjected,
    vaultContribWei,
    totalContribWei,
    drawsInWindow,
    anyPrizeChance,
    tiers: info,
    isLoading: base.isLoading || tiers.isLoading
  }
}

/** Vault-level stats for the /stats page */
export function useVaultStats() {
  const q = useReadContracts({
    contracts: [
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'totalAssets' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'totalSupply' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'availableYieldBalance' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'yieldFeeBalance' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'yieldFeePercentage' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'yieldFeeRecipient' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'owner' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'liquidationPair' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'currentYieldBuffer' },
      { address: ADDRESSES.vault, abi: vaultAbi, functionName: 'totalYieldBalance' }
    ],
    query: { refetchInterval: 15_000 }
  })
  const r = q.data
  const g = <T,>(i: number, d: T): T => (r?.[i]?.result as T | undefined) ?? d
  return {
    totalAssets: g<bigint>(0, 0n),
    totalSupply: g<bigint>(1, 0n),
    availableYield: g<bigint>(2, 0n),
    feeBalanceShares: g<bigint>(3, 0n),
    feePct: Number(g<number>(4, 0)) / 1e9,
    feeRecipient: g<Address>(5, '0x0000000000000000000000000000000000000000'),
    owner: g<Address>(6, '0x0000000000000000000000000000000000000000'),
    liquidationPair: g<Address>(7, '0x0000000000000000000000000000000000000000'),
    yieldBuffer: g<bigint>(8, 0n),
    totalYield: g<bigint>(9, 0n),
    isLoading: q.isLoading,
    refetch: q.refetch
  }
}

/** Unique depositors + deposit count from vault Deposit events (Blockscout; best-effort) */
export function useDepositorStats() {
  return useQuery({
    queryKey: ['depositorStats'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const topic0 = encodeEventTopics({ abi: vaultAbi, eventName: 'Deposit' })[0]!
      const logs = await fetchLogsBlockscout({ address: ADDRESSES.vault, topic0 })
      const owners = new Set<string>()
      let deposits = 0
      for (const l of logs) {
        try {
          const ev = decodeEventLog({ abi: vaultAbi, eventName: 'Deposit', data: l.data, topics: l.topics as [Hex, ...Hex[]] })
          owners.add(ev.args.owner.toLowerCase()); deposits++
        } catch {}
      }
      return { depositors: owners.size, deposits }
    }
  })
}

export function useEthPrice() {
  return useQuery({
    queryKey: ['ethUsd'],
    queryFn: async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
      const j = await r.json()
      return Number(j?.ethereum?.usd) || 0
    },
    staleTime: 5 * 60_000
  })
}

// ---------- Activity (deposits, withdrawals, prizes) via Blockscout ----------

export interface ActivityItem {
  kind: 'deposit' | 'withdraw' | 'prize'
  amount: string // human-readable
  unit: 'USDC' | 'ETH'
  txHash: Hex
  blockNumber: number
  timestamp?: number
  drawId?: number // prizes only
  tier?: number // prizes only
}

type RawLog = { data: Hex; topics: Hex[]; transactionHash: Hex; blockNumber: Hex | bigint; timeStamp?: Hex }

async function fetchLogsBlockscout(params: Record<string, string>): Promise<RawLog[]> {
  const url = new URL(BLOCKSCOUT)
  url.searchParams.set('module', 'logs')
  url.searchParams.set('action', 'getLogs')
  url.searchParams.set('fromBlock', VAULT_DEPLOY_BLOCK.toString())
  url.searchParams.set('toBlock', 'latest')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const r = await fetch(url.toString(), { signal: AbortSignal.timeout(12_000) })
  const j = await r.json()
  if (j.status === '0' && /No records/i.test(String(j.message))) return []
  if (j.status !== '1' || !Array.isArray(j.result)) throw new Error('blockscout unavailable')
  return j.result as RawLog[]
}

export function useActivity(address?: Address) {
  const client = usePublicClient()
  return useQuery({
    queryKey: ['activity', CHAIN_ID, address],
    enabled: !!address,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ActivityItem[]> => {
      if (!address) return []
      const depTopics = encodeEventTopics({ abi: vaultAbi, eventName: 'Deposit', args: { owner: address } })
      const wdTopics = encodeEventTopics({ abi: vaultAbi, eventName: 'Withdraw', args: { owner: address } })
      const przTopics = encodeEventTopics({ abi: prizePoolAbi, eventName: 'ClaimedPrize', args: { vault: ADDRESSES.vault, winner: address } })

      let deps: RawLog[], wds: RawLog[], przs: RawLog[]
      try {
        ;[deps, wds, przs] = await Promise.all([
          fetchLogsBlockscout({ address: ADDRESSES.vault, topic0: depTopics[0]!, topic2: depTopics[2] as string, topic0_2_opr: 'and' }),
          fetchLogsBlockscout({ address: ADDRESSES.vault, topic0: wdTopics[0]!, topic3: wdTopics[3] as string, topic0_3_opr: 'and' }),
          fetchLogsBlockscout({ address: ADDRESSES.prizePool, topic0: przTopics[0]!, topic1: przTopics[1] as string, topic2: przTopics[2] as string, topic0_1_opr: 'and', topic1_2_opr: 'and', topic0_2_opr: 'and' })
        ])
      } catch {
        // Fallback: recent window via RPC (free RPCs cap eth_getLogs at ~10k blocks ≈ 5.5h on Base)
        if (!client) return []
        const latest = await client.getBlockNumber()
        const fromBlock = latest - 9_000n > VAULT_DEPLOY_BLOCK ? latest - 9_000n : VAULT_DEPLOY_BLOCK
        const toRaw = (ls: any[]): RawLog[] => ls.map((l) => ({ data: l.data, topics: l.topics, transactionHash: l.transactionHash, blockNumber: l.blockNumber }))
        ;[deps, wds, przs] = await Promise.all([
          client.getLogs({ address: ADDRESSES.vault, event: getAbiItem({ abi: vaultAbi, name: 'Deposit' }), args: { owner: address }, fromBlock, toBlock: 'latest' }).then(toRaw),
          client.getLogs({ address: ADDRESSES.vault, event: getAbiItem({ abi: vaultAbi, name: 'Withdraw' }), args: { owner: address }, fromBlock, toBlock: 'latest' }).then(toRaw),
          client.getLogs({ address: ADDRESSES.prizePool, event: getAbiItem({ abi: prizePoolAbi, name: 'ClaimedPrize' }), args: { vault: ADDRESSES.vault, winner: address }, fromBlock, toBlock: 'latest' }).then(toRaw)
        ])
      }

      const items: ActivityItem[] = []
      for (const l of deps) {
        try {
          const ev = decodeEventLog({ abi: vaultAbi, eventName: 'Deposit', data: l.data, topics: l.topics as [Hex, ...Hex[]] })
          items.push({ kind: 'deposit', amount: formatUnits(ev.args.assets, USDC_DECIMALS), unit: 'USDC', txHash: l.transactionHash, blockNumber: Number(l.blockNumber), timestamp: l.timeStamp ? Number(l.timeStamp) : undefined })
        } catch {}
      }
      for (const l of wds) {
        try {
          const ev = decodeEventLog({ abi: vaultAbi, eventName: 'Withdraw', data: l.data, topics: l.topics as [Hex, ...Hex[]] })
          items.push({ kind: 'withdraw', amount: formatUnits(ev.args.assets, USDC_DECIMALS), unit: 'USDC', txHash: l.transactionHash, blockNumber: Number(l.blockNumber), timestamp: l.timeStamp ? Number(l.timeStamp) : undefined })
        } catch {}
      }
      for (const l of przs) {
        try {
          const ev = decodeEventLog({ abi: prizePoolAbi, eventName: 'ClaimedPrize', data: l.data, topics: l.topics as [Hex, ...Hex[]] })
          items.push({ kind: 'prize', amount: formatUnits(ev.args.payout, 18), unit: 'ETH', txHash: l.transactionHash, blockNumber: Number(l.blockNumber), timestamp: l.timeStamp ? Number(l.timeStamp) : undefined, drawId: Number(ev.args.drawId), tier: Number(ev.args.tier) })
        } catch {}
      }
      return items.sort((a, b) => b.blockNumber - a.blockNumber)
    }
  })
}
