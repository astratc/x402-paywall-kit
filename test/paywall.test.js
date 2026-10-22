// Offline tests: stub facilitator + stub upstream. Run: npm test
import { test } from "node:test"; import assert from "node:assert/strict";
import { createApp } from "../src/index.js"; import { toAtomic, requirements, USDC } from "../src/x402.js";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const payment = (o = {}) => btoa(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0xstub", authorization: {} }, ...o }));
const mk = (fac, calls = { handler: 0 }) => ({ calls, app: createApp({ PAY_TO, NETWORK: "base", facilitator: fac,
  ROUTES: { "/paid": { price: "$0.05", description: "test" } }, handlers: { "/paid": () => { calls.handler++; return Response.json({ ok: 1 }); } } }) });
const ok = { verify: async () => ({ isValid: true, payer: "0xabc" }), settle: async () => ({ success: true, transaction: "0xtx", network: "base" }) };

test("price converts to atomic USDC", () => { assert.equal(toAtomic("$0.05"), "50000"); assert.equal(toAtomic("5"), "5000000"); assert.throws(() => toAtomic("abc")); });
test("requirements use the right USDC asset per network", () => {
  assert.equal(requirements({ price: "$1", payTo: PAY_TO, network: "base", resource: "x" }).v2.asset, USDC.base.address);
  assert.equal(requirements({ price: "$1", payTo: PAY_TO, network: "base-sepolia", resource: "x" }).v2.asset, USDC["base-sepolia"].address);
});
test("GET /health is free", async () => { const r = await mk(ok).app.fetch(new Request("https://t/health")); assert.equal(r.status, 200); });
test("unpaid request gets 402 with x402 v2 requirements and PAYMENT-REQUIRED header", async () => {
  const { app, calls } = mk(ok); const r = await app.fetch(new Request("https://t/paid")); const b = await r.json();
  assert.equal(r.status, 402); assert.equal(b.x402Version, 2); assert.equal(b.accepts[0].scheme, "exact"); assert.equal(b.accepts[0].network, "eip155:8453");
  assert.deepEqual(JSON.parse(atob(r.headers.get("payment-required"))), b); assert.equal(b.resource.url, "https://t/paid"); assert.ok(b.extensions.bazaar);
  assert.equal(b.accepts[0].amount, "50000"); assert.equal(b.accepts[0].payTo, PAY_TO); assert.ok(r.headers.get("payment-required")); assert.equal(calls.handler, 0);
});
test("valid payment: verifies, runs handler, settles, returns 200 + X-PAYMENT-RESPONSE", async () => {
  const { app, calls } = mk(ok); const r = await app.fetch(new Request("https://t/paid", { headers: { "x-payment": payment() } }));
  assert.equal(r.status, 200); assert.equal(calls.handler, 1); assert.equal(JSON.parse(atob(r.headers.get("x-payment-response"))).transaction, "0xtx");
});
test("failed verify returns 402 and does no work", async () => {
  const { app, calls } = mk({ ...ok, verify: async () => ({ isValid: false, invalidReason: "insufficient_funds" }) });
  const r = await app.fetch(new Request("https://t/paid", { headers: { "x-payment": payment() } }));
  assert.equal(r.status, 402); assert.equal((await r.json()).error, "insufficient_funds"); assert.equal(calls.handler, 0);
});
test("failed settle returns 402 and withholds the response", async () => {
  const { app } = mk({ ...ok, settle: async () => ({ success: false, errorReason: "nonce_used" }) });
  const r = await app.fetch(new Request("https://t/paid", { headers: { "x-payment": payment() } })); assert.equal(r.status, 402);
});
test("wrong network payload is rejected before facilitator", async () => {
  let v = 0; const { app } = mk({ ...ok, verify: async () => { v++; return { isValid: true }; } });
  const r = await app.fetch(new Request("https://t/paid", { headers: { "x-payment": payment({ network: "polygon" }) } })); assert.equal(r.status, 402); assert.equal(v, 0);
});
test("discovery documents list paid routes", async () => {
  const { app } = mk(ok); const w = await (await app.fetch(new Request("https://t/.well-known/x402"))).json(); assert.deepEqual(w.resources, ["https://t/paid"]);
  const d = await (await app.fetch(new Request("https://t/.well-known/did.json"))).json(); assert.equal(d.id, "did:web:t");
  assert.match(await (await app.fetch(new Request("https://t/llms.txt"))).text(), /\/paid \(\$0\.05\)/);
});
test("handler error is not settled", async () => {
  let s = 0; const app = createApp({ PAY_TO, facilitator: { ...ok, settle: async () => { s++; return { success: true }; } }, ROUTES: { "/paid": { price: "$1" } }, handlers: { "/paid": () => new Response("boom", { status: 500 }) } });
  const r = await app.fetch(new Request("https://t/paid", { headers: { "x-payment": payment() } })); assert.equal(r.status, 500); assert.equal(s, 0);
});
test("v2 payment: PAYMENT-SIGNATURE verified with v2 body, returns PAYMENT-RESPONSE", async () => {
  let seen; const fac = { verify: async (p, r, v) => { seen = { r, v }; return { isValid: true, payer: "0xabc" }; }, settle: async () => ({ success: true, transaction: "0xtx2" }) };
  const { app, calls } = mk(fac); const chal = await (await app.fetch(new Request("https://t/paid"))).json();
  const sig = btoa(JSON.stringify({ x402Version: 2, resource: chal.resource, accepted: chal.accepts[0], payload: { signature: "0xstub", authorization: {} } }));
  const r = await app.fetch(new Request("https://t/paid", { headers: { "payment-signature": sig } }));
  assert.equal(r.status, 200); assert.equal(calls.handler, 1); assert.equal(seen.v, 2); assert.equal(seen.r.amount, "50000");
  assert.equal(JSON.parse(atob(r.headers.get("payment-response"))).transaction, "0xtx2");
});
test("v2 payment with tampered amount is rejected before facilitator", async () => {
  let v = 0; const { app } = mk({ ...ok, verify: async () => { v++; return { isValid: true }; } }); const chal = await (await app.fetch(new Request("https://t/paid"))).json();
  const sig = btoa(JSON.stringify({ x402Version: 2, accepted: { ...chal.accepts[0], amount: "1" }, payload: {} }));
  const r = await app.fetch(new Request("https://t/paid", { headers: { "payment-signature": sig } })); assert.equal(r.status, 402); assert.equal(v, 0);
});
test("favicon served", async () => { const r = await mk(ok).app.fetch(new Request("https://t/favicon.ico")); assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/x-icon"); });
