# The Operator's Booth: Meera's Railway Delay API

An x402-gated API that parses messy Indian Railway delay notices into structured JSON. Built for Road to Devcon VI Problem 1.

## What it does

Meera runs a railway delay notice parser. Travellers send her raw delay notices (English, Hindi, or Marathi) and she returns structured data:

```json
{
  "trainNumber": "12951",
  "stationCode": "NDLS",
  "expectedTime": "17:10",
  "reason": "signal failure"
}
```

The parser is deterministic — no LLM, no external railway service. It extracts train number (5 digits), station code (2–5 uppercase letters), expected arrival time (normalised to 24-hour `HH:MM`), and an optional reason. If any required field is missing, the parse fails with a controlled error listing what could not be read.

## API routes

| Method | Path | Payment | Price (testnet USDC) |
|--------|------|---------|---------------------|
| POST | `/parse` | Free | — |
| POST | `/parse/basic` | x402 | $0.01 |
| POST | `/parse/premium` | x402 | $0.05 |

All routes accept a JSON body `{"notice": "..."}` and return the parsed result or a 4xx error.

### Request body

```json
{ "notice": "Train 12951 Mumbai Rajdhani delayed at NDLS by 45 minutes, expected 17:10 due to signal failure" }
```

### Success response (200)

```json
{
  "trainNumber": "12951",
  "stationCode": "NDLS",
  "expectedTime": "17:10",
  "reason": "signal failure"
}
```

### Error responses

- **400** — malformed JSON, missing/empty/non-string notice, unexpected fields, or unparseable notice
- **402** — payment required (paid routes only); includes a `PAYMENT-REQUIRED` header with the x402 challenge
- **413** — request body exceeds the server-side size limit (default 16 KiB)

## x402 payment flow

Paid routes are protected by the official `@x402/express` middleware. The flow:

1. `express.json()` enforces the server-side body size limit (413) before any payment processing.
2. The x402 middleware checks for a `payment-signature` header. Missing header → 402 payment challenge (no funds move).
3. Payment header present → the middleware verifies the payment with the facilitator (off-chain check; no funds move) and calls the route handler with the response buffered.
4. The handler validates the request body, runs the parser, and validates parser output against a runtime Zod schema. An invalid notice responds HTTP 400.
5. Because the handler responded with a 4xx status, the middleware **cancels settlement** and flushes the buffered 400 response. No payment is settled.
6. Only a successful (<400) handler response triggers `processSettlement`, which performs the real on-chain settlement via the facilitator.

**Nobody pays for a notice the parser could not read.**

## Network and asset

- **Network:** Base Sepolia testnet (`eip155:84532`) — pinned by the config schema; the server refuses to boot on any other network value
- **Asset:** testnet USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`)
- **Facilitator:** defaults to `https://x402.org/facilitator` (configurable via `FACILITATOR_URL`)

## Server-controlled parameters

The client cannot override any payment parameter:

- **Price** — set server-side via `PRICE_BASIC` / `PRICE_PREMIUM` environment variables
- **payTo** — set server-side via `SELLER_ADDRESS` environment variable
- **Network** — pinned to `eip155:84532` by the config schema
- **Asset** — resolved by the x402 SDK from the network default

Client-supplied `price`, `payTo`, or any other payment-related fields in the request body are rejected by the strict body schema (only `notice` is accepted).

## Buyer client

`src/buyer.ts` is a real x402 client that performs the actual payment flow:

```bash
BUYER_PRIVATE_KEY=0x... SERVER_URL=http://localhost:3000 npx tsx src/buyer.ts --route /parse/basic
```

It uses `@x402/fetch`'s `wrapFetchWithPaymentFromConfig` to create a genuine EIP-3009 signed payment on Base Sepolia testnet USDC and retries the request with the payment header. The private key is read from the environment and never hard-coded.

## Environment variables

Copy `.env.example` to `.env` and fill in your values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELLER_ADDRESS` | Yes | — | Base Sepolia wallet address that receives payments |
| `NETWORK` | No | `eip155:84532` | Payment network (must stay on Base Sepolia) |
| `FACILITATOR_URL` | No | `https://x402.org/facilitator` | x402 facilitator endpoint |
| `BODY_LIMIT_BYTES` | No | `16384` | Max request body size in bytes |
| `NOTICE_MAX_LENGTH` | No | `4096` | Max notice length in characters |
| `PRICE_BASIC` | No | `$0.01` | Price for `/parse/basic` in testnet USDC |
| `PRICE_PREMIUM` | No | `$0.05` | Price for `/parse/premium` in testnet USDC |
| `PORT` | No | `3000` | HTTP port |
| `BUYER_PRIVATE_KEY` | Buyer only | — | Base Sepolia test wallet private key (never commit) |
| `SERVER_URL` | Buyer only | `http://localhost:3000` | URL of the running server |

## Installation

```bash
npm install
cp .env.example .env
# Edit .env with your SELLER_ADDRESS and other values
```

## Running

```bash
npm run dev    # tsx watch mode
npm start      # tsx production mode
```

## Testing

```bash
npm test       # vitest — parser unit tests + x402 integration tests
npm run build  # tsc compile
npm run typecheck  # tsc --noEmit
```

The test suite includes:

- **Parser unit tests** — realistic English, Hindi, and Marathi notices; controlled failures for missing fields; schema integration
- **x402 integration tests** — payment challenge (402), payment verification and settlement via a local mock facilitator, malformed notice rejection (400) with no settlement, body size limit (413), strict body schema, server-controlled price/payTo, mainnet network rejection

The mock facilitator stands in only for the remote facilitator HTTP endpoint. The x402 middleware, resource server, and client in the tests are the real SDK code.

## Limitations

- The parser is deterministic and regex-based; it handles common Indian Railway notice formats but may not cover every possible phrasing
- Real on-chain settlement requires a funded Base Sepolia test wallet with testnet USDC and a live facilitator; the test suite uses a local mock facilitator for verify/settle
- The server is designed for testnet use; production deployment would require additional hardening (rate limiting, logging, etc.)
