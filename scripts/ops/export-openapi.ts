/** Writes docs/api/openapi.json from the in-code OpenAPI document (a test fails if the committed file is stale). Usage: npx tsx scripts/ops/export-openapi.ts */
import { writeFileSync } from "node:fs";
import { openApiDocument } from "../../apps/api/src/openapi";

writeFileSync(new URL("../../docs/api/openapi.json", import.meta.url), `${JSON.stringify(openApiDocument, null, 2)}\n`);
console.log("wrote docs/api/openapi.json");
