// SCAN-only (never deletes) check for leftover test-owned BullMQ keys. Requires REDIS_URL.
import { Redis } from "ioredis";
if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required");
const r = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
let total = 0;
for (const pat of ["bull:r0b_test_*"]) {
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", pat, "COUNT", 500);
    cursor = next; total += keys.length;
  } while (cursor !== "0");
}
console.log(`bull:r0b_test_* keys remaining: ${total}`);
await r.quit();
process.exit(total === 0 ? 0 : 3);
