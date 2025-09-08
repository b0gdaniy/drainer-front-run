# Drainer Front‑Run (Flashbots)

Hardhat + Ethers v5 script that sends a bundled transaction to Flashbots relays to:

- Fund a compromised account from a sponsor within the bundle.
- Call a bridge `exit(bytes inputData)` using your full `EXIT_INPUT_HEX` proof bytes.
- Optionally sweep an ERC‑20 token to a safe address via `transfer(to, amount)`.
- Target Ethereum mainnet only (chainId 1) with multi‑relay submission and simulation before sending.

Use responsibly. This script interacts with mainnet and signs with private keys.

## Requirements

- Node.js LTS (v18 or v20 recommended). Hardhat may warn on unsupported Node versions.
- npm or pnpm/yarn. Example commands use npm.
- An Ethereum RPC. Defaults to `https://eth.llamarpc.com`, but you should set a reliable `ETH_RPC_URL`.

## Install

```bash
npm i
```

## Configure .env

Copy `.env.example` to `.env` and fill the fields. Required vs optional:

- ETH_RPC_URL (optional): RPC endpoint. Defaults to `https://eth.llamarpc.com`.
- PK (optional): Used by Hardhat for general tasks. Not required for the Flashbots script.
- COMPROMISED_PK (required): Private key of the compromised account.
- SPONSOR_PK (required): Private key of the sponsor who pays and funds the compromised account in‑bundle.
- BRIDGE_ADDRESS (required): Bridge contract implementing `exit(bytes)` on mainnet.
- SAFE_ADDRESS (required): Recipient of any swept tokens.
- BUDGET_IN_WEI (required): Amount of ETH (in wei) to transfer from sponsor to compromised inside the bundle. Used to cap gas price.
- EXIT_INPUT_HEX (required): Full calldata bytes for `exit(bytes)`. Must start with `0x` and include the entire proof payload.
- ERC20_TO_SWEEP (optional): Token address to sweep after the claim.
- SWEEP_AMOUNT_WEI (optional): Amount (in token base units) to transfer. Defaults to `1e18` if omitted.

Example:

```env
ETH_RPC_URL=https://your-mainnet-rpc
PK=0xabc... # optional
COMPROMISED_PK=0xcompromised...
SPONSOR_PK=0xsponsor...
BRIDGE_ADDRESS=0xbridge...
SAFE_ADDRESS=0xsafe...
BUDGET_IN_WEI=300000000000000000 # 0.3 ETH budget
EXIT_INPUT_HEX=0xYourFullExitProofBytes
# Optional sweep
ERC20_TO_SWEEP=0xtoken...
SWEEP_AMOUNT_WEI=1000000000000000000 # 1 token if 18 decimals
```

Security: Never commit `.env`. Keys in `.env` are live credentials. Rotate any key that might have leaked.

## Commands

- Verify mainnet connectivity (read‑only):
  - `npm run chainid`
  - This prints the provider `chainId` using `scripts/test.ts`.

- Run Flashbots bundle (main flow):
  - `npm run flashbot`
  - Uses `scripts/flashbot.ts`. Requires all required env vars set and the sponsor account funded.

## What the Flashbots script does

1) Reads env vars and validates required ones. Fails fast with clear errors if missing.
2) Connects to mainnet via Hardhat provider. Enforces `chainId === 1`.
3) ABI‑encodes `exit(bytes)` using `EXIT_INPUT_HEX` and optionally encodes an ERC‑20 `transfer`.
4) Estimates gas for the claim. Adds a buffer (+20%). Uses a fixed estimate for the token transfer (85,000).
5) Computes a gas price budget from `BUDGET_IN_WEI` and skips blocks where the budget isn’t enough to cover base fee + tip + safety.
6) Builds a bundle:
   - Tx1: Sponsor -> Compromised (value = `BUDGET_IN_WEI`).
   - Tx2: Compromised -> Bridge `exit(bytes)`.
   - Tx3 (optional): Compromised -> ERC‑20 `transfer(SAFE_ADDRESS, amount)`.
7) Simulates, then sends the signed bundle concurrently to multiple relays (Flashbots, Beaverbuild, Titan, Ethermine) for the next block. Repeats for several attempts if not included.

Notes:
- If `ERC20_TO_SWEEP` is not set, the sweep step is skipped; only funding + claim are sent.
- `BUDGET_IN_WEI` is both the funding value and the cap driver for max fees. Ensure it comfortably covers estimated gas at your target fees.
- The sponsor must hold enough ETH to fund the bundle transfer and pay for the first transaction’s gas.
- Inclusion is not guaranteed; the script retries for multiple blocks.

## Troubleshooting

- Missing env vars: The script will throw a descriptive error. Check `.env` names and formats.
- Unsupported Node warning: Use Node v18 or v20 for best compatibility with Hardhat.
- RPC errors or rate limits: Switch `ETH_RPC_URL` to a more reliable provider.
- Estimate gas fails for claim: Ensure `BRIDGE_ADDRESS` is correct and `EXIT_INPUT_HEX` is valid for the current bridge state.

## Development Notes

- Hardhat config reads `PK` (or `SPONSOR_PK`/`COMPROMISED_PK`) if present. If no key is set, read‑only tasks still work.
- There are no contracts in this repo; it’s script‑only. `npx hardhat compile` shows “Nothing to compile”.
