import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

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
      url: "https://eth.llamarpc.com", // Public mainnet RPC
      accounts: [process.env.PK!], // Replace with your private key
      chainId: 1, // mainnet
    },
  },
};

export default config;
