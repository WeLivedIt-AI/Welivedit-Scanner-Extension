// Central runtime configuration for the extension.
// Change this file when moving the AI or authentication service.
globalThis.WELIVEDIT_CONFIG = Object.freeze({
  API_BASE_URL: "https://welivedit-ai-servicev2-production.up.railway.app",
  AUTH_BASE_URL: "https://welivedit-service-server-production-7991.up.railway.app",
  COMMUNITY_ID: "SAW_v1",
  MODEL: "gpt-4.1-nano",
  ITEM_CONCURRENCY: 3,
  RESOLVE_BATCH_SIZE: 40,
  DOM_SCAN_DEBOUNCE_MS: 300,
  AUTO_ENQUEUE_DEBOUNCE_MS: 180,
});
