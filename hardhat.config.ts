import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// Prefer explicit ETH_RPC_URL if provided, otherwise use a public RPC
const RPC_URL = process.env.ETH_RPC_URL ?? "https://eth.llamarpc.com";

// Allow using PK, or fall back to SPONSOR_PK / COMPROMISED_PK for convenience
const ACCOUNT_PK = process.env.PK ?? process.env.SPONSOR_PK ?? process.env.COMPROMISED_PK;
if (!ACCOUNT_PK) {
  // Allow running read-only tasks without a key
  console.warn(
    "[hardhat] No private key found. Set PK or SPONSOR_PK/COMPROMISED_PK in .env for signing."
  );
}

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },
  defaultNetwork: "mainnet",
  networks: {
    mainnet: {
      url: RPC_URL,
      accounts: ACCOUNT_PK ? [ACCOUNT_PK] : [],
      chainId: 1,
    },
  },
};

export default config;
