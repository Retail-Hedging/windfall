import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits, parseUnits, type Address } from 'viem'
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { ADDRESSES, BASESCAN, CABANA_VAULT_URL, CHAIN_ID, USDC_DECIMALS, erc20Abi, vaultAbi } from './config'
import { oddsFor, useAaveApy, useAccountData, useActivity, useBalancesFor, useDepositorLedger, useDepositorStats, useEthPrice, usePrizeInfo, useVaultStats } from './hooks'
import { config } from './wagmi'

const fmtUsd = (n: number, d = 2) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtUsdc = (v: bigint, d = 2) => fmtUsd(Number(formatUnits(v, USDC_DECIMALS)), d)
const short = (a?: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '')
const oneIn = (p: number) => (p <= 0 ? '—' : p >= 0.999 ? 'near-certain' : '1 in ' + Math.round(1 / p).toLocaleString())
const pct = (p: number, d = 2) => (p * 100).toFixed(d) + '%'
// Prize sizes: whole dollars above $10, cents to $0.01, otherwise fractions of a cent (e.g. 0.08¢) so micro-prizes never read as $0.00
const fmtPrize = (usd: number) => usd >= 10 ? fmtUsd(usd, 0) : usd >= 0.01 ? fmtUsd(usd, 2) : usd > 0 ? (usd * 100).toPrecision(2).replace(/\.?0+$/, '') + '¢' : '$0'

// ---------- tiny hash router ----------
function useRoute() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const f = () => setHash(location.hash)
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])
  return hash.startsWith('#/stats') ? 'stats' : 'account'
}

export function App() {
  const { address, isConnected, chainId } = useAccount()
  const route = useRoute()
  const wrongChain = isConnected && chainId !== CHAIN_ID
  return (
    <div className="wrap">
      <header>
        <a className="logo" href="/windfall/">
          <CubeMark />
          Windfall<small>by Retail Hedging</small>
        </a>
        <nav className="nav">
          <a href="/windfall/about.html">How it works</a>
          <a href="#/" className={route === 'account' ? 'on' : ''}>Account</a>
          <a href="#/stats" className={route === 'stats' ? 'on' : ''}>Vault stats</a>
          <ConnectControls />
        </nav>
      </header>
      {route === 'stats' ? (
        <StatsPage />
      ) : !isConnected ? (
        <Landing />
      ) : wrongChain ? (
        <WrongChain />
      ) : (
        <Dashboard address={address!} />
      )}
      <footer>
        <p>Windfall is operated by Retail Hedging: a non-custodial interface to a PoolTogether V5 prize vault on Base; yield from Aave v3 funds daily prize draws. Not a bank; not FDIC or NCUA insured; no guaranteed returns; smart-contract and stablecoin risk apply. <a href="/windfall/about.html#risks">Risks</a></p>
        <p>Vault <a href={`${BASESCAN}/address/${ADDRESSES.vault}`} target="_blank" rel="noopener">{ADDRESSES.vault}</a> · <a href={CABANA_VAULT_URL} target="_blank" rel="noopener">View on Cabana</a></p>
      </footer>
    </div>
  )
}

function CubeMark() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <path fill="currentColor" d="M50 8 88 30v40L50 92 12 70V30z" />
      <path fill="none" style={{ stroke: 'var(--bg)' }} strokeWidth="2" strokeLinejoin="round" d="M12 30 50 52 88 30M50 52v40" />
    </svg>
  )
}

function ConnectControls() {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  if (!isConnected) return null
  return (
    <span className="acct">
      <span className="pill mono">{short(address)}</span>
      <button className="link" onClick={() => disconnect()}>Sign out</button>
    </span>
  )
}

function Landing() {
  const { connectors, connect, isPending, error } = useConnect()
  const coinbase = connectors.find((c) => c.id === 'coinbaseWalletSDK')
  const injected = connectors.find((c) => c.id === 'injected')
  return (
    <section className="hero card">
      <h1>Account</h1>
      <p className="muted">Sign in with a passkey to see your balance, deposit or withdraw, and check your odds. New here? The same button creates your account.</p>
      <div className="btnrow">
        {coinbase && (
          <button className="btn primary" disabled={isPending} onClick={() => connect({ connector: coinbase })}>
            {isPending ? 'Opening…' : 'Sign in / Create account'}
          </button>
        )}
        {injected && (
          <button className="btn ghost" disabled={isPending} onClick={() => connect({ connector: injected })}>
            Use browser wallet
          </button>
        )}
      </div>
      <p className="fine">"Sign in" opens Coinbase Smart Wallet — a passkey wallet (Face ID / Windows Hello). No seed phrase. First time? It creates one in about 30 seconds.</p>
      {error && <p className="err">{error.message}</p>}
    </section>
  )
}

function WrongChain() {
  const { switchChain, isPending } = useSwitchChain()
  return (
    <section className="card hero">
      <h2>Switch to Base</h2>
      <p className="muted">Your wallet is on another network. Windfall runs on Base.</p>
      <button className="btn primary" disabled={isPending} onClick={() => switchChain({ chainId: CHAIN_ID })}>Switch network</button>
    </section>
  )
}

// ---------- pending transaction tracking ----------
type Pending = { kind: 'deposit' | 'withdraw'; amount: string; hash?: `0x${string}`; startedAt: number; step?: string }

function usePendingTx(acct: ReturnType<typeof useAccountData>) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const qc = useQueryClient()
  const startBalance = useRef<bigint>(0n)

  // While pending: poll balance every 2.5s until it changes (works even if the receipt lookup lags), max 3 min
  useEffect(() => {
    if (!pending) return
    const id = setInterval(async () => {
      const r = await acct.refetch()
      const now = (r.data?.[1]?.result as bigint | undefined) ?? undefined
      const changed = now !== undefined && now !== startBalance.current
      const timedOut = Date.now() - pending.startedAt > 180_000
      if (changed || timedOut) {
        clearInterval(id)
        setPending(null)
        qc.invalidateQueries({ queryKey: ['activity'] })
        setToast(changed ? (pending.kind === 'deposit' ? `Deposit of ${fmtUsd(Number(pending.amount))} confirmed. It's in your balance.` : `Withdrawal of ${fmtUsd(Number(pending.amount))} confirmed. USDC is back in your wallet.`) : 'Still confirming — check Activity in a minute.')
        setTimeout(() => setToast(null), 8000)
      }
    }, 2500)
    return () => clearInterval(id)
  }, [pending?.startedAt])

  const begin = (kind: Pending['kind'], amount: string) => {
    startBalance.current = acct.withdrawable
    setPending({ kind, amount, startedAt: Date.now(), step: kind === 'deposit' ? 'Waiting for your approval in the wallet…' : 'Waiting for your approval in the wallet…' })
  }
  const update = (patch: Partial<Pending>) => setPending((p) => (p ? { ...p, ...patch } : p))
  const fail = (msg: string) => { setPending(null); setToast(msg); setTimeout(() => setToast(null), 8000) }
  return { pending, toast, begin, update, fail }
}

function Dashboard({ address }: { address: Address }) {
  const acct = useAccountData()
  const eth = useEthPrice()
  const aave = useAaveApy()
  const ethUsd = eth.data ?? 0
  const prize = usePrizeInfo(acct.shareOfVault, { vaultTotalAssets: acct.totalAssets, apy: aave.apy, ethUsd })
  const activity = useActivity(address)
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit')
  const tx = usePendingTx(acct)

  const totalDeposited = useMemo(() => (activity.data ?? []).filter((a) => a.kind === 'deposit').reduce((s, a) => s + Number(a.amount), 0), [activity.data])
  const totalWithdrawn = useMemo(() => (activity.data ?? []).filter((a) => a.kind === 'withdraw').reduce((s, a) => s + Number(a.amount), 0), [activity.data])
  const prizesWonEth = useMemo(() => (activity.data ?? []).filter((a) => a.kind === 'prize').reduce((s, a) => s + Number(a.amount), 0), [activity.data])
  const balanceUsd = Number(formatUnits(acct.withdrawable, USDC_DECIMALS))
  const unseenPrizes = useUnseenPrizes(activity)
  const unseenEth = unseenPrizes.unseen.reduce((s, p) => s + Number(p.amount), 0)

  return (
    <>
      {unseenPrizes.unseen.length > 0 && (
        <div className="banner won">
          <div>
            <b>You won {ethUsd ? fmtPrize(unseenEth * ethUsd) : `${unseenEth.toFixed(5)} ETH`}</b>
            <div className="fine">{unseenPrizes.unseen.length} prize{unseenPrizes.unseen.length > 1 ? 's' : ''} since your last visit — paid to your wallet as ETH.</div>
          </div>
          <button className="link" onClick={unseenPrizes.dismiss}>Got it</button>
        </div>
      )}
      {tx.pending && (
        <div className="banner pending">
          <span className="spinner" />
          <div>
            <b>{tx.pending.kind === 'deposit' ? 'Depositing' : 'Withdrawing'} {fmtUsd(Number(tx.pending.amount))}</b>
            <div className="fine">{tx.pending.step} {tx.pending.hash && <a href={`${BASESCAN}/tx/${tx.pending.hash}`} target="_blank" rel="noopener">view on Basescan ↗</a>}</div>
          </div>
        </div>
      )}
      {tx.toast && <div className="banner ok">{tx.toast}</div>}

      <section className="card balance">
        <div className="bal-top">
          <div>
            <div className="label">Prize savings balance</div>
            <div className="big">{acct.isLoading ? '…' : fmtUsdc(acct.withdrawable)}</div>
            <div className="fine">Withdrawable now · Account {short(address)} · updates automatically</div>
          </div>
          <div className="stats">
            <Stat label="Deposited" value={fmtUsd(totalDeposited)} />
            <Stat label="Withdrawn" value={fmtUsd(totalWithdrawn)} />
            <Stat label="Prizes won" value={prizesWonEth > 0 && ethUsd ? fmtPrize(prizesWonEth * ethUsd) : prizesWonEth > 0 ? `${prizesWonEth.toFixed(6)} ETH` : '$0'} sub={prizesWonEth > 0 ? `${prizesWonEth.toFixed(6)} ETH` : undefined} />
            <Stat label="Your share of vault" value={pct(acct.shareOfVault)} sub={`Vault total ${fmtUsdc(acct.totalAssets, 0)}`} />
          </div>
        </div>
        <div className="tabs">
          <button className={tab === 'deposit' ? 'tab on' : 'tab'} onClick={() => setTab('deposit')}>Deposit</button>
          <button className={tab === 'withdraw' ? 'tab on' : 'tab'} onClick={() => setTab('withdraw')}>Withdraw</button>
        </div>
        {tab === 'deposit' ? <DepositForm acct={acct} tx={tx} prize={prize} apy={aave.apy} ethUsd={ethUsd} /> : <WithdrawForm acct={acct} tx={tx} />}
      </section>

      <DailyReveal prize={prize} activity={activity} balanceUsd={balanceUsd} ethUsd={ethUsd} apy={aave.apy} address={address} />

      <section className="card">
        <div className="sec-head">
          <h2>Your odds</h2>
          <NextDraw closesAt={prize.drawClosesAt} />
        </div>
        {acct.withdrawable === 0n ? (
          <p className="muted">Deposit to enter the daily draws. Every dollar in your balance is one entry in every draw, for as long as it stays deposited.</p>
        ) : (
          <>
            <div className="odds-summary">
              <div>
                <div className="label">Chance of a prize (1¢ or more) in the next draw</div>
                <div className="big2">{oneIn(prize.anyPrizeChance)}</div>
              </div>
              <div>
                <div className="label">Chance of the grand prize per draw</div>
                <div className="big2">{oneIn(prize.tiers[0]?.perDrawChance ?? 0)}</div>
              </div>
              <div>
                <div className="label">Your entries</div>
                <div className="big2">{Math.floor(balanceUsd).toLocaleString()}</div>
                <div className="fine">= your balance in dollars · {pct(acct.shareOfVault)} of this vault</div>
              </div>
            </div>
            {prize.isProjected && (
              <p className="note">Projected: this vault is new, so its yield hasn't been converted into prize-pool contributions yet (that happens automatically, usually within a day or two). These odds assume the vault's {pct(aave.apy, 1)} Aave yield flows in at the current pool size. They'll switch to live figures once it does.</p>
            )}
          </>
        )}
        <h3 className="sub-h">Prize tiers</h3>
        <div className="tiers">
          {prize.tiers.map((t) => {
            const ethAmt = Number(formatUnits(t.prizeSizeWei, 18))
            const usd = ethAmt * ethUsd
            return (
              <div className="tier" key={t.tier}>
                <div className="tier-name">{t.label}</div>
                <div className="tier-size">{ethUsd ? fmtPrize(usd) : ethAmt.toFixed(6) + ' ETH'}</div>
                <div className="tier-meta">{t.prizeCount.toLocaleString()} prize{t.prizeCount === 1 ? '' : 's'} per draw · this tier pays out {t.tierOdds >= 0.999 ? 'every draw' : `about every ${Math.round(1 / Math.max(t.tierOdds, 1e-9))} draws`}</div>
                <div className="tier-odds">Your odds per draw: <b>{oneIn(t.perDrawChance)}</b></div>
              </div>
            )
          })}
        </div>
        <p className="fine">Draws are daily. Odds are estimates from your share of this vault and the vault's share of the prize pool over the last {prize.drawsInWindow} draws{prize.isProjected ? ' (projected)' : ''}. Prizes are paid in ETH straight to your account by the protocol; dollar figures use the current ETH price.</p>
      </section>

      <section className="card">
        <h2>Activity</h2>
        {tx.pending && (
          <div className="pending-row"><span className="spinner" /> {tx.pending.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} of {fmtUsd(Number(tx.pending.amount))} — confirming…</div>
        )}
        {activity.isLoading ? (
          <p className="muted">Loading…</p>
        ) : !activity.data?.length ? (
          <p className="muted">{tx.pending ? '' : 'No activity yet.'}</p>
        ) : (
          <table className="activity">
            <tbody>
              {activity.data.map((a) => (
                <tr key={a.txHash + a.kind + a.amount}>
                  <td className="when">{a.timestamp ? new Date(a.timestamp * 1000).toLocaleString() : 'block ' + a.blockNumber}</td>
                  <td>{a.kind === 'deposit' ? 'Deposit' : a.kind === 'withdraw' ? 'Withdrawal' : 'Prize won'}</td>
                  <td className={'amt ' + (a.kind === 'withdraw' ? 'neg' : 'pos')}>
                    {a.kind === 'withdraw' ? '−' : '+'}{a.unit === 'USDC' ? fmtUsd(Number(a.amount)) : (ethUsd ? fmtPrize(Number(a.amount) * ethUsd) + ` (${Number(a.amount).toFixed(6)} ETH)` : `${Number(a.amount).toFixed(6)} ETH`)}
                  </td>
                  <td><a href={`${BASESCAN}/tx/${a.txHash}`} target="_blank" rel="noopener">receipt ↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="fine">History can take a minute to appear after a transaction. Your balance above is always live.</p>
      </section>
    </>
  )
}

// ---------- Daily reveal ----------

const LS_REVEALED = 'wf.revealedDraws'
const LS_SEEN_PRIZE = 'wf.lastSeenPrizeTx'
const readLS = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } }
const writeLS = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

function useUnseenPrizes(activity: ReturnType<typeof useActivity>) {
  const [seenTx, setSeenTx] = useState<string | null>(() => readLS<string | null>(LS_SEEN_PRIZE, null))
  const prizes = (activity.data ?? []).filter((a) => a.kind === 'prize')
  const newestTx = prizes[0]?.txHash ?? null
  const unseen = seenTx ? prizes.filter((p) => p.blockNumber > (prizes.find((x) => x.txHash === seenTx)?.blockNumber ?? 0)) : prizes
  const dismiss = () => { if (newestTx) { writeLS(LS_SEEN_PRIZE, newestTx); setSeenTx(newestTx) } }
  return { unseen, dismiss }
}

function DailyReveal({ prize, activity, balanceUsd, ethUsd, apy, address }: { prize: ReturnType<typeof usePrizeInfo>; activity: ReturnType<typeof useActivity>; balanceUsd: number; ethUsd: number; apy: number; address: Address }) {
  const key = `${LS_REVEALED}.${address.toLowerCase()}`
  const [revealed, setRevealed] = useState<number[]>(() => readLS<number[]>(key, []))
  const [animating, setAnimating] = useState(false)
  const drawId = prize.lastAwardedDrawId
  const isRevealed = revealed.includes(drawId)
  const nowS = Date.now() / 1000
  const closedAt = prize.lastDrawClosedAt ?? 0
  const finalized = closedAt > 0 && nowS - closedAt > 6 * 3600 // give bots time to award + claim
  const wins = (activity.data ?? []).filter((a) => a.kind === 'prize' && a.drawId === drawId)
  const wonEth = wins.reduce((s, w) => s + Number(w.amount), 0)
  const firstDeposit = (activity.data ?? []).filter((a) => a.kind === 'deposit').slice(-1)[0]
  const daysIn = firstDeposit?.timestamp ? Math.max(1, Math.floor((nowS - firstDeposit.timestamp) / 86400) + 1) : (balanceUsd > 0 ? 1 : 0)
  const dailyContribution = (balanceUsd * apy) / 365 * 0.9
  const streak = (() => {
    // consecutive awarded draws revealed, ending at the latest revealed
    const set = new Set(revealed); let n = 0; let d = isRevealed ? drawId : drawId - 1
    while (set.has(d)) { n++; d-- }
    return n
  })()

  function reveal() {
    setAnimating(true)
    setTimeout(() => {
      const next = Array.from(new Set([...revealed, drawId])).slice(-400)
      writeLS(key, next); setRevealed(next); setAnimating(false)
    }, 900)
  }

  if (drawId === 0) return null

  return (
    <section className="card reveal">
      <div className="sec-head">
        <h2>Draw #{drawId}</h2>
        <span className="pill">{closedAt ? 'closed ' + timeAgo(closedAt) : ''}{finalized ? '' : ' · results settling'}</span>
      </div>
      {balanceUsd <= 0 && !isRevealed ? (
        <p className="muted">Deposit to be in tomorrow's draw. Every dollar is an entry.</p>
      ) : !isRevealed ? (
        <div className="reveal-box">
          <div className="reveal-meta">You had <b>{Math.floor(balanceUsd).toLocaleString()}</b> entries in this draw{!finalized ? ' · prizes may still be on their way' : ''}.</div>
          <button className={'btn primary reveal-btn' + (animating ? ' shaking' : '')} onClick={reveal} disabled={animating}>{animating ? 'Drawing…' : 'Reveal my result'}</button>
        </div>
      ) : (
        <div className={'reveal-result' + (wonEth > 0 ? ' won' : '')}>
          {wonEth > 0 ? (
            <>
              <div className="big2">You won {ethUsd ? fmtPrize(wonEth * ethUsd) : `${wonEth.toFixed(5)} ETH`}</div>
              <div className="fine">{wins.length} prize{wins.length > 1 ? 's' : ''} · {wins.map((w) => (w.tier === 0 ? 'grand prize' : `tier ${w.tier}`)).join(', ')} · paid to your wallet as ETH.</div>
            </>
          ) : (
            <>
              <div className="big2">No prize this draw</div>
              <div className="fine">{finalized ? 'Your entries roll into the next draw automatically.' : 'Results are still settling for a few hours — a prize can still land. Your entries roll into the next draw automatically.'}</div>
            </>
          )}
        </div>
      )}
      <div className="counters">
        <div><div className="label">Days in the draw</div><div className="val">{daysIn}</div></div>
        <div><div className="label">Reveal streak</div><div className="val">{streak}</div></div>
        <div><div className="label">Your money adds to the pot</div><div className="val">{fmtUsd(dailyContribution, dailyContribution < 0.1 ? 3 : 2)}<span className="fine"> / day</span></div></div>
        <div><div className="label">Next draw</div><div className="val"><NextDraw closesAt={prize.drawClosesAt} plain /></div></div>
      </div>
    </section>
  )
}

function timeAgo(ts: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="val">{value}</div>
      {sub && <div className="fine">{sub}</div>}
    </div>
  )
}

function NextDraw({ closesAt, plain }: { closesAt?: number; plain?: boolean }) {
  const [now, setNow] = useState(Date.now() / 1000)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(id)
  }, [])
  if (!closesAt) return plain ? <>…</> : null
  const s = Math.max(0, Math.floor(closesAt - now))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (plain) return <>{h}h {m}m {sec}s</>
  return <div className="pill">Next draw in {h}h {m}m {sec}s</div>
}

// ---------- Deposit ----------

function DepositForm({ acct, tx, prize, apy, ethUsd }: { acct: ReturnType<typeof useAccountData>; tx: ReturnType<typeof usePendingTx>; prize: ReturnType<typeof usePrizeInfo>; apy: number; ethUsd: number }) {
  const [amt, setAmt] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const { writeContractAsync } = useWriteContract()

  const value = (() => { try { return amt ? parseUnits(amt, USDC_DECIMALS) : 0n } catch { return 0n } })()
  const tooMuch = value > acct.usdcBalance
  const busy = !!tx.pending
  const canSubmit = value > 0n && !tooMuch && !busy

  // ---- odds calculator: current vs after this deposit ----
  const addUsd = Number(formatUnits(value, USDC_DECIMALS))
  const curBal = Number(formatUnits(acct.withdrawable, USDC_DECIMALS))
  const curTvl = Number(formatUnits(acct.totalAssets, USDC_DECIMALS))
  const newBal = curBal + addUsd, newTvl = curTvl + addUsd
  const curShare = curTvl > 0 ? curBal / curTvl : 0
  const newShare = newTvl > 0 ? newBal / newTvl : 0
  // vault's share of the pool grows with TVL: rescale the (actual or projected) portion for the new TVL
  const portionAt = (tvl: number) => {
    if (prize.actualPortion > 0 && curTvl > 0) return Math.min(1, prize.actualPortion * (tvl / curTvl))
    const poolDailyUsd = prize.totalContribWei > 0n && ethUsd ? (Number(formatUnits(prize.totalContribWei, 18)) / prize.drawsInWindow) * ethUsd : 0
    if (!apy || !poolDailyUsd) return 0
    const ours = (tvl * apy) / 365 * 0.9
    return ours / (poolDailyUsd + ours)
  }
  const oddsNow = oddsFor(prize.tiers, portionAt(curTvl), curShare)
  const oddsAfter = oddsFor(prize.tiers, portionAt(newTvl), newShare)
  const monthly = (p: number) => 1 - Math.pow(1 - p, 30)
  const evYear = (bal: number) => bal * apy * 0.9
  const calcReady = prize.tiers.length > 0 && !prize.isLoading

  async function submit() {
    setErr(null)
    const human = formatUnits(value, USDC_DECIMALS)
    tx.begin('deposit', human)
    try {
      if (acct.allowance < value) {
        tx.update({ step: 'Step 1 of 2 — approve USDC in your wallet…' })
        const h1 = await writeContractAsync({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: 'approve', args: [ADDRESSES.vault, value] })
        tx.update({ hash: h1, step: 'Step 1 of 2 — approval confirming on Base…' })
        await waitForTransactionReceipt(config, { hash: h1 })
      }
      tx.update({ step: 'Step 2 of 2 — confirm the deposit in your wallet…' })
      const h2 = await writeContractAsync({ address: ADDRESSES.vault, abi: vaultAbi, functionName: 'deposit', args: [value, acct.address!] })
      tx.update({ hash: h2, step: 'Deposit sent — confirming on Base (usually 5–20 seconds)…' })
      setAmt('')
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || 'Transaction failed'
      setErr(msg)
      tx.fail(/reject|denied|cancel/i.test(msg) ? 'Cancelled in wallet — nothing was sent.' : 'Transaction failed: ' + msg)
    }
  }

  return (
    <div className="form">
      <label>Amount (USDC)</label>
      <div className="amt-row">
        <input inputMode="decimal" placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} disabled={busy} />
        <button className="link" onClick={() => setAmt(formatUnits(acct.usdcBalance, USDC_DECIMALS))}>Max</button>
      </div>
      <div className="fine">Available in wallet: {fmtUsdc(acct.usdcBalance)} USDC {acct.usdcBalance === 0n && <>· <a href="https://wallet.coinbase.com" target="_blank" rel="noopener">add USDC on Base with a card ↗</a></>}</div>
      {tooMuch && <div className="err">That's more USDC than your wallet holds.</div>}

      <div className="calc">
        <div className="calc-head">
          <span className="label">What this deposit buys you</span>
          <span className="chips">{[100, 1000, 10000].map((v) => <button key={v} className={'chip' + (addUsd === v ? ' on' : '')} onClick={() => setAmt(String(v))} disabled={busy}>{fmtUsd(v, 0)}</button>)}</span>
        </div>
        {!calcReady ? (
          <div className="fine">Loading prize data…</div>
        ) : (
          <table className="calc-t">
            <thead><tr><th></th><th>Now</th><th>After deposit</th></tr></thead>
            <tbody>
              <tr><td>Entries in every draw</td><td>{Math.floor(curBal).toLocaleString()}</td><td><b>{Math.floor(newBal).toLocaleString()}</b></td></tr>
              <tr><td>Chance of a prize (1¢ or more) per draw</td><td>{oneIn(oddsNow.any)}</td><td><b>{oneIn(oddsAfter.any)}</b></td></tr>
              <tr><td>Chance of a prize (1¢ or more) in a month</td><td>{oneIn(monthly(oddsNow.any))}</td><td><b>{oneIn(monthly(oddsAfter.any))}</b></td></tr>
              <tr><td>Grand prize, per draw</td><td>{oneIn(oddsNow.grand)}</td><td><b>{oneIn(oddsAfter.grand)}</b></td></tr>
              <tr><td>Expected prizes per year (long-run avg.)</td><td>{fmtUsd(evYear(curBal))}</td><td><b>{fmtUsd(evYear(newBal))}</b></td></tr>
            </tbody>
          </table>
        )}
        <div className="fine">Estimates. Odds scale with your balance; prizes are random, so any single year can be more or less than the average. {prize.isProjected ? 'Projected while the vault\'s first yield reaches the pool.' : ''}</div>
      </div>

      <button className="btn primary wide" disabled={!canSubmit} onClick={submit}>
        {busy ? 'Working…' : acct.allowance < value && value > 0n ? 'Approve & deposit' : 'Deposit'}
      </button>
      {err && <div className="err">{err}</div>}
      <p className="fine">Your USDC goes straight from your wallet into the Windfall vault contract. Withdraw anytime.</p>
    </div>
  )
}

// ---------- Withdraw ----------

function WithdrawForm({ acct, tx }: { acct: ReturnType<typeof useAccountData>; tx: ReturnType<typeof usePendingTx> }) {
  const [amt, setAmt] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const { writeContractAsync } = useWriteContract()

  const value = (() => { try { return amt ? parseUnits(amt, USDC_DECIMALS) : 0n } catch { return 0n } })()
  const all = value > 0n && value >= acct.withdrawable
  const tooMuch = value > acct.withdrawable
  const busy = !!tx.pending
  const canSubmit = value > 0n && !tooMuch && !busy

  async function submit() {
    setErr(null)
    const human = formatUnits(all ? acct.withdrawable : value, USDC_DECIMALS)
    tx.begin('withdraw', human)
    try {
      tx.update({ step: 'Confirm the withdrawal in your wallet…' })
      const h = all
        ? await writeContractAsync({ address: ADDRESSES.vault, abi: vaultAbi, functionName: 'redeem', args: [acct.shares, acct.address!, acct.address!] })
        : await writeContractAsync({ address: ADDRESSES.vault, abi: vaultAbi, functionName: 'withdraw', args: [value, acct.address!, acct.address!] })
      tx.update({ hash: h, step: 'Withdrawal sent — confirming on Base (usually 5–20 seconds)…' })
      setAmt('')
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || 'Transaction failed'
      setErr(msg)
      tx.fail(/reject|denied|cancel/i.test(msg) ? 'Cancelled in wallet — nothing was sent.' : 'Transaction failed: ' + msg)
    }
  }

  return (
    <div className="form">
      <label>Amount (USDC)</label>
      <div className="amt-row">
        <input inputMode="decimal" placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} disabled={busy} />
        <button className="link" onClick={() => setAmt(formatUnits(acct.withdrawable, USDC_DECIMALS))}>Withdraw all</button>
      </div>
      <div className="fine">Available to withdraw: {fmtUsdc(acct.withdrawable)}</div>
      {tooMuch && <div className="err">That's more than your balance.</div>}
      <button className="btn primary wide" disabled={!canSubmit} onClick={submit}>
        {busy ? 'Working…' : all ? 'Withdraw everything' : 'Withdraw'}
      </button>
      {err && <div className="err">{err}</div>}
      <p className="fine">USDC returns to your wallet immediately. From there, cash out to your bank via Coinbase.</p>
    </div>
  )
}

// ---------- Vault stats (public) + owner actions ----------

function StatsPage() {
  const s = useVaultStats()
  const aave = useAaveApy()
  const eth = useEthPrice()
  const ethUsd = eth.data ?? 0
  const prize = usePrizeInfo(1, { vaultTotalAssets: s.totalAssets, apy: aave.apy, ethUsd })
  const dep = useDepositorStats()
  const { address } = useAccount()
  const isOwner = !!address && address.toLowerCase() === s.owner.toLowerCase()
  const isRecipient = !!address && address.toLowerCase() === s.feeRecipient.toLowerCase()

  const tvl = Number(formatUnits(s.totalAssets, USDC_DECIMALS))
  const yearlyYield = tvl * aave.apy
  const feeYear = yearlyYield * s.feePct
  const prizeYear = yearlyYield - feeYear
  const feeBalUsd = Number(formatUnits(s.feeBalanceShares, USDC_DECIMALS)) // shares ≈ 1:1 with USDC
  const vaultContribEth = Number(formatUnits(prize.vaultContribWei, 18))
  const totalContribEth = Number(formatUnits(prize.totalContribWei, 18))

  return (
    <>
      <section className="card">
        <div className="sec-head"><h2>Vault stats</h2><span className="pill">live · refreshes every 15s</span></div>
        <div className="grid4">
          <Stat label="Total in vault (TVL)" value={fmtUsd(tvl)} sub={`${dep.data?.depositors ?? '…'} depositors · ${dep.data?.deposits ?? '…'} deposits`} />
          <Stat label="Aave USDC supply APY" value={pct(aave.apy)} sub={`APR ${pct(aave.apr)}`} />
          <Stat label="Projected yield / year" value={fmtUsd(yearlyYield)} sub={`${fmtUsd(yearlyYield / 365, 4)} per day`} />
          <Stat label="Yield fee" value={pct(s.feePct, 0)} sub={`≈ ${fmtUsd(feeYear)} / yr to fee recipient`} />
          <Stat label="To prize pool / year" value={fmtUsd(prizeYear)} sub={`${fmtUsd(prizeYear / 365, 4)} per day`} />
          <Stat label="Yield waiting to be liquidated" value={fmtUsdc(s.availableYield, 4)} sub={`total yield ${fmtUsdc(s.totalYield, 4)} · buffer ${fmtUsdc(s.yieldBuffer, 2)}`} />
          <Stat label="Fees accrued (claimable)" value={fmtUsd(feeBalUsd, 4)} sub={`recipient ${short(s.feeRecipient)}`} />
          <Stat label="Vault share of prize pool" value={prize.actualPortion > 0 ? pct(prize.actualPortion, 4) : `${pct(prize.projectedPortion, 4)} (projected)`} sub={`last ${prize.drawsInWindow} draws: vault ${vaultContribEth.toFixed(5)} ETH of ${totalContribEth.toFixed(3)} ETH`} />
        </div>
      </section>

      <section className="card">
        <h2>Prize pool (Base)</h2>
        <div className="grid4">
          <Stat label="Open draw" value={'#' + prize.openDrawId} sub={prize.drawClosesAt ? 'closes ' + new Date(prize.drawClosesAt * 1000).toLocaleString() : ''} />
          <Stat label="Last awarded draw" value={'#' + prize.lastAwardedDrawId} />
          <Stat label="Tiers" value={String(prize.numTiers)} />
          <Stat label="ETH price" value={ethUsd ? fmtUsd(ethUsd, 0) : '…'} sub="CoinGecko" />
        </div>
        <table className="activity" style={{ marginTop: 12 }}>
          <thead><tr><th>Tier</th><th>Prize</th><th>Prizes/draw</th><th>Tier frequency</th><th>Odds for a $1 depositor</th></tr></thead>
          <tbody>
            {prize.tiers.map((t) => {
              const usd = Number(formatUnits(t.prizeSizeWei, 18)) * ethUsd
              const perDollar = tvl > 0 ? 1 - Math.pow(1 - Math.min(t.tierOdds * prize.vaultPortion * (1 / tvl), 1), t.prizeCount) : 0
              return (
                <tr key={t.tier}>
                  <td>{t.label}</td>
                  <td>{fmtPrize(usd)}</td>
                  <td>{t.prizeCount.toLocaleString()}</td>
                  <td>{t.tierOdds >= 0.999 ? 'every draw' : `1 in ${Math.round(1 / t.tierOdds)} draws`}</td>
                  <td>{oneIn(perDollar)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Contracts</h2>
        <table className="activity">
          <tbody>
            <Row k="Prize vault" v={ADDRESSES.vault} />
            <Row k="Yield vault (Aave waBasUSDC)" v={ADDRESSES.yieldVault} />
            <Row k="Liquidation pair" v={s.liquidationPair} />
            <Row k="Prize pool" v={ADDRESSES.prizePool} />
            <Row k="Owner" v={s.owner} />
            <Row k="Fee recipient" v={s.feeRecipient} />
          </tbody>
        </table>
      </section>

      {(isOwner || isRecipient) && <DepositorsPanel enabled={isOwner || isRecipient} />}
      {(isOwner || isRecipient) && <OwnerPanel s={s} isOwner={isOwner} isRecipient={isRecipient} />}
      {!address && <p className="fine">Sign in as the vault owner to see admin actions.</p>}
    </>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="when">{k}</td>
      <td className="mono"><a href={`${BASESCAN}/address/${v}`} target="_blank" rel="noopener">{v}</a></td>
    </tr>
  )
}

function DepositorsPanel({ enabled }: { enabled: boolean }) {
  const ledger = useDepositorLedger(enabled)
  const rows = ledger.data ?? []
  const owners = rows.map((r) => r.owner)
  const { balances } = useBalancesFor(owners)
  const [sort, setSort] = useState<'balance' | 'deposited' | 'last'>('balance')
  const withBal = rows.map((r) => ({ ...r, balance: balances[r.owner.toLowerCase()] ?? NaN }))
  const active = withBal.filter((r) => r.balance > 0.000001)
  const totalBal = active.reduce((s, r) => s + r.balance, 0)
  const totalIn = rows.reduce((s, r) => s + r.deposited, 0)
  const totalOut = rows.reduce((s, r) => s + r.withdrawn, 0)
  const largest = active.reduce((m, r) => Math.max(m, r.balance), 0)
  const median = (() => { const a = active.map((r) => r.balance).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0 })()
  const sorted = [...withBal].sort((a, b) => sort === 'balance' ? (b.balance || 0) - (a.balance || 0) : sort === 'deposited' ? b.deposited - a.deposited : (b.lastTs ?? b.lastBlock) - (a.lastTs ?? a.lastBlock))
  const csv = () => {
    const lines = [['address', 'balance_usdc', 'deposited_usdc', 'withdrawn_usdc', 'deposits', 'withdrawals', 'first_deposit', 'last_activity'].join(',')]
    for (const r of sorted) lines.push([r.owner, r.balance.toFixed(6), r.deposited.toFixed(6), r.withdrawn.toFixed(6), r.deposits, r.withdrawals, r.firstTs ? new Date(r.firstTs * 1000).toISOString() : '', r.lastTs ? new Date(r.lastTs * 1000).toISOString() : ''].join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'windfall-depositors.csv'; a.click()
  }
  return (
    <section className="card admin">
      <div className="sec-head">
        <h2>Depositors</h2>
        <span className="fine">Owner view · built from on-chain Deposit/Withdraw events · refreshes every minute</span>
      </div>
      <div className="grid4" style={{ marginBottom: 14 }}>
        <Stat label="Active depositors" value={ledger.isLoading ? '…' : String(active.length)} sub={`${rows.length} ever deposited`} />
        <Stat label="Total balances" value={fmtUsd(totalBal)} sub={`in ${fmtUsd(totalIn)} · out ${fmtUsd(totalOut)}`} />
        <Stat label="Average balance" value={active.length ? fmtUsd(totalBal / active.length) : '—'} sub={`median ${fmtUsd(median)}`} />
        <Stat label="Largest balance" value={fmtUsd(largest)} sub={totalBal > 0 ? `${pct(largest / totalBal, 0)} of vault` : undefined} />
      </div>
      <div className="sec-head">
        <span className="fine">Sort by: {(['balance', 'deposited', 'last'] as const).map((k) => <button key={k} className={'chip' + (sort === k ? ' on' : '')} style={{ marginLeft: 6 }} onClick={() => setSort(k)}>{k === 'last' ? 'last activity' : k}</button>)}</span>
        <button className="link" onClick={csv} disabled={!rows.length}>Download CSV</button>
      </div>
      {ledger.isLoading ? <p className="muted">Loading ledger…</p> : !rows.length ? <p className="muted">No deposits yet.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="activity">
            <thead><tr><th>Address</th><th style={{ textAlign: 'right' }}>Balance</th><th style={{ textAlign: 'right' }}>Deposited</th><th style={{ textAlign: 'right' }}>Withdrawn</th><th style={{ textAlign: 'right' }}>Txs</th><th>First deposit</th><th>Last activity</th></tr></thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.owner}>
                  <td className="mono"><a href={`${BASESCAN}/address/${r.owner}`} target="_blank" rel="noopener">{short(r.owner)}</a></td>
                  <td className="amt">{Number.isNaN(r.balance) ? '…' : fmtUsd(r.balance)}</td>
                  <td className="amt pos">{fmtUsd(r.deposited)}</td>
                  <td className="amt neg">{r.withdrawn ? fmtUsd(r.withdrawn) : '—'}</td>
                  <td className="amt">{r.deposits + r.withdrawals}</td>
                  <td className="when">{r.firstTs ? new Date(r.firstTs * 1000).toLocaleDateString() : '—'}</td>
                  <td className="when">{r.lastTs ? new Date(r.lastTs * 1000).toLocaleString() : 'block ' + r.lastBlock}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">Addresses are public on Base; this view is gated only for convenience. The fee recipient's own address will appear here once fees are claimed as shares.</p>
    </section>
  )
}

function OwnerPanel({ s, isOwner, isRecipient }: { s: ReturnType<typeof useVaultStats>; isOwner: boolean; isRecipient: boolean }) {
  const { writeContractAsync } = useWriteContract()
  const [msg, setMsg] = useState<string | null>(null)
  const [newRecipient, setNewRecipient] = useState('')
  const [newPct, setNewPct] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(label: string, fn: () => Promise<`0x${string}`>) {
    setBusy(true); setMsg(label + '…')
    try {
      const h = await fn()
      await waitForTransactionReceipt(config, { hash: h })
      setMsg(label + ' ✓')
      s.refetch()
    } catch (e: any) {
      setMsg('Failed: ' + (e?.shortMessage || e?.message))
    } finally { setBusy(false) }
  }

  return (
    <section className="card admin">
      <h2>Admin</h2>
      <p className="fine">You're signed in as the vault {isOwner ? 'owner' : ''}{isOwner && isRecipient ? ' and ' : ''}{isRecipient ? 'fee recipient' : ''}.</p>
      {isRecipient && (
        <div className="admin-row">
          <div><b>Claim accrued fees</b><div className="fine">Mints {fmtUsdc(s.feeBalanceShares, 4)} of vault shares to the fee recipient. Withdraw them like any deposit afterwards.</div></div>
          <button className="btn primary" disabled={busy || s.feeBalanceShares === 0n} onClick={() => run('Claiming fees', () => writeContractAsync({ address: ADDRESSES.vault, abi: vaultAbi, functionName: 'claimYieldFeeShares', args: [s.feeBalanceShares] }))}>Claim</button>
        </div>
      )}
      {isOwner && (
        <>
          <div className="admin-row">
            <div><b>Change fee recipient</b><div className="fine">Current: {s.feeRecipient}</div><input className="txt" placeholder="0x… new recipient (e.g. company Safe)" value={newRecipient} onChange={(e) => setNewRecipient(e.target.value.trim())} /></div>
            <button className="btn ghost" disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(newRecipient)} onClick={() => run('Updating recipient', () => writeContractAsync({ address: ADDRESSES.vault, abi: vaultAbi, functionName: 'setYieldFeeRecipient', args: [newRecipient as Address] }))}>Update</button>
          </div>
          <div className="admin-row">
            <div><b>Change yield fee %</b><div className="fine">Current: {pct(s.feePct, 0)} · max 90%</div><input className="txt" placeholder="e.g. 10" value={newPct} onChange={(e) => setNewPct(e.target.value.replace(/[^0-9.]/g, ''))} /></div>
            <button className="btn ghost" disabled={busy || !(Number(newPct) >= 0 && Number(newPct) <= 90)} onClick={() => run('Updating fee', () => writeContractAsync({ address: ADDRESSES.vault, abi: vaultAbi, functionName: 'setYieldFeePercentage', args: [Math.round(Number(newPct) * 1e7)] }))}>Update</button>
          </div>
        </>
      )}
      {msg && <p className="fine">{msg}</p>}
    </section>
  )
}
