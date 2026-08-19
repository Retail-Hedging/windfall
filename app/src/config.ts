import { parseAbi } from 'viem'

export const CHAIN_ID = 8453 // Base

export const ADDRESSES = {
  vault: '0x0ee63210597564db524a7b1f7502781bf19c832f',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  prizePool: '0x45b2010d8A4f08b53c9fa7544C51dFd9733732cb',
  weth: '0x4200000000000000000000000000000000000006'
} as const

export const CABANA_VAULT_URL = `https://app.cabana.fi/vault/${CHAIN_ID}/${ADDRESSES.vault}`
export const BASESCAN = 'https://basescan.org'

export const USDC_DECIMALS = 6

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)'
])

export const vaultAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function yieldFeePercentage() view returns (uint32)',
  'function liquidationPair() view returns (address)',
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'
])

export const prizePoolAbi = parseAbi([
  'function getOpenDrawId() view returns (uint24)',
  'function getLastAwardedDrawId() view returns (uint24)',
  'function drawClosesAt(uint24 drawId) view returns (uint48)',
  'function drawPeriodSeconds() view returns (uint48)',
  'function numberOfTiers() view returns (uint8)',
  'function getTierPrizeSize(uint8 tier) view returns (uint104)',
  'function getTierPrizeCount(uint8 tier) pure returns (uint32)',
  'function getTierOdds(uint8 tier, uint8 numTiers) view returns (int256)',
  'function getVaultPortion(address vault, uint24 startDrawIdInclusive, uint24 endDrawIdInclusive) view returns (int256)',
  'event ClaimedPrize(address indexed vault, address indexed winner, address indexed recipient, uint24 drawId, uint8 tier, uint32 prizeIndex, uint152 payout, uint96 claimReward, address claimRewardRecipient)'
])
