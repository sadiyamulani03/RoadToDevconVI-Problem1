import { z } from "zod";

/**
 * Server-side configuration for Meera's Railway Delay API.
 *
 * Every value that controls money movement (price, payTo address, network,
 * asset) lives here and is loaded from environment variables at boot. The
 * client can never override any of them: the HTTP handlers never read these
 * values from req.body, query parameters or request headers.
 *
 * Testnet-only: the network is pinned to Base Sepolia (eip155:84532) via a
 * Zod literal, so a mainnet value in the environment makes the server refuse
 * to start.
 */

const HexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address (0x + 40 hex chars)");

const MoneyString = z
  .string()
  .regex(/^\$\d+(\.\d{1,6})?$/, "must be a USD-denominated money string like $0.01");

export const ConfigSchema = z.object({
  /** HTTP port for the server. Env: PORT. */
  port: z.coerce.number().int().positive().default(3000),
  /** Seller (payTo) address receiving x402 payments. Env: SELLER_ADDRESS. Required. */
  sellerAddress: HexAddress,
  /** Payment network. Env: NETWORK. Pinned to Base Sepolia; anything else fails. */
  network: z.literal("eip155:84532"),
  /** x402 facilitator URL. Env: FACILITATOR_URL. Defaults to the official facilitator. */
  facilitatorUrl: z.string().url().default("https://x402.org/facilitator"),
  /** Server-side request body size limit in bytes. Env: BODY_LIMIT_BYTES. */
  bodyLimitBytes: z.coerce.number().int().positive().default(16 * 1024),
  /** Maximum accepted notice length in characters. Env: NOTICE_MAX_LENGTH. */
  noticeMaxLength: z.coerce.number().int().positive().default(4096),
  /** Price for POST /parse/basic in testnet USDC. Env: PRICE_BASIC. */
  priceBasic: MoneyString.default("$0.01"),
  /** Price for POST /parse/premium in testnet USDC. Env: PRICE_PREMIUM. */
  pricePremium: MoneyString.default("$0.05"),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Well-known testnet USDC (Base Sepolia, eip155:84532). This is the same
 * default asset the x402 SDK resolves for "$" money strings on this network.
 */
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Load and validate configuration from environment variables.
 * Throws a descriptive error when a required value is missing or invalid
 * (e.g. a non-testnet NETWORK value), so the server never boots misconfigured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    port: env.PORT,
    sellerAddress: env.SELLER_ADDRESS,
    network: env.NETWORK ?? "eip155:84532",
    facilitatorUrl: env.FACILITATOR_URL,
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
    noticeMaxLength: env.NOTICE_MAX_LENGTH,
    priceBasic: env.PRICE_BASIC,
    pricePremium: env.PRICE_PREMIUM,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server configuration: ${details}`);
  }
  return parsed.data;
}
