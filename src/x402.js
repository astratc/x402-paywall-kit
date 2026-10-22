// Minimal x402 v1 server core ("exact" scheme, USDC on Base). No dependencies, web-standard fetch API.
// The server only RECEIVES: it never holds keys or signs. Verification and settlement go to a facilitator.

export const USDC = {
  base: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
  "base-sepolia": { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" },
};

/** "$0.05" | "0.05" | 0.05 -> atomic USDC units string (6 decimals) */
export function toAtomic(price) {
  const s = String(price).replace(/^\$/, "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid price: ${price}`);
  const [i, f = ""] = s.split(".");
  return (BigInt(i) * 1000000n + BigInt((f + "000000").slice(0, 6))).toString();
}

export function requirements({ price, payTo, network = "base", resource, description = "", mimeType = "application/json", outputSchema, inputSchema, maxTimeoutSeconds = 60 }) {
  const asset = USDC[network];
  if (!asset) throw new Error(`unsupported network: ${network}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo || "")) throw new Error("payTo must be a 0x address");
  return { scheme: "exact", network, maxAmountRequired: toAtomic(price), resource, description, mimeType, payTo, maxTimeoutSeconds, asset: asset.address,
    outputSchema: { input: { type: "http", method: "GET", discoverable: true, ...(inputSchema ? { queryParams: inputSchema } : {}) }, output: outputSchema || null },
    extra: { name: asset.name, version: asset.version } };
}

const b64 = o => btoa(JSON.stringify(o));
export const decodePayment = h => { try { return JSON.parse(atob(h)); } catch { return null; } };

export function challenge(req, error = "X-PAYMENT header is required") {
  const body = { x402Version: 1, error, accepts: [req] };
  return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "payment-required": b64(body) } });
}

/** HTTP facilitator client (PayAI, x402.org, or your own). Injectable for tests. */
export function httpFacilitator(url, fetchImpl = fetch) {
  const call = async (path, body) => {
    const r = await fetchImpl(url.replace(/\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { error: t.slice(0, 200) }; }
    if (!r.ok) j.httpStatus = r.status; return j;
  };
  return {
    verify: (paymentPayload, paymentRequirements) => call("/verify", { x402Version: 1, paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements) => call("/settle", { x402Version: 1, paymentPayload, paymentRequirements }),
  };
}

/**
 * Wrap a handler with an x402 paywall.
 * Flow: no X-PAYMENT -> 402. Invalid/failed verify -> 402 and the handler is NOT run.
 * Valid -> run handler; if it errors (>=400) nothing is settled and the error is returned.
 * Otherwise settle; settle failure -> 402 (response withheld); success -> response + X-PAYMENT-RESPONSE.
 */
export async function paywall(request, req, handler, facilitator) {
  const h = request.headers.get("x-payment");
  if (!h) return challenge(req);
  const payload = decodePayment(h);
  if (!payload || payload.x402Version !== 1 || payload.scheme !== "exact" || payload.network !== req.network) return challenge(req, "malformed or mismatched X-PAYMENT");
  let v; try { v = await facilitator.verify(payload, req); } catch (e) { return challenge(req, "facilitator verify failed: " + e.message); }
  if (!v?.isValid) return challenge(req, v?.invalidReason || v?.error || "payment invalid");
  const res = await handler();
  if (res.status >= 400) return res;
  let s; try { s = await facilitator.settle(payload, req); } catch (e) { return challenge(req, "settlement failed: " + e.message); }
  if (!s?.success) return challenge(req, s?.errorReason || s?.error || "settlement failed");
  const out = new Response(res.body, res);
  out.headers.set("x-payment-response", b64({ success: true, transaction: s.transaction, network: s.network || req.network, payer: s.payer || v.payer }));
  return out;
}
