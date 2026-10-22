import { buildApp as realBuildApp } from "../../apps/api/src/index";
import { TEST_ALL_CHATS_APPROVED } from "./telegramTestPolicy";

/** buildApp with the TEST-ONLY allow-all Telegram intake policy as the default (an explicit option still wins). */
export const buildApp: typeof realBuildApp = (options = {}) => realBuildApp({ telegramIntakePolicy: TEST_ALL_CHATS_APPROVED, ...options });
