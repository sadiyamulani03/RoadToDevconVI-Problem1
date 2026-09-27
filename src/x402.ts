import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Config } from "./config.js";

/**
 * Genuine x402 payment wiring for the paid routes.
 *
 * The server controls price, payTo address, network and asset:
 * - price:  per-route USD money strings from server config (never from the request)
 * - payTo:  SELLER_ADDRESS from server config (never from the request)
 * - network: pinned to Base Sepolia (eip155:84532) by the config schema
 * - asset:  resolved by the x402 SDK from the network default, which is
 *           testnet USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e) on
 *           Base Sepolia
 *
 * The two paid routes use the same resource server, the same scheme
 * implementation and the same facilitator, but carry different prices.
 */

export const PAID_ROUTES = {
  basic: "POST /parse/basic",
  premium: "POST /parse/premium",
} as const;

export type PaidRouteKey = keyof typeof PAID_ROUTES;

/**
 * Build the x402 route configuration from server config.
 * Route keys are "METHOD /path" pairs as required by @x402/express.
 */
export function buildRoutesConfig(config: Config) {
  return {
    [PAID_ROUTES.basic]: {
      accepts: {
        scheme: "exact",
        price: config.priceBasic,
        network: config.network,
        payTo: config.sellerAddress,
        maxTimeoutSeconds: 60,
      },
      description: "Basic parse of an Indian Railway delay notice",
      mimeType: "application/json",
    },
    [PAID_ROUTES.premium]: {
      accepts: {
        scheme: "exact",
        price: config.pricePremium,
        network: config.network,
        payTo: config.sellerAddress,
        maxTimeoutSeconds: 60,
      },
      description: "Premium parse of an Indian Railway delay notice",
      mimeType: "application/json",
    },
  } as const;
}

/**
 * Build the x402 resource server: the official facilitator client plus the
 * exact EVM scheme registered for the pinned testnet network.
 */
export function buildResourceServer(config: Config): x402ResourceServer {
  const facilitatorClient = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
  });
  return new x402ResourceServer(facilitatorClient).register(
    config.network,
    new ExactEvmScheme(),
  );
}
