// x402 Paywall Kit: put any HTTP API behind x402 (USDC on Base) on Cloudflare Workers.
// Configure in wrangler.toml [vars]; ROUTES maps paths to prices. Unlisted paths are free passthrough only if FREE_PASSTHROUGH="true".
import { requirements, paywall, httpFacilitator } from "./x402.js";
import { favicon } from "./favicon.js";

export function createApp(opts = {}) {
  return {
    async fetch(request, env = {}, ctx) {
      const cfg = { ...env, ...opts };
      const routes = typeof cfg.ROUTES === "string" ? JSON.parse(cfg.ROUTES) : (cfg.ROUTES || {});
      const facilitator = cfg.facilitator || httpFacilitator(cfg.FACILITATOR_URL || "https://facilitator.payai.network");
      const url = new URL(request.url); const origin = url.origin; const network = cfg.NETWORK || "base";
      const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE", "access-control-allow-headers": "*" };
      const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json", ...cors } });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const name = cfg.SERVICE_NAME || "x402 API";
      const list = Object.entries(routes).map(([path, r]) => ({ path, url: origin + path, ...r }));
      const p = url.pathname;
      if (p === "/health") return json({ ok: true });
      if (p === "/favicon.ico") return favicon();
      if (p === "/.well-known/x402") return json({ version: 2, resources: list.map(r => r.url), instructions: `Pay via x402 v2 (exact, USDC on ${network}; PAYMENT-SIGNATURE header). v1 X-PAYMENT also accepted.` });
      if (p === "/.well-known/did.json") return json({ "@context": ["https://www.w3.org/ns/did/v1"], id: `did:web:${url.hostname}`, service: [{ id: "#x402", type: "x402API", serviceEndpoint: origin + "/.well-known/x402" }] });
      if (p === "/llms.txt") return new Response(`# ${name}\n> ${cfg.SERVICE_DESCRIPTION || "Pay-per-call API via x402."}\n\n## Paid endpoints (x402, USDC on ${network})\n${list.map(r => `- ${r.method || "GET"} ${r.url} (${r.price}): ${r.description || ""}`).join("\n")}\n${cfg.CONTACT ? `\n## Contact\n${cfg.CONTACT}\n` : ""}`, { headers: { "content-type": "text/markdown; charset=utf-8", ...cors } });
      if (p === "/openapi.json") return json({ openapi: "3.1.0", info: { title: name, version: "1.0.0", ...(cfg.CONTACT ? { contact: { email: cfg.CONTACT } } : {}), "x-guidance": cfg.GUIDANCE || `${cfg.SERVICE_DESCRIPTION || name}. Paid routes: ${list.map(r => `${r.method || "GET"} ${r.path} (${r.price})${r.description ? ": " + r.description : ""}`).join("; ")}. Pay via x402 v2, USDC on ${network}.` }, servers: [{ url: origin }],
        paths: Object.fromEntries(list.map(r => [r.path, { [(r.method || "GET").toLowerCase()]: { summary: r.description, parameters: Object.entries(r.inputSchema || {}).map(([n, v]) => ({ name: n, in: "query", required: !!v?.required, schema: { type: v?.type || "string" }, ...(v?.description ? { description: v.description } : {}) })), "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: String(r.price).replace("$", "") } }, responses: { 200: { description: "OK" }, 402: { description: "Payment required (x402)" } } } }])) });
      if (p === "/" && !routes["/"]) return json({ name, description: cfg.SERVICE_DESCRIPTION || "", network, payTo: cfg.PAY_TO, endpoints: list.map(({ path, price, description }) => ({ path, price, description })), discovery: ["/.well-known/x402", "/openapi.json", "/llms.txt"] });

      const route = routes[p];
      const upstream = () => {
        if (!cfg.UPSTREAM_URL) return json({ error: "UPSTREAM_URL not set" }, 500);
        const target = new URL(p + url.search, cfg.UPSTREAM_URL);
        const headers = new Headers(request.headers); headers.delete("x-payment"); headers.delete("payment-signature"); headers.delete("host");
        if (cfg.UPSTREAM_AUTH_HEADER && cfg.UPSTREAM_AUTH_VALUE) headers.set(cfg.UPSTREAM_AUTH_HEADER, cfg.UPSTREAM_AUTH_VALUE);
        return fetch(target, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body });
      };
      if (!route) return cfg.FREE_PASSTHROUGH === "true" ? upstream() : json({ error: "not found" }, 404);
      if (route.method && route.method.toUpperCase() !== request.method) return json({ error: "method not allowed" }, 405);
      const req = requirements({ price: route.price, payTo: cfg.PAY_TO, network, resource: url.origin + p, description: route.description, mimeType: route.mimeType, inputSchema: route.inputSchema, outputSchema: route.outputSchema, method: (route.method || "GET").toUpperCase(), serviceName: name });
      const handler = cfg.handlers?.[p] ? () => cfg.handlers[p](request, env, ctx) : upstream;
      const res = await paywall(request, req, handler, facilitator);
      const out = new Response(res.body, res); for (const [k, v] of Object.entries(cors)) out.headers.set(k, v); return out;
    },
  };
}
export default createApp();
