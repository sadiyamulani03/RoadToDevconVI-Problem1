import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware } from "@x402/express";
import { loadConfig, type Config } from "./config.js";
import { buildResourceServer, buildRoutesConfig } from "./x402.js";
import { buildNoticeRequestBodySchema } from "./schemas.js";
import { parseNotice } from "./parser.js";

/**
 * Payment-safe parse flow (verified against the installed @x402/express v2
 * source, node_modules/@x402/express/dist/esm/index.mjs):
 *
 * 1. express.json() enforces the server-side body size limit (413) BEFORE any
 *    payment processing runs.
 * 2. The x402 middleware checks for a payment header. Missing header ->
 *    402 payment challenge (no funds move).
 * 3. Payment header present -> the middleware verifies the payment with the
 *    facilitator (an off-chain check; no funds move) and then calls the route
 *    handler with the client response buffered.
 * 4. The handler validates the request body, runs the parser and validates
 *    the parser output against the runtime schema. An invalid notice
 *    responds HTTP 400.
 * 5. Back inside the middleware: because the handler responded with a 4xx
 *    status, the middleware cancels settlement (cancellationDispatcher.cancel)
 *    and flushes the buffered 400 response. No payment is settled.
 * 6. Only a successful (<400) handler response triggers processSettlement,
 *    which performs the real on-chain settlement via the facilitator.
 *
 * The default payment flow of the exact EVM scheme (EIP-3009) is
 * "authorization": verifyBeforeHandler = true, settleBeforeHandler = false.
 * Nobody pays for a notice the parser could not read.
 */

export interface AppOptions {
  config: Config;
  /**
   * Whether the x402 middleware should sync supported payment kinds from the
   * facilitator at startup (defaults to true). The facilitator is still used
   * for verify/settle at request time either way.
   */
  syncFacilitatorOnStart?: boolean;
}

/**
 * Shared handler for the free and paid parse routes.
 * The SAME real parser and schema validation run on every route.
 */
function handleParseNotice(requestSchema: ReturnType<typeof buildNoticeRequestBodySchema>) {
  return (req: Request, res: Response): void => {
    const bodyCheck = requestSchema.safeParse(req.body);
    if (!bodyCheck.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: bodyCheck.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const result = parseNotice(bodyCheck.data.notice);
    if (!result.ok) {
      res.status(400).json({ error: result.error, missing: result.missing });
      return;
    }

    res.status(200).json(result.data);
  };
}

export function createApp({ config, syncFacilitatorOnStart = true }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  // Server-side request body size limit. Enforced before expensive parsing
  // and payment processing. Oversized bodies are rejected with HTTP 413.
  app.use(express.json({ limit: config.bodyLimitBytes }));

  // Genuine x402 payment middleware. Price, payTo, network and asset are
  // taken from server configuration only; the client cannot override them.
  const routesConfig = buildRoutesConfig(config);
  const resourceServer = buildResourceServer(config);
  app.use(
    paymentMiddleware(routesConfig, resourceServer, undefined, undefined, syncFacilitatorOnStart),
  );

  // Request-body schema built from server config (NOTICE_MAX_LENGTH).
  const requestSchema = buildNoticeRequestBodySchema(config.noticeMaxLength);

  // FREE route: parse without payment.
  app.post("/parse", handleParseNotice(requestSchema));

  // PAID routes: same handler, gated by the x402 middleware above, each with
  // its own server-controlled price.
  app.post("/parse/basic", handleParseNotice(requestSchema));
  app.post("/parse/premium", handleParseNotice(requestSchema));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const errStatus =
      typeof err === "object" && err !== null && "statusCode" in err && typeof (err as { statusCode: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number"
          ? (err as { status: number }).status
          : undefined;
    const errType =
      typeof err === "object" && err !== null && "type" in err && typeof (err as { type: unknown }).type === "string"
        ? (err as { type: string }).type
        : undefined;

    if (errStatus === 413 || errType === "entity.too.large") {
      res.status(413).json({
        error: `Request body too large. Server-side limit is ${config.bodyLimitBytes} bytes.`,
      });
      return;
    }
    if (errType === "entity.parse.failed") {
      res.status(400).json({ error: "Malformed JSON body" });
      return;
    }
    if (res.headersSent) {
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

/** Entry point helper used by src/server.ts. */
export function main(): void {
  const config = loadConfig();
  const app = createApp({ config });
  app.listen(config.port, () => {
    console.log(`Meera's Railway Delay API listening on port ${config.port}`);
    console.log(`  network:   ${config.network} (Base Sepolia testnet)`);
    console.log(`  payTo:     ${config.sellerAddress}`);
    console.log(`  prices:    /parse/basic ${config.priceBasic}, /parse/premium ${config.pricePremium}`);
    console.log(`  body limit: ${config.bodyLimitBytes} bytes`);
    console.log(`  facilitator: ${config.facilitatorUrl}`);
  });
}
