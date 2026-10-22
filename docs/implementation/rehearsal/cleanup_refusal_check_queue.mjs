// Separate cleanup of the ACCIDENTAL idle-worker queue created during crash-test preparation.
// Exact name only; verifies before acting; never uses force. Aborts (no changes) if anything is unexpected.
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const NAME = "r0b_test_refusal_check";
const url = new URL(process.env.REDIS_URL ?? "redis://missing");
if (`${url.hostname}:${url.port}` !== "127.0.0.1:16379") throw new Error("refusing: REDIS_URL is not 127.0.0.1:16379");

const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
const queue = new Queue(NAME, { connection: redis });
const scan = async () => {
  let c = "0"; const keys = [];
  do { const [n, k] = await redis.scan(c, "MATCH", `bull:${NAME}:*`, "COUNT", 500); c = n; keys.push(...k); } while (c !== "0");
  return keys.sort();
};
try {
  const counts = await queue.getJobCounts("active", "waiting", "delayed", "paused", "prioritized", "waiting-children", "completed", "failed");
  const workers = await queue.getWorkers();
  const keys = await scan();
  console.log(JSON.stringify({ target: "127.0.0.1:16379", queue: NAME, counts, workers: workers.length, keys }));
  const nonzero = Object.entries(counts).filter(([, v]) => v !== 0);
  if (nonzero.length || workers.length) throw new Error(`unexpected jobs/workers: ${JSON.stringify({ nonzero, workers: workers.length })}`);
  if (keys.length !== 1 || keys[0] !== `bull:${NAME}:meta`) throw new Error(`unexpected keys: ${JSON.stringify(keys)}`);
  await queue.obliterate(); // no force: errors if the queue has active jobs
  const after = await scan();
  console.log(JSON.stringify({ removed: true, keysAfter: after }));
  if (after.length) throw new Error("keys remain after obliterate");
} finally {
  await queue.close();
  await redis.quit();
}
