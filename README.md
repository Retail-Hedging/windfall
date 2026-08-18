# Windfall

Prize-linked stablecoin savings MVP. Static landing page + deep link to a PoolTogether V5 prize vault on Base.

- Site: https://retail-hedging.github.io/windfall/
- Non-custodial: users deposit from their own wallet into the vault contract. This repo never touches funds.

## Tier 1 — deploy the Windfall vault (one-time, founder task)

See [FOUNDER_SETUP.md](FOUNDER_SETUP.md): Aave v3 USDC on Base via Aave's official ERC-4626 stata token, 10% yield fee, verified addresses, and the two ways to deploy now that `factory.cabana.fi` is gone. Until then the site's deposit button points at PoolTogether's official Prize USDC vault on Base (0% fee).

## Waitlist

Form posts to formsubmit.co. First submission triggers a one-time activation email to the address in the form `action`. After activation, formsubmit gives a random-string endpoint — swap it in to hide the email.

## Local

Open `index.html` in a browser. No build step.
