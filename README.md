# Windfall

Prize-linked stablecoin savings MVP. Static landing page + deep link to a PoolTogether V5 prize vault on Base.

- Site: https://retail-hedging.github.io/windfall/
- Non-custodial: users deposit from their own wallet into the vault contract. This repo never touches funds.

## Tier 1 — deploy the vault (one-time, needs a wallet with ~$20 ETH on Base)

1. Go to https://factory.cabana.fi and connect a wallet on **Base** (chain 8453).
2. Yield source: pick an ERC-4626 USDC vault (Aave USDC on Base is listed; Morpho works too).
3. Vault name / symbol: `Windfall USDC` / `wfUSDC`.
4. Yield fee: start at `10`% (revenue). Fee recipient: your treasury address.
5. Deploy. Copy the vault address.
6. Paste it into `VAULT_ADDRESS` in `index.html`, commit, push. Deposit button now deep-links to `app.cabana.fi/vault/8453/<address>`.
7. Deposit $1 yourself to verify.

## Waitlist

Form posts to formsubmit.co. First submission triggers a one-time activation email to the address in the form `action`. After activation, formsubmit gives a random-string endpoint — swap it in to hide the email.

## Local

Open `index.html` in a browser. No build step.
