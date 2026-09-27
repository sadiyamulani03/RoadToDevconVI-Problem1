import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local mock facilitator used by the test suite.
 *
 * This stands in ONLY for the remote facilitator HTTP endpoint (the on-chain
 * part of the x402 stack that would normally talk to Base Sepolia). The x402
 * middleware, resource server and client in the tests are the REAL SDK code:
 * the middleware genuinely performs verify/settle calls against this HTTP API
 * exactly as it would against a live facilitator.
 *
 * Call counters let tests assert the critical payment-safety property:
 * settle must never be called for a notice the parser could not read.
 */

export interface MockFacilitatorOptions {
  /** Whether /verify responds isValid: true (default) or false. */
  verifyValid?: boolean;
  /** Whether /settle responds success: true (default) or false. */
  settleSuccess?: boolean;
}

export interface MockFacilitator {
  /** Base URL of the running mock facilitator (e.g. http://127.0.0.1:45621). */
  url: string;
  /** Number of verify calls received. */
  verifyCalls: () => number;
  /** Number of settle calls received. */
  settleCalls: () => number;
  /** Payment payloads posted to /settle (for asserting what was settled). */
  settlePayloads: () => unknown[];
  /** Close the underlying HTTP server. */
  close: () => Promise<void>;
}

export async function startMockFacilitator(
  options: MockFacilitatorOptions = {},
): Promise<MockFacilitator> {
  let verifyCount = 0;
  let settleCount = 0;
  const settlePayloads: unknown[] = [];

  const app: Express = express();
  app.use(express.json());

  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
      extensions: [],
      signers: {},
    });
  });

  app.post("/verify", (req, res) => {
    verifyCount++;
    void req.body;
    if (options.verifyValid === false) {
      res.json({
        isValid: false,
        invalidReason: "invalid_signature",
        invalidMessage: "mock facilitator: signature rejected",
      });
      return;
    }
    res.json({
      isValid: true,
      payer: "0x1111111111111111111111111111111111111111",
    });
  });

  app.post("/settle", (req, res) => {
    settleCount++;
    settlePayloads.push(req.body);
    if (options.settleSuccess === false) {
      res.json({
        success: false,
        errorReason: "mock_settle_rejected",
        errorMessage: "mock facilitator: settlement rejected (test only)",
        transaction: "",
        network: "eip155:84532",
      });
      return;
    }
    // Synthetic receipt for the settle path only. This is NOT a real on-chain
    // transaction and is never presented as one; the mock facilitator does
    // not broadcast anything.
    res.json({
      success: true,
      transaction: `0x${"ab".repeat(32)}`,
      network: "eip155:84532",
      payer: "0x1111111111111111111111111111111111111111",
    });
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    verifyCalls: () => verifyCount,
    settleCalls: () => settleCount,
    settlePayloads: () => settlePayloads,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
