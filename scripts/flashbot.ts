// Ethers v5 + Flashbots bundle: sponsor->compromised funding + Polygon claim + optional sweep
// ENV: ETH_RPC_URL, SPONSOR_PK, COMPROMISED_PK, SAFE_ADDRESS, BRIDGE_ADDRESS,
//      BUDGET_IN_WEI, ERC20_TO_SWEEP (optional), SWEEP_AMOUNT_WEI (optional), EXIT_INPUT_HEX

import { ethers } from "hardhat";
import { Wallet, utils, BigNumber, providers } from "ethers";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
  FlashbotsBundleTransaction,
  FlashbotsTransactionResponse,
} from "@flashbots/ethers-provider-bundle";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const provider: providers.JsonRpcProvider =
    ethers.provider as providers.JsonRpcProvider;
  const network = await provider.getNetwork();
  if (network.chainId !== 1) {
    // Flashbots main relay targets Ethereum mainnet
    throw new Error(`Expected mainnet (1), got chainId=${network.chainId}`);
  }

  const BRIDGE_ADDRESS = process.env.BRIDGE_ADDRESS;
  const ERC20 = process.env.ERC20_TO_SWEEP; // optional
  const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
  const COMPROMISED_PK = process.env.COMPROMISED_PK;
  const SPONSOR_PK = process.env.SPONSOR_PK;
  const BUDGET_IN_WEI = process.env.BUDGET_IN_WEI;

  // --- MAIN LOOP: try to get included within N blocks ---
  if (!BRIDGE_ADDRESS || !SAFE_ADDRESS || !COMPROMISED_PK || !SPONSOR_PK) {
    throw new Error(
      "Missing .env vars. Require BRIDGE_ADDRESS, SAFE_ADDRESS, COMPROMISED_PK, SPONSOR_PK"
    );
  }
  if (!BUDGET_IN_WEI) {
    throw new Error("Missing BUDGET_IN_WEI in .env");
  }
  const BUDGET = BigNumber.from(BUDGET_IN_WEI);

  // === ABI-ENCODED CALLDATA (no raw method IDs) ==============================
  // exit(bytes inputData) — pass your full exit proof as a single bytes argument:
  const EXIT_INPUT_HEX = process.env.EXIT_INPUT_HEX ?? "0xdata"; // <-- put your full exit input bytes here
  if (!EXIT_INPUT_HEX || EXIT_INPUT_HEX === "0xdata") {
    throw new Error("Provide EXIT_INPUT_HEX in .env with your full exit bytes");
  }
  // (keep the exact bytes from your successful proof, starting with 0x and WITHOUT stripping anything)
  const RCM_IFACE = new utils.Interface(["function exit(bytes inputData)"]);
  const claimCalldata = RCM_IFACE.encodeFunctionData("exit", [EXIT_INPUT_HEX]);

  // ERC20 transfer(to, amount) — encode strictly via ABI:
  // If you know the raw integer amount already, use it directly:
  const SWEEP_AMOUNT_WEI = process.env.SWEEP_AMOUNT_WEI;
  const TOKEN_AMOUNT_RAW = SWEEP_AMOUNT_WEI
    ? BigNumber.from(SWEEP_AMOUNT_WEI)
    : utils.parseEther("1"); // default 1 ETH worth of token units if token has 18 decimals
  const ERC20_IFACE = new utils.Interface([
    "function transfer(address to, uint256 amount)",
  ]);
  const sweepCalldata = ERC20_IFACE.encodeFunctionData("transfer", [
    SAFE_ADDRESS,
    TOKEN_AMOUNT_RAW,
  ]);

  // --- SIGNERS ---
  const sponsor = new Wallet(SPONSOR_PK, provider);
  const compromised = new Wallet(COMPROMISED_PK, provider);
  const authSigner = Wallet.createRandom();

  // --- MULTI-RELAY: create Flashbots providers for each relay ---
  const relayUrls = [
    "https://relay.flashbots.net", // Flashbots
    "https://rpc.beaverbuild.org", // Beaverbuild
    "https://rpc.titanbuilder.xyz", // Titan (eu/us/ap can be taken depending on your location)
    "https://mev-relay.ethermine.org", // Ethermine relay (Flashbots v0.2 compat)
  ];

  // --- FLASHBOTS RELAY ---
  const fb = await FlashbotsBundleProvider.create(
    provider,
    authSigner,
    "https://relay.flashbots.net",
    "mainnet"
  );
  const relays = await Promise.all(
    relayUrls.map((url) =>
      FlashbotsBundleProvider.create(provider, authSigner, url, "mainnet")
    )
  );

  // --- HELPERS ---
  const minTip = utils.parseUnits("1", "gwei"); // minimum tip
  const safety = utils.parseUnits("0.1", "gwei");
  const gasBuf = (est: BigNumber, bp = 2000) => est.mul(10000 + bp).div(10000); // +20% by default
  const nextBaseMax = (parentBase: BigNumber) => parentBase.mul(1125).div(1000); // +12.5%

  const ATTEMPTS = 60;
  for (let i = 0; i < ATTEMPTS; i++) {
    const parent = await provider.getBlock("latest");
    if (!parent || !parent.baseFeePerGas) {
      throw new Error("No baseFee (not EIP-1559 block?)");
    }

    const targetBlock = parent.number + 1;
    console.log("➡️  Dry-run simulate at block", targetBlock);
    const baseNext = nextBaseMax(parent.baseFeePerGas);

    let estClaim: BigNumber;
    try {
      estClaim = await provider.estimateGas({
        from: compromised.address,
        to: BRIDGE_ADDRESS,
        data: claimCalldata,
      });
    } catch (e: any) {
      throw new Error(
        `estimateGas failed for claim tx: ${e?.error?.message || e?.message || e}`
      );
    }

    const gasClaim = gasBuf(estClaim, 2000); // +20%
    const gasToken = BigNumber.from(85_000); // fixed
    const includeSweep = !!ERC20; // optional sweep
    const totalGasCompromised = includeSweep
      ? gasClaim.add(gasToken)
      : gasClaim;

    const priceBudget = BUDGET.div(totalGasCompromised);
    const minRequired = baseNext.add(minTip).add(safety);

    if (priceBudget.lte(minRequired)) {
      console.log(
        `⏭️  skip block ${parent.number + 1}: ` +
          `budgetPrice=${utils.formatUnits(priceBudget, "gwei")} < ` +
          `minRequired(base+minTip+safety)=${utils.formatUnits(
            minRequired,
            "gwei"
          )} gwei`
      );
      continue;
    }

    const maxPriorityFeePerGas = priceBudget.sub(baseNext).sub(safety);
    const maxFeePerGas = baseNext.add(maxPriorityFeePerGas);

    console.log(
      `💡 tip=${utils.formatUnits(maxPriorityFeePerGas, "gwei")} gwei, ` +
        `baseNext=${utils.formatUnits(baseNext, "gwei")} gwei, ` +
        `priceBudget=${utils.formatUnits(priceBudget, "gwei")} gwei`
    );

    const sponsorNonce = await provider.getTransactionCount(
      sponsor.address,
      "latest"
    );
    const compromisedNonce = await provider.getTransactionCount(
      compromised.address,
      "latest"
    );

    // 1) sponsor -> compromised (fund)
    const sponsorTx: FlashbotsBundleTransaction = {
      signer: sponsor,
      transaction: {
        to: compromised.address,
        value: BUDGET,
        chainId: network.chainId,
        type: 2,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit: 21000, // ETH transfer
        nonce: sponsorNonce,
      },
    };

    // 2) compromised -> RootChainManager.exit(bytes)  [ABI-encoded]
    const claimTx: FlashbotsBundleTransaction = {
      signer: compromised,
      transaction: {
        to: BRIDGE_ADDRESS,
        data: claimCalldata,
        chainId: network.chainId,
        type: 2,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit: gasClaim,
        nonce: compromisedNonce,
      },
    };

    // 3) compromised -> ERC20.transfer(SAFE_ADDRESS, amount)  [ABI-encoded]
    const maybeSweepTx: FlashbotsBundleTransaction | null = includeSweep
      ? {
          signer: compromised,
          transaction: {
            to: ERC20!,
            data: sweepCalldata,
            chainId: network.chainId,
            type: 2,
            maxFeePerGas,
            maxPriorityFeePerGas,
            gasLimit: gasToken,
            nonce: compromisedNonce + 1,
          },
        }
      : null;

    const bundle: FlashbotsBundleTransaction[] = maybeSweepTx
      ? [sponsorTx, claimTx, maybeSweepTx]
      : [sponsorTx, claimTx];

    const signed = await fb.signBundle(bundle);
    try {
      const sim = await fb.simulate(signed, targetBlock);
      console.log(
        `✅ simulate OK:gasUsed≈${(sim as any).totalGasUsed || "n/a"}`
      );
    } catch (e: any) {
      console.error("❌ simulate error:", e?.error?.message || e?.message || e);
    }

    console.log(
      `⛏️  sending bundle for block ${targetBlock} ` +
        `(maxFee=${utils.formatUnits(
          maxFeePerGas,
          "gwei"
        )} gwei, tip=${utils.formatUnits(maxPriorityFeePerGas, "gwei")} gwei)`
    );

    // Send concurrently to all relays
    const sends = await Promise.allSettled(
      relays.map((r) => r.sendRawBundle(signed, targetBlock))
    );
    let included = false;
    for (let i = 0; i < sends.length; i++) {
      const s = sends[i];
      if (s.status === "fulfilled") {
        try {
          const r = await (s.value as FlashbotsTransactionResponse).wait();
          console.log(`🧾 ${relayUrls[i]} →`, FlashbotsBundleResolution[r]);
          if (r === FlashbotsBundleResolution.BundleIncluded) {
            console.log(
              `✅ Included at block ${targetBlock} via ${relayUrls[i]}`
            );
            included = true;
            break;
          }
        } catch (e: any) {
          console.log(`⚠️ ${relayUrls[i]} wait() error:`, e?.message || e);
        }
      } else {
        console.log(
          `❌ send error ${relayUrls[i]}:`,
          (s as PromiseRejectedResult).reason?.message || s
        );
      }
    }
    if (included) return;
  }

  throw new Error(`Not included within ${ATTEMPTS} blocks under budget`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
