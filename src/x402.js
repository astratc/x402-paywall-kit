// Minimal x402 server core, v2 (with v1 fallback). "exact" scheme, USDC on Base. No dependencies, web-standard fetch API.
// The server only RECEIVES: it never holds keys or signs. Verification and settlement go to a facilitator.
// v2: 402 + PAYMENT-REQUIRED header (base64 JSON PaymentRequired); client retries with PAYMENT-SIGNATURE; success adds PAYMENT-RESPONSE.
// v1 clients (X-PAYMENT header) are still accepted.

export const USDC = {
  base: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2", caip2: "eip155:8453" },
  "base-sepolia": { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", caip2: "eip155:84532" },
};

/** "$0.05" | "0.05" | 0.05 -> atomic USDC units string (6 decimals) */
export function toAtomic(price) {
  const s = String(price).replace(/^\$/, "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid price: ${price}`);
  const [i, f = ""] = s.split(".");
  return (BigInt(i) * 1000000n + BigInt((f + "000000").slice(0, 6))).toString();
}

/** Build both the v2 requirement and the v1 equivalent for one paid resource. */
export function requirements({ price, payTo, network = "base", resource, description = "", mimeType = "application/json", outputSchema, inputSchema, method = "GET", maxTimeoutSeconds = 60, serviceName }) {
  const asset = USDC[network];
  if (!asset) throw new Error(`unsupported network: ${network}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo || "")) throw new Error("payTo must be a 0x address");
  const amount = toAtomic(price); const extra = { name: asset.name, version: asset.version };
  const v2 = { scheme: "exact", network: asset.caip2, amount, asset: asset.address, payTo, maxTimeoutSeconds, extra };
  const v1 = { scheme: "exact", network, maxAmountRequired: amount, resource, description, mimeType, payTo, maxTimeoutSeconds, asset: asset.address,
    outputSchema: { input: { type: "http", method, discoverable: true, ...(inputSchema ? { queryParams: inputSchema } : {}) }, output: outputSchema || null }, extra };
  const input = { type: "http", method, ...(inputSchema ? { queryParams: Object.fromEntries(Object.entries(inputSchema).map(([k, v]) => [k, v?.description || v?.type || "string"])) } : {}) };
  const bazaar = { info: { input, output: { type: "json", ...(outputSchema ? { example: {} } : {}) } },
    schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {
      input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: [method] },
        ...(inputSchema ? { queryParams: { type: "object", properties: Object.fromEntries(Object.entries(inputSchema).map(([k, v]) => [k, { type: v?.type || "string", ...(v?.description ? { description: v.description } : {}) }])), required: Object.entries(inputSchema).filter(([, v]) => v?.required).map(([k]) => k) } } : {}) }, required: ["type", "method"] },
      output: { type: "object", properties: { type: { type: "string" }, example: outputSchema || { type: "object" } }, required: ["type"] } }, required: ["input"] } };
  return { v2, v1, network, resourceInfo: { url: resource, description, mimeType, ...(serviceName ? { serviceName } : {}) }, extensions: { bazaar } };
}

const b64 = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
export const decodePayment = h => { try { return JSON.parse(decodeURIComponent(escape(atob(h)))); } catch { return null; } };

export function paymentRequiredBody(req, error = "PAYMENT-SIGNATURE header is required") {
  return { x402Version: 2, error, resource: req.resourceInfo, accepts: [req.v2], extensions: req.extensions };
}

/** 402 response: v2 PaymentRequired in the PAYMENT-REQUIRED header and in the body. */
export function challenge(req, error) {
  const body = paymentRequiredBody(req, error);
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
    verify: (paymentPayload, paymentRequirements, version = 2) => call("/verify", { x402Version: version, paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements, version = 2) => call("/settle", { x402Version: version, paymentPayload, paymentRequirements }),
  };
}

const same = (a, b) => a && b && a.scheme === b.scheme && a.network === b.network && a.amount === b.amount && String(a.payTo).toLowerCase() === String(b.payTo).toLowerCase() && String(a.asset).toLowerCase() === String(b.asset).toLowerCase();

/**
 * Wrap a handler with an x402 paywall.
 * Flow: no payment header -> 402. Invalid/failed verify -> 402 and the handler is NOT run.
 * Valid -> run handler; if it errors (>=400) nothing is settled and the error is returned.
 * Otherwise settle; settle failure -> 402 (response withheld); success -> response + PAYMENT-RESPONSE (v2) / X-PAYMENT-RESPONSE (v1).
 */
export async function paywall(request, req, handler, facilitator) {
  const h2 = request.headers.get("payment-signature"); const h1 = request.headers.get("x-payment");
  if (!h2 && !h1) return challenge(req);
  const payload = decodePayment(h2 || h1);
  let version, pr;
  if (payload?.x402Version === 2 && same(payload.accepted, req.v2)) { version = 2; pr = req.v2; }
  else if (payload?.x402Version === 1 && payload.scheme === "exact" && payload.network === req.network) { version = 1; pr = req.v1; }
  else return challenge(req, "malformed or mismatched payment payload");
  let v; try { v = await facilitator.verify(payload, pr, version); } catch (e) { return challenge(req, "facilitator verify failed: " + e.message); }
  if (!v?.isValid) return challenge(req, v?.invalidReason || v?.error || "payment invalid");
  const res = await handler();
  if (res.status >= 400) return res;
  let s; try { s = await facilitator.settle(payload, pr, version); } catch (e) { return challenge(req, "settlement failed: " + e.message); }
  if (!s?.success) return challenge(req, s?.errorReason || s?.error || "settlement failed");
  const out = new Response(res.body, res);
  const receipt = b64({ success: true, transaction: s.transaction, network: s.network || pr.network, payer: s.payer || v.payer });
  out.headers.set(version === 2 ? "payment-response" : "x-payment-response", receipt);
  return out;
}
