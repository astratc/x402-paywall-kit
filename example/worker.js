// Example: a self-contained paid endpoint (no upstream). Deploy with: npx wrangler deploy -c example/wrangler.toml
import { createApp } from "../src/index.js";
export default createApp({
  SERVICE_NAME: "Fortune API (x402 example)",
  ROUTES: { "/v1/fortune": { price: "$0.001", description: "A random fortune, paid per call in USDC", outputSchema: { type: "object", properties: { fortune: { type: "string" } } } } },
  handlers: { "/v1/fortune": () => Response.json({ fortune: ["Ship it.", "Small fees, many payers.", "402 is the new 200."][Math.floor(Math.random() * 3)] }) },
});
