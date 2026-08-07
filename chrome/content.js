
console.info("[WeLivedIt Chrome v5.1.3] content.js loaded", {
  href: location.href,
  readyState: document.readyState,
  origin: location.origin,
  time: new Date().toISOString(),
});
window.__weliveditV45Loaded = true;
window.__weliveditV47Loaded = true;
window.__weliveditChromeV48Loaded = true;
window.__weliveditChromeV49Loaded = true;
window.__weliveditChromeV50Loaded = true;
window.__weliveditChromeV504Loaded = true;
window.__weliveditChromeV511Loaded = true;
window.__weliveditChromeV512Loaded = true;
window.__weliveditChromeV513Loaded = true;

const DEFAULT_API_BASE_URL = globalThis.WELIVEDIT_CONFIG?.API_BASE_URL || "https://welivedit-ai-servicev2-production.up.railway.app";
const DEFAULT_AUTH_BASE_URL = globalThis.WELIVEDIT_CONFIG?.AUTH_BASE_URL || "https://welivedit-service-server-production-7991.up.railway.app";
const DEFAULT_COMMUNITY_ID = globalThis.WELIVEDIT_CONFIG?.COMMUNITY_ID || "SAW_v1";
const DEFAULT_MODEL = globalThis.WELIVEDIT_CONFIG?.MODEL || "gpt-4.1-nano";
const DEFAULT_AUTH_ENABLED = true;
const COMMENT_CLIMATE_CONFIG = (() => {
  const raw = globalThis.WELIVEDIT_CONFIG?.COMMENT_CLIMATE || {};
  const happy = clampPercent(raw.HAPPY_MIN_SAFE_PERCENT, 70);
  const veryHappy = Math.max(happy, clampPercent(raw.VERY_HAPPY_MIN_SAFE_PERCENT, 90));
  return Object.freeze({
    happyMinSafePercent: happy,
    veryHappyMinSafePercent: veryHappy,
    forceNeutralWhenDangerous: raw.FORCE_NEUTRAL_WHEN_DANGEROUS !== false,
  });
})();
const SEEN_CACHE_NAMESPACE = "welivedit-extension:v45";
const LEGACY_API_BASE_URLS = new Set([
  "http://localhost",
  "http://localhost:8000",
  "http://127.0.0.1",
  "http://127.0.0.1:8000",
  "http://192.168.100.40:8000",
  "https://api.welivedit.ai",
]);

const SOURCE_META = {
  source: "browser_extension",
  ingestion_source: "browser_extension",
  ingestion_method: "manual_extension_thread_scan",
  processing_context: "browser_extension_item_queue",
  source_label: "extension_item",
};

const STORAGE_KEYS = {
  apiBaseUrl: "welivedit_api_base_url",
  authBaseUrl: "welivedit_auth_base_url",
  communityId: "welivedit_community_id",
  model: "welivedit_model",
  autoMode: "welivedit_auto_mode",
  seenRecords: "welivedit_seen_records_v1",
};

const state = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  authBaseUrl: DEFAULT_AUTH_BASE_URL,
  communityId: DEFAULT_COMMUNITY_ID,
  model: DEFAULT_MODEL,
  authEnabled: DEFAULT_AUTH_ENABLED,
  autoMode: false,
  authStatus: { authenticated: false, email: null },
  // Identity of the person using WeLivedIt. This is authentication context only.
  // It must never be used as the target account for comments.
  viewerIdentity: { userId: null, linkedAccounts: [] },
  // The monitored X account that owns the original post in the current /status/:id URL.
  threadAccount: {
    postId: null,
    username: null,
    accountName: null,
    accountId: null,
    exists: false,
    linkedToCommunity: false,
    status: "unknown",
    loading: false,
    saving: false,
    error: null,
  },
  threadAccountLookupKey: null,
  threadAccountLookupTimer: null,
  threadAccountLookupPromise: null,
  classifierConfig: null,
  classifierCacheKey: null,
  items: new Map(),
  domByKey: new Map(),
  inFlight: new Set(),
  queued: new Set(),
  retrying: new Set(),
  workQueue: [],
  activeWorkers: 0,
  lastBulkResolveCount: 0,
  coverByKey: new Map(),
  lastPayload: null,
  originalPost: null,
  // Immutable identity of the original /status/:id owner for the current thread.
  // Once set, scrolling or DOM recycling must never replace it with a reply author.
  threadOwnerLock: null,
  seenRecords: {},
  seenPersistTimer: null,
  autoEnqueueTimer: null,
  pendingManualSend: false,
  generation: 0,
  currentPageKey: locationThreadStatusId() ? `${location.hostname}|status:${locationThreadStatusId()}` : `${location.hostname}${location.pathname}`,
  navigationResetTimer: null,
  explicitNavigationStatusId: null,
  explicitNavigationAt: 0,
  debugEvents: [],
  lastApiResponses: [],
};

// Keep message/status data outside visible DOM. This lets us use display:none
// for hidden replies without losing the text needed for resolve/analyze.
const articleDataCache = new WeakMap();


function scheduleInitExtension() {
  if (window.__weliveditInitScheduled) return;
  window.__weliveditInitScheduled = true;
  window.setTimeout(() => {
    initExtension().catch((error) => {
      console.error("[WeLivedIt] init failed", error);
    });
  }, 500);
}

// Firefox content scripts with run_at=document_idle may run after window.load.
// If we only listen for "load", the extension may never initialize.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", scheduleInitExtension, { once: true });
  window.addEventListener("load", scheduleInitExtension, { once: true });
} else {
  scheduleInitExtension();
}



function cleanupExistingWeliveditUi() {
  for (const selector of [
    "#welivedit-ball",
    "#welivedit-panel",
    "#welivedit-style",
    ".welivedit-cover",
    ".welivedit-mark"
  ]) {
    document.querySelectorAll(selector).forEach((el) => {
      try { el.remove(); } catch (_) {}
    });
  }

  document.querySelectorAll("[data-welivedit-hidden='true'], .welivedit-hard-hidden").forEach((article) => {
    try {
      article.classList.remove("welivedit-hard-hidden");
      article.removeAttribute("data-welivedit-hidden");
      article.style.removeProperty("min-height");
      article.querySelectorAll(".welivedit-redacted-shell, [data-welivedit-original-style]").forEach((el) => {
        el.classList.remove("welivedit-redacted-shell");
        el.removeAttribute("aria-hidden");
        el.removeAttribute("inert");
        const original = el.getAttribute("data-welivedit-original-style");
        el.removeAttribute("data-welivedit-original-style");
        if (original) el.setAttribute("style", original);
        else {
          el.style.removeProperty("visibility");
          el.style.removeProperty("opacity");
          el.style.removeProperty("pointer-events");
          el.style.removeProperty("user-select");
          el.style.removeProperty("-webkit-user-select");
          el.style.removeProperty("filter");
        }
      });
    } catch (_) {}
  });
}


async function initExtension() {
  cleanupExistingWeliveditUi();
  await loadSettings();
  await refreshClassifierConfig();
  await refreshAuthStatus(false);
  injectStyles();
  createFloatingButton();
  createPanel();
  scanVisibleReplies({ render: true, hide: true });
  if (state.autoMode) scheduleAutoEnqueue();
  startNavigationWatcher();
  startThreadObserver();
  console.info("[WeLivedIt] extension initialized", { url: location.href });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return resolve({});
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return resolve();
    chrome.storage.local.set(values, () => resolve());
  });
}

async function loadSettings() {
  const values = await storageGet(Object.values(STORAGE_KEYS));
  const storedApiBaseUrl = normalizeBaseUrl(values[STORAGE_KEYS.apiBaseUrl] || "");
  const shouldMigrateApiUrl = !storedApiBaseUrl || LEGACY_API_BASE_URLS.has(storedApiBaseUrl);

  state.apiBaseUrl = shouldMigrateApiUrl ? DEFAULT_API_BASE_URL : storedApiBaseUrl;
  const storedAuthBaseUrl = normalizeBaseUrl(values[STORAGE_KEYS.authBaseUrl] || "");
  state.authBaseUrl = DEFAULT_AUTH_BASE_URL;
  state.communityId = String(values[STORAGE_KEYS.communityId] || DEFAULT_COMMUNITY_ID);
  state.model = String(values[STORAGE_KEYS.model] || DEFAULT_MODEL);
  state.authEnabled = DEFAULT_AUTH_ENABLED;
  state.autoMode = parseBool(values[STORAGE_KEYS.autoMode], false);
  const records = values[STORAGE_KEYS.seenRecords];
  state.seenRecords = records && typeof records === "object" && !Array.isArray(records) ? records : {};

  if (shouldMigrateApiUrl && storedApiBaseUrl !== DEFAULT_API_BASE_URL) {
    await storageSet({ [STORAGE_KEYS.apiBaseUrl]: DEFAULT_API_BASE_URL });
    console.info("[WeLivedIt] migrated AI API base URL", { from: storedApiBaseUrl || null, to: DEFAULT_API_BASE_URL });
  }

  if (storedAuthBaseUrl !== DEFAULT_AUTH_BASE_URL) {
    await storageSet({ [STORAGE_KEYS.authBaseUrl]: DEFAULT_AUTH_BASE_URL });
    console.info("[WeLivedIt] migrated authentication base URL", { from: storedAuthBaseUrl || null, to: DEFAULT_AUTH_BASE_URL });
  }
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function classifierCacheKeyFromResponse(data) {
  const classifier = data?.classifier || data?.config || data?.data?.classifier || data?.data?.config || data || {};
  const signature = classifier.model_signature_id || classifier.modelSignatureId || classifier.signature || null;
  const preset = classifier.preset || classifier.classifier_preset || classifier.profile || null;
  const variant = classifier.variant || classifier.pipeline_variant || null;
  const engine = classifier.engine || null;
  const model = classifier.model || state.model;
  return [signature, preset, variant, engine, model].filter(Boolean).join("|") || `${state.apiBaseUrl}|${state.model}`;
}

async function refreshClassifierConfig() {
  state.classifierCacheKey = `${state.apiBaseUrl}|${state.model}`;
  try {
    const response = await runtimeMessage({
      type: "WELIVEDIT_API_REQUEST",
      url: `${state.apiBaseUrl}/api/classifier/config`,
      method: "GET",
      authRequired: false,
      timeoutMs: 15000,
    });
    if (!response?.ok) {
      console.warn("[WeLivedIt] classifier config unavailable", { status: response?.status || 0, message: response?.message || response?.error || null });
      return;
    }
    state.classifierConfig = response.data || null;
    state.classifierCacheKey = classifierCacheKeyFromResponse(response.data);
    console.info("[WeLivedIt] classifier config loaded", { apiBaseUrl: state.apiBaseUrl, classifierCacheKey: state.classifierCacheKey });
  } catch (error) {
    console.warn("[WeLivedIt] classifier config lookup failed", error);
  }
}

function createFloatingButton() {
  const button = document.createElement("button");
  button.id = "welivedit-ball";
  button.type = "button";
  button.setAttribute("aria-label", "Open WeLivedIt Community Helper");
  const iconUrl = chrome.runtime.getURL("icons/icon128.png");
  button.innerHTML = `<img src="${escapeAttr(iconUrl)}" alt="" />`;
  document.body.appendChild(button);
  button.addEventListener("click", togglePanel);
}


function createPanel() {
  const panel = document.createElement("div");
  panel.id = "welivedit-panel";
  panel.innerHTML = `
    <div class="welivedit-header">
      <div>
        <h3>WeLivedIt Community Helper</h3>
        <p class="welivedit-muted">Each reply is checked independently and marked as soon as its result arrives.</p>
      </div>
      <button id="welivedit-close" aria-label="Close">×</button>
    </div>

    <div class="welivedit-auth-box">
      <div id="welivedit-auth-current" class="welivedit-auth-current">Checking sign-in...</div>
      <div id="welivedit-auth-form" class="welivedit-auth-form">
        <input id="welivedit-auth-email" type="email" autocomplete="username" placeholder="Email" value="${escapeAttr(state.authStatus.email || "")}" />
        <input id="welivedit-auth-password" type="password" autocomplete="current-password" placeholder="Password" />
        <button id="welivedit-login">Sign in</button>
      </div>
      <details id="welivedit-auth-logged-in" class="welivedit-auth-logged-in">
        <summary id="welivedit-auth-summary">Signed in</summary>
        <button id="welivedit-logout" class="welivedit-secondary-action">Sign out</button>
      </details>
    </div>

    <div id="welivedit-thread-account" class="welivedit-account-box">
      <div class="welivedit-account-head">
        <span>Original post account</span>
        <strong id="welivedit-account-username">Not detected</strong>
      </div>
      <div id="welivedit-account-status" class="welivedit-account-status">Open an X post to identify its author.</div>
      <button id="welivedit-save-account" class="welivedit-secondary-action" type="button" hidden>Save account to community</button>
    </div>

    <label class="welivedit-auto-row">
      <span>
        <strong>Auto-check new replies</strong>
        <small>Resolve and analyze each new reply once.</small>
      </span>
      <input id="welivedit-auto-mode" type="checkbox" ${state.autoMode ? "checked" : ""} />
    </label>

    <button id="welivedit-send" class="welivedit-main-action">Send replies to community</button>

    <div id="welivedit-status" class="welivedit-status">Ready.</div>
    <section id="welivedit-climate" class="welivedit-climate" aria-live="polite">
      <div class="welivedit-climate-title">Comment climate</div>
      <div class="welivedit-climate-empty">Waiting for checked replies.</div>
    </section>
    <div id="welivedit-summary" class="welivedit-summary"></div>
    <div id="welivedit-content"></div>
  `;
  document.body.appendChild(panel);

  document.getElementById("welivedit-close").addEventListener("click", togglePanel);
  document.getElementById("welivedit-login").addEventListener("click", loginFromPanel);
  document.getElementById("welivedit-logout").addEventListener("click", logoutFromPanel);
  document.getElementById("welivedit-save-account").addEventListener("click", saveThreadAccount);
  document.getElementById("welivedit-send").addEventListener("click", () => sendVisibleToCommunity({ triggeredByLogin: false }));
  document.getElementById("welivedit-auto-mode").addEventListener("change", onAutoModeChanged);

  renderPanel();
}

function togglePanel() {
  const panel = document.getElementById("welivedit-panel");
  if (!panel) return;
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) refreshAuthStatus(true);
}

function injectStyles() {
  document.getElementById("welivedit-style")?.remove();
  const style = document.createElement("style");
  style.id = "welivedit-style";
  style.textContent = `
#welivedit-ball{position:fixed;right:20px;top:50%;transform:translateY(-50%);width:56px;height:56px;border:0;padding:0;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483647;box-shadow:0 8px 25px rgba(0,0,0,.28);overflow:hidden}#welivedit-ball img{display:block;width:100%;height:100%;object-fit:cover}
#welivedit-panel{position:fixed;right:-100vw;top:0;width:min(370px,100vw);max-width:100vw;height:100vh;height:100dvh;background:linear-gradient(135deg,#e5f1e8,#fff);color:#17212b;transition:right .25s ease;z-index:2147483646;padding:14px;font-family:Arial,sans-serif;box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;border-left:1px solid rgba(0,0,0,.12);box-shadow:-6px 0 22px rgba(0,0,0,.16)}
#welivedit-panel.open{right:0}.welivedit-header{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.welivedit-header h3{margin:0 0 3px;font-size:17px}.welivedit-muted{margin:0 0 8px;font-size:11px;color:#53606a;line-height:1.3}#welivedit-close{border:0!important;background:transparent!important;color:#26333f!important;font-size:25px!important;padding:0 3px!important;cursor:pointer}
#welivedit-panel input{box-sizing:border-box;padding:7px;border-radius:7px;border:1px solid #c8d4cc}.welivedit-auth-box{background:rgba(255,255,255,.72);border:1px solid #d8e2db;border-radius:10px;padding:8px;margin-top:4px}.welivedit-auth-current{font-size:11px;color:#43505a}.welivedit-auth-current.ok{color:#155b31;font-weight:700}.welivedit-auth-current.warn{color:#a31313;font-weight:700}.welivedit-auth-form{display:grid;grid-template-columns:1fr 1fr auto;gap:5px;margin-top:6px}.welivedit-auth-form input{min-width:0;width:100%;font-size:11px}.welivedit-auth-form button{white-space:nowrap;padding:7px!important;font-size:11px!important}.welivedit-auth-logged-in{margin-top:3px}.welivedit-auth-logged-in summary{cursor:pointer;font-size:10px;color:#53606a;list-style-position:inside}.welivedit-auth-logged-in button{width:100%;margin-top:5px;padding:6px!important;font-size:10px!important}
.welivedit-account-box{background:rgba(255,255,255,.82);border:1px solid #d8e2db;border-radius:10px;padding:9px 10px;margin-top:8px}.welivedit-account-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:#53606a}.welivedit-account-head strong{color:#26333f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.welivedit-account-status{font-size:10px;line-height:1.35;color:#65727d;margin-top:4px}.welivedit-account-status.ok{color:#155b31;font-weight:700}.welivedit-account-status.warn{color:#8a5b00}.welivedit-account-status.error{color:#a31313}.welivedit-account-box button{width:100%;margin-top:7px;padding:7px!important;font-size:10px!important}
.welivedit-auto-row{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff;border:1px solid #d8e2db;border-radius:10px;padding:9px 10px;margin-top:9px}.welivedit-auto-row span{display:flex;flex-direction:column;gap:2px;font-size:12px}.welivedit-auto-row small{font-size:10px;color:#65727d;font-weight:400}.welivedit-auto-row input{width:18px!important;height:18px;margin:0;cursor:pointer}.welivedit-auto-row.is-disabled{opacity:.62}.welivedit-auto-row.is-disabled input{cursor:not-allowed}.welivedit-main-action{width:100%;margin:8px 0 7px;padding:9px!important;font-size:12px!important}.welivedit-secondary-action{background:#6b7884!important}
.welivedit-climate{background:rgba(255,255,255,.84);border:1px solid #d8e2db;border-radius:10px;padding:9px 10px;margin:0 0 7px}.welivedit-climate-title{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#53606a;margin-bottom:6px}.welivedit-climate-grid{display:grid;grid-template-columns:1fr auto;gap:5px 10px;align-items:center}.welivedit-climate-label{font-size:10px;color:#65727d}.welivedit-climate-result{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:126px}.welivedit-climate-emoji{font-size:22px;line-height:1}.welivedit-climate-value{font-size:11px;font-weight:800;color:#26333f;text-align:right}.welivedit-climate-value small{display:block;font-size:9px;font-weight:500;color:#65727d;margin-top:1px}.welivedit-climate-impact{font-size:10px;color:#155b31;font-weight:700;margin-top:7px}.welivedit-climate-note{font-size:9px;color:#65727d;margin-top:5px;line-height:1.3}.welivedit-climate-empty{font-size:10px;color:#65727d}
#welivedit-panel button,.welivedit-card button{border:0;border-radius:8px;background:#438951;color:#fff;cursor:pointer;font-weight:700}#welivedit-panel button:hover:not(:disabled),.welivedit-card button:hover:not(:disabled){filter:brightness(.95)}#welivedit-panel button:disabled,.welivedit-card button:disabled{cursor:not-allowed!important;opacity:.55!important;filter:none!important}.welivedit-status{font-size:11px;padding:6px 8px;background:rgba(255,255,255,.72);border-radius:8px;border:1px solid #d8e2db;margin-bottom:6px}.welivedit-summary{font-size:11px;color:#43505a;margin-bottom:7px}#welivedit-content{overflow-y:auto;padding-right:3px;min-height:0}.welivedit-card{background:#fff;border-radius:10px;padding:9px;margin-bottom:7px;box-shadow:0 3px 10px rgba(0,0,0,.06);border:1px solid #e3ece6}.welivedit-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:5px}.welivedit-card-author{font-size:11px;font-weight:700;color:#26333f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.welivedit-card-text{font-size:12px;line-height:1.35;max-height:68px;overflow:auto;margin-bottom:6px;color:#26333f}.welivedit-card-placeholder{font-size:11px;line-height:1.35;color:#65727d;margin-bottom:6px}.welivedit-card-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center}.welivedit-badge{display:inline-block;border-radius:999px;padding:3px 7px;font-size:10px;font-weight:700;background:#eef2f7;color:#293744}.welivedit-badge.processing{background:#fff2cc;color:#745500}.welivedit-badge.harmful{background:#ffe2e2;color:#a31313}.welivedit-badge.supportive,.welivedit-badge.safe{background:#def7e7;color:#155b31}.welivedit-badge.error{background:#f6dfe3;color:#9c1c31}.welivedit-card-actions{display:flex;justify-content:flex-end;gap:5px;margin-top:6px}.welivedit-card-actions button{font-size:10px;padding:5px 7px}
.welivedit-mark{position:absolute;top:4px;right:4px;z-index:2147483646;background:#65727d;color:#fff;font:700 10px Arial;border-radius:999px;padding:3px 6px;pointer-events:none;min-width:14px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.22)}.welivedit-mark.is-processing{background:#c58b00}.welivedit-mark.is-safe{background:#238846}.welivedit-mark.is-harmful{background:#ba2b3c}.welivedit-mark.is-error{background:#7a3340}.welivedit-mark.is-cached{background:#28758f}
.welivedit-cover{display:none;position:absolute!important;inset:0!important;width:auto!important;height:auto!important;z-index:2147483645!important;box-sizing:border-box!important;margin:0!important;padding:10px 12px!important;border-radius:12px!important;background:#e8f5eb!important;color:#183925!important;border:1px solid #b8d8c1!important;font:700 12px Arial,sans-serif!important;align-items:center!important;justify-content:center!important;flex-direction:column!important;text-align:center!important;box-shadow:0 4px 18px rgba(0,0,0,.10)!important;pointer-events:auto!important;overflow:hidden!important}.welivedit-cover.is-visible{display:flex!important}.welivedit-cover.is-rehide{display:flex!important;inset:auto 8px 8px auto!important;width:auto!important;height:auto!important;padding:0!important;background:transparent!important;border:0!important;box-shadow:none!important;align-items:center!important;justify-content:center!important;overflow:visible!important}.welivedit-cover.is-rehide button{margin:0!important;background:#17212b!important;box-shadow:0 3px 10px rgba(0,0,0,.24)!important}.welivedit-cover button{margin-top:6px;background:#438951!important;color:#fff!important;border:0!important;border-radius:8px!important;padding:5px 9px!important;font:700 11px Arial!important;cursor:pointer!important;pointer-events:auto!important}.welivedit-hard-hidden{position:relative!important}.welivedit-redacted-shell{visibility:hidden!important;opacity:0!important;filter:none!important;pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important}.welivedit-redacted-shell *{visibility:hidden!important;opacity:0!important;filter:none!important;pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important}.welivedit-empty{font-size:11px;line-height:1.4;color:#53606a;background:rgba(255,255,255,.55);padding:9px;border-radius:9px}.welivedit-focus-highlight{outline:4px solid #438951!important;outline-offset:4px!important;border-radius:12px!important;animation:welivedit-focus-pulse .7s ease-in-out 3!important}@keyframes welivedit-focus-pulse{0%,100%{outline-width:4px;box-shadow:0 0 0 0 rgba(67,137,81,.15)}50%{outline-width:6px;box-shadow:0 0 0 10px rgba(67,137,81,.12)}}
@media (max-width:480px){#welivedit-panel{width:100vw;padding:11px}#welivedit-ball{right:9px;width:49px;height:49px}.welivedit-auth-form{grid-template-columns:1fr}.welivedit-auth-form button{width:100%}}
  `;
  document.head.appendChild(style);
}

function runtimeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, status: 0, error: chrome.runtime.lastError.message });
        resolve(response);
      });
    } catch (error) {
      resolve({ ok: false, status: 0, error: String(error?.message || error) });
    }
  });
}

async function refreshAuthStatus(updatePanel = true) {
  const response = await runtimeMessage({ type: "WELIVEDIT_AUTH_STATUS" });
  state.authStatus = response?.ok
    ? { authenticated: Boolean(response.authenticated), email: response.email || null }
    : { authenticated: false, email: null };
  state.viewerIdentity = response?.ok
    ? {
        userId: response.viewer?.userId || null,
        linkedAccounts: Array.isArray(response.viewer?.linkedAccounts) ? response.viewer.linkedAccounts : [],
      }
    : { userId: null, linkedAccounts: [] };
  updateAuthUi();
  if (state.authStatus.authenticated && state.originalPost?.author_username) {
    scheduleThreadAccountRefresh(state.originalPost);
  }
  if (updatePanel) renderPanel();
  return state.authStatus;
}

function updateAuthUi() {
  const authEl = document.getElementById("welivedit-auth-current");
  const formEl = document.getElementById("welivedit-auth-form");
  const signedEl = document.getElementById("welivedit-auth-logged-in");
  const signedSummary = document.getElementById("welivedit-auth-summary");
  const emailInput = document.getElementById("welivedit-auth-email");
  const autoInput = document.getElementById("welivedit-auto-mode");
  if (autoInput) autoInput.checked = Boolean(state.autoMode);
  if (emailInput && state.authStatus.email && !emailInput.value) emailInput.value = state.authStatus.email;
  if (!authEl) return;

  if (!state.authEnabled) {
    authEl.textContent = "Local mode";
    authEl.className = "welivedit-auth-current";
    if (formEl) formEl.style.display = "none";
    if (signedEl) signedEl.style.display = "none";
    return;
  }

  if (state.authStatus.authenticated) {
    const email = state.authStatus.email || "account";
    authEl.textContent = `✓ Signed in as ${email}`;
    authEl.className = "welivedit-auth-current ok";
    if (signedSummary) signedSummary.textContent = "Account options";
    if (formEl) formEl.style.display = "none";
    if (signedEl) signedEl.style.display = "block";
  } else {
    authEl.textContent = "Sign in to send replies.";
    authEl.className = "welivedit-auth-current warn";
    if (formEl) formEl.style.display = "grid";
    if (signedEl) {
      signedEl.style.display = "none";
      signedEl.open = false;
    }
  }
  updateSendPermissionsUi();
}

async function loginFromPanel() {
  const email = document.getElementById("welivedit-auth-email")?.value || "";
  const password = document.getElementById("welivedit-auth-password")?.value || "";
  setStatus("Signing in...");
  const response = await runtimeMessage({
    type: "WELIVEDIT_AUTH_LOGIN",
    payload: { authBaseUrl: state.authBaseUrl, email, password },
  });

  if (!response?.ok) {
    state.authStatus = { authenticated: false, email: null };
    updateAuthUi();
    setStatus(response?.message || response?.error || "Sign-in failed.");
    return;
  }

  const passwordInput = document.getElementById("welivedit-auth-password");
  if (passwordInput) passwordInput.value = "";
  state.authStatus = { authenticated: true, email: response.email || email };
  state.viewerIdentity = {
    userId: response.viewer?.userId || null,
    linkedAccounts: Array.isArray(response.viewer?.linkedAccounts) ? response.viewer.linkedAccounts : [],
  };
  updateAuthUi();
  await refreshClassifierConfig();
  scheduleThreadAccountRefresh(state.originalPost, { force: true });
  setStatus("Signed in.");
  if (state.autoMode || state.pendingManualSend) {
    const manual = state.pendingManualSend;
    state.pendingManualSend = false;
    await enqueueUnprocessedItems({ manual });
  }
}

async function logoutFromPanel() {
  const response = await runtimeMessage({ type: "WELIVEDIT_AUTH_LOGOUT" });
  state.authStatus = { authenticated: false, email: null };
  state.viewerIdentity = { userId: null, linkedAccounts: [] };
  updateAuthUi();
  setStatus(response?.ok ? "Signed out." : "Sign-out failed.");
}

async function ensureAuthIfNeeded() {
  if (!state.authEnabled) return true;
  if (state.authStatus.authenticated) return true;
  await refreshAuthStatus(false);
  if (state.authStatus.authenticated) return true;
  setStatus("Please sign in once before sending replies.");
  document.getElementById("welivedit-panel")?.classList.add("open");
  return false;
}

function normalizeAccountId(value) {
  return String(value || "").trim().toLowerCase();
}

function viewerLinkedAccountForThread() {
  const targetAccountId = normalizeAccountId(state.threadAccount?.accountId);
  if (!targetAccountId) return null;
  return (state.viewerIdentity?.linkedAccounts || []).find((account) => (
    normalizeAccountId(account?.accountId) === targetAccountId &&
    (!account?.platform || String(account.platform).toLowerCase() === "x")
  )) || null;
}

function getThreadSendPermission() {
  if (!state.authStatus.authenticated) {
    return { allowed: false, canPromptLogin: true, reason: "Sign in to verify that this is your own X post." };
  }
  if (state.threadAccount?.loading) {
    return { allowed: false, reason: "Checking who owns the original post…" };
  }
  if (!state.threadAccount?.accountId) {
    return { allowed: false, reason: "The original post account has not been identified yet." };
  }
  if (!state.threadAccount?.linkedToCommunity) {
    return { allowed: false, reason: "This post owner is not configured in the selected community." };
  }
  const viewerAccount = viewerLinkedAccountForThread();
  if (!viewerAccount) {
    return {
      allowed: false,
      reason: "You can send replies only from posts owned by one of your linked X accounts.",
    };
  }
  return { allowed: true, viewerAccount };
}

function updateSendPermissionsUi() {
  const sendButton = document.getElementById("welivedit-send");
  const autoInput = document.getElementById("welivedit-auto-mode");
  const autoRow = autoInput?.closest?.(".welivedit-auto-row") || null;
  const permission = getThreadSendPermission();

  if (sendButton) {
    if (!state.authStatus.authenticated) {
      sendButton.disabled = false;
      sendButton.textContent = "Sign in to send replies";
      sendButton.title = "Sign in first; ownership will be checked before anything is sent.";
    } else if (permission.allowed) {
      sendButton.disabled = false;
      sendButton.textContent = "Send replies to community";
      sendButton.title = "This original post belongs to your linked X account.";
    } else {
      sendButton.disabled = true;
      sendButton.textContent = "Only your own posts can be sent";
      sendButton.title = permission.reason;
    }
  }

  if (autoInput) {
    const ownershipKnownAndDenied = Boolean(
      state.authStatus.authenticated &&
      state.threadAccount?.accountId &&
      !permission.allowed
    );
    autoInput.disabled = ownershipKnownAndDenied;
    autoInput.checked = ownershipKnownAndDenied ? false : Boolean(state.autoMode);
    autoInput.title = ownershipKnownAndDenied ? permission.reason : "";
    autoRow?.classList.toggle("is-disabled", ownershipKnownAndDenied);
  }
}

function ensureViewerOwnsCurrentPost() {
  const permission = getThreadSendPermission();
  if (permission.allowed) return true;
  setStatus(permission.reason);
  document.getElementById("welivedit-panel")?.classList.add("open");
  updateSendPermissionsUi();
  return false;
}

function locationThreadStatusId() {
  const match = location.pathname.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function explicitNavigationTargets(statusId) {
  return Boolean(
    statusId &&
    state.explicitNavigationStatusId === statusId &&
    Date.now() - state.explicitNavigationAt < 2500
  );
}

function currentThreadStatusId() {
  const locationStatusId = locationThreadStatusId();
  const lockedStatusId = state.threadOwnerLock?.threadStatusId || null;

  // Some X DOM/history updates can move the URL to a visible reply while the
  // user is only scrolling. Keep the initially pinned thread unless a real
  // user navigation targeted the new status.
  if (
    lockedStatusId &&
    locationStatusId &&
    locationStatusId !== lockedStatusId &&
    !explicitNavigationTargets(locationStatusId)
  ) {
    return lockedStatusId;
  }
  return locationStatusId;
}

function extractStatusIdFromHref(href) {
  const match = String(href || "").match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function normalizedUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function canonicalStatusAnchor(article) {
  // The permalink around <time> belongs to the article itself. Arbitrary
  // /status/ links may point to quoted posts, media, parents, or cards.
  const timeAnchor = article?.querySelector?.("time")?.closest?.('a[href*="/status/"]');
  if (timeAnchor && extractStatusIdFromHref(timeAnchor.getAttribute("href") || timeAnchor.href)) {
    return timeAnchor;
  }

  const candidates = [...(article?.querySelectorAll?.('a[href*="/status/"]') || [])];
  return candidates.find((anchor) => {
    const href = anchor.getAttribute("href") || anchor.href || "";
    try {
      const pathname = new URL(href, location.origin).pathname.replace(/\/$/, "");
      return /^\/[^/]+\/status\/\d+$/.test(pathname);
    } catch (_) {
      return /^\/?[^/?#]+\/status\/\d+$/.test(String(href).split(/[?#]/)[0].replace(/\/$/, ""));
    }
  }) || null;
}

function articleAuthorUsername(article, canonicalHref, cachedUsername = null) {
  const userNameRoot = article?.querySelector?.('[data-testid="User-Name"]');
  const profileAnchor = [...(userNameRoot?.querySelectorAll?.('a[href^="/"]') || [])]
    .find((anchor) => {
      const href = String(anchor.getAttribute("href") || "");
      return /^\/[^/?#]+\/?$/.test(href) && !href.includes("/status/");
    });
  const profileMatch = String(profileAnchor?.getAttribute("href") || "").match(/^\/([^/?#]+)/);
  if (profileMatch?.[1]) return profileMatch[1];

  const statusMatch = String(canonicalHref || "").match(/^\/?([^/?#]+)\/status\//);
  return statusMatch?.[1] || cachedUsername || null;
}

function snapshotOriginalPost(candidate) {
  if (!candidate) return null;
  return {
    x_id: candidate.x_id,
    comment_id: candidate.comment_id || candidate.x_id,
    client_key: candidate.client_key || `x:${candidate.x_id}`,
    message: candidate.message || "",
    author_username: candidate.author_username || null,
    author_name: candidate.author_name || candidate.author_username || null,
    url: candidate.url || location.href,
    element: candidate.element || null,
  };
}

function pinOriginalPost(candidate) {
  const threadStatusId = currentThreadStatusId();
  if (!threadStatusId || candidate?.x_id !== threadStatusId || !candidate?.author_username) return false;

  const candidateUsername = normalizedUsername(candidate.author_username);
  const lock = state.threadOwnerLock;
  if (lock?.threadStatusId === threadStatusId) {
    if (candidateUsername !== lock.normalizedUsername) {
      console.warn("[WeLivedIt] ignored original-owner drift while scrolling", {
        threadStatusId,
        pinnedUsername: lock.username,
        candidateUsername: candidate.author_username,
        candidateUrl: candidate.url || null,
      });
      return false;
    }

    // Keep the owner immutable. Only refresh non-identity presentation fields.
    state.originalPost = {
      ...state.originalPost,
      message: candidate.message || state.originalPost?.message || "",
      author_name: candidate.author_name || state.originalPost?.author_name || lock.username,
      url: state.originalPost?.url || candidate.url || location.href,
      element: candidate.element || state.originalPost?.element || null,
    };
    return true;
  }

  const pinned = snapshotOriginalPost(candidate);
  state.threadOwnerLock = {
    threadStatusId,
    username: candidate.author_username,
    normalizedUsername: candidateUsername,
  };
  state.originalPost = pinned;
  console.info("[WeLivedIt] pinned original thread owner", {
    threadStatusId,
    username: candidate.author_username,
  });
  return true;
}

function extractAuthorDisplayName(article, username, cachedName = null) {
  const userNameEl = article?.querySelector?.('[data-testid="User-Name"]');
  if (!userNameEl) return cachedName || username || null;
  const candidates = [...userNameEl.querySelectorAll("span")]
    .map((span) => normalizeText(span.innerText || span.textContent || ""))
    .filter(Boolean)
    .filter((value) => !value.startsWith("@") && value !== "·" && !/^\d+[smhd]$/i.test(value));
  return candidates[0] || cachedName || username || null;
}

function extractArticleData(article) {
  const cached = articleDataCache.get(article);
  if (cached && article.getAttribute("data-welivedit-hidden") === "true") {
    return { ...cached, element: article };
  }

  const textEl = article.querySelector('[data-testid="tweetText"]');
  const text = normalizeText(textEl?.innerText || textEl?.textContent || "");
  if (!text && cached) return { ...cached, element: article };
  if (!text) return null;

  const statusAnchor = canonicalStatusAnchor(article);
  const statusLink = statusAnchor?.getAttribute("href") || statusAnchor?.href || null;
  const statusId = extractStatusIdFromHref(statusLink) || cached?.x_id;
  if (!statusId) return null;
  const authorUsername = articleAuthorUsername(article, statusLink, cached?.author_username);
  const authorName = extractAuthorDisplayName(article, authorUsername, cached?.author_name);
  const absoluteUrl = statusLink?.startsWith("http") ? statusLink : (statusLink ? `${location.origin}${statusLink}` : cached?.url || location.href);
  const data = { x_id: statusId, comment_id: statusId, client_key: `x:${statusId}`, message: text, author_username: authorUsername, author_name: authorName, url: absoluteUrl, element: article };
  articleDataCache.set(article, data);
  return data;
}

function isOriginalForCurrentThread(candidate) {
  const threadStatusId = currentThreadStatusId();
  return Boolean(threadStatusId && candidate?.x_id === threadStatusId);
}

function selectThreadArticles(parsed, originalStatusId, pinnedOriginal = null) {
  const validPinnedOriginal = pinnedOriginal?.x_id === originalStatusId ? pinnedOriginal : null;
  const lockedUsername = state.threadOwnerLock?.threadStatusId === originalStatusId
    ? state.threadOwnerLock.normalizedUsername
    : null;

  const visibleOriginalEntry = parsed.find((entry) => {
    if (entry.data.x_id !== originalStatusId) return false;
    if (!lockedUsername) return true;
    return normalizedUsername(entry.data.author_username) === lockedUsername;
  });
  const visibleOriginal = visibleOriginalEntry?.data || null;

  // Once pinned, the original snapshot has priority over every later DOM candidate.
  // X recycles article nodes and replies may contain links to the parent status.
  const original = validPinnedOriginal || visibleOriginal;
  if (!original) {
    return { original: null, replies: [], originalVisible: false };
  }

  const replies = parsed
    .filter((entry) => {
      if (entry.data.x_id !== originalStatusId) return true;
      // The real original is excluded. A same-ID candidate with another author is
      // malformed/ambiguous and must not be allowed to replace the owner.
      return false;
    })
    .map((entry) => entry.data);

  return { original, replies, originalVisible: Boolean(visibleOriginal) };
}

function getThreadArticles() {
  const originalStatusId = currentThreadStatusId();
  if (!originalStatusId) {
    return {
      original: null,
      replies: [],
      reason: "Open a reply conversation first. Replies will stay hidden until checked.",
      originalVisible: false,
    };
  }

  const articles = [...document.querySelectorAll("article")];
  const parsed = articles
    .map((article) => ({ article, data: extractArticleData(article) }))
    .filter((entry) => entry.data);

  const selected = selectThreadArticles(parsed, originalStatusId, state.originalPost);
  if (!selected.original) {
    return {
      ...selected,
      reason: "Waiting for the original post to be identified. Scroll to the top of the conversation once.",
    };
  }

  return { ...selected, reason: null };
}

function scanVisibleReplies({ render = true, hide = true } = {}) {
  const { original, replies, reason } = getThreadArticles();
  if (reason) {
    setStatus(reason);
    return [];
  }
  if (isOriginalForCurrentThread(original)) {
    const hadPinnedOwner = Boolean(
      state.threadOwnerLock?.threadStatusId === original.x_id &&
      state.originalPost?.x_id === original.x_id
    );
    const accepted = pinOriginalPost(original);
    if (accepted && (!hadPinnedOwner || !state.threadAccount?.accountId)) {
      scheduleThreadAccountRefresh(state.originalPost);
    }
  }
  let newCount = 0;
  for (const [domOrder, reply] of replies.entries()) {
    state.domByKey.set(reply.client_key, reply.element);
    if (!state.items.has(reply.client_key)) {
      state.items.set(reply.client_key, {
        ...reply,
        status: "detected",
        classified: false,
        classification: null,
        hidden: true,
        resolveDone: false,
        analyzeAttempted: false,
      });
      newCount += 1;
    } else {
      const current = state.items.get(reply.client_key);
      current.element = reply.element;
      current.message = reply.message;
      current.url = reply.url;
      current.author_username = reply.author_username;
      current.author_name = reply.author_name;
    }
    const currentItem = state.items.get(reply.client_key);
    currentItem.dom_order = domOrder;
    hydrateItemFromSeen(currentItem);
    updateArticleMark(currentItem);
    if (hide && !currentItem.manualRevealed) {
      if (currentItem.classified) {
        const keepHidden = isHarmful(currentItem.classification);
        applyHidden(currentItem.client_key, keepHidden, keepHidden ? "Message hidden. It may need care." : "");
      } else {
        applyHidden(currentItem.client_key, true, coverLabelForItem(currentItem));
      }
    }
  }
  state.lastPayload = buildPayload([...state.items.values()], original);
  if (newCount) setStatus(`Detected ${newCount} new repl${newCount === 1 ? "y" : "ies"}.`);
  if (render) renderPanel();
  if (state.autoMode && newCount) scheduleAutoEnqueue();
  return replies;
}

function getSelectedThreadContext() {
  const threadStatusId = currentThreadStatusId();
  const contextMatchesThread = Boolean(
    threadStatusId &&
    state.originalPost?.x_id === threadStatusId &&
    state.threadOwnerLock?.threadStatusId === threadStatusId &&
    normalizedUsername(state.originalPost?.author_username) === state.threadOwnerLock?.normalizedUsername &&
    state.threadAccount?.postId === threadStatusId &&
    state.threadAccount?.linkedToCommunity
  );
  return {
    communityId: state.communityId || null,
    accountId: contextMatchesThread ? state.threadAccount?.accountId || null : null,
  };
}

function buildPayload(items, originalOverride = null) {
  const { original } = getThreadArticles();
  const originalCandidate = originalOverride || state.originalPost || original;
  const originalPost = isOriginalForCurrentThread(originalCandidate) ? originalCandidate : null;
  const orderedItems = [...items].sort((a, b) => (a.dom_order ?? Number.MAX_SAFE_INTEGER) - (b.dom_order ?? Number.MAX_SAFE_INTEGER));
  const selectedContext = getSelectedThreadContext();
  return {
    community_id: selectedContext.communityId,
    account_id: selectedContext.accountId,
    platform: "x",
    ...SOURCE_META,
    ingestion_method: state.autoMode ? "automatic_extension_item_detection" : "manual_extension_item_send",
    processing_context: state.autoMode ? "auto_item_queue" : "manual_item_queue",
    source_label: state.autoMode ? "extension_auto" : "extension_manual",
    entity_mode: "single_comment",
    page_url: location.href,
    original_post: originalPost ? {
      x_id: originalPost.x_id,
      message: originalPost.message,
      author_username: originalPost.author_username,
      author_name: originalPost.author_name || originalPost.author_username,
      account_id: selectedContext.accountId,
      community_id: selectedContext.communityId,
      url: originalPost.url,
    } : null,
    comments: orderedItems.map((item) => ({
      client_key: item.client_key,
      x_id: item.x_id,
      comment_id: item.comment_id || item.x_id,
      message: item.message,
      author_username: item.author_username,
      author_name: item.author_name || item.author_username,
      account_id: selectedContext.accountId,
      community_id: selectedContext.communityId,
      url: item.url,
      ...SOURCE_META,
    })),
  };
}


function emptyThreadAccount(overrides = {}) {
  return {
    postId: null,
    username: null,
    accountName: null,
    accountId: null,
    exists: false,
    linkedToCommunity: false,
    status: "unknown",
    loading: false,
    saving: false,
    error: null,
    ...overrides,
  };
}

function accountRequestPayload(originalOverride = null) {
  const original = originalOverride || state.originalPost;
  const lockMatches = Boolean(
    state.threadOwnerLock?.threadStatusId === currentThreadStatusId() &&
    normalizedUsername(original?.author_username) === state.threadOwnerLock?.normalizedUsername
  );
  if (!isOriginalForCurrentThread(original) || !original?.author_username || !lockMatches) return null;
  return {
    community_id: state.communityId,
    platform: "x",
    username: original.author_username,
    account_name: original.author_name || original.author_username,
    post_id: original.x_id || original.post_id || null,
    page_url: location.href,
    source: "browser_extension",
  };
}

function applyThreadAccountResponse(response, fallbackOriginal = null) {
  const account = response?.account || response?.thread_account || response?.data?.account || response?.data?.thread_account;
  if (!account) return false;
  const original = fallbackOriginal || state.originalPost || {};
  if (!isOriginalForCurrentThread(original) || state.originalPost?.x_id !== original.x_id) {
    console.info("[WeLivedIt] ignored stale account response", {
      responsePostId: original?.x_id || null,
      currentThreadId: currentThreadStatusId(),
    });
    return false;
  }
  state.threadAccount = emptyThreadAccount({
    postId: original.x_id,
    username: account.username || original.author_username || null,
    accountName: account.account_name || account.accountName || original.author_name || original.author_username || null,
    accountId: account.account_id || account.accountId || account.id || null,
    exists: Boolean(account.exists || account.account_id || account.accountId || account.id),
    linkedToCommunity: Boolean(account.linked_to_community || account.linkedToCommunity || account.status === "configured"),
    status: account.status || "unknown",
  });
  renderThreadAccount();
  return true;
}

function scheduleThreadAccountRefresh(originalOverride = null, { force = false } = {}) {
  const original = originalOverride || state.originalPost;
  if (!isOriginalForCurrentThread(original) || !original?.author_username) {
    // Do not erase a valid pinned owner merely because X virtualized the
    // original post out of the visible DOM.
    if (isOriginalForCurrentThread(state.originalPost)) return;
    state.threadAccount = emptyThreadAccount();
    state.threadAccountLookupKey = null;
    renderThreadAccount();
    return;
  }
  clearTimeout(state.threadAccountLookupTimer);
  state.threadAccountLookupTimer = window.setTimeout(() => {
    refreshThreadAccount(original, { force }).catch((error) => {
      console.warn("[WeLivedIt] account lookup failed", error);
    });
  }, 250);
}

async function refreshThreadAccount(originalOverride = null, { force = false } = {}) {
  const original = originalOverride || state.originalPost;
  const payload = accountRequestPayload(original);
  if (!payload) return null;

  const requestGeneration = state.generation;
  const requestThreadId = original.x_id;
  const lookupKey = `${state.apiBaseUrl}|${state.communityId}|x|${requestThreadId}|${String(payload.username).toLowerCase()}`;
  if (!force && state.threadAccountLookupKey === lookupKey) {
    if (state.threadAccountLookupPromise) return state.threadAccountLookupPromise;
    if (!state.threadAccount.error && !state.threadAccount.loading) return state.threadAccount;
  }

  state.threadAccountLookupKey = lookupKey;
  if (state.authEnabled && !state.authStatus.authenticated) {
    state.threadAccount = emptyThreadAccount({
      postId: requestThreadId,
      username: payload.username,
      accountName: payload.account_name,
      status: "sign_in_required",
    });
    renderThreadAccount();
    return state.threadAccount;
  }

  state.threadAccount = emptyThreadAccount({
    postId: requestThreadId,
    username: payload.username,
    accountName: payload.account_name,
    status: "loading",
    loading: true,
  });
  renderThreadAccount();

  const lookupPromise = (async () => {
    try {
      const response = await apiPost("/api/extension/accounts/resolve", payload);
      const requestIsCurrent =
        state.generation === requestGeneration &&
        state.threadAccountLookupKey === lookupKey &&
        currentThreadStatusId() === requestThreadId &&
        state.originalPost?.x_id === requestThreadId;
      if (requestIsCurrent) {
        applyThreadAccountResponse(response, original);
      } else {
        console.info("[WeLivedIt] discarded stale account lookup", {
          requestThreadId,
          currentThreadId: currentThreadStatusId(),
          requestGeneration,
          currentGeneration: state.generation,
        });
      }
    } catch (error) {
      const requestIsCurrent =
        state.generation === requestGeneration &&
        state.threadAccountLookupKey === lookupKey &&
        currentThreadStatusId() === requestThreadId;
      if (requestIsCurrent) {
        state.threadAccount = emptyThreadAccount({
          postId: requestThreadId,
          username: payload.username,
          accountName: payload.account_name,
          status: "error",
          error: String(error?.message || error),
        });
        renderThreadAccount();
      }
    } finally {
      if (state.threadAccountLookupKey === lookupKey) {
        state.threadAccountLookupPromise = null;
      }
    }
    return state.threadAccount;
  })();

  state.threadAccountLookupPromise = lookupPromise;
  return lookupPromise;
}

async function ensureThreadContextReady() {
  if (!state.communityId) {
    setStatus("No community is selected.");
    return false;
  }

  const threadStatusId = currentThreadStatusId();
  const detectedOriginal = getThreadArticles().original;
  const original = isOriginalForCurrentThread(state.originalPost)
    ? state.originalPost
    : detectedOriginal;
  if (!threadStatusId || !isOriginalForCurrentThread(original) || !original?.author_username) {
    setStatus("Open the original X post (or scroll to its top once) so its account can be identified.");
    return false;
  }

  state.originalPost = original;
  const account = await refreshThreadAccount(original);
  if (!account?.accountId) {
    const detail = account?.error ? ` ${account.error}` : "";
    setStatus(`The original post account has not been identified yet.${detail}`);
    renderPanel();
    return false;
  }
  if (!account.linkedToCommunity) {
    setStatus("This post owner is not a monitored account in the selected community. The viewer's account will not be used as a fallback.");
    renderPanel();
    return false;
  }

  return true;
}

async function saveThreadAccount() {
  const payload = accountRequestPayload();
  if (!payload || state.threadAccount.saving) return;
  if (!(await ensureAuthIfNeeded())) return;

  state.threadAccount = { ...state.threadAccount, saving: true, error: null };
  renderThreadAccount();
  try {
    const response = await apiPost("/api/extension/accounts/save", payload);
    applyThreadAccountResponse(response, state.originalPost);
    setStatus(`Saved @${payload.username} to ${state.communityId}.`);
  } catch (error) {
    state.threadAccount = {
      ...state.threadAccount,
      saving: false,
      status: "error",
      error: String(error?.message || error),
    };
    setStatus(state.threadAccount.error);
    renderThreadAccount();
  }
}

function renderThreadAccount() {
  const box = document.getElementById("welivedit-thread-account");
  const usernameEl = document.getElementById("welivedit-account-username");
  const statusEl = document.getElementById("welivedit-account-status");
  const saveButton = document.getElementById("welivedit-save-account");
  if (!box || !usernameEl || !statusEl || !saveButton) return;

  const account = state.threadAccount || emptyThreadAccount();
  updateSendPermissionsUi();
  usernameEl.textContent = account.username ? `@${account.username}` : "Not detected";
  statusEl.className = "welivedit-account-status";

  if (!account.username) {
    statusEl.textContent = "Open an X post to identify its author.";
    saveButton.hidden = true;
    return;
  }
  if (account.loading) {
    statusEl.textContent = "Checking this account against the community…";
    saveButton.hidden = true;
    return;
  }
  if (account.saving) {
    statusEl.textContent = "Saving account and community relationship…";
    saveButton.hidden = false;
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    return;
  }
  if (account.linkedToCommunity) {
    statusEl.textContent = `Configured for ${state.communityId}${account.accountId ? ` · DB ${account.accountId}` : ""}. Comments will be linked to this post owner.`;
    statusEl.classList.add("ok");
    saveButton.hidden = true;
    return;
  }
  if (account.status === "sign_in_required") {
    statusEl.textContent = "Sign in to check or save this account.";
    statusEl.classList.add("warn");
  } else if (account.error) {
    statusEl.textContent = account.error;
    statusEl.classList.add("error");
  } else if (account.exists) {
    statusEl.textContent = `The account exists, but is not linked to ${state.communityId}.`;
    statusEl.classList.add("warn");
  } else {
    statusEl.textContent = `This account is not configured for ${state.communityId}. Saving it is optional.`;
    statusEl.classList.add("warn");
  }

  saveButton.hidden = false;
  saveButton.disabled = !state.authStatus.authenticated;
  saveButton.textContent = account.exists ? "Add account to community" : "Save account to community";
}

const MAX_CONCURRENT_ITEM_JOBS = Math.max(1, Number(globalThis.WELIVEDIT_CONFIG?.ITEM_CONCURRENCY || 3));
const MAX_RESOLVE_BATCH_SIZE = Math.max(1, Number(globalThis.WELIVEDIT_CONFIG?.RESOLVE_BATCH_SIZE || 40));
const DOM_SCAN_DEBOUNCE_MS = Math.max(100, Number(globalThis.WELIVEDIT_CONFIG?.DOM_SCAN_DEBOUNCE_MS || 300));
const AUTO_ENQUEUE_DEBOUNCE_MS = Math.max(100, Number(globalThis.WELIVEDIT_CONFIG?.AUTO_ENQUEUE_DEBOUNCE_MS || 180));
const MAX_SEEN_RECORDS = 2000;

function itemSeenKey(item) {
  const id = String(item?.comment_id || item?.x_id || item?.client_key || "").replace(/^x:/, "");
  return `${SEEN_CACHE_NAMESPACE}|${state.classifierCacheKey || state.apiBaseUrl}|${state.communityId}|${state.model}|x|${id}`;
}

function minimalClassification(classification) {
  if (!classification || typeof classification !== "object") return null;
  return {
    classification_id: classification.classification_id || classification.id || null,
    type_of_harm: classification.type_of_harm || classification.label || "none",
    content_tone: classification.content_tone || null,
    severity: classification.severity || null,
    severity_score: classification.severity_score ?? null,
    confidence: classification.confidence ?? null,
    evidence_quote: classification.evidence_quote || "",
    reason: classification.reason || "",
    model_signature_id: classification.model_signature_id || null,
  };
}

function hydrateItemFromSeen(item) {
  if (!item) return item;
  const record = state.seenRecords[itemSeenKey(item)];
  if (!record) return item;
  item.resolveDone = Boolean(record.resolve_done);
  item.analyzeAttempted = Boolean(record.analyze_attempted);
  item.autoBlocked = Boolean(record.blocked);
  item.status = record.status || item.status;
  item.classification_id = record.classification_id || item.classification_id;
  if (record.classification) {
    item.classification = record.classification;
    item.classified = true;
    item.status = record.status || "cached_local";
  }
  return item;
}

function scheduleSeenRecordsPersist() {
  clearTimeout(state.seenPersistTimer);
  state.seenPersistTimer = window.setTimeout(async () => {
    const entries = Object.entries(state.seenRecords);
    if (entries.length > MAX_SEEN_RECORDS) {
      entries.sort((a, b) => Number(b[1]?.updated_at || 0) - Number(a[1]?.updated_at || 0));
      state.seenRecords = Object.fromEntries(entries.slice(0, MAX_SEEN_RECORDS));
    }
    await storageSet({ [STORAGE_KEYS.seenRecords]: state.seenRecords });
  }, 120);
}

function rememberItem(item, patch = {}) {
  if (!item) return;
  const key = itemSeenKey(item);
  const previous = state.seenRecords[key] || {};
  state.seenRecords[key] = {
    ...previous,
    comment_id: String(item.comment_id || item.x_id || ""),
    status: item.status,
    resolve_done: Boolean(item.resolveDone),
    analyze_attempted: Boolean(item.analyzeAttempted),
    classification_id: item.classification_id || item.classification?.classification_id || previous.classification_id || null,
    classification: item.classified ? minimalClassification(item.classification) : (previous.classification || null),
    updated_at: Date.now(),
    ...patch,
  };
  scheduleSeenRecordsPersist();
}

function coverLabelForItem(item) {
  const status = String(item?.status || "");
  if (status === "queued" || status === "queued_analyze") return "Reply queued for checking.";
  if (status === "resolving") return "Checking whether this reply was seen before...";
  if (status === "analyzing") return "Analyzing this reply...";
  if (status === "error") return "This reply could not be checked. Use Retry in the panel.";
  return "Message hidden until it is checked.";
}

function statusDisplay(item) {
  if (item.classified) {
    if (isHarmful(item.classification)) return { text: "may need care", className: "harmful" };
    if (String(item.status).includes("cached")) return { text: "safe · cached", className: "safe" };
    return { text: "safe · checked", className: "safe" };
  }
  const status = String(item.status || "detected");
  if (status === "resolving") return { text: "resolving", className: "processing" };
  if (status === "analyzing") return { text: "analyzing", className: "processing" };
  if (status === "queued" || status === "queued_analyze") return { text: "queued", className: "processing" };
  if (status === "error") return { text: "check failed", className: "error" };
  if (status === "missing") return { text: "waiting for analysis", className: "processing" };
  return { text: "detected", className: "" };
}

function normalizeBackendIdentity(value) {
  return String(value || "").trim().replace(/^x:/, "");
}

function backendItemIdentities(serverItem) {
  const values = [
    serverItem?.client_key,
    serverItem?.clientKey,
    serverItem?.comment_id,
    serverItem?.commentId,
    serverItem?.x_id,
    serverItem?.xId,
    serverItem?.source_comment_id,
    serverItem?.input?.client_key,
    serverItem?.input?.comment_id,
    serverItem?.comment?.client_key,
    serverItem?.comment?.comment_id,
  ];
  return [...new Set(values.map(normalizeBackendIdentity).filter(Boolean))];
}

function applyServerItemToItem(item, serverItem, { render = true } = {}) {
  if (!item || !serverItem) return item;
  item.comment_db_id = serverItem.comment_db_id || serverItem.commentDbId || item.comment_db_id;
  item.classification_id = serverItem.classification_id || serverItem.classificationId || serverItem.classification?.classification_id || serverItem.classification?.id || item.classification_id;
  item.status = serverItem.status || (isServerItemClassified(serverItem) ? "cached" : "missing");
  item.classified = isServerItemClassified(serverItem);
  item.classification = serverItem.classification || item.classification || null;
  item.ui = serverItem.ui || item.ui || null;

  const current = state.items.get(item.client_key);
  if (current && current !== item) Object.assign(current, item);
  const visibleItem = current || item;
  if (state.items.has(visibleItem.client_key)) {
    if (visibleItem.classified) {
      const keepHidden = isHarmful(visibleItem.classification);
      if (!visibleItem.manualRevealed) applyHidden(visibleItem.client_key, keepHidden, keepHidden ? "Message hidden. It may need care." : "");
    } else if (!visibleItem.manualRevealed) {
      applyHidden(visibleItem.client_key, true, coverLabelForItem(visibleItem));
    }
    updateArticleMark(visibleItem);
    if (render) renderPanel();
  }
  return visibleItem;
}

function applySingleResponseToItem(item, response) {
  const serverItem = extractBackendItems(response)[0];
  return serverItem ? applyServerItemToItem(item, serverItem) : item;
}

function applyBatchResponseToItems(items, response) {
  const serverItems = extractBackendItems(response);
  const byIdentity = new Map();
  for (const serverItem of serverItems) {
    for (const identity of backendItemIdentities(serverItem)) {
      if (!byIdentity.has(identity)) byIdentity.set(identity, serverItem);
    }
  }

  let matched = 0;
  items.forEach((item, index) => {
    const identities = [item.client_key, item.comment_id, item.x_id]
      .map(normalizeBackendIdentity)
      .filter(Boolean);
    let serverItem = identities.map((identity) => byIdentity.get(identity)).find(Boolean);
    if (!serverItem && serverItems.length === items.length) serverItem = serverItems[index];
    if (!serverItem) return;
    matched += 1;
    applyServerItemToItem(item, serverItem, { render: false });
  });
  renderPanel();
  return { matched, total: serverItems.length };
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function resolveItemsInBatches(items) {
  const pending = items.filter((item) => item && !item.classified && !item.resolveDone && !state.inFlight.has(item.client_key));
  if (!pending.length) return { attempted: 0, classified: 0, failed: false };

  const generation = state.generation;
  let classified = 0;
  let failed = false;

  for (const batch of chunkItems(pending, MAX_RESOLVE_BATCH_SIZE)) {
    for (const item of batch) {
      state.inFlight.add(item.client_key);
      item.status = "resolving";
      updateArticleMark(item);
      if (!item.manualRevealed) applyHidden(item.client_key, true, coverLabelForItem(item));
    }
    renderPanel();

    try {
      const response = await apiPost("/api/extension/x-comments/resolve", {
        ...buildPayload(batch),
        model: state.model,
      });
      if (generation !== state.generation) break;

      applyBatchResponseToItems(batch, response);
      for (const item of batch) {
        item.resolveDone = true;
        if (item.classified) {
          classified += 1;
          item.status = String(item.status || "cached").includes("analyzed") ? "analyzed" : "cached";
          rememberItem(item, { blocked: false, resolve_status: "classified" });
        } else {
          item.status = "missing";
          rememberItem(item, { blocked: false, resolve_status: "missing", classification: null });
        }
        updateArticleMark(item);
      }
    } catch (error) {
      failed = true;
      console.warn("[WeLivedIt] bulk resolve failed; falling back to per-item resolve", error);
      for (const item of batch) {
        item.status = "detected";
        item.lastError = String(error?.message || error);
        updateArticleMark(item);
      }
    } finally {
      for (const item of batch) state.inFlight.delete(item.client_key);
      renderPanel();
    }
  }

  state.lastBulkResolveCount = pending.length;
  return { attempted: pending.length, classified, failed };
}

async function processSingleItem(item, { manual = false } = {}) {
  if (!item) return;
  const key = item.client_key;
  state.inFlight.add(key);
  item.autoBlocked = false;
  try {
    hydrateItemFromSeen(item);
    if (item.classified) {
      updateArticleMark(item);
      return;
    }
    if (item.autoBlocked && !manual) return;

    if (!item.resolveDone) {
      item.status = "resolving";
      updateArticleMark(item);
      if (!item.manualRevealed) applyHidden(key, true, coverLabelForItem(item));
      renderPanel();
      const resolved = await apiPost("/api/extension/x-comments/resolve", { ...buildPayload([item]), model: state.model });
      applySingleResponseToItem(item, resolved);
      item.resolveDone = true;
      if (item.classified) {
        item.status = String(item.status || "cached").includes("analyzed") ? "analyzed" : "cached";
        rememberItem(item, { blocked: false, resolve_status: "classified" });
        updateArticleMark(item);
        return;
      }
      item.status = "missing";
      rememberItem(item, { blocked: false, resolve_status: "missing", classification: null });
    }

    item.status = "analyzing";
    item.analyzeAttempted = true;
    updateArticleMark(item);
    if (!item.manualRevealed) applyHidden(key, true, coverLabelForItem(item));
    renderPanel();
    const analyzed = await apiPost("/api/extension/x-comments/analyze", { ...buildPayload([item]), model: state.model, force: false });
    applySingleResponseToItem(item, analyzed);
    if (!item.classified) throw new Error("The backend did not return a classification for this reply.");
    item.status = "analyzed";
    rememberItem(item, { blocked: false, resolve_status: "missing", analyze_status: "classified" });
    updateArticleMark(item);
  } catch (error) {
    item.status = "error";
    item.autoBlocked = true;
    item.lastError = String(error?.message || error);
    rememberItem(item, {
      blocked: true,
      failed_stage: item.resolveDone ? "analyze" : "resolve",
      last_error: item.lastError,
    });
    if (!item.manualRevealed) applyHidden(key, true, coverLabelForItem(item));
    updateArticleMark(item);
  } finally {
    state.inFlight.delete(key);
    state.retrying.delete(key);
    renderPanel();
  }
}

function pumpItemQueue() {
  while (state.activeWorkers < MAX_CONCURRENT_ITEM_JOBS && state.workQueue.length) {
    const job = state.workQueue.shift();
    state.queued.delete(job.key);
    const item = state.items.get(job.key) || job.item;
    if (!item || item.classified || (item.autoBlocked && !job.manual)) continue;
    state.activeWorkers += 1;
    processSingleItem(item, { manual: job.manual })
      .finally(() => {
        state.activeWorkers -= 1;
        pumpItemQueue();
        renderPanel();
      });
  }
}

function enqueueItem(item, { manual = false } = {}) {
  if (!item) return false;
  hydrateItemFromSeen(item);
  if (item.classified || state.inFlight.has(item.client_key) || state.queued.has(item.client_key)) return false;
  if (item.autoBlocked && !manual) return false;
  if (manual && item.autoBlocked) {
    item.autoBlocked = false;
    const record = state.seenRecords[itemSeenKey(item)] || {};
    state.seenRecords[itemSeenKey(item)] = { ...record, blocked: false, last_error: null, updated_at: Date.now() };
    scheduleSeenRecordsPersist();
  }
  item.status = item.resolveDone ? "queued_analyze" : "queued";
  state.queued.add(item.client_key);
  state.workQueue.push({ key: item.client_key, item, manual });
  updateArticleMark(item);
  if (!item.manualRevealed) applyHidden(item.client_key, true, coverLabelForItem(item));
  pumpItemQueue();
  return true;
}

async function enqueueUnprocessedItems({ manual = false } = {}) {
  if (!(await ensureAuthIfNeeded())) {
    if (manual) state.pendingManualSend = true;
    return 0;
  }
  scanVisibleReplies({ render: false, hide: true });
  if (!(await ensureThreadContextReady())) return 0;
  if (!ensureViewerOwnsCurrentPost()) return 0;
  const items = [...state.items.values()].sort((a, b) => (a.dom_order ?? Number.MAX_SAFE_INTEGER) - (b.dom_order ?? Number.MAX_SAFE_INTEGER));
  const candidates = items.filter((item) => (
    !item.classified &&
    !state.inFlight.has(item.client_key) &&
    !state.queued.has(item.client_key) &&
    (!item.autoBlocked || manual)
  ));

  const resolveSummary = await resolveItemsInBatches(candidates);

  let queued = 0;
  for (const item of candidates) {
    if (enqueueItem(item, { manual })) queued += 1;
  }

  const cached = resolveSummary.classified;
  if (cached || queued) {
    setStatus(`${cached ? `${cached} cached · ` : ""}${queued} queued for analysis · up to ${MAX_CONCURRENT_ITEM_JOBS} active.`);
  } else {
    setStatus("No new replies to check.");
  }
  renderPanel();
  return queued;
}

function scheduleAutoEnqueue() {
  clearTimeout(state.autoEnqueueTimer);
  state.autoEnqueueTimer = window.setTimeout(() => {
    if (state.autoMode) enqueueUnprocessedItems({ manual: false });
  }, AUTO_ENQUEUE_DEBOUNCE_MS);
}

async function onAutoModeChanged(event) {
  const requested = Boolean(event?.target?.checked);
  if (requested && state.authStatus.authenticated && !getThreadSendPermission().allowed) {
    state.autoMode = false;
    if (event?.target) event.target.checked = false;
    await storageSet({ [STORAGE_KEYS.autoMode]: false });
    setStatus(getThreadSendPermission().reason);
    renderPanel();
    return;
  }
  state.autoMode = requested;
  await storageSet({ [STORAGE_KEYS.autoMode]: state.autoMode });
  setStatus(state.autoMode ? "Auto-check is on." : "Auto-check is off.");
  if (state.autoMode) scheduleAutoEnqueue();
  renderPanel();
}

async function retryItem(clientKey) {
  const item = state.items.get(clientKey);
  if (!item) return;

  // Lock immediately, before awaiting authentication, so repeated clicks cannot
  // start overlapping retries for the same reply. The lock is released only
  // when the retry finishes or fails and the item is retryable again.
  if (state.retrying.has(clientKey) || state.inFlight.has(clientKey) || state.queued.has(clientKey)) return;
  state.retrying.add(clientKey);
  renderPanel();

  try {
    if (!(await ensureAuthIfNeeded())) {
      state.pendingManualSend = true;
      state.retrying.delete(clientKey);
      renderPanel();
      return;
    }
    if (!(await ensureThreadContextReady())) {
      state.retrying.delete(clientKey);
      renderPanel();
      return;
    }
    if (!ensureViewerOwnsCurrentPost()) {
      state.retrying.delete(clientKey);
      renderPanel();
      return;
    }

    const queued = enqueueItem(item, { manual: true });
    if (!queued) {
      state.retrying.delete(clientKey);
      renderPanel();
      return;
    }

    setStatus("Retry queued.");
    renderPanel();
  } catch (error) {
    state.retrying.delete(clientKey);
    setStatus(`Retry could not start: ${String(error?.message || error)}`);
    renderPanel();
  }
}


function logCheckStep(step, data = {}) {
  try {
    const event = {
      at: new Date().toISOString(),
      step,
      data,
    };
    state.debugEvents.push(event);
    if (state.debugEvents.length > 300) state.debugEvents.shift();
    window.__weliveditLastDebug = debugSnapshot ? debugSnapshot() : { step, data };
    console.info(`[WeLivedIt v41] ${step}`, data);
    const box = document.getElementById("welivedit-debug-log-box");
    if (box) {
      const line = document.createElement("div");
      line.textContent = `${event.at.split("T")[1]?.replace("Z","") || ""} ${step} ${JSON.stringify(data || {}).slice(0, 220)}`;
      box.appendChild(line);
      while (box.childNodes.length > 80) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }
  } catch (_) {
    // Logging must never break the safety flow.
  }
}

function recordApiResponse(path, data) {
  try {
    state.lastApiResponses.push({
      at: new Date().toISOString(),
      path,
      summary: data?.summary || null,
      item_count: extractBackendItems(data).length,
      sample_items: extractBackendItems(data).slice(0, 5).map((item) => ({
        client_key: item.client_key,
        comment_id: item.comment_id,
        x_id: item.x_id,
        classified: item.classified,
        status: item.status,
        has_classification: Boolean(item.classification),
        type_of_harm: item.classification?.type_of_harm || item.type_of_harm || null,
      })),
    });
    if (state.lastApiResponses.length > 20) state.lastApiResponses.shift();
  } catch (_) {}
}

function debugSnapshot() {
  const items = [...state.items.values()].sort((a, b) => (a.dom_order ?? Number.MAX_SAFE_INTEGER) - (b.dom_order ?? Number.MAX_SAFE_INTEGER));
  return {
    url: location.href,
    apiBaseUrl: state.apiBaseUrl,
    communityId: state.communityId,
    accountId: state.threadAccount?.accountId || null,
    accountLinkedToCommunity: Boolean(state.threadAccount?.linkedToCommunity),
    model: state.model,
    classifierCacheKey: state.classifierCacheKey,
    classifierConfig: state.classifierConfig,
    authEnabled: state.authEnabled,
    authStatus: state.authStatus,
    counts: {
      items: items.length,
      domByKey: state.domByKey.size,
      classified: items.filter((x) => x.classified).length,
      safe: items.filter((x) => x.classified && !isHarmful(x.classification)).length,
      harmful: items.filter((x) => x.classified && isHarmful(x.classification)).length,
      waiting: items.filter((x) => !x.classified).length,
      hidden: items.filter((x) => x.hidden).length,
    },
    item_sample: items.slice(0, 12).map((item) => ({
      client_key: item.client_key,
      comment_id: item.comment_id,
      x_id: item.x_id,
      status: item.status,
      classified: item.classified,
      hidden: item.hidden,
      manualRevealed: item.manualRevealed,
      has_dom: Boolean(item.element?.isConnected || state.domByKey.get(item.client_key)?.isConnected),
      classification: item.classification ? {
        type_of_harm: item.classification.type_of_harm,
        content_tone: item.classification.content_tone,
        confidence: item.classification.confidence,
      } : null,
    })),
    lastApiResponses: state.lastApiResponses,
    debugEvents: state.debugEvents.slice(-300),
  };
}



async function sendVisibleToCommunity({ triggeredByLogin = false } = {}) {
  const queued = await enqueueUnprocessedItems({ manual: true });
  if (triggeredByLogin && queued) setStatus(`Signed in. Queued ${queued} replies.`);
}


async function apiPost(path, body) {
  if (
    path === "/api/extension/x-comments/resolve" ||
    path === "/api/extension/x-comments/analyze"
  ) {
    const permission = getThreadSendPermission();
    if (!permission.allowed) {
      throw new Error(permission.reason || "This post is not owned by your linked X account.");
    }
  }
  const url = `${state.apiBaseUrl}${path}`;
  logCheckStep("apiPost through background", {
    path,
    url,
    bodyComments: Array.isArray(body?.comments) ? body.comments.length : null,
    communityId: body?.community_id || null,
    accountId: body?.account_id || null,
  });

  const proxyResponse = await runtimeMessage({
    type: "WELIVEDIT_API_REQUEST",
    url,
    method: "POST",
    body,
    authRequired: state.authEnabled,
    timeoutMs: 180000,
  });

  if (proxyResponse?.auth_required || proxyResponse?.status === 401 || proxyResponse?.status === 403) {
    state.authStatus = { authenticated: false, email: null };
    updateAuthUi();
    document.getElementById("welivedit-panel")?.classList.add("open");
  }
  if (!proxyResponse?.ok) {
    console.error("WeLivedIt API error", proxyResponse);
    throw new Error(proxyResponse?.message || proxyResponse?.data?.message || proxyResponse?.error || `API error ${proxyResponse?.status || 0}`);
  }
  if (proxyResponse.data?.thread_account) {
    applyThreadAccountResponse(proxyResponse.data, state.originalPost);
  }
  recordApiResponse(path, proxyResponse.data);
  return proxyResponse.data;
}

function extractBackendItems(response) {
  const candidates = [
    response?.items,
    response?.data?.items,
    response?.data?.data?.items,
    response?.results,
    response?.comments,
    response?.data?.comments,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function isServerItemClassified(serverItem) {
  const status = String(serverItem?.status || "").toLowerCase();
  return Boolean(serverItem?.classified || serverItem?.classification || status === "cached" || status === "analyzed" || status === "classified");
}

function revealOnlyWhenAllVisibleClassified() {
  // Earlier builds waited until *all* visible replies were classified before
  // revealing any safe reply. In X, new replies can be detected while analyze is
  // running, so this could keep already-classified safe replies hidden forever.
  // Reveal per item instead: safe classified replies are shown, harmful/missing
  // replies stay hidden.
  const items = [...state.items.values()];
  if (!items.length) return;
  for (const item of items) {
    if (item.manualRevealed) continue;
    if (!item.classified) {
      applyHidden(item.client_key, true, "Message hidden until it is checked.");
      continue;
    }
    const keepHidden = isHarmful(item.classification);
    applyHidden(item.client_key, keepHidden, keepHidden ? "Message hidden. It may need care." : "");
  }
}

function redactionTargets(article) {
  if (!article) return [];
  return [...article.children].filter((el) => {
    return !el.classList?.contains("welivedit-cover") && !el.classList?.contains("welivedit-mark");
  });
}

function applyRedactionShell(article) {
  if (!article) return;

  for (const el of redactionTargets(article)) {
    // Empty original style is a valid stored value. Do not overwrite it on hover/mutation.
    if (!el.hasAttribute("data-welivedit-original-style")) {
      el.dataset.weliveditOriginalStyle = el.getAttribute("style") || "";
    }

    el.classList.add("welivedit-redacted-shell");
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("inert", "");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("opacity", "0", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.style.setProperty("user-select", "none", "important");
    el.style.setProperty("-webkit-user-select", "none", "important");
    el.style.setProperty("filter", "none", "important");
  }
}

function restoreRedactionShell(article) {
  if (!article) return;
  for (const el of redactionTargets(article)) {
    el.classList.remove("welivedit-redacted-shell");
    el.removeAttribute("aria-hidden");
    el.removeAttribute("inert");
    if (el.dataset.weliveditOriginalStyle !== undefined) {
      const original = el.dataset.weliveditOriginalStyle;
      delete el.dataset.weliveditOriginalStyle;
      if (original) el.setAttribute("style", original);
      else el.removeAttribute("style");
    } else {
      el.style.removeProperty("visibility");
      el.style.removeProperty("opacity");
      el.style.removeProperty("pointer-events");
      el.style.removeProperty("user-select");
      el.style.removeProperty("-webkit-user-select");
      el.style.removeProperty("filter");
    }
  }
  if (article.hasAttribute("data-welivedit-original-min-height")) {
    const original = article.dataset.weliveditOriginalMinHeight;
    delete article.dataset.weliveditOriginalMinHeight;
    if (original) article.style.minHeight = original;
    else article.style.removeProperty("min-height");
  }
}


function markArticle(article, item = null) {
  if (!article) return null;
  let mark = article.querySelector(":scope > .welivedit-mark");
  if (!mark) {
    mark = document.createElement("span");
    mark.className = "welivedit-mark";
    article.style.position = article.style.position || "relative";
    article.prepend(mark);
  }
  if (item) {
    mark.className = "welivedit-mark";
    if (item.classified) {
      if (isHarmful(item.classification)) {
        mark.textContent = "!";
        mark.classList.add("is-harmful");
        mark.title = "Checked: may need care";
      } else {
        mark.textContent = "✓";
        mark.classList.add(String(item.status).includes("cached") ? "is-cached" : "is-safe");
        mark.title = String(item.status).includes("cached") ? "Checked from cache" : "Checked: safe";
      }
    } else if (item.status === "error") {
      mark.textContent = "×";
      mark.classList.add("is-error");
      mark.title = item.lastError || "Check failed";
    } else if (["queued", "queued_analyze", "resolving", "analyzing", "missing"].includes(String(item.status))) {
      mark.textContent = "…";
      mark.classList.add("is-processing");
      mark.title = statusDisplay(item).text;
    } else {
      mark.textContent = "W";
      mark.title = "Detected by WeLivedIt";
    }
  }
  return mark;
}

function updateArticleMark(item) {
  if (!item) return;
  const article = item.element || state.domByKey.get(item.client_key);
  markArticle(article, item);
}

function ensureCover(article, clientKey) {
  if (!article || !clientKey) return null;
  let cover = state.coverByKey.get(clientKey);
  if (!cover) {
    cover = document.createElement("div");
    cover.className = "welivedit-cover";
    cover.dataset.clientKey = clientKey;
    cover.addEventListener("click", (event) => event.stopPropagation());
    cover.addEventListener("mousedown", (event) => event.stopPropagation());
    cover.addEventListener("mouseup", (event) => event.stopPropagation());
    cover.addEventListener("mouseover", (event) => event.stopPropagation());
    state.coverByKey.set(clientKey, cover);
  }

  article.style.position = article.style.position || "relative";
  if (cover.parentElement !== article) article.appendChild(cover);
  positionCover(article, cover);
  return cover;
}

function positionCover(article, cover) {
  if (!article?.isConnected || !cover?.isConnected) {
    cover?.classList?.remove("is-visible");
    return;
  }
  cover.classList.add("is-visible");
}

function showRehideControl(article, cover, clientKey) {
  if (!article?.isConnected || !cover) return;
  cover.classList.add("is-rehide", "is-visible");
  cover.setAttribute("aria-hidden", "false");

  if (cover.dataset.weliveditRehideFor === clientKey && cover.querySelector("button")) return;

  cover.dataset.weliveditRehideFor = clientKey;
  cover.innerHTML = `<button type="button" aria-label="Hide this reply again on X">Hide again</button>`;
  cover.querySelector("button")?.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    const item = state.items.get(clientKey);
    if (!item) return;
    item.manualRevealed = false;
    applyHidden(
      clientKey,
      true,
      item.classified && isHarmful(item.classification)
        ? "Message hidden. It may need care."
        : "Message hidden.",
      { force: true }
    );
    setStatus("Reply hidden again on X.");
    renderPanel();
  });
}

function updateAllPortalCovers() {
  for (const [clientKey, cover] of state.coverByKey.entries()) {
    const item = state.items.get(clientKey);
    const article = item?.element || state.domByKey.get(clientKey);
    if (!item || !article?.isConnected) {
      cover?.classList?.remove("is-visible", "is-rehide");
      continue;
    }

    if (item.hidden) {
      cover.classList.remove("is-rehide");
      delete cover.dataset.weliveditRehideFor;
      positionCover(article, cover);
      continue;
    }

    if (item.manualRevealed) {
      showRehideControl(article, cover, clientKey);
      continue;
    }

    cover.classList.remove("is-visible", "is-rehide");
    delete cover.dataset.weliveditRehideFor;
  }
}
function applyHidden(clientKey, hidden, label = "Message hidden until it is checked.", options = {}) {
  const item = state.items.get(clientKey);
  const article = item?.element || state.domByKey.get(clientKey);
  if (!article || !item) return;

  if (hidden && item.manualRevealed && !options.force) return;

  const cover = ensureCover(article, clientKey);
  if (!cover) return;
  item.hidden = hidden;
  if (hidden) {
    item.manualRevealed = false;
    cover.classList.remove("is-rehide");
    delete cover.dataset.weliveditRehideFor;
    article.classList.add("welivedit-hard-hidden");
    article.setAttribute("data-welivedit-hidden", "true");
    applyRedactionShell(article);
    cover.setAttribute("aria-hidden", "false");
    cover.innerHTML = `<div>${escapeHtml(label || "Message hidden.")}</div><button type="button">Show message</button>`;
    positionCover(article, cover);
    cover.querySelector("button")?.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      item.manualRevealed = true;
      applyHidden(clientKey, false, "", { manual: true });
      setStatus("Reply shown on X. Use Hide again to conceal it when finished.");
      renderPanel();
    }, { once: true });
  } else {
    article.classList.remove("welivedit-hard-hidden");
    article.removeAttribute("data-welivedit-hidden");
    restoreRedactionShell(article);

    if (options.manual || item.manualRevealed) {
      showRehideControl(article, cover, clientKey);
    } else {
      cover.setAttribute("aria-hidden", "true");
      cover.classList.remove("is-visible", "is-rehide");
      delete cover.dataset.weliveditRehideFor;
      cover.innerHTML = "";
    }
  }
}
function toggleVisibility(clientKey) {
  const item = state.items.get(clientKey);
  if (!item) return;
  if (item.hidden) {
    item.manualRevealed = true;
    applyHidden(clientKey, false, "", { manual: true });
  } else {
    item.manualRevealed = false;
    applyHidden(clientKey, true, item.classified && isHarmful(item.classification) ? "Message hidden. It may need care." : "Message hidden.", { force: true });
  }
  renderPanel();
}

function exactArticleForItem(item) {
  if (!item) return null;
  const expectedId = String(item.x_id || item.comment_id || "");
  const expectedAuthor = normalizedUsername(item.author_username);
  const direct = item.element || state.domByKey.get(item.client_key);
  if (direct?.isConnected) {
    const directData = extractArticleData(direct);
    if (
      String(directData?.x_id || "") === expectedId &&
      (!expectedAuthor || normalizedUsername(directData?.author_username) === expectedAuthor)
    ) return direct;
  }

  let idOnlyMatch = null;
  for (const article of document.querySelectorAll("article")) {
    const data = extractArticleData(article);
    if (String(data?.x_id || "") !== expectedId) continue;
    if (!idOnlyMatch) idOnlyMatch = article;
    if (!expectedAuthor || normalizedUsername(data?.author_username) === expectedAuthor) return article;
  }
  return idOnlyMatch;
}

function temporarilyHighlightArticle(article) {
  if (!article) return;
  article.classList.remove("welivedit-focus-highlight");
  void article.offsetWidth;
  article.classList.add("welivedit-focus-highlight");
  window.setTimeout(() => article.classList.remove("welivedit-focus-highlight"), 2600);
}

function focusItemOnX(clientKey) {
  const item = state.items.get(clientKey);
  if (!item) return;

  item.manualRevealed = true;
  applyHidden(clientKey, false, "", { manual: true });
  const article = exactArticleForItem(item);

  if (article) {
    document.getElementById("welivedit-panel")?.classList.remove("open");
    article.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    temporarilyHighlightArticle(article);
    window.setTimeout(() => temporarilyHighlightArticle(article), 450);
    setStatus(`Focused ${item.author_username ? `@${item.author_username}` : "reply"} on X.`);
  } else if (item.url) {
    const opened = window.open(item.url, "_blank", "noopener,noreferrer");
    if (opened) {
      setStatus("The reply was no longer loaded in this scroll, so its exact X URL was opened in a new tab.");
    } else {
      setStatus("The reply is no longer loaded. Allow pop-ups to open its exact X URL.");
    }
  } else {
    setStatus("This reply is no longer loaded and has no exact X URL available.");
  }
  renderPanel();
}

function renderPanel() {
  updateAuthUi();
  renderThreadAccount();
  updateSendPermissionsUi();
  const summary = document.getElementById("welivedit-summary");
  const content = document.getElementById("welivedit-content");
  if (!summary || !content) return;
  const items = [...state.items.values()].sort((a, b) => (a.dom_order ?? Number.MAX_SAFE_INTEGER) - (b.dom_order ?? Number.MAX_SAFE_INTEGER));
  renderCommentClimate(items);
  const active = items.filter((x) => state.inFlight.has(x.client_key)).length;
  const queuedCount = items.filter((x) => state.queued.has(x.client_key)).length;
  const waiting = items.filter((x) => !x.classified && x.status !== "error" && !state.inFlight.has(x.client_key) && !state.queued.has(x.client_key)).length;
  const errors = items.filter((x) => x.status === "error").length;
  const harmful = items.filter((x) => x.classified && isHarmful(x.classification)).length;
  const safe = items.filter((x) => x.classified && !isHarmful(x.classification)).length;
  summary.textContent = `${items.length} replies · ${safe} safe · ${harmful} hidden · ${active} active · ${queuedCount} queued${errors ? ` · ${errors} failed` : ""}${waiting ? ` · ${waiting} waiting` : ""}`;
  content.innerHTML = "";

  if (!items.length) {
    content.innerHTML = `<div class="welivedit-empty">Open an X post with replies. New replies will appear here in feed order.</div>`;
    return;
  }

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "welivedit-card";
    const status = statusDisplay(item);
    const author = item.author_username ? `@${item.author_username}` : "Reply";
    let body = "";
    if (item.classified && !isHarmful(item.classification)) {
      body = `<div class="welivedit-card-text">${escapeHtml(item.message)}</div>`;
    } else if (item.classified) {
      body = `<div class="welivedit-card-placeholder">Hidden on X because it may need care.</div>`;
    } else if (item.status === "error") {
      body = `<div class="welivedit-card-placeholder">${escapeHtml(item.lastError || "This reply could not be checked.")}</div>`;
    } else {
      body = `<div class="welivedit-card-placeholder">${escapeHtml(coverLabelForItem(item))}</div>`;
    }

    const isManualRetry = state.retrying.has(item.client_key);
    const retryBusy = isManualRetry || state.inFlight.has(item.client_key) || state.queued.has(item.client_key);
    const focusLabel = item.hidden ? "Show & focus on X" : "Focus on X";
    const retryButton = (item.status === "error" || isManualRetry)
      ? `<button data-action="retry" ${retryBusy ? "disabled aria-disabled=\"true\"" : ""}>${retryBusy ? "Retrying…" : "Retry"}</button>`
      : "";
    const hideButton = item.classified && !item.hidden
      ? `<button data-action="toggle">${item.manualRevealed ? "Hide again on X" : "Hide on X"}</button>`
      : "";
    const action = `<div class="welivedit-card-actions">${retryButton}<button data-action="focus">${focusLabel}</button>${hideButton}</div>`;

    card.innerHTML = `
      <div class="welivedit-card-head">
        <span class="welivedit-card-author">${escapeHtml(author)}</span>
        <span class="welivedit-badge ${status.className}">${escapeHtml(status.text)}</span>
      </div>
      ${body}
      ${action}`;
    card.querySelector('[data-action="retry"]')?.addEventListener("click", () => retryItem(item.client_key));
    card.querySelector('[data-action="focus"]')?.addEventListener("click", () => focusItemOnX(item.client_key));
    card.querySelector('[data-action="toggle"]')?.addEventListener("click", () => toggleVisibility(item.client_key));
    content.appendChild(card);
  }
} 

function pageKey() {
  // Ignore query/hash churn. Only a different /status/:id should reset a thread.
  const threadStatusId = currentThreadStatusId();
  if (threadStatusId) return `${location.hostname}|status:${threadStatusId}`;
  return `${location.hostname}${location.pathname}`;
}

function removeAllPortalCovers() {
  for (const cover of state.coverByKey.values()) {
    try { cover.remove(); } catch (_) {}
  }
  state.coverByKey.clear();
}

function restoreAllVisibleRedactions() {
  for (const item of state.items.values()) {
    const article = item.element || state.domByKey.get(item.client_key);
    if (article?.isConnected) {
      restoreRedactionShell(article);
      article.classList.remove("welivedit-hard-hidden");
      article.removeAttribute("data-welivedit-hidden");
    }
  }
}

function resetThreadStateForNavigation(reason = "navigation") {
  restoreAllVisibleRedactions();
  removeAllPortalCovers();
  state.generation += 1;
  state.items.clear();
  state.domByKey.clear();
  state.queued.clear();
  state.retrying.clear();
  state.workQueue = [];
  state.lastPayload = null;
  state.originalPost = null;
  state.threadOwnerLock = null;
  clearTimeout(state.threadAccountLookupTimer);
  state.threadAccountLookupTimer = null;
  state.threadAccountLookupKey = null;
  state.threadAccountLookupPromise = null;
  state.threadAccount = emptyThreadAccount();
  state.currentPageKey = pageKey();
  state.explicitNavigationStatusId = null;
  state.explicitNavigationAt = 0;
  setStatus("New X page detected.");
  window.setTimeout(() => {
    scanVisibleReplies({ render: true, hide: true });
    updateAllPortalCovers();
    renderPanel();
    if (state.autoMode) scheduleAutoEnqueue();
  }, 700);
  console.info("[WeLivedIt] reset on X navigation", { reason, url: location.href });
}

function scheduleNavigationReset(reason = "navigation") {
  const nextKey = pageKey();
  if (nextKey === state.currentPageKey) return;
  clearTimeout(state.navigationResetTimer);
  state.navigationResetTimer = window.setTimeout(() => {
    if (pageKey() !== state.currentPageKey) resetThreadStateForNavigation(reason);
  }, 250);
}

function markExplicitNavigation(statusId, source = "click") {
  if (!statusId) return;
  state.explicitNavigationStatusId = statusId;
  state.explicitNavigationAt = Date.now();
  console.info("[WeLivedIt] explicit X thread navigation", { statusId, source });
}

function startNavigationWatcher() {
  if (window.__weliveditNavigationWatcherStarted) return;
  window.__weliveditNavigationWatcherStarted = true;

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    scheduleNavigationReset("pushState");
    return result;
  };

  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    scheduleNavigationReset("replaceState");
    return result;
  };

  document.addEventListener("click", (event) => {
    const anchor = event.target?.closest?.('a[href*="/status/"]');
    const targetStatusId = extractStatusIdFromHref(anchor?.getAttribute?.("href") || anchor?.href);
    if (targetStatusId && targetStatusId !== state.threadOwnerLock?.threadStatusId) {
      markExplicitNavigation(targetStatusId, "status-link-click");
    }
  }, true);

  window.addEventListener("popstate", () => {
    markExplicitNavigation(locationThreadStatusId(), "popstate");
    scheduleNavigationReset("popstate");
  });
  window.addEventListener("hashchange", () => scheduleNavigationReset("hashchange"));
  window.setInterval(() => scheduleNavigationReset("url-poll"), 1000);
}


function startThreadObserver() {
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (pageKey() !== state.currentPageKey) {
        scheduleNavigationReset("mutation-route-change");
        return;
      }
      scanVisibleReplies({ render: false, hide: true });
      for (const item of state.items.values()) {
        if (item.hidden && !item.manualRevealed) {
          const article = item.element || state.domByKey.get(item.client_key);
          applyRedactionShell(article);
          const cover = ensureCover(article, item.client_key);
          positionCover(article, cover);
        }
        updateArticleMark(item);
      }
      updateAllPortalCovers();
      revealOnlyWhenAllVisibleClassified();
      renderPanel();
      if (state.autoMode) scheduleAutoEnqueue();
    }, DOM_SCAN_DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function clampPercent(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function isDangerousClassification(classification) {
  if (!classification || typeof classification !== "object") return false;
  const severity = String(classification.severity || "").trim().toLowerCase();
  const score = Number(classification.severity_score ?? classification.severityScore ?? 0);
  return severity === "dangerous" || (Number.isFinite(score) && score >= 3);
}

function climateLevel(safePercent, { hasDangerous = false } = {}) {
  const normalized = clampPercent(safePercent, 0);
  if (COMMENT_CLIMATE_CONFIG.forceNeutralWhenDangerous && hasDangerous) {
    return { emoji: "😐", label: "Needs protection", level: "neutral" };
  }
  if (normalized >= COMMENT_CLIMATE_CONFIG.veryHappyMinSafePercent) {
    return { emoji: "😄", label: "Very safe", level: "very_happy" };
  }
  if (normalized >= COMMENT_CLIMATE_CONFIG.happyMinSafePercent) {
    return { emoji: "🙂", label: "Mostly safe", level: "happy" };
  }
  return { emoji: "😐", label: "Needs protection", level: "neutral" };
}

function calculateCommentClimate(items) {
  const classified = items.filter((item) => item.classified && item.classification);
  const harmful = classified.filter((item) => isHarmful(item.classification));
  const safe = classified.length - harmful.length;
  const safePercent = classified.length ? Math.round((safe / classified.length) * 100) : null;
  const hasDangerous = harmful.some((item) => isDangerousClassification(item.classification));

  const visible = classified.filter((item) => !item.hidden || item.manualRevealed);
  const visibleHarmful = visible.filter((item) => isHarmful(item.classification));
  const visibleSafe = visible.length - visibleHarmful.length;
  const visibleSafePercent = classified.length
    ? (visible.length ? Math.round((visibleSafe / visible.length) * 100) : 100)
    : null;
  const visibleHasDangerous = visibleHarmful.some((item) => isDangerousClassification(item.classification));

  return {
    classifiedCount: classified.length,
    safeCount: safe,
    harmfulCount: harmful.length,
    harmfulHiddenCount: harmful.filter((item) => item.hidden && !item.manualRevealed).length,
    safePercent,
    visibleSafePercent,
    before: safePercent === null ? null : climateLevel(safePercent, { hasDangerous }),
    after: visibleSafePercent === null ? null : climateLevel(visibleSafePercent, { hasDangerous: visibleHasDangerous }),
    hasDangerous,
  };
}

function climateResultHtml(level, percent) {
  if (!level || percent === null) return "";
  return `<div class="welivedit-climate-result"><span class="welivedit-climate-emoji" aria-hidden="true">${level.emoji}</span><span class="welivedit-climate-value">${percent}% safe<small>${escapeHtml(level.label)}</small></span></div>`;
}

function renderCommentClimate(items) {
  const container = document.getElementById("welivedit-climate");
  if (!container) return;
  const climate = calculateCommentClimate(items);
  if (!climate.classifiedCount) {
    container.innerHTML = `<div class="welivedit-climate-title">Comment climate</div><div class="welivedit-climate-empty">Waiting for checked replies.</div>`;
    return;
  }

  const dangerNote = climate.hasDangerous
    ? `<div class="welivedit-climate-note">A dangerous reply keeps the pre-protection climate neutral, even when the safe percentage is high.</div>`
    : "";
  const impact = climate.harmfulHiddenCount
    ? `<div class="welivedit-climate-impact">${climate.harmfulHiddenCount} harmful ${climate.harmfulHiddenCount === 1 ? "reply" : "replies"} hidden from view.</div>`
    : "";
  container.innerHTML = `
    <div class="welivedit-climate-title">Comment climate</div>
    <div class="welivedit-climate-grid">
      <div class="welivedit-climate-label">Before protection</div>
      ${climateResultHtml(climate.before, climate.safePercent)}
      <div class="welivedit-climate-label">Visible now</div>
      ${climateResultHtml(climate.after, climate.visibleSafePercent)}
    </div>
    ${impact}
    ${dangerNote}
    <div class="welivedit-climate-note">Based on ${climate.classifiedCount} checked ${climate.classifiedCount === 1 ? "reply" : "replies"}. Thresholds: 🙂 ${COMMENT_CLIMATE_CONFIG.happyMinSafePercent}% · 😄 ${COMMENT_CLIMATE_CONFIG.veryHappyMinSafePercent}%.</div>`;
}

function isHarmful(classification) {
  if (!classification) return false;
  const harm = String(classification.type_of_harm || classification.label || classification.classification_text || "none").toLowerCase();
  const tone = String(classification.content_tone || "").toLowerCase();
  if (["supportive", "neutral", "safe"].includes(tone) && ["none", "not_hate_speech", "no_harm", "safe", ""].includes(harm)) return false;
  return !["none", "not_hate_speech", "no_harm", "safe", ""].includes(harm) || ["harmful", "hostile", "abusive"].includes(tone);
}

function setStatus(text) {
  const el = document.getElementById("welivedit-status");
  if (el) el.textContent = text;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
