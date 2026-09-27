import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { startMockFacilitator, type MockFacilitator } from "./helpers/mockFacilitator.js";

const SELLER = "0x9999999999999999999999999999999999999999";
const BUYER = "0x1111111111111111111111111111111111111111";

const VALID_NOTICE =
  "Train 12951 Mumbai Rajdhani delayed at NDLS by 45 minutes, expected 17:10 due to signal failure";
const MALFORMED_NOTICE = "NOTE: platform 3 closed, nothing about trains here";

function decodePaymentRequired(header: string): { accepts: Array<Record<string, unknown>> } {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    SELLER_ADDRESS: SELLER,
    NETWORK: "eip155:84532",
    PRICE_BASIC: "$0.01",
    PRICE_PREMIUM: "$0.05",
    BODY_LIMIT_BYTES: "2048",
    NOTICE_MAX_LENGTH: "256",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function paymentHeaderFor(price: string): string {
  const dollars = parseFloat(price.replace("$", ""));
  const amount = Math.round(dollars * 1_000_000).toString();
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      amount,
      asset: BASE_SEPOLIA_USDC,
      payTo: SELLER,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function findAccepts(challenge: { accepts: Array<Record<string, unknown>> }) {
  return challenge.accepts.find((a) => a.network === "eip155:84532")!;
}

describe("app — x402 payment gating", () => {
  let facilitator: MockFacilitator;
  let app: Express;

  beforeAll(async () => {
    facilitator = await startMockFacilitator();
    app = createApp({ config: testConfig({ FACILITATOR_URL: facilitator.url }) });
  });

  afterAll(async () => {
    await facilitator.close();
  });

  it("returns a 402 payment challenge for a paid route without a payment header", async () => {
    const res = await request(app).post("/parse/basic").send({ notice: VALID_NOTICE });
    expect(res.status).toBe(402);
    const header = res.headers["payment-required"];
    expect(header).toBeDefined();
    const challenge = decodePaymentRequired(header as string);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]!.amount).toBe("10000");
    expect(challenge.accepts[0]!.payTo).toBe(SELLER);
    expect(challenge.accepts[0]!.network).toBe("eip155:84532");
  });

  it("does not require payment on the free /parse route", async () => {
    const res = await request(app).post("/parse").send({ notice: VALID_NOTICE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      trainNumber: "12951",
      stationCode: "NDLS",
      expectedTime: "17:10",
      reason: "signal failure",
    });
  });

  it("server controls the price: client-supplied price is ignored", async () => {
    const res = await request(app)
      .post("/parse/basic")
      .send({ notice: VALID_NOTICE, price: "$999.00", payTo: BUYER });
    expect(res.status).toBe(402);
    const challenge = decodePaymentRequired(res.headers["payment-required"] as string);
    const basic = findAccepts(challenge);
    expect(basic.amount).toBe("10000");
    expect(basic.payTo).toBe(SELLER);
  });

  it("server controls the price on the premium route too", async () => {
    const res = await request(app)
      .post("/parse/premium")
      .send({ notice: VALID_NOTICE, price: "$0.00", payTo: BUYER });
    expect(res.status).toBe(402);
    const challenge = decodePaymentRequired(res.headers["payment-required"] as string);
    const premium = findAccepts(challenge);
    expect(premium.amount).toBe("50000");
    expect(premium.payTo).toBe(SELLER);
  });

  it("server controls payTo: client cannot redirect payment", async () => {
    const res = await request(app)
      .post("/parse/basic")
      .send({ notice: VALID_NOTICE, payTo: BUYER });
    expect(res.status).toBe(402);
    const challenge = decodePaymentRequired(res.headers["payment-required"] as string);
    const basic = findAccepts(challenge);
    expect(basic.payTo).toBe(SELLER);
    expect(basic.payTo).not.toBe(BUYER);
  });

  it("rejects query-string price/payTo overrides with the same 402 challenge", async () => {
    const res = await request(app)
      .post("/parse/basic?price=$0.00&payTo=" + BUYER)
      .send({ notice: VALID_NOTICE });
    expect(res.status).toBe(402);
    const challenge = decodePaymentRequired(res.headers["payment-required"] as string);
    const basic = findAccepts(challenge);
    expect(basic.amount).toBe("10000");
    expect(basic.payTo).toBe(SELLER);
  });

  it("accepts a valid signed payment (mock facilitator) and settles exactly once", async () => {
    const res = await request(app)
      .post("/parse/basic")
      .set("payment-signature", paymentHeaderFor("$0.01"))
      .send({ notice: VALID_NOTICE });
    expect(res.status).toBe(200);
    expect(res.body.trainNumber).toBe("12951");
    expect(facilitator.verifyCalls()).toBeGreaterThan(0);
    expect(facilitator.settleCalls()).toBe(1);
  });

  it("a malformed notice returns 400 and never settles payment", async () => {
    const settleBefore = facilitator.settleCalls();
    const res = await request(app)
      .post("/parse/basic")
      .set("payment-signature", paymentHeaderFor("$0.01"))
      .send({ notice: MALFORMED_NOTICE });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(facilitator.settleCalls()).toBe(settleBefore);
  });

  it("a malformed notice on the free route returns 400, not 200", async () => {
    const res = await request(app).post("/parse").send({ notice: MALFORMED_NOTICE });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("missing notice field returns 400", async () => {
    const res = await request(app).post("/parse").send({});
    expect(res.status).toBe(400);
  });

  it("empty notice returns 400", async () => {
    const res = await request(app).post("/parse").send({ notice: "" });
    expect(res.status).toBe(400);
  });

  it("non-string notice returns 400", async () => {
    const res = await request(app).post("/parse").send({ notice: 12345 });
    expect(res.status).toBe(400);
  });

  it("unexpected extra fields are rejected by the strict body schema", async () => {
    const res = await request(app)
      .post("/parse")
      .send({ notice: VALID_NOTICE, price: "$0.00" });
    expect(res.status).toBe(400);
  });

  it("oversized body is rejected with 413 before payment processing", async () => {
    const settleBefore = facilitator.settleCalls();
    const bigNotice = "Train 12951 delayed at CSMT expected 16:45 " + "x".repeat(4096);
    const res = await request(app).post("/parse").send({ notice: bigNotice });
    expect(res.status).toBe(413);
    expect(facilitator.settleCalls()).toBe(settleBefore);
  });

  it("malformed JSON body returns 400", async () => {
    const res = await request(app)
      .post("/parse")
      .set("Content-Type", "application/json")
      .send("{not valid json");
    expect(res.status).toBe(400);
  });

  it("paid route with an unverifiable payment returns 402 and does not settle", async () => {
    const strictFacilitator = await startMockFacilitator({ verifyValid: false });
    try {
      const strictApp = createApp({
        config: testConfig({ FACILITATOR_URL: strictFacilitator.url }),
      });
      const res = await request(strictApp)
        .post("/parse/basic")
        .set("payment-signature", paymentHeaderFor("$0.01"))
        .send({ notice: VALID_NOTICE });
      expect(res.status).toBe(402);
      expect(strictFacilitator.settleCalls()).toBe(0);
    } finally {
      await strictFacilitator.close();
    }
  });

  it("server refuses to boot on a mainnet network value", () => {
    expect(() => testConfig({ NETWORK: "eip155:1" })).toThrow(/Invalid server configuration/);
  });
});
