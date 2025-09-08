import { ethers } from "hardhat";

async function main() {
  console.log(`${(await ethers.provider.getNetwork()).chainId}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
