/**
 * TEST-ONLY intake policy. Production default is deny-by-default (no chat approved unless
 * TWINS_TELEGRAM_ALLOWED_CHAT_IDS lists it). Pre-existing tests exercise ingestion with arbitrary, often random chats, so
 * they reach the API/worker through the wrappers in apiWithTestPolicy.ts / workerWithTestPolicy.ts, which inject this
 * explicit allow-all policy. Tests of the policy itself never use it: they pass real policies built with
 * createTelegramIntakePolicy().
 */
export const TEST_ALL_CHATS_APPROVED = {
  approvedChatCount: 1,
  optionsOnly: false,
  isChatApproved: (): boolean => true,
} as const;
