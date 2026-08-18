# Founder setup — deploy the Windfall vault (Base, Aave USDC, 10% yield fee)

Do this once. Needs a wallet with ~$15 of ETH on Base and $0.10 USDC. The old no-code UI at
`factory.cabana.fi` is gone (NXDOMAIN as of 2026-08-18), so run the same UI locally (Option A)
or call the factory contract directly (Option B).

## Verified addresses (Base, chain 8453)

| Thing | Address | Source |
|---|---|---|
| Yield source: Aave "Wrapped Aave Base USDC" (ERC-4626, Aave-governance stata token) | `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6` | bgd-labs/aave-address-book `AaveV3BaseAssets.USDC_STATA_TOKEN`; verified on-chain name/asset |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | |
| PrizeVaultFactory | `0xa55a74A457D8a24D68DdA0b5d1E0341746d444Bf` | pooltogether-client-monorepo `VAULT_FACTORY_ADDRESSES` |
| PrizePool | `0x45b2010d8A4f08b53c9fa7544C51dFd9733732cb` | monorepo `PRIZE_POOLS` |
| Default Claimer | `0xcdCE635b774DE77cdF791647601dba64a75547ba` | monorepo `DEFAULT_CLAIMER_ADDRESSES` |
| LiquidationPairFactory | `0x8557a9a33b573dc4403708c5a8746a52648374ea` | monorepo `LIQUIDATION_PAIR_FACTORY_ADDRESSES` |
| Reference: official "Prize USDC - Moonwell" vault (0% fee, ~$3.3M TVL) | `0x7f5C2b379b88499aC2B997Db583f8079503f25b9` | used as site fallback |

Re-verify every address against the source before signing anything.

## Option A — run the vault factory UI locally (recommended, ~30 min)

```bash
git clone https://github.com/GenerationSoftware/pooltogether-client-monorepo
cd pooltogether-client-monorepo
pnpm install
cp apps/vault-factory/.env.example apps/vault-factory/.env
# set NEXT_PUBLIC_BASE_RPC_URL (Alchemy/Infura/publicnode: https://base-rpc.publicnode.com)
pnpm --filter vault-factory dev      # http://localhost:3002
```

In the UI: network **Base** → deposit token USDC → yield source: paste `0xC768…DBD6` (custom ERC-4626)
→ name `Windfall USDC`, symbol `wfUSDC` → yield fee `10`% → fee recipient = treasury address →
owner = treasury address → deploy. The UI does all three steps: (1) approve 0.1 USDC yield buffer,
(2) `deployVault`, (3) create + set the LiquidationPair. Copy the vault address at the end.

## Option B — direct contract calls (basescan "Write Contract")

1. USDC `approve(0xa55a…4Bf, 100000)` — the factory pulls a 0.1 USDC yield buffer from you.
2. PrizeVaultFactory `deployVault(`
   `"Windfall USDC", "wfUSDC",`
   `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6,`   yieldVault
   `0x45b2010d8A4f08b53c9fa7544C51dFd9733732cb,`   prizePool
   `0xcdCE635b774DE77cdF791647601dba64a75547ba,`   claimer
   `<TREASURY>,`                                   yieldFeeRecipient
   `100000000,`                                    yieldFeePercentage = 10% of 1e9
   `100000,`                                       yieldBuffer = 0.1 USDC
   `<TREASURY>)`                                   owner
   Read the `NewPrizeVault` event for the vault address.
3. LiquidationPairFactory `createPair(...)` for (source = new vault, tokenIn = WETH prize token
   `0x4200000000000000000000000000000000000006`, tokenOut = vault shares) — copy params from an existing
   Base USDC vault's pair (see `liquidationPair()` on `0x7f5C…25b9`) if unsure.
4. Vault `setLiquidationPair(<pair>)` from the owner address.

Without step 3–4 the vault accrues yield but never converts it to prizes.

## After deploy

1. Paste vault address into `VAULT_ADDRESS` in `index.html`, commit, push `main`.
2. Deposit $1 first. Wait one draw (daily on Base) and confirm the vault appears at
   `app.cabana.fi/vault/8453/<address>` with a nonzero prize yield.
3. Fees: `yieldFeeRecipient` can call `claimYieldFeeShares()` on the vault. Move ownership /
   recipient to a Safe multisig once TVL matters.

## Wallet for non-crypto founders

Coinbase Smart Wallet (passkey, no seed phrase): https://wallet.coinbase.com → create → fund with
debit card → pick **Base** network for both ETH (gas) and USDC.
