// Next's standalone output does not include static assets: copy them next to the server so `node .next/standalone/frontend/server.js` is a complete, self-contained deployable.
// (Deployment-specific configuration stays explicit in the environment; nothing is deployed by this script.)
import { cpSync, existsSync } from "node:fs";
const root = ".next/standalone/frontend";
if (!existsSync(`${root}/server.js`)) { console.error("run `next build` first"); process.exit(1); }
cpSync(".next/static", `${root}/.next/static`, { recursive: true });
if (existsSync("public")) cpSync("public", `${root}/public`, { recursive: true });
console.log("standalone server prepared at", root);
