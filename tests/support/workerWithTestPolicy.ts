import { processTelegramJob as realProcessTelegramJob, processTelegramQueueJob as realProcessTelegramQueueJob } from "../../services/worker/src/index";
import { TEST_ALL_CHATS_APPROVED } from "./telegramTestPolicy";

/** The worker entry points with the TEST-ONLY allow-all Telegram intake policy as the default (an explicit option still wins). */
export const processTelegramJob: typeof realProcessTelegramJob = (job, correlationId, db, options = {}) =>
  realProcessTelegramJob(job, correlationId, db, { intakePolicy: TEST_ALL_CHATS_APPROVED, ...options });
export const processTelegramQueueJob: typeof realProcessTelegramQueueJob = (job, correlationId, db, options = {}) =>
  realProcessTelegramQueueJob(job, correlationId, db, { intakePolicy: TEST_ALL_CHATS_APPROVED, ...options });
