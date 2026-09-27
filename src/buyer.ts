import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Real x402 buyer/client for Meera's Railway Delay API.
 *
 * Flow (using the actual x402 client, not faked payment fields):
 * 1. Sends a POST request with the railway notice to a paid endpoint.
 * 2. Receives the x402 402 payment challenge.
 * 3. wrapFetchWithPayment creates the real payment header (EIP-3009 signed
 *    authorization on Base Sepolia testnet USDC) via the configured scheme
 *    client and retries the request with it.
 * 4. Prints the parsed JSON result and the settlement response.
 *
 * The private key is read from the BUYER_PRIVATE_KEY environment variable.
 * It is never hard-coded and never sent anywhere except into the local
 * signer. Price, payTo address, network and asset are controlled by the
 * server; the buyer cannot override them and does not try.
 */

const DEFAULT_ROUTE = "/parse/basic";
const DEFAULT_NOTICE =
  "Train 12951 Mumbai Rajdhani delayed at NDLS by 45 minutes, expected 17:10 due to signal failure";

function parseArgs(argv: string[]): { route: string; notice: string } {
  let route = DEFAULT_ROUTE;
  let notice = DEFAULT_NOTICE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--route" && argv[i + 1]) {
      route = argv[i + 1]!;
      i++;
    } else if (argv[i] === "--notice" && argv[i + 1]) {
      notice = argv[i + 1]!;
      i++;
    }
  }
  if (!route.startsWith("/")) route = `/${route}`;
  return { route, notice };
}

async function run(): Promise<void> {
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  const serverUrl = process.env.SERVER_URL;
  const { route, notice } = parseArgs(process.argv.slice(2));

  if (!privateKey) {
    console.error(
      "Missing BUYER_PRIVATE_KEY environment variable.\n" +
        "Set it to a Base Sepolia test wallet private key (never commit it):\n" +
        "  BUYER_PRIVATE_KEY=0x... npx tsx src/buyer.ts --route /parse/basic",
    );
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error("BUYER_PRIVATE_KEY must be a 32-byte hex private key (0x + 64 hex chars).");
    process.exit(1);
  }
  if (!serverUrl) {
    console.error(
      "Missing SERVER_URL environment variable.\n" +
        "Point it at the running server, e.g. SERVER_URL=http://localhost:3000",
    );
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  console.log(`Buyer wallet: ${account.address}`);
  console.log(`Paying endpoint: ${serverUrl}${route}`);
  console.log(`Notice: ${notice}`);
  console.log("---");

  // Wrap fetch with the real x402 client (v2, Base Sepolia).
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      {
        network: "eip155:84532",
        client: new ExactEvmScheme(account),
      },
    ],
  });

  const response = await fetchWithPayment(`${serverUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notice }),
  });

  const paymentResponseHeader = response.headers.get("PAYMENT-RESPONSE");
  if (paymentResponseHeader) {
    const settlement = decodePaymentResponseHeader(paymentResponseHeader);
    console.log("Settlement (PAYMENT-RESPONSE header):");
    console.log(JSON.stringify(settlement, null, 2));
    console.log("---");
  } else if (response.status === 402) {
    console.error("Request still unpaid after payment attempt (402 received twice).");
  }

  const bodyText = await response.text();
  console.log(`HTTP ${response.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    console.log(bodyText);
    return;
  }
  console.log("Parsed result:");
  console.log(JSON.stringify(parsed, null, 2));
}

run().catch((error) => {
  console.error("Buyer failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
