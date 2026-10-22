# x402 Paywall Kit

Put any HTTP API behind **x402** pay-per-call payments (USDC on Base) with one Cloudflare Worker. No accounts, no API keys for your buyers, no Stripe. Zero runtime dependencies.

- Unpaid request → `402 Payment Required` with valid x402 v1 requirements (`exact` scheme, atomic USDC amount, correct USDC contract for `base` / `base-sepolia`, plus a base64 `PAYMENT-REQUIRED` header).
- Paid request → verified with a facilitator → your API runs → payment settled → `200` + `X-PAYMENT-RESPONSE` (tx hash).
- Failed verify → `402`, **your API is never called**. Upstream error → nothing is settled. Failed settle → `402`, response withheld.
- Auto-generated discovery: `/.well-known/x402`, `/.well-known/did.json` (did:web), `/llms.txt`, `/openapi.json` (with `x-payment-info`), CORS, free `/health`.
- The worker only **receives** money. It holds no private keys and signs nothing.

## Deploy in one command

```bash
git clone https://github.com/astratc/x402-paywall-kit && cd x402-paywall-kit
# edit wrangler.toml: PAY_TO (your Base address), UPSTREAM_URL, ROUTES
npm install && npx wrangler deploy
```

That's it: `https://x402-paywall.<you>.workers.dev/v1/data` now answers 402 until paid.

Upstream needs a key? Keep it secret:
```bash
npx wrangler secret put UPSTREAM_AUTH_VALUE    # e.g. "Bearer sk_..."
# and in wrangler.toml: UPSTREAM_AUTH_HEADER = "authorization"
```

## Configure (`wrangler.toml` `[vars]`)

| Var | Meaning |
|---|---|
| `PAY_TO` | Your receiving address on Base (required) |
| `NETWORK` | `base` (mainnet) or `base-sepolia` (testnet) |
| `FACILITATOR_URL` | Default `https://facilitator.payai.network` (free, Base mainnet). `https://x402.org/facilitator` works for base-sepolia |
| `UPSTREAM_URL` | The API being monetized; path and query are forwarded |
| `ROUTES` | JSON: `{"/v1/data": {"price": "$0.01", "description": "...", "method": "GET", "outputSchema": {...}}}` |
| `FREE_PASSTHROUGH` | `"true"` forwards unlisted paths for free; default 404 |
| `SERVICE_NAME`, `SERVICE_DESCRIPTION`, `CONTACT` | Used in `/`, `/llms.txt`, `/openapi.json` |

Add a good `description` and `outputSchema` per route: directories and agents use them to decide whether to pay you.

## Example (no upstream)

`example/worker.js` serves its own paid endpoint via `createApp({ ROUTES, handlers })`:

```bash
npx wrangler deploy -c example/wrangler.toml
curl -i https://x402-fortune-example.<you>.workers.dev/v1/fortune   # 402
```

Pay from a client with any x402 library, e.g. [`x402-fetch`](https://www.npmjs.com/package/x402-fetch):
```js
import { wrapFetchWithPayment } from "x402-fetch";
const pay = wrapFetchWithPayment(fetch, walletClient);   // a viem wallet with USDC on Base
const r = await pay("https://x402-fortune-example.<you>.workers.dev/v1/fortune");
```

Live reference deployment: https://x402-paywall-demo.astratc.workers.dev (route `/v1/fortune`, $0.001 on Base).

## Use as a library

```js
import { createApp } from "./src/index.js";
export default createApp({ ROUTES: { "/v1/x": { price: "$0.02" } }, handlers: { "/v1/x": (req, env) => Response.json({ hi: 1 }) } });
```
`src/x402.js` exports `requirements`, `challenge`, `paywall`, `httpFacilitator`, `toAtomic`, `USDC` for other runtimes (Deno, Bun, Node 18+).

## Tests

```bash
npm test     # node:test, offline: stub facilitator + stub upstream
```
Covers: 402 shape and asset per network, free health, verify → run → settle → 200 + `X-PAYMENT-RESPONSE`, failed verify does no work, failed settle withholds the response, network mismatch rejected before the facilitator, handler errors are never settled, discovery documents.

## Check your setup

Run your URL through [AgentReady](https://agentready.astratc.workers.dev) (free demo) to confirm the 402, discovery files and agent metadata are right.

## Paid setup help

Want it done for you? We set up the kit on your API, write route descriptions/schemas, add discovery files and test a real payment:
- **$25**: deploy + one paid route on your Cloudflare account
- **$40**: up to 5 routes, upstream auth, discovery files, AgentReady check
- **$60**: the above + custom handlers / MCP or agent-card setup

Paid in USDC. Contact: **carl.astratc@proton.me**

## Notes and limits
- x402 v1, `exact` scheme, EVM (Base). Facilitators may change their supported networks; check `GET <facilitator>/supported`.
- Settlement happens after your handler runs; for expensive work consider `maxTimeoutSeconds` and idempotency in your upstream.
- MIT licensed. Not affiliated with Coinbase or Cloudflare.
