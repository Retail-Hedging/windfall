import { useEffect, useMemo, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { ADDRESSES, BASESCAN, CABANA_VAULT_URL, CHAIN_ID, USDC_DECIMALS, erc20Abi, vaultAbi } from './config'
import { useAccountData, useActivity, useEthPrice, usePrizeInfo } from './hooks'
import { config } from './wagmi'

const fmtUsd = (n: number, d = 2) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtUsdc = (v: bigint, d = 2) => fmtUsd(Number(formatUnits(v, USDC_DECIMALS)), d)
const short = (a?: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '')
const oneIn = (p: number) => (p <= 0 ? '—' : p >= 1 ? 'certain' : '1 in ' + Math.round(1 / p).toLocaleString())

export function App() {
  const { address, isConnected, chainId } = useAccount()
  const wrongChain = isConnected && chainId !== CHAIN_ID
  return (
    <div className="wrap">
      <header>
        <a className="logo" href="/windfall/">Wind<span>fall</span></a>
        <ConnectControls />
      </header>
      {!isConnected ? <Landing /> : wrongChain ? <WrongChain /> : <Dashboard address={address!} />}
      <footer>
        <p>Windfall is a non-custodial prize-savings vault on Base built on PoolTogether V5. Yield from Aave v3 funds daily prize draws. Not a bank, not FDIC insured, no guaranteed returns; smart-contract and stablecoin risk apply.</p>
        <p>Vault <a href={`${BASESCAN}/address/${ADDRESSES.vault}`} target="_blank" rel="noopener">{ADDRESSES.vault}</a> · <a href={CABANA_VAULT_URL} target="_blank" rel="noopener">View on Cabana</a></p>
      </footer>
    </div>
  )
}

function ConnectControls() {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  if (!isConnected) return null
  return (
    <div className="acct">
      <span className="pill mono">{short(address)}</span>
      <button className="link" onClick={() => disconnect()}>Sign out</button>
    </div>
  )
}

function Landing() {
  const { connectors, connect, isPending, error } = useConnect()
  const coinbase = connectors.find((c) => c.id === 'coinbaseWalletSDK')
  const injected = connectors.find((c) => c.id === 'injected')
  return (
    <section className="hero card">
      <h1>Your Windfall account</h1>
      <p className="muted">Sign in with a passkey to see your balance, deposit or withdraw, and check the prizes you're in the running for.</p>
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

function Dashboard({ address }: { address: `0x${string}` }) {
  const acct = useAccountData()
  const prize = usePrizeInfo(acct.shareOfVault)
  const eth = useEthPrice()
  const activity = useActivity(address)
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit')

  const ethUsd = eth.data ?? 0
  const balance = Number(formatUnits(acct.withdrawable, USDC_DECIMALS))
  const totalDeposited = useMemo(() => (activity.data ?? []).filter((a) => a.kind === 'deposit').reduce((s, a) => s + Number(a.amount), 0), [activity.data])
  const totalWithdrawn = useMemo(() => (activity.data ?? []).filter((a) => a.kind === 'withdraw').reduce((s, a) => s + Number(a.amount), 0), [activity.data])
  const prizesWonEth = useMemo(() => (activity.data ?? []).filter((a) => a.kind === 'prize').reduce((s, a) => s + Number(a.amount), 0), [activity.data])

  return (
    <>
      <section className="card balance">
        <div className="bal-top">
          <div>
            <div className="label">Prize savings balance</div>
            <div className="big">{acct.isLoading ? '…' : fmtUsdc(acct.withdrawable)}</div>
            <div className="fine">Withdrawable now · Account {short(address)}</div>
          </div>
          <div className="stats">
            <Stat label="Deposited" value={fmtUsd(totalDeposited)} />
            <Stat label="Withdrawn" value={fmtUsd(totalWithdrawn)} />
            <Stat label="Prizes won" value={prizesWonEth > 0 ? `${prizesWonEth.toFixed(5)} ETH` : '$0.00'} sub={prizesWonEth > 0 && ethUsd ? fmtUsd(prizesWonEth * ethUsd) : undefined} />
            <Stat label="Your share of vault" value={(acct.shareOfVault * 100).toFixed(2) + '%'} sub={`Vault total ${fmtUsdc(acct.totalAssets, 0)}`} />
          </div>
        </div>
        <div className="tabs">
          <button className={tab === 'deposit' ? 'tab on' : 'tab'} onClick={() => setTab('deposit')}>Deposit</button>
          <button className={tab === 'withdraw' ? 'tab on' : 'tab'} onClick={() => setTab('withdraw')}>Withdraw</button>
        </div>
        {tab === 'deposit' ? <DepositForm acct={acct} /> : <WithdrawForm acct={acct} />}
      </section>

      <section className="card">
        <div className="sec-head">
          <h2>Prizes you're in the running for</h2>
          <NextDraw closesAt={prize.drawClosesAt} />
        </div>
        {acct.withdrawable === 0n ? (
          <p className="muted">Deposit to enter the daily draws. Every dollar in your balance is an entry, every day, for as long as it stays deposited.</p>
        ) : prize.vaultPortion === 0 ? (
          <p className="muted">Your deposit is earning yield in Aave. The vault's first yield hasn't been converted into prize-pool contributions yet (that happens automatically, usually within a day or two). Odds appear once it has.</p>
        ) : null}
        <div className="tiers">
          {prize.tiers.map((t) => {
            const ethAmt = Number(formatUnits(t.prizeSizeWei, 18))
            return (
              <div className="tier" key={t.tier}>
                <div className="tier-name">{t.label}</div>
                <div className="tier-size">{ethUsd ? fmtUsd(ethAmt * ethUsd, ethAmt * ethUsd < 10 ? 2 : 0) : ethAmt.toFixed(4) + ' ETH'}</div>
                <div className="tier-meta">{t.prizeCount.toLocaleString()} prize{t.prizeCount === 1 ? '' : 's'} · awarded {t.tierOdds >= 0.999 ? 'every draw' : `~1 in ${Math.round(1 / Math.max(t.tierOdds, 1e-9))} draws`}</div>
                <div className="tier-odds">Your odds per draw: <b>{oneIn(t.perDrawChance)}</b></div>
              </div>
            )
          })}
        </div>
        <p className="fine">Odds are estimates based on your current share of this vault and the vault's recent share of the prize pool. Prize sizes are in ETH and change with the pool. Winnings are paid to your account automatically by the protocol.</p>
      </section>

      <section className="card">
        <h2>Activity</h2>
        {activity.isLoading ? (
          <p className="muted">Loading…</p>
        ) : !activity.data?.length ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <table className="activity">
            <tbody>
              {activity.data.map((a) => (
                <tr key={a.txHash + a.kind + a.amount}>
                  <td className="when">{a.timestamp ? new Date(a.timestamp * 1000).toLocaleString() : 'block ' + a.blockNumber}</td>
                  <td>{a.kind === 'deposit' ? 'Deposit' : a.kind === 'withdraw' ? 'Withdrawal' : 'Prize won 🎉'}</td>
                  <td className={'amt ' + (a.kind === 'withdraw' ? 'neg' : 'pos')}>
                    {a.kind === 'withdraw' ? '−' : '+'}{a.unit === 'USDC' ? fmtUsd(Number(a.amount)) : `${Number(a.amount).toFixed(5)} ETH`}
                  </td>
                  <td><a href={`${BASESCAN}/tx/${a.txHash}`} target="_blank" rel="noopener">receipt ↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
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

function NextDraw({ closesAt }: { closesAt?: number }) {
  const [now, setNow] = useState(Date.now() / 1000)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(id)
  }, [])
  if (!closesAt) return null
  const s = Math.max(0, Math.floor(closesAt - now))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return <div className="pill">Next draw in {h}h {m}m {sec}s</div>
}

// ---------- Deposit ----------

function DepositForm({ acct }: { acct: ReturnType<typeof useAccountData> }) {
  const [amt, setAmt] = useState('')
  const [phase, setPhase] = useState<'idle' | 'approving' | 'depositing' | 'done'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const { writeContractAsync } = useWriteContract()
  const [hash, setHash] = useState<`0x${string}` | undefined>()
  const receipt = useWaitForTransactionReceipt({ hash })

  const value = (() => { try { return amt ? parseUnits(amt, USDC_DECIMALS) : 0n } catch { return 0n } })()
  const tooMuch = value > acct.usdcBalance
  const canSubmit = value > 0n && !tooMuch && phase === 'idle'

  useEffect(() => {
    if (receipt.isSuccess && phase === 'depositing') {
      setPhase('done'); acct.refetch(); setAmt('')
      const t = setTimeout(() => setPhase('idle'), 4000)
      return () => clearTimeout(t)
    }
  }, [receipt.isSuccess])

  async function submit() {
    setErr(null)
    try {
      if (acct.allowance < value) {
        setPhase('approving')
        const h1 = await writeContractAsync({ address: ADDRESSES.usdc, abi: erc20Abi, functionName: 'approve', args: [ADDRESSES.vault, value] })
        setHash(h1)
        // wait for approval to land before depositing
        await waitFor(h1)
      }
      setPhase('depositing')
      const h2 = await writeContractAsync({ address: ADDRESSES.vault, abi: vaultAbi, functionName: 'deposit', args: [value, acct.address!] })
      setHash(h2)
    } catch (e: any) {
      setErr(e?.shortMessage || e?.message || 'Transaction failed')
      setPhase('idle')
    }
  }

  return (
    <div className="form">
      <label>Amount (USDC)</label>
      <div className="amt-row">
        <input inputMode="decimal" placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} />
        <button className="link" onClick={() => setAmt(formatUnits(acct.usdcBalance, USDC_DECIMALS))}>Max</button>
      </div>
      <div className="fine">Available in wallet: {fmtUsdc(acct.usdcBalance)} USDC {acct.usdcBalance === 0n && <>· <a href="https://wallet.coinbase.com" target="_blank" rel="noopener">add USDC on Base with a card ↗</a></>}</div>
      {tooMuch && <div className="err">That's more USDC than your wallet holds.</div>}
      <button className="btn primary wide" disabled={!canSubmit} onClick={submit}>
        {phase === 'approving' ? 'Step 1 of 2: approving USDC…' : phase === 'depositing' ? 'Step 2 of 2: depositing…' : phase === 'done' ? 'Deposited ✓' : acct.allowance < value && value > 0n ? 'Approve & deposit' : 'Deposit'}
      </button>
      {err && <div className="err">{err}</div>}
      <p className="fine">Your USDC goes straight from your wallet into the Windfall vault contract. Withdraw anytime.</p>
    </div>
  )
}

// ---------- Withdraw ----------

function WithdrawForm({ acct }: { acct: ReturnType<typeof useAccountData> }) {
  const [amt, setAmt] = useState('')
  const [phase, setPhase] = useState<'idle' | 'sending' | 'done'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const { writeContractAsync } = useWriteContract()
  const [hash, setHash] = useState<`0x${string}` | undefined>()
  const receipt = useWaitForTransactionReceipt({ hash })

  const value = (() => { try { return amt ? parseUnits(amt, USDC_DECIMALS) : 0n } catch { return 0n } })()
  const all = value > 0n && value >= acct.withdrawable
  const tooMuch = value > acct.withdrawable
  const canSubmit = value > 0n && !tooMuch && phase === 'idle'

  useEffect(() => {
    if (receipt.isSuccess && phase === 'sending') {
      setPhase('done'); acct.refetch(); setAmt('')
      const t = setTimeout(() => setPhase('idle'), 4000)
      return () => clearTimeout(t)
    }
  }, [receipt.isSuccess])

  async function submit() {
    setErr(null)
    try {
      setPhase('sending')
      const h = all
        ? await writeContractAsync({ address: ADDRESSES.vault, abi: vaultAbi, functionName: 'redeem', args: [acct.shares, acct.address!, acct.address!] })
        : await writeContractAsync({ address: ADDRESSES.vault, abi: vaultAbi, functionName: 'withdraw', args: [value, acct.address!, acct.address!] })
      setHash(h)
    } catch (e: any) {
      setErr(e?.shortMessage || e?.message || 'Transaction failed')
      setPhase('idle')
    }
  }

  return (
    <div className="form">
      <label>Amount (USDC)</label>
      <div className="amt-row">
        <input inputMode="decimal" placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} />
        <button className="link" onClick={() => setAmt(formatUnits(acct.withdrawable, USDC_DECIMALS))}>Withdraw all</button>
      </div>
      <div className="fine">Available to withdraw: {fmtUsdc(acct.withdrawable)}</div>
      {tooMuch && <div className="err">That's more than your balance.</div>}
      <button className="btn primary wide" disabled={!canSubmit} onClick={submit}>
        {phase === 'sending' ? 'Withdrawing…' : phase === 'done' ? 'Withdrawn ✓' : all ? 'Withdraw everything' : 'Withdraw'}
      </button>
      {err && <div className="err">{err}</div>}
      <p className="fine">USDC returns to your wallet immediately. From there, cash out to your bank via Coinbase.</p>
    </div>
  )
}

// wait for a tx receipt inside an async flow (no hooks)
async function waitFor(hash: `0x${string}`) {
  await waitForTransactionReceipt(config, { hash })
}
