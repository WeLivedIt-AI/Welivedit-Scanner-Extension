
console.info("[WeLivedIt Chrome v5.2.3] content.js loaded", {
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
window.__weliveditChromeV521Loaded = true;
window.__weliveditChromeV522Loaded = true;
window.__weliveditChromeV523Loaded = true;

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
  processingMode: "welivedit_processing_mode",
  hideMedia: "welivedit_hide_media",
  blockedWords: "welivedit_blocked_words",
  onboardingComplete: "welivedit_onboarding_complete",
  seenRecords: "welivedit_seen_records_v1",
};

const state = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  authBaseUrl: DEFAULT_AUTH_BASE_URL,
  communityId: DEFAULT_COMMUNITY_ID,
  model: DEFAULT_MODEL,
  authEnabled: DEFAULT_AUTH_ENABLED,
  autoMode: false,
  processingMode: "local",
  hideMedia: true,
  blockedWords: [],
  onboardingComplete: false,
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

  console.log(
    "[WeLivedIt] local classifier available:",
    typeof globalThis.WELIVEDIT_HATEBERT,
    globalThis.WELIVEDIT_HATEBERT
  );

  
  if (state.authEnabled) {
    await refreshClassifierConfig();
  }
  await refreshAuthStatus(false);
  injectStyles();
  createFloatingButton();
  createPanel();
  augmentProcessingControls();
  makePanelCompact();
  applyPanelLayoutFixes();
  updateCompactPanelSummary();
  scanVisibleReplies({ render: true, hide: true });
  if (state.autoMode) scheduleAutoEnqueue();
  startNavigationWatcher();
  startThreadObserver();

  maybeOpenFirstRunTour();

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

  const storedProcessingMode = String(
    values[STORAGE_KEYS.processingMode] || "local"
  ).toLowerCase();

  state.processingMode =
    storedProcessingMode === "online" ? "online" : "local";

  state.hideMedia = parseBool(
    values[STORAGE_KEYS.hideMedia],
    true
  );

  state.blockedWords = Array.isArray(values[STORAGE_KEYS.blockedWords])
    ? values[STORAGE_KEYS.blockedWords]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];

  state.onboardingComplete = parseBool(
    values[STORAGE_KEYS.onboardingComplete],
    false
  );
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


function normalizeProtectionText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}


function blockedWordMatch(item) {
  const message = normalizeProtectionText(item?.message);

  if (!message || !Array.isArray(state.blockedWords)) {
    return null;
  }

  for (const raw of state.blockedWords) {
    const rule = normalizeProtectionText(raw);

    if (!rule) continue;

    if (message.includes(rule)) {
      return raw;
    }
  }

  return null;
}


function isHiddenByUserRule(item) {
  return Boolean(blockedWordMatch(item));
}


function shouldProtectItem(item) {
  if (!item) return false;

  if (isHiddenByUserRule(item)) {
    return true;
  }

  return Boolean(
    item.classified &&
    isHarmful(item.classification)
  );
}


function protectionLabelForItem(item) {
  const matched = blockedWordMatch(item);

  if (matched) {
    return "Message hidden by one of your protection rules.";
  }

  if (item?.classified && isHarmful(item.classification)) {
    return "Message hidden. It may need care.";
  }

  return "Message hidden.";
}


function reapplyBlockedWordRules() {
  for (const item of state.items.values()) {
    if (!item) continue;

    const matched = blockedWordMatch(item);

    if (matched) {
      item.manualRevealed = false;

      applyHidden(
        item.client_key,
        true,
        protectionLabelForItem(item),
        { force: true }
      );

      continue;
    }

    // Removing a personal rule must not reveal model-harmful content.
    if (
      item.classified &&
      isHarmful(item.classification)
    ) {
      applyHidden(
        item.client_key,
        true,
        protectionLabelForItem(item),
        { force: true }
      );
    } else if (!item.manualHidden) {
      applyHidden(
        item.client_key,
        false,
        "",
        { manual: false }
      );
    }
  }

  renderPanel();
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
  const ball = document.getElementById("welivedit-ball");
  if (!panel) return;

  panel.classList.toggle("open");

  const isOpen = panel.classList.contains("open");

  if (ball) {
    ball.style.display = isOpen ? "none" : "flex";
  }

  if (isOpen) {
    refreshAuthStatus(true);
  }
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
.welivedit-cover{display:none;position:relative!important;inset:auto!important;width:100%!important;height:auto!important;z-index:2147483645!important;box-sizing:border-box!important;margin:4px 0!important;padding:10px 12px!important;border-radius:12px!important;background:#e8f5eb!important;color:#183925!important;border:1px solid #b8d8c1!important;font:700 12px Arial,sans-serif!important;align-items:center!important;justify-content:center!important;flex-direction:column!important;text-align:center!important;box-shadow:0 4px 18px rgba(0,0,0,.10)!important;pointer-events:auto!important;overflow:hidden!important}.welivedit-cover.is-visible{display:flex!important}.welivedit-cover.is-rehide{display:flex!important;inset:auto 8px 8px auto!important;width:auto!important;height:auto!important;padding:0!important;background:transparent!important;border:0!important;box-shadow:none!important;align-items:center!important;justify-content:center!important;overflow:visible!important}.welivedit-cover.is-rehide button{margin:0!important;background:#17212b!important;box-shadow:0 3px 10px rgba(0,0,0,.24)!important}.welivedit-cover button{margin-top:6px;background:#438951!important;color:#fff!important;border:0!important;border-radius:8px!important;padding:5px 9px!important;font:700 11px Arial!important;cursor:pointer!important;pointer-events:auto!important}.welivedit-hard-hidden{position:relative!important}.welivedit-redacted-shell{visibility:hidden!important;opacity:0!important;filter:none!important;pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important}.welivedit-redacted-shell *{visibility:hidden!important;opacity:0!important;filter:none!important;pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important}.welivedit-empty{font-size:11px;line-height:1.4;color:#53606a;background:rgba(255,255,255,.55);padding:9px;border-radius:9px}.welivedit-focus-highlight{outline:4px solid #438951!important;outline-offset:4px!important;border-radius:12px!important;animation:welivedit-focus-pulse .7s ease-in-out 3!important}@keyframes welivedit-focus-pulse{0%,100%{outline-width:4px;box-shadow:0 0 0 0 rgba(67,137,81,.15)}50%{outline-width:6px;box-shadow:0 0 0 10px rgba(67,137,81,.12)}}
@media (max-width:480px){#welivedit-panel{width:100vw;padding:11px}#welivedit-ball{right:9px;width:49px;height:49px}.welivedit-auth-form{grid-template-columns:1fr}.welivedit-auth-form button{width:100%}}
  `;
  document.head.appendChild(style);
}


function augmentProcessingControls() {
  const panel = document.getElementById("welivedit-panel");
  if (!panel || document.getElementById("welivedit-processing-controls")) return;

  const box = document.createElement("div");
  box.id = "welivedit-processing-controls";
  box.style.cssText = `
    margin:10px 0;
    padding:10px;
    border:1px solid rgba(0,0,0,.12);
    border-radius:10px;
    font:12px Arial,sans-serif;
  `;

  box.innerHTML = `
    <div style="font-weight:700;margin-bottom:7px">Processing</div>

    <label style="display:block;margin:5px 0">
      <input
        type="radio"
        name="welivedit-processing-mode"
        value="local"
        ${state.processingMode === "local" ? "checked" : ""}
      >
      On this device
    </label>

    <label style="display:block;margin:5px 0">
      <input
        type="radio"
        name="welivedit-processing-mode"
        value="online"
        ${state.processingMode === "online" ? "checked" : ""}
      >
      Online on WeLivedIt servers
    </label>

    <div style="font-weight:700;margin:10px 0 5px">Media</div>

    <label style="display:block;margin:5px 0">
      <input
        id="welivedit-hide-media"
        type="checkbox"
        ${state.hideMedia ? "checked" : ""}
      >
      Hide images/videos in screened replies
    </label>

    <div style="font-size:10px;opacity:.7;margin-top:7px">
      Image hiding is exposure control only. Images are not analyzed yet.
    </div>
  `;

  const firstChild = panel.children[1] || null;
  panel.insertBefore(box, firstChild);

  box.querySelectorAll('input[name="welivedit-processing-mode"]').forEach((input) => {
    input.addEventListener("change", async () => {
      if (!input.checked) return;

      state.processingMode = input.value === "online" ? "online" : "local";

      await storageSet({
        [STORAGE_KEYS.processingMode]: state.processingMode,
      });

      state.classifierCacheKey =
        state.processingMode === "local"
          ? "local_hatebert_q8_0.51"
          : `${state.apiBaseUrl}|${state.model}`;

      setStatus(
        state.processingMode === "local"
          ? "Processing locally on this device."
          : "Processing online with WeLivedIt."
      );
    });
  });

  const hideMedia = box.querySelector("#welivedit-hide-media");

  hideMedia?.addEventListener("change", async () => {
    state.hideMedia = Boolean(hideMedia.checked);

    await storageSet({
      [STORAGE_KEYS.hideMedia]: state.hideMedia,
    });

    // Reapply current visibility so media follows the setting immediately.
    for (const item of state.items.values()) {
      if (!item.classified || item.manualRevealed) continue;

      const hidden = isHarmful(item.classification);
      applyHidden(
        item.client_key,
        hidden,
        hidden ? "Message hidden. It may need care." : "",
        { force: true }
      );
    }
  });
}


function makePanelCompact() {
  const panel = document.getElementById("welivedit-panel");
  if (!panel) return;

  const header = panel.querySelector(".welivedit-header");

  // ----------------------------------------------------------
  // Header: title + settings gear + close
  // ----------------------------------------------------------

  if (!document.getElementById("welivedit-settings-button")) {
    const close = document.getElementById("welivedit-close");

    const actions = document.createElement("div");
    actions.id = "welivedit-header-actions";

    const settings = document.createElement("button");
    settings.id = "welivedit-settings-button";
    settings.type = "button";
    settings.setAttribute("aria-label", "Open WeLivedIt settings");
    settings.title = "Settings";
    settings.textContent = "⚙";

    actions.appendChild(settings);

    if (close?.parentElement) {
      close.parentElement.removeChild(close);
      actions.appendChild(close);
    }

    header?.appendChild(actions);

    settings.addEventListener("click", openSettingsModal);
  }

  // ----------------------------------------------------------
  // Compact status
  // ----------------------------------------------------------

  let compact = document.getElementById("welivedit-compact-summary");

  if (!compact) {
    compact = document.createElement("div");
    compact.id = "welivedit-compact-summary";

    compact.innerHTML = `
      <span id="welivedit-compact-status">Protection active</span>
    `;

    header?.insertAdjacentElement("afterend", compact);
  }

  // ----------------------------------------------------------
  // Quick privacy explanation
  // ----------------------------------------------------------

  if (!document.getElementById("welivedit-data-note")) {
    const note = document.createElement("div");
    note.id = "welivedit-data-note";

    note.innerHTML = `
      <div>
        <strong>Your data, your choice.</strong>
        Local protection can work without signing in.
      </div>
      <button id="welivedit-data-settings-shortcut" type="button">
        How we use data
      </button>
    `;

    compact.insertAdjacentElement("afterend", note);

    document
      .getElementById("welivedit-data-settings-shortcut")
      ?.addEventListener("click", openSettingsModal);
  }

  // ----------------------------------------------------------
  // Quick blocked-words shortcut — functionality comes next
  // ----------------------------------------------------------

  if (!document.getElementById("welivedit-blocked-words-shortcut")) {
    const words = document.createElement("button");
    words.id = "welivedit-blocked-words-shortcut";
    words.type = "button";
    words.innerHTML = `🛡 <span>Always hide words or phrases…</span>`;

    const send = document.getElementById("welivedit-send");

    if (send?.parentElement) {
      send.parentElement.insertBefore(words, send);
    }

    words.addEventListener(
      "click",
      openBlockedWordsModal
    );
  }

  // ----------------------------------------------------------
  // Create settings modal and move configuration into it
  // ----------------------------------------------------------

  ensureSettingsModal();

  updateCompactPanelSummary();
}
function updateCompactPanelSummary() {
  const el = document.getElementById("welivedit-compact-status");
  if (!el) return;

  const items = [...state.items.values()];
  const classified = items.filter((item) => item.classified);

  const harmful = classified.filter(
    (item) => isHarmful(item.classification)
  );

  const hidden = classified.filter(
    (item) => item.hidden
  );

  const waiting = items.filter(
    (item) => !item.classified
  );

  const mode =
    state.processingMode === "local"
      ? "Local"
      : "Online";

  el.textContent =
    `${mode} · ${classified.length} checked · ` +
    `${hidden.length} hidden · ${waiting.length} waiting`;
}


function applyPanelLayoutFixes() {
  if (document.getElementById("welivedit-layout-fixes")) return;

  const style = document.createElement("style");
  style.id = "welivedit-layout-fixes";

  style.textContent = `

    /* ========================================================
       MAIN PANEL
       ======================================================== */

    #welivedit-panel {
      overflow: hidden !important;
      display: flex !important;
      flex-direction: column !important;
      position: fixed !important;
    }

    .welivedit-header {
      flex: 0 0 auto !important;
      align-items: flex-start !important;
    }

    #welivedit-header-actions {
      display: flex !important;
      align-items: center !important;
      gap: 3px !important;
    }

    #welivedit-settings-button {
      border: 0 !important;
      background: transparent !important;
      color: #26333f !important;
      font-size: 20px !important;
      line-height: 1 !important;
      width: 30px !important;
      height: 30px !important;
      padding: 0 !important;
      border-radius: 50% !important;
    }

    #welivedit-settings-button:hover {
      background: rgba(67,137,81,.12) !important;
    }

    #welivedit-close {
      width: 30px !important;
      height: 30px !important;
    }


    #welivedit-compact-summary {
      flex: 0 0 auto !important;
      display: flex !important;
      align-items: center !important;

      padding: 8px 10px !important;
      margin: 4px 0 6px !important;

      background: #dceee1 !important;
      border: 1px solid #b5d4be !important;
      border-radius: 9px !important;

      color: #24402d !important;
      font: 700 11px Arial,sans-serif !important;
    }


    #welivedit-data-note {
      flex: 0 0 auto !important;

      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 8px !important;

      padding: 7px 9px !important;
      margin-bottom: 6px !important;

      border: 1px solid #d4e1d7 !important;
      border-radius: 9px !important;

      background: rgba(255,255,255,.68) !important;

      color: #53606a !important;
      font: 10px/1.35 Arial,sans-serif !important;
    }

    #welivedit-data-note strong {
      display: block !important;
      color: #26333f !important;
      margin-bottom: 1px !important;
    }

    #welivedit-data-settings-shortcut {
      flex: 0 0 auto !important;

      background: transparent !important;
      color: #337345 !important;

      padding: 4px 5px !important;

      font-size: 9px !important;
      white-space: nowrap !important;
    }


    #welivedit-blocked-words-shortcut {
      flex: 0 0 auto !important;

      width: 100% !important;
      text-align: left !important;

      background: #f4f8f5 !important;
      color: #294936 !important;

      border: 1px solid #ceddd2 !important;
      padding: 8px 10px !important;
      margin: 0 0 6px !important;

      font-size: 11px !important;
    }


    #welivedit-send,
    #welivedit-status,
    #welivedit-climate,
    #welivedit-summary {
      flex: 0 0 auto !important;
    }


    #welivedit-content {
      flex: 1 1 0 !important;
      min-height: 0 !important;
      height: 0 !important;

      overflow-y: auto !important;
      overflow-x: hidden !important;

      overscroll-behavior: contain !important;
      touch-action: pan-y !important;

      padding-right: 5px !important;
      padding-bottom: 30px !important;
    }

    #welivedit-content::-webkit-scrollbar {
      width: 8px !important;
    }

    #welivedit-content::-webkit-scrollbar-thumb {
      background: rgba(67,93,74,.40) !important;
      border-radius: 999px !important;
    }


    /* ========================================================
       SETTINGS OVERLAY
       ======================================================== */

    #welivedit-settings-overlay {
      position: absolute !important;
      inset: 0 !important;

      z-index: 2147483647 !important;

      display: none !important;

      align-items: center !important;
      justify-content: center !important;

      padding: 13px !important;
      box-sizing: border-box !important;

      background: rgba(15,25,19,.46) !important;

      backdrop-filter: blur(1.5px) !important;
      -webkit-backdrop-filter: blur(1.5px) !important;
    }

    #welivedit-settings-overlay.is-open {
      display: flex !important;
    }


    #welivedit-settings-modal {
      width: 100% !important;
      max-height: calc(100% - 16px) !important;

      display: flex !important;
      flex-direction: column !important;

      overflow: hidden !important;

      background: #f8fbf9 !important;

      border: 1px solid #b7cabd !important;
      border-radius: 15px !important;

      box-shadow:
        0 18px 45px rgba(0,0,0,.30),
        0 3px 12px rgba(0,0,0,.12) !important;
    }


    .welivedit-settings-header {
      flex: 0 0 auto !important;

      display: flex !important;
      align-items: flex-start !important;
      justify-content: space-between !important;

      gap: 10px !important;

      padding: 13px 14px 11px !important;

      border-bottom: 1px solid #d6e1d9 !important;

      background: #e6f1e9 !important;
    }

    .welivedit-settings-header h3 {
      margin: 0 0 2px !important;
      font-size: 16px !important;
    }

    .welivedit-settings-header small {
      display: block !important;
      color: #617069 !important;
      font-size: 10px !important;
      line-height: 1.3 !important;
    }

    #welivedit-settings-close {
      border: 0 !important;
      background: transparent !important;
      color: #26333f !important;

      font-size: 23px !important;
      line-height: 1 !important;

      width: 30px !important;
      height: 30px !important;
      padding: 0 !important;
    }


    #welivedit-settings-scroll {
      flex: 1 1 auto !important;
      min-height: 0 !important;

      overflow-y: auto !important;

      padding: 10px !important;
    }


    .welivedit-settings-section {
      padding: 10px !important;
      margin-bottom: 9px !important;

      background: #fff !important;

      border: 1px solid #d9e4dc !important;
      border-radius: 10px !important;
    }


    .welivedit-settings-section-title {
      margin-bottom: 7px !important;

      color: #294335 !important;

      font: 800 11px Arial,sans-serif !important;

      text-transform: uppercase !important;
      letter-spacing: .045em !important;
    }


    .welivedit-settings-explanation {
      margin: 5px 0 8px !important;

      color: #617069 !important;

      font: 10px/1.4 Arial,sans-serif !important;
    }


    .welivedit-settings-link-button {
      width: 100% !important;

      padding: 8px 9px !important;

      text-align: left !important;

      background: #edf5ef !important;
      color: #285d39 !important;

      border: 1px solid #c9dccf !important;

      font-size: 10px !important;
    }


    .welivedit-settings-placeholder-button {
      width: 100% !important;

      padding: 8px !important;

      background: #eef1ef !important;
      color: #89918c !important;

      font-size: 10px !important;

      cursor: default !important;
    }


    /* Existing controls inside settings */

    #welivedit-settings-modal #welivedit-processing-controls {
      margin: 0 !important;
    }

    #welivedit-settings-modal .welivedit-auth-box,
    #welivedit-settings-modal .welivedit-account-box,
    #welivedit-settings-modal .welivedit-auto-row {
      margin: 6px 0 !important;
    }


    /* ========================================================
       PAGE-LEVEL PRODUCT TOUR
       ======================================================== */

    #welivedit-tour-overlay {
      position: fixed !important;
      inset: 0 !important;

      z-index: 2147483647 !important;

      display: none !important;

      pointer-events: auto !important;
    }

    #welivedit-tour-overlay.is-open {
      display: block !important;
    }

    #welivedit-tour-spotlight {
      position: fixed !important;

      display: none;

      z-index: 2147483647 !important;

      border: 2px solid rgba(100, 174, 119, .95) !important;
      border-radius: 11px !important;

      box-shadow:
        0 0 0 9999px rgba(10, 18, 13, .62),
        0 0 0 5px rgba(100, 174, 119, .18) !important;

      pointer-events: none !important;

      transition:
        left .18s ease,
        top .18s ease,
        width .18s ease,
        height .18s ease !important;
    }

    #welivedit-tour-card {
      position: fixed !important;

      z-index: 2147483647 !important;

      width: min(320px, calc(100vw - 28px)) !important;

      box-sizing: border-box !important;

      padding: 14px !important;

      background: #fbfdfb !important;

      border: 1px solid #b7cabd !important;
      border-radius: 13px !important;

      box-shadow:
        0 18px 45px rgba(0,0,0,.34) !important;
    }

    .welivedit-tour-top {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;

      margin-bottom: 7px !important;
    }

    #welivedit-tour-progress {
      color: #718078 !important;
      font: 700 10px Arial,sans-serif !important;
    }

    #welivedit-tour-close {
      width: 27px !important;
      height: 27px !important;

      padding: 0 !important;

      border: 0 !important;
      background: transparent !important;

      color: #26333f !important;

      font-size: 22px !important;
      line-height: 1 !important;
    }

    #welivedit-tour-title {
      margin: 0 0 6px !important;

      color: #24392c !important;
      font-size: 15px !important;
    }

    #welivedit-tour-text {
      margin: 0 0 13px !important;

      color: #58665f !important;

      font: 11px/1.45 Arial,sans-serif !important;
    }

    .welivedit-tour-actions {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;

      gap: 8px !important;
    }

    .welivedit-tour-nav {
      display: flex !important;
      gap: 6px !important;
    }

    .welivedit-tour-actions button {
      padding: 7px 10px !important;
      font-size: 10px !important;
    }

    .welivedit-tour-secondary {
      background: #e7eee9 !important;
      color: #405049 !important;
    }



    /* Product-tour polish */

    #welivedit-tour-card {
      width: 300px !important;
      padding: 16px !important;

      background:
        linear-gradient(
          180deg,
          #ffffff 0%,
          #f8fbf9 100%
        ) !important;

      border: 1px solid #c7dbcd !important;
      border-radius: 16px !important;

      box-shadow:
        0 22px 60px rgba(0,0,0,.30),
        0 4px 14px rgba(0,0,0,.12) !important;
    }

    #welivedit-tour-progress {
      display: inline-flex !important;
      align-items: center !important;

      min-height: 22px !important;

      padding: 0 8px !important;

      border-radius: 999px !important;

      background: #e8f3eb !important;
      color: #367148 !important;

      font-size: 10px !important;
      font-weight: 800 !important;
    }

    #welivedit-tour-title {
      margin: 10px 0 7px !important;

      color: #1e3426 !important;

      font-size: 16px !important;
      font-weight: 800 !important;
      line-height: 1.2 !important;
    }

    #welivedit-tour-text {
      margin-bottom: 17px !important;

      color: #59665e !important;

      font-size: 11px !important;
      line-height: 1.5 !important;
    }

    #welivedit-tour-next {
      min-width: 68px !important;

      background: #438951 !important;
      color: white !important;

      border-radius: 8px !important;
    }

    #welivedit-tour-back,
    #welivedit-tour-skip {
      background: transparent !important;
      color: #526158 !important;
    }

    #welivedit-tour-skip {
      padding-left: 0 !important;
    }

    #welivedit-tour-spotlight {
      border: 2px solid rgba(90,170,111,.95) !important;

      box-shadow:
        0 0 0 9999px rgba(8,14,10,.68),
        0 0 0 5px rgba(90,170,111,.16),
        0 5px 20px rgba(0,0,0,.18) !important;
    }



    /* Personal word rules */

    #welivedit-blocked-words-overlay {
      position: absolute !important;
      inset: 0 !important;

      z-index: 2147483647 !important;

      display: none !important;
      align-items: center !important;
      justify-content: center !important;

      padding: 13px !important;

      box-sizing: border-box !important;

      background: rgba(15,25,19,.48) !important;

      backdrop-filter: blur(1.5px) !important;
      -webkit-backdrop-filter: blur(1.5px) !important;
    }

    #welivedit-blocked-words-overlay.is-open {
      display: flex !important;
    }

    #welivedit-blocked-words-modal {
      width: 100% !important;
      max-height: calc(100% - 18px) !important;

      display: flex !important;
      flex-direction: column !important;

      overflow: hidden !important;

      background: #f8fbf9 !important;

      border: 1px solid #b7cabd !important;
      border-radius: 15px !important;

      box-shadow:
        0 18px 45px rgba(0,0,0,.30) !important;
    }

    .welivedit-blocked-words-body {
      overflow-y: auto !important;
      padding: 12px !important;
    }

    #welivedit-blocked-words-form {
      display: grid !important;
      grid-template-columns: 1fr auto !important;

      gap: 7px !important;

      margin: 9px 0 12px !important;
    }

    #welivedit-blocked-words-input {
      width: 100% !important;

      border: 1px solid #cbd9cf !important;
      background: #fff !important;
      color: #243129 !important;
      caret-color: #243129 !important;

      padding: 8px 9px !important;

      border-radius: 8px !important;

      font-size: 11px !important;
    }

    #welivedit-blocked-words-input::placeholder {
      color: #7b877f !important;
      opacity: 1 !important;
    }

    #welivedit-blocked-words-list {
      display: flex !important;
      flex-direction: column !important;

      gap: 6px !important;
    }

    .welivedit-blocked-word-row {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;

      gap: 8px !important;

      padding: 7px 8px !important;

      background: #edf5ef !important;

      border: 1px solid #cfdfd3 !important;
      border-radius: 8px !important;

      color: #294936 !important;

      font-size: 11px !important;
    }

    .welivedit-blocked-word-row span {
      overflow-wrap: anywhere !important;
    }

    .welivedit-blocked-word-row button {
      flex: 0 0 auto !important;

      width: 25px !important;
      height: 25px !important;

      padding: 0 !important;

      border-radius: 50% !important;

      background: transparent !important;
      color: #65756b !important;

      font-size: 17px !important;
    }

    .welivedit-blocked-words-note {
      margin-top: 12px !important;

      padding-top: 9px !important;

      border-top: 1px solid #dce6df !important;

      color: #728078 !important;

      font: 9px/1.4 Arial,sans-serif !important;
    }



    /* ========================================================
       REPLY CLASSIFICATION TONES
       ======================================================== */

    .welivedit-card {
      border: 1px solid rgba(60,75,65,.13) !important;
      transition:
        border-color .15s ease,
        box-shadow .15s ease !important;
    }

    .welivedit-card.is-safe {
      border-color: rgba(74,145,92,.30) !important;
      box-shadow:
        inset 3px 0 0 rgba(74,145,92,.35) !important;
    }

    .welivedit-card.is-harmful {
      border-color: rgba(184,82,82,.30) !important;
      box-shadow:
        inset 3px 0 0 rgba(184,82,82,.42) !important;
    }

    .welivedit-card.is-user-rule {
      border-color: rgba(183,137,58,.34) !important;
      box-shadow:
        inset 3px 0 0 rgba(183,137,58,.44) !important;
    }

    .welivedit-card.is-error {
      border-color: rgba(150,90,90,.28) !important;
    }

    .welivedit-card.is-pending {
      border-color: rgba(95,110,101,.18) !important;
    }

    .welivedit-card-reason {
      display: flex !important;
      flex-direction: column !important;
      gap: 3px !important;

      padding: 8px 9px !important;
      margin: 5px 0 !important;

      border-radius: 8px !important;

      font-size: 10px !important;
      line-height: 1.35 !important;
    }

    .welivedit-card-reason strong {
      font-size: 10px !important;
      font-weight: 700 !important;
    }

    .welivedit-card-reason span {
      opacity: .72 !important;
      font-size: 9px !important;
    }

    .welivedit-card-reason.is-harmful {
      background: rgba(184,82,82,.07) !important;
      color: #694040 !important;
    }

    .welivedit-card-reason.is-user-rule {
      background: rgba(183,137,58,.08) !important;
      color: #665126 !important;
    }


  `;

  document.head.appendChild(style);
}

function ensureBlockedWordsModal() {
  const panel = document.getElementById("welivedit-panel");
  if (!panel) return null;

  let overlay =
    document.getElementById("welivedit-blocked-words-overlay");

  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "welivedit-blocked-words-overlay";
  overlay.setAttribute("aria-hidden", "true");

  overlay.innerHTML = `
    <div
      id="welivedit-blocked-words-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welivedit-blocked-words-title"
    >
      <div class="welivedit-settings-header">
        <div>
          <h3 id="welivedit-blocked-words-title">
            Always hide words or phrases
          </h3>

          <small>
            These rules stay on this device and work independently
            from the classifier.
          </small>
        </div>

        <button
          id="welivedit-blocked-words-close"
          type="button"
          aria-label="Close"
        >×</button>
      </div>

      <div class="welivedit-blocked-words-body">

        <p class="welivedit-settings-explanation">
          If a reply contains any item below, WeLivedIt will hide it
          even if the model considers the reply safe.
        </p>

        <form id="welivedit-blocked-words-form">
          <input
            id="welivedit-blocked-words-input"
            type="text"
            maxlength="160"
            placeholder="Word or phrase"
            autocomplete="off"
          />

          <button type="submit">
            Add
          </button>
        </form>

        <div id="welivedit-blocked-words-list"></div>

        <div
          id="welivedit-blocked-words-empty"
          class="welivedit-settings-explanation"
        >
          You have no personal word rules yet.
        </div>

        <div class="welivedit-blocked-words-note">
          Matching ignores capitalization.
          Phrases are matched as written inside the reply.
        </div>

      </div>
    </div>
  `;

  panel.appendChild(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeBlockedWordsModal();
    }
  });

  document
    .getElementById("welivedit-blocked-words-close")
    ?.addEventListener("click", closeBlockedWordsModal);

  document
    .getElementById("welivedit-blocked-words-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();

      const input =
        document.getElementById("welivedit-blocked-words-input");

      const value = String(input?.value || "").trim();

      if (!value) return;

      const normalized = normalizeProtectionText(value);

      const exists = state.blockedWords.some(
        (entry) =>
          normalizeProtectionText(entry) === normalized
      );

      if (!exists) {
        state.blockedWords.push(value);

        await storageSet({
          [STORAGE_KEYS.blockedWords]: state.blockedWords
        });
      }

      if (input) input.value = "";

      renderBlockedWordsList();
      reapplyBlockedWordRules();
    });

  renderBlockedWordsList();

  return overlay;
}


function renderBlockedWordsList() {
  const list =
    document.getElementById("welivedit-blocked-words-list");

  const empty =
    document.getElementById("welivedit-blocked-words-empty");

  if (!list || !empty) return;

  list.innerHTML = "";

  empty.style.display =
    state.blockedWords.length ? "none" : "block";

  state.blockedWords.forEach((word, index) => {
    const row = document.createElement("div");
    row.className = "welivedit-blocked-word-row";

    const label = document.createElement("span");
    label.textContent = word;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute(
      "aria-label",
      `Remove ${word}`
    );

    remove.addEventListener("click", async () => {
      state.blockedWords.splice(index, 1);

      await storageSet({
        [STORAGE_KEYS.blockedWords]: state.blockedWords
      });

      renderBlockedWordsList();
      reapplyBlockedWordRules();
    });

    row.appendChild(label);
    row.appendChild(remove);

    list.appendChild(row);
  });
}


function openBlockedWordsModal() {
  closeSettingsModal();

  const overlay = ensureBlockedWordsModal();
  if (!overlay) return;

  renderBlockedWordsList();

  overlay.classList.add("is-open");
  overlay.setAttribute("aria-hidden", "false");

  document
    .getElementById("welivedit-blocked-words-input")
    ?.focus();
}


function closeBlockedWordsModal() {
  const overlay =
    document.getElementById("welivedit-blocked-words-overlay");

  if (!overlay) return;

  overlay.classList.remove("is-open");
  overlay.setAttribute("aria-hidden", "true");
}


function ensureSettingsModal() {
  const panel = document.getElementById("welivedit-panel");
  if (!panel) return null;

  let overlay = document.getElementById("welivedit-settings-overlay");

  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "welivedit-settings-overlay";
  overlay.setAttribute("aria-hidden", "true");

  overlay.innerHTML = `
    <div
      id="welivedit-settings-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welivedit-settings-title"
    >
      <div class="welivedit-settings-header">
        <div>
          <h3 id="welivedit-settings-title">Settings</h3>
          <small>Choose how WeLivedIt protects you and handles your data.</small>
        </div>

        <button
          id="welivedit-settings-close"
          type="button"
          aria-label="Close settings"
        >×</button>
      </div>

      <div id="welivedit-settings-scroll">

        <section class="welivedit-settings-section">
          <div class="welivedit-settings-section-title">
            Processing
          </div>

          <div id="welivedit-settings-processing-slot"></div>
        </section>


        <section class="welivedit-settings-section">
          <div class="welivedit-settings-section-title">
            Account
          </div>

          <p class="welivedit-settings-explanation">
            An account is optional for local protection.
            Sign in for feedback and saved online features.
          </p>

          <div id="welivedit-settings-auth-slot"></div>
          <div id="welivedit-settings-account-slot"></div>
        </section>


        <section class="welivedit-settings-section">
          <div class="welivedit-settings-section-title">
            Protection
          </div>

          <div id="welivedit-settings-auto-slot"></div>
        </section>


        <section class="welivedit-settings-section">
          <div class="welivedit-settings-section-title">
            Your words
          </div>

          <p class="welivedit-settings-explanation">
            Define words or phrases that should always be hidden,
            regardless of what the model predicts.
          </p>

          <button
            id="welivedit-settings-blocked-words"
            type="button"
            class="welivedit-settings-link-button"
          >
            🛡 Always hidden words and phrases
          </button>
        </section>


        <section
          id="welivedit-settings-privacy"
          class="welivedit-settings-section"
        >
          <div class="welivedit-settings-section-title">
            How we use your data
          </div>

          <p class="welivedit-settings-explanation">
            You choose where processing happens and whether you sign in.
            On-device protection can run without an account.
            Local processing does not send replies to WeLivedIt for
            classification.
          </p>

          <p class="welivedit-settings-explanation">
            Features such as online processing, saved account features,
            or sending feedback may communicate with WeLivedIt servers.
          </p>

          <button
            type="button"
            class="welivedit-settings-placeholder-button"
            disabled
          >
            Learn more · Coming soon
          </button>
        </section>


        <section class="welivedit-settings-section">
          <div class="welivedit-settings-section-title">
            Help
          </div>

          <button
            id="welivedit-take-tour"
            type="button"
            class="welivedit-settings-link-button"
          >
            👋 Take the tour
          </button>
        </section>

      </div>
    </div>
  `;

  panel.appendChild(overlay);

  document
    .getElementById("welivedit-settings-close")
    ?.addEventListener("click", closeSettingsModal);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeSettingsModal();
    }
  });

  document
    .getElementById("welivedit-settings-blocked-words")
    ?.addEventListener(
      "click",
      openBlockedWordsModal
    );

  document
    .getElementById("welivedit-take-tour")
    ?.addEventListener("click", openWeliveditTour);

  // ----------------------------------------------------------
  // Move EXISTING controls. Their event listeners remain intact.
  // ----------------------------------------------------------

  const processing =
    document.getElementById("welivedit-processing-controls");

  const auth =
    panel.querySelector(".welivedit-auth-box");

  const account =
    document.getElementById("welivedit-thread-account");

  const auto =
    panel.querySelector(".welivedit-auto-row");

  if (processing) {
    document
      .getElementById("welivedit-settings-processing-slot")
      ?.appendChild(processing);
  }

  if (auth) {
    document
      .getElementById("welivedit-settings-auth-slot")
      ?.appendChild(auth);
  }

  if (account) {
    document
      .getElementById("welivedit-settings-account-slot")
      ?.appendChild(account);
  }

  if (auto) {
    document
      .getElementById("welivedit-settings-auto-slot")
      ?.appendChild(auto);
  }

  return overlay;
}


function openSettingsModal() {
  const overlay =
    ensureSettingsModal() ||
    document.getElementById("welivedit-settings-overlay");

  if (!overlay) return;

  overlay.classList.add("is-open");
  overlay.setAttribute("aria-hidden", "false");

  document
    .getElementById("welivedit-settings-close")
    ?.focus();
}


function closeSettingsModal() {
  const overlay =
    document.getElementById("welivedit-settings-overlay");

  if (!overlay) return;

  overlay.classList.remove("is-open");
  overlay.setAttribute("aria-hidden", "true");

  document
    .getElementById("welivedit-settings-button")
    ?.focus();
}



const WELIVEDIT_TOUR_STEPS = [
  {
    target: "#welivedit-settings-button",
    view: "main",
    title: "Make WeLivedIt yours",
    text:
      "Settings is where you choose how protection works, whether processing stays on your device, and which optional features you want to use.",
  },

  {
    target: "#welivedit-processing-controls",
    view: "settings",
    title: "Choose where processing happens",
    text:
      "On this device keeps reply classification local. Online processing uses WeLivedIt servers. Local protection does not require an account.",
  },

  {
    target: "#welivedit-settings-auth-slot",
    view: "settings",
    title: "An account is optional",
    text:
      "You can use local protection without signing in. An account is used for optional features such as feedback and saved online features.",
  },

  {
    target: "#welivedit-settings-auto-slot",
    view: "settings",
    title: "Automatic protection",
    text:
      "Auto-check can analyze new replies as they appear, so protection does not depend on manually pressing Analyze each time.",
  },

  {
    target: "#welivedit-settings-privacy",
    view: "settings",
    title: "You control your data",
    text:
      "WeLivedIt separates processing, sign-in, and data handling. The Learn more page will later document the architecture and data flows in detail.",
  },

  {
    target: "#welivedit-climate",
    view: "main",
    title: "See the conversation climate",
    text:
      "Comment climate summarizes the checked conversation and shows how much harmful content is currently being kept out of view.",
  },

  {
    target: ".welivedit-card",
    view: "main",
    title: "Stay in control of every reply",
    text:
      "Each checked reply appears here. Show or Hide changes visibility, while Focus takes you to its position on X without needing to reveal harmful content.",
  },

  {
    target: "#welivedit-blocked-words-shortcut",
    view: "main",
    title: "Add your own protection rules",
    text:
      "You will also be able to define words or phrases that should always be hidden, regardless of what the model predicts.",
  },
];

let weliveditTourIndex = 0;


function ensureWeliveditTour() {
  const panel = document.getElementById("welivedit-panel");
  if (!panel) return null;

  let overlay = document.getElementById("welivedit-tour-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "welivedit-tour-overlay";
  overlay.setAttribute("aria-hidden", "true");

  overlay.innerHTML = `
    <div id="welivedit-tour-spotlight"></div>

    <div
      id="welivedit-tour-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welivedit-tour-title"
    >
      <div class="welivedit-tour-top">
        <span id="welivedit-tour-progress"></span>

        <button
          id="welivedit-tour-close"
          type="button"
          aria-label="Close tour"
        >×</button>
      </div>

      <h3 id="welivedit-tour-title"></h3>
      <p id="welivedit-tour-text"></p>

      <div class="welivedit-tour-actions">
        <button
          id="welivedit-tour-skip"
          type="button"
          class="welivedit-tour-secondary"
        >
          Skip tour
        </button>

        <div class="welivedit-tour-nav">
          <button
            id="welivedit-tour-back"
            type="button"
            class="welivedit-tour-secondary"
          >
            Back
          </button>

          <button
            id="welivedit-tour-next"
            type="button"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    closeWeliveditTour();
  };

  document
    .getElementById("welivedit-tour-close")
    ?.addEventListener("click", close);

  document
    .getElementById("welivedit-tour-skip")
    ?.addEventListener("click", close);

  document
    .getElementById("welivedit-tour-back")
    ?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (weliveditTourIndex > 0) {
        weliveditTourIndex -= 1;
        renderWeliveditTour();
      }
    });

  document
    .getElementById("welivedit-tour-next")
    ?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (weliveditTourIndex >= WELIVEDIT_TOUR_STEPS.length - 1) {
        closeWeliveditTour();
        return;
      }

      weliveditTourIndex += 1;
      renderWeliveditTour();
    });

  return overlay;
}


function positionWeliveditTour() {
  const card =
    document.getElementById("welivedit-tour-card");

  const spotlight =
    document.getElementById("welivedit-tour-spotlight");

  const step =
    WELIVEDIT_TOUR_STEPS[weliveditTourIndex];

  if (!card || !spotlight || !step) return;

  const target =
    document.querySelector(step.target);

  if (!target) {
    spotlight.style.display = "none";

    card.style.left = "50%";
    card.style.top = "50%";
    card.style.right = "auto";
    card.style.bottom = "auto";
    card.style.transform = "translate(-50%, -50%)";

    return;
  }

  target.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });

  window.setTimeout(() => {
    const rect = target.getBoundingClientRect();

    const padding = 6;

    const left = Math.max(4, rect.left - padding);
    const top = Math.max(4, rect.top - padding);
    const width = rect.width + padding * 2;
    const height = rect.height + padding * 2;

    spotlight.style.display = "block";
    spotlight.style.left = `${left}px`;
    spotlight.style.top = `${top}px`;
    spotlight.style.width = `${width}px`;
    spotlight.style.height = `${height}px`;

    card.style.transform = "none";
    card.style.right = "auto";
    card.style.bottom = "auto";

    const sidebar =
      document.getElementById("welivedit-panel");

    const sidebarRect =
      sidebar?.getBoundingClientRect();

    const cardWidth = 320;
    const gap = 14;

    // If target is inside the WeLivedIt sidebar,
    // put the explanation immediately to its LEFT, over X.
    if (
      sidebar &&
      sidebar.contains(target) &&
      sidebarRect
    ) {
      const preferredLeft =
        sidebarRect.left - cardWidth - gap;

      card.style.left =
        `${Math.max(12, preferredLeft)}px`;

      const preferredTop =
        Math.min(
          window.innerHeight - 210,
          Math.max(12, rect.top)
        );

      card.style.top =
        `${preferredTop}px`;

      return;
    }

    // Target is on X.
    // Put the card on whichever side has more room.
    const roomRight =
      window.innerWidth - rect.right;

    const roomLeft =
      rect.left;

    if (roomRight >= cardWidth + gap) {
      card.style.left =
        `${rect.right + gap}px`;

      card.style.top =
        `${Math.max(12, Math.min(rect.top, window.innerHeight - 210))}px`;

      return;
    }

    if (roomLeft >= cardWidth + gap) {
      card.style.left =
        `${rect.left - cardWidth - gap}px`;

      card.style.top =
        `${Math.max(12, Math.min(rect.top, window.innerHeight - 210))}px`;

      return;
    }

    // Fallback: bottom-centre.
    card.style.left = "50%";
    card.style.top = "auto";
    card.style.bottom = "18px";
    card.style.transform = "translateX(-50%)";
  }, 250);
}
function renderWeliveditTour() {
  const step = WELIVEDIT_TOUR_STEPS[weliveditTourIndex];
  if (!step) return;

  // The tour demonstrates the real UI instead of only describing it.
  if (step.view === "settings") {
    const settingsOverlay = ensureSettingsModal();

    if (settingsOverlay) {
      settingsOverlay.classList.add("is-open");
      settingsOverlay.setAttribute("aria-hidden", "false");
    }
  } else {
    const settingsOverlay =
      document.getElementById("welivedit-settings-overlay");

    if (settingsOverlay) {
      settingsOverlay.classList.remove("is-open");
      settingsOverlay.setAttribute("aria-hidden", "true");
    }
  }

  const progress =
    document.getElementById("welivedit-tour-progress");

  const title =
    document.getElementById("welivedit-tour-title");

  const text =
    document.getElementById("welivedit-tour-text");

  const back =
    document.getElementById("welivedit-tour-back");

  const next =
    document.getElementById("welivedit-tour-next");

  if (progress) {
    progress.textContent =
      `${weliveditTourIndex + 1} / ${WELIVEDIT_TOUR_STEPS.length}`;
  }

  if (title) title.textContent = step.title;
  if (text) text.textContent = step.text;

  if (back) {
    back.style.visibility =
      weliveditTourIndex === 0 ? "hidden" : "visible";
  }

  if (next) {
    next.textContent =
      weliveditTourIndex === WELIVEDIT_TOUR_STEPS.length - 1
        ? "Finish"
        : "Next";
  }

  positionWeliveditTour();
}



function maybeOpenFirstRunTour() {
  if (state.onboardingComplete) return;

  // Give X and the extension UI a moment to settle before spotlighting it.
  window.setTimeout(() => {
    if (state.onboardingComplete) return;

    const panel =
      document.getElementById("welivedit-panel");

    if (!panel) return;

    panel.classList.add("open");

    openWeliveditTour();
  }, 900);
}


function markWeliveditOnboardingComplete() {
  if (state.onboardingComplete) return;

  state.onboardingComplete = true;

  storageSet({
    [STORAGE_KEYS.onboardingComplete]: true
  }).catch((error) => {
    console.warn(
      "[WeLivedIt] could not persist onboarding state",
      error
    );
  });
}


function openWeliveditTour() {
  closeSettingsModal();

  const overlay = ensureWeliveditTour();
  if (!overlay) return;

  weliveditTourIndex = 0;

  overlay.classList.add("is-open");
  overlay.setAttribute("aria-hidden", "false");

  renderWeliveditTour();
}


function closeWeliveditTour() {
  markWeliveditOnboardingComplete();

  const overlay =
    document.getElementById("welivedit-tour-overlay");

  const spotlight =
    document.getElementById("welivedit-tour-spotlight");

  if (spotlight) {
    spotlight.style.display = "none";
  }

  if (!overlay) return;

  overlay.classList.remove("is-open");
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.display = "none";

  // Remove the inline display on the next opening.
  window.setTimeout(() => {
    overlay.style.removeProperty("display");
  }, 0);
}


function refreshWeliveditTourPosition() {
  const overlay =
    document.getElementById("welivedit-tour-overlay");

  if (!overlay?.classList.contains("is-open")) return;

  positionWeliveditTour();
}

window.addEventListener(
  "resize",
  refreshWeliveditTourPosition
);


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
    authEl.textContent = "Optional account — sign in for feedback and saved features.";
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
  // Screening is available without an account.
  // Authentication is only required for account/persistence/feedback features.
  return true;
}

function normalizeAccountId(value) {
  return String(value || "").trim().toLowerCase();
}

function accountBelongsToSelectedCommunity(account) {
  const selected = String(state.communityId || "").trim().toLowerCase();
  if (!selected) return false;
  const communities = Array.isArray(account?.communities) ? account.communities : [];
  return communities.some((community) => {
    const id = String(community?.communityId || "").trim().toLowerCase();
    const name = String(community?.name || "").trim().toLowerCase();
    return selected === id || selected === name;
  });
}

function viewerLinkedAccountForOriginalPost() {
  // Kept only for diagnostics/UI. Persistence is NOT gated by equality with
  // the viewer's account_id anymore. The monitored community is the boundary.
  const originalUsername = normalizedUsername(state.originalPost?.author_username);
  const resolvedAccountId = normalizeAccountId(state.threadAccount?.accountId);
  const linkedAccounts = state.viewerIdentity?.linkedAccounts || [];

  return linkedAccounts.find((account) => {
    if (account?.platform && String(account.platform).toLowerCase() !== "x") return false;
    const accountId = normalizeAccountId(account?.accountId);
    const username = normalizedUsername(account?.username);
    return Boolean(
      (resolvedAccountId && accountId && resolvedAccountId === accountId) ||
      (originalUsername && username && originalUsername === username)
    );
  }) || null;
}

function getThreadAnalysisPermission() {
  if (!state.communityId) {
    return { allowed: false, reason: "No community is selected." };
  }
  const threadStatusId = currentThreadStatusId();
  if (!threadStatusId || !isOriginalForCurrentThread(state.originalPost) || !state.originalPost?.author_username) {
    return { allowed: false, reason: "Open the original X post (or scroll to its top once) before analyzing replies." };
  }
  return { allowed: true };
}

function getThreadStoragePermission() {
  const analysis = getThreadAnalysisPermission();
  if (!analysis.allowed) return { allowed: false, reason: analysis.reason };

  const account = state.threadAccount || {};
  if (account.loading) {
    return {
      allowed: false,
      reason: "Checking whether the original post account belongs to the selected community.",
    };
  }

  // Community membership is the persistence boundary. The original post does
  // NOT need to belong to the signed-in viewer. It can belong to any monitored
  // X account registered in the selected community, including monitored
  // accounts whose owners do not have a WeLivedIt platform user.
  if (account.linkedToCommunity && account.accountId) {
    return {
      allowed: true,
      accountId: account.accountId,
      communityAccount: account,
      viewerOwnsPost: Boolean(viewerLinkedAccountForOriginalPost()),
    };
  }

  return {
    allowed: false,
    reason: `@${state.originalPost?.author_username || "this account"} is not registered in ${state.communityId}. Replies will be analyzed without being stored.`,
  };
}

function getThreadSendPermission() {
  // Kept as a compatibility alias for older UI code. "Send" now means analyze;
  // storage is decided independently by getThreadStoragePermission().
  return getThreadAnalysisPermission();
}

function updateSendPermissionsUi() {
  const sendButton = document.getElementById("welivedit-send");
  const autoInput = document.getElementById("welivedit-auto-mode");
  const autoRow = autoInput?.closest?.(".welivedit-auto-row") || null;
  const analysis = getThreadAnalysisPermission();
  const storage = getThreadStoragePermission();

  if (sendButton) {
    if (state.authEnabled && !state.authStatus.authenticated) {
      sendButton.disabled = false;
      sendButton.textContent = "Analyze replies";
      sendButton.title = "Analysis is available without an account.";
    } else if (!analysis.allowed) {
      sendButton.disabled = true;
      sendButton.textContent = "Open a post to analyze";
      sendButton.title = analysis.reason;
    } else if (storage.allowed) {
      sendButton.disabled = false;
      sendButton.textContent = "Analyze & save replies";
      sendButton.title = "This post belongs to an X account monitored by the selected community. Results and replies may be stored.";
    } else {
      sendButton.disabled = false;
      sendButton.textContent = "Analyze replies (not saved)";
      sendButton.title = storage.reason;
    }
  }

  if (autoInput) {
    const unavailable = Boolean(state.authStatus.authenticated && !analysis.allowed);
    autoInput.disabled = unavailable;
    autoInput.checked = unavailable ? false : Boolean(state.autoMode);
    autoInput.title = unavailable ? analysis.reason : "Analyze new replies automatically. Posts outside the selected community are not stored.";
    autoRow?.classList.toggle("is-disabled", unavailable);
  }
}

function ensureViewerOwnsCurrentPost() {
  // Community membership does not block analysis. This helper reports whether
  // the current thread is eligible for persistence only.
  return getThreadStoragePermission().allowed;
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
        manualHidden: false,
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

    if (currentItem?.classified) {
      ensureFeedbackControls(currentItem);
    }
    currentItem.dom_order = domOrder;
    hydrateItemFromSeen(currentItem);
    updateArticleMark(currentItem);
    if (hide) {
      if (currentItem.manualHidden) {
        applyHidden(
          currentItem.client_key,
          true,
          currentItem.classified && isHarmful(currentItem.classification)
            ? "Message hidden. It may need care."
            : "Message hidden.",
          { force: true }
        );
      } else if (!currentItem.manualRevealed) {
        if (currentItem.classified) {
          const keepHidden = isHarmful(currentItem.classification);
          applyHidden(currentItem.client_key, keepHidden, keepHidden ? "Message hidden. It may need care." : "");
        } else {
          applyHidden(currentItem.client_key, true, coverLabelForItem(currentItem));
        }
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
  const storage = getThreadStoragePermission();
  return {
    communityId: state.communityId || null,
    accountId: storage.allowed ? storage.accountId : null,
    storeInDb: Boolean(storage.allowed),
    storageReason: storage.allowed ? "account_linked_to_selected_community" : (storage.reason || "analysis_only"),
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
    store_in_db: selectedContext.storeInDb,
    analysis_only: !selectedContext.storeInDb,
    storage_reason: selectedContext.storageReason,
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
  // Local processing must not send thread/account data automatically.
  if (state.processingMode === "local") {
    return;
  }
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
  // Local processing must not resolve accounts automatically.
  if (state.processingMode === "local") {
    return;
  }

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
    setStatus("Open the original X post (or scroll to its top once) before analyzing replies.");
    return false;
  }

  state.originalPost = original;

  // Resolve the original post account before deciding persistence. Failure does
  // not block classification; it simply makes this run analysis-only.
  try {
    await refreshThreadAccount(original);
  } catch (error) {
    console.info("[WeLivedIt] community account lookup failed; continuing analysis-only", String(error?.message || error));
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
    statusEl.textContent = `Configured for ${state.communityId}${account.accountId ? ` · DB ${account.accountId}` : ""}. Analysis is available; storage is enabled because this account is monitored by the selected community.`;
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
  const classifierKey =
    state.processingMode === "local"
      ? "local_hatebert_q8_0.51"
      : (state.classifierCacheKey || state.apiBaseUrl);

  return `${SEEN_CACHE_NAMESPACE}|${classifierKey}|${state.communityId}|${state.model}|x|${id}`;
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
  if (typeof record.manual_hidden === "boolean") {
    item.manualHidden = record.manual_hidden;
    if (item.manualHidden) item.manualRevealed = false;
  }
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
    manual_hidden: Boolean(item.manualHidden),
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
    if (visibleItem.manualHidden) {
      applyHidden(
        visibleItem.client_key,
        true,
        visibleItem.classified && isHarmful(visibleItem.classification)
          ? "Message hidden. It may need care."
          : "Message hidden.",
        { force: true }
      );
    } else if (visibleItem.classified) {
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
  // Local classifier mode never uses server-side resolve/cache lookup.
  if (state.processingMode === "local") {
    const pending = items.filter(
      (item) => item && !item.classified && !state.inFlight.has(item.client_key)
    );

    for (const item of pending) {
      item.resolveDone = true;
      item.status = "queued_analyze";
      item.lastError = null;
      updateArticleMark(item);

      if (!item.manualRevealed) {
        applyHidden(
          item.client_key,
          true,
          "Message hidden until it is checked."
        );
      }
    }

    renderPanel();

    return {
      attempted: 0,
      classified: 0,
      failed: false,
      skippedForAnalysisOnly: true,
    };
  }

  const pending = items.filter((item) => item && !item.classified && !item.resolveDone && !state.inFlight.has(item.client_key));
  if (!pending.length) return { attempted: 0, classified: 0, failed: false, skippedForAnalysisOnly: false };

  // IMPORTANT: /resolve is a persistence-aware path. The extension itself
  // validates community membership before calling it. For a post whose owner is
  // not registered in the selected community, do NOT call /resolve
  // at all. Mark the items ready for direct analysis instead.
  const storagePermission = getThreadStoragePermission();
  if (!storagePermission.allowed) {
    for (const item of pending) {
      item.resolveDone = true;
      item.status = "queued_analyze";
      item.lastError = null;
      updateArticleMark(item);
      if (!item.manualRevealed) applyHidden(item.client_key, true, coverLabelForItem(item));
    }
    renderPanel();
    logCheckStep("extension community validation: skip resolve", {
      postId: state.originalPost?.x_id || null,
      postOwner: state.originalPost?.author_username || null,
      reason: storagePermission.reason || "outside_community",
      comments: pending.length,
    });
    return { attempted: 0, classified: 0, failed: false, skippedForAnalysisOnly: true };
  }

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

    // ============================================================
    // LOCAL HATEBERT MODE
    // No resolve endpoint and no analyze endpoint.
    // Login is independent from where inference runs.
    // ============================================================
    if (state.processingMode === "local") {
      if (!globalThis.WELIVEDIT_HATEBERT?.classify) {
        throw new Error("Local HateBERT classifier is not available.");
      }

      item.resolveDone = true;
      item.status = "analyzing";
      item.analyzeAttempted = true;
      item.lastError = null;

      updateArticleMark(item);

      if (!item.manualRevealed) {
        applyHidden(key, true, "Message hidden until it is checked.");
      }

      renderPanel();

      const result = await globalThis.WELIVEDIT_HATEBERT.classify(
        String(item.message || "")
      );

      const harmful = Boolean(result?.harmful);
      const harmProbability = Number(result?.harm_probability || 0);
      const confidence = harmful
        ? harmProbability
        : 1 - harmProbability;

      item.classification = {
        type_of_harm: harmful ? "harm" : "none",
        content_tone: harmful ? "harmful" : "neutral",
        secondary_types: [],
        confidence,
        harm_probability: harmProbability,
        evidence_quote: "",
        reason: "WeLivedIt local HateBERT binary classifier",
        source: "local_hatebert",
        threshold: Number(result?.threshold || 0.51),
      };

      item.classified = true;
      item.status = "analyzed";

      rememberItem(item, {
        blocked: false,
        resolve_status: "local",
        analyze_status: "classified",
        classification: item.classification,
      });

      updateArticleMark(item);

      const keepHidden = isHarmful(item.classification);

      if (!item.manualRevealed) {
        applyHidden(
          key,
          keepHidden,
          keepHidden ? "Message hidden. It may need care." : ""
        );
      }

      console.info("[WeLivedIt local HateBERT]", {
        clientKey: key,
        harmful,
        harmProbability,
        threshold: item.classification.threshold,
      });

      return;
    }

    // ============================================================
    // LEGACY SERVER MODE
    // Retained for authenticated/community mode.
    // ============================================================
    if (!item.resolveDone) {
      const storagePermission = getThreadStoragePermission();

      if (storagePermission.allowed) {
        item.status = "resolving";
        updateArticleMark(item);

        if (!item.manualRevealed) {
          applyHidden(key, true, coverLabelForItem(item));
        }

        renderPanel();

        const resolved = await apiPost(
          "/api/extension/x-comments/resolve",
          {
            ...buildPayload([item]),
            model: state.model,
          }
        );

        applySingleResponseToItem(item, resolved);
        item.resolveDone = true;

        if (item.classified) {
          item.status = String(item.status || "cached").includes("analyzed")
            ? "analyzed"
            : "cached";

          rememberItem(item, {
            blocked: false,
            resolve_status: "classified",
          });

          updateArticleMark(item);
          return;
        }

        item.status = "missing";

        rememberItem(item, {
          blocked: false,
          resolve_status: "missing",
          classification: null,
        });
      } else {
        item.resolveDone = true;
        item.status = "queued_analyze";

        logCheckStep(
          "extension community validation: direct analysis",
          {
            clientKey: item.client_key,
            postId: state.originalPost?.x_id || null,
            postOwner: state.originalPost?.author_username || null,
            reason:
              storagePermission.reason || "outside_community",
          }
        );
      }
    }

    item.status = "analyzing";
    item.analyzeAttempted = true;

    updateArticleMark(item);

    if (!item.manualRevealed) {
      applyHidden(key, true, coverLabelForItem(item));
    }

    renderPanel();

    const analyzed = await apiPost(
      "/api/extension/x-comments/analyze",
      {
        ...buildPayload([item]),
        model: state.model,
        force: false,
      }
    );

    applySingleResponseToItem(item, analyzed);

    if (!item.classified) {
      throw new Error(
        "The backend did not return a classification for this reply."
      );
    }

    item.status = "analyzed";

    rememberItem(item, {
      blocked: false,
      resolve_status: "missing",
      analyze_status: "classified",
    });

    updateArticleMark(item);
    ensureFeedbackControls(item);
  } catch (error) {
    item.status = "error";
    item.autoBlocked = true;
    item.lastError = String(error?.message || error);

    rememberItem(item, {
      blocked: true,
      failed_stage: item.resolveDone ? "analyze" : "resolve",
      last_error: item.lastError,
    });

    if (!item.manualRevealed) {
      applyHidden(key, true, coverLabelForItem(item));
    }

    updateArticleMark(item);

    console.error("[WeLivedIt] item processing failed", {
      clientKey: key,
      error: item.lastError,
    });
  } finally {
    state.inFlight.delete(key);
    state.retrying.delete(key);
    renderPanel();
  }
}


function pumpItemQueue() {
  const maxWorkers = Math.max(
    1,
    Number(globalThis.WELIVEDIT_CONFIG?.ITEM_CONCURRENCY || 3)
  );

  while (
    state.activeWorkers < maxWorkers &&
    state.workQueue.length > 0
  ) {
    const job = state.workQueue.shift();
    if (!job) continue;

    const { key, item, manual = false } = job;

    state.queued.delete(key);

    if (
      !item ||
      item.classified ||
      state.inFlight.has(key)
    ) {
      continue;
    }

    state.activeWorkers += 1;

    Promise.resolve(
      processSingleItem(item, { manual })
    )
      .catch((error) => {
        console.error("[WeLivedIt] queue worker failed", {
          clientKey: key,
          error: String(error?.message || error),
        });
      })
      .finally(() => {
        state.activeWorkers = Math.max(
          0,
          state.activeWorkers - 1
        );

        pumpItemQueue();
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
  // Refresh auth state, then resolve the original post account against the
  // selected community before deciding whether this thread may be persisted.
  await refreshAuthStatus(false);
  scanVisibleReplies({ render: false, hide: true });
  if (!(await ensureThreadContextReady())) return 0;
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
    const storagePermission = getThreadStoragePermission();
    const modeLabel = storagePermission.allowed
      ? "community-monitored post: DB storage enabled"
      : "outside community: analyzed only, no DB store request sent";
    setStatus(`${cached ? `${cached} cached · ` : ""}${queued} queued for analysis · ${modeLabel}.`);
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
  if (requested && state.authStatus.authenticated && !getThreadAnalysisPermission().allowed) {
    state.autoMode = false;
    if (event?.target) event.target.checked = false;
    await storageSet({ [STORAGE_KEYS.autoMode]: false });
    setStatus(getThreadAnalysisPermission().reason);
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



async function submitClassificationFeedback(item, feedback = {}) {
  if (!item?.classified) {
    throw new Error("Reply is not classified.");
  }

  if (!state.authStatus.authenticated) {
    document.getElementById("welivedit-panel")?.classList.add("open");
    setStatus("Sign in to send feedback.");
    updateAuthUi();
    return { ok: false, needsLogin: true };
  }

  if (
    state.processingMode === "local" &&
    !window.confirm(
      "This reply was processed locally. Sending feedback will upload this reply and its classification to WeLivedIt. Continue?"
    )
  ) {
    return { ok: false, cancelled: true };
  }

  const verdict = String(feedback.verdict || "").trim().toLowerCase();

  if (!["right", "wrong", "complicated"].includes(verdict)) {
    throw new Error("Invalid feedback verdict.");
  }

  const modelLabel =
    isHarmful(item.classification)
      ? "harmful"
      : "safe";

  const rawScore =
    item.classification?.score ??
    item.classification?.confidence ??
    null;

  const numericScore =
    rawScore !== null &&
    rawScore !== "" &&
    Number.isFinite(Number(rawScore))
      ? Number(rawScore)
      : null;

  const rawThreshold =
    item.classification?.threshold ??
    state.modelThreshold ??
    state.threshold ??
    null;

  const numericThreshold =
    rawThreshold !== null &&
    rawThreshold !== "" &&
    Number.isFinite(Number(rawThreshold))
      ? Number(rawThreshold)
      : null;

  const originalPost = state.originalPost || {};

  const payload = {
    commentId:
      item.x_id ||
      item.comment_id ||
      null,

    postId:
      originalPost.x_id ||
      originalPost.post_id ||
      currentThreadStatusId() ||
      null,

    replyText:
      item.message ||
      null,

    postText:
      originalPost.message ||
      originalPost.text ||
      null,

    modelName:
      item.classification?.model_name ||
      item.classification?.model ||
      state.model ||
      null,

    modelLabel,

    modelScore: numericScore,
    modelThreshold: numericThreshold,

    processingMode:
      state.processingMode ||
      null,

    testerStrictnessSetting:
      state.testerStrictnessSetting ||
      null,

    verdict,

    originalHidden:
      typeof feedback.originalHidden === "boolean"
        ? feedback.originalHidden
        : Boolean(item.hidden && !item.manualRevealed),
  };

  setStatus("Sending feedback...");

  const response = await runtimeMessage({
    type: "WELIVEDIT_API_REQUEST",
    method: "POST",
    url: `${state.apiBaseUrl}/api/communities/${encodeURIComponent(
      state.communityId
    )}/classification-feedback`,
    body: payload,
    authRequired: true,
  });

  if (!response?.ok) {
    if (response?.auth_required) {
      state.authStatus = {
        authenticated: false,
        email: null,
      };
      updateAuthUi();
    }

    throw new Error(
      response?.message ||
      response?.data?.message ||
      response?.error ||
      "Feedback could not be saved."
    );
  }

  const saved = response?.data?.item || null;

  item.feedbackId = saved?.id || null;
  item.feedbackVerdict = verdict;
  item.feedbackReasonChip = saved?.reason_chip || null;
  item.feedbackNote = saved?.note || null;

  setStatus("Thanks — feedback saved.");

  return {
    ok: true,
    item: saved,
  };
}


async function updateClassificationFeedback(item, patch = {}) {
  if (!item?.feedbackId) {
    throw new Error("Feedback has not been created yet.");
  }

  if (!state.authStatus.authenticated) {
    setStatus("Sign in to update feedback.");
    return { ok: false, needsLogin: true };
  }

  const body = {};

  if ("reasonChip" in patch) {
    body.reasonChip = patch.reasonChip;
  }

  if ("note" in patch) {
    body.note = patch.note;
  }

  const response = await runtimeMessage({
    type: "WELIVEDIT_API_REQUEST",
    method: "PATCH",
    url: `${state.apiBaseUrl}/api/communities/${encodeURIComponent(
      state.communityId
    )}/classification-feedback/${encodeURIComponent(item.feedbackId)}`,
    body,
    authRequired: true,
  });

  if (!response?.ok) {
    throw new Error(
      response?.message ||
      response?.data?.message ||
      response?.error ||
      "Feedback details could not be saved."
    );
  }

  const saved = response?.data?.item || null;

  item.feedbackReasonChip =
    saved?.reason_chip ?? item.feedbackReasonChip ?? null;

  item.feedbackNote =
    saved?.note ?? item.feedbackNote ?? null;

  setStatus("Feedback details saved.");

  return {
    ok: true,
    item: saved,
  };
}


function feedbackReasonOptions() {
  return [
    ["supporter_or_calling_out_abuse", "Supporter or calling out abuse"],
    ["reclaimed_language", "Reclaimed language"],
    ["sarcasm_or_joke", "Sarcasm or a joke"],
    ["it_is_abuse_missed", "It IS abuse (missed)"],
    ["coded_or_dog_whistle", "Coded or dog-whistle"],
    ["other", "Other"],
  ];
}


function feedbackControlsHtml(item) {
  if (!item?.classified) return "";

  if (!item.feedbackId) {
    return `
      <div class="welivedit-card-feedback">
        <button
          type="button"
          data-action="feedback"
        >Give feedback</button>
      </div>
    `;
  }

  let label = "Feedback saved";

  if (item.feedbackVerdict === "right") {
    label = "✓ Feedback saved";
  } else if (item.feedbackVerdict === "wrong") {
    label = "✕ Correction saved";
  } else if (item.feedbackVerdict === "complicated") {
    label = "🤷 Feedback saved";
  }

  return `
    <div
      class="welivedit-card-feedback"
      style="
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
        margin-top:7px;
        font-size:10px;
      "
    >
      <span style="opacity:.78">
        ${escapeHtml(label)}
      </span>

      <button
        type="button"
        data-action="feedback"
      >Edit</button>
    </div>
  `;
}


function closeFeedbackModal() {
  const overlay =
    document.getElementById("welivedit-feedback-overlay");

  if (!overlay) return;

  overlay.classList.remove("is-open");
  overlay.setAttribute("aria-hidden", "true");
  delete overlay.dataset.clientKey;
}


function feedbackVerdictLabel(verdict) {
  if (verdict === "right") return "✓ Right";
  if (verdict === "wrong") return "✕ Wrong";
  if (verdict === "complicated") return "🤷 It's complicated";
  return "";
}


function renderFeedbackModal(item) {
  const body =
    document.getElementById("welivedit-feedback-body");

  if (!body || !item) return;

  const author =
    item.author_username
      ? `@${item.author_username}`
      : "Reply";

  const modelHarmful =
    Boolean(
      item.classified &&
      isHarmful(item.classification)
    );

  const modelLabel =
    modelHarmful
      ? "MAY NEED CARE"
      : "SAFE";

  const replyText =
    item.message ||
    "Reply text unavailable.";

  let controls = "";

  if (!item.feedbackId) {
    controls = `
      <section class="welivedit-settings-section">
        <div class="welivedit-settings-section-title">
          Was the classification right?
        </div>

        <div
          class="welivedit-card-actions"
          style="
            display:flex;
            flex-direction:column;
            gap:7px;
            margin-top:9px;
          "
        >
          <button
            type="button"
            data-feedback-modal-verdict="right"
          >✓ Right</button>

          <button
            type="button"
            data-feedback-modal-verdict="wrong"
          >✕ Wrong</button>

          <button
            type="button"
            data-feedback-modal-verdict="complicated"
          >🤷 It's complicated</button>
        </div>
      </section>
    `;
  } else {
    const verdict =
      feedbackVerdictLabel(item.feedbackVerdict);

    const detailsAllowed =
      ["wrong", "complicated"].includes(
        item.feedbackVerdict
      );

    const chips = detailsAllowed
      ? feedbackReasonOptions()
          .map(([value, label]) => {
            const selected =
              item.feedbackReasonChip === value;

            return `
              <button
                type="button"
                data-feedback-modal-reason="${escapeHtml(value)}"
                aria-pressed="${selected ? "true" : "false"}"
                style="${
                  selected
                    ? "font-weight:700; outline:2px solid rgba(55,120,75,.25);"
                    : ""
                }"
              >
                ${escapeHtml(label)}
              </button>
            `;
          })
          .join("")
      : "";

    controls = `
      <section class="welivedit-settings-section">
        <div
          style="
            padding:9px 10px;
            border-radius:8px;
            background:rgba(65,145,85,.08);
            margin-bottom:10px;
          "
        >
          <strong>
            ${escapeHtml(verdict)}
          </strong>

          <div
            style="
              margin-top:3px;
              font-size:10px;
              opacity:.72;
            "
          >
            ✓ Feedback saved
          </div>
        </div>

        ${
          detailsAllowed
            ? `
              <div class="welivedit-settings-section-title">
                What made this tricky?
              </div>

              <p class="welivedit-settings-explanation">
                Optional. Choose the closest reason.
              </p>

              <div
                class="welivedit-card-actions"
                style="
                  display:grid;
                  grid-template-columns:1fr 1fr;
                  gap:7px;
                  margin-top:8px;
                "
              >
                ${chips}
              </div>

              <div
                style="
                  margin-top:12px;
                "
              >
                <label
                  for="welivedit-feedback-note"
                  style="
                    display:block;
                    font-size:10px;
                    font-weight:700;
                    margin-bottom:5px;
                  "
                >
                  Optional note
                </label>

                <textarea
                  id="welivedit-feedback-note"
                  maxlength="140"
                  rows="3"
                  placeholder="Add context if useful..."
                  style="
                    box-sizing:border-box;
                    width:100%;
                    resize:none;
                    border:1px solid #d5ded8;
                    border-radius:8px;
                    padding:8px;
                    font:11px/1.35 Arial,sans-serif;
                  "
                >${escapeHtml(item.feedbackNote || "")}</textarea>

                <div
                  style="
                    display:flex;
                    justify-content:flex-end;
                    margin-top:7px;
                  "
                >
                  <button
                    type="button"
                    data-feedback-modal-save-note
                  >
                    Save note
                  </button>
                </div>
              </div>
            `
            : `
              <p class="welivedit-settings-explanation">
                Thanks. Your feedback has been saved.
              </p>
            `
        }
      </section>
    `;
  }

  body.innerHTML = `
    <section class="welivedit-settings-section">
      <div
        style="
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap:8px;
          margin-bottom:7px;
        "
      >
        <strong style="font-size:11px">
          ${escapeHtml(author)}
        </strong>

        <span
          style="
            font-size:9px;
            font-weight:700;
            padding:3px 6px;
            border-radius:999px;
            background:${
              modelHarmful
                ? "rgba(184,82,82,.10)"
                : "rgba(74,145,92,.12)"
            };
          "
        >
          ${escapeHtml(modelLabel)}
        </span>
      </div>

      <div
        style="
          padding:9px;
          border:1px solid #e1e8e3;
          border-radius:8px;
          font-size:11px;
          line-height:1.4;
          background:#fff;
        "
      >
        ${escapeHtml(replyText)}
      </div>
    </section>

    ${controls}
  `;


  body
    .querySelectorAll(
      "[data-feedback-modal-verdict]"
    )
    .forEach((button) => {
      button.addEventListener(
        "click",
        async (event) => {
          event.preventDefault();
          event.stopPropagation();

          const verdict =
            button.dataset.feedbackModalVerdict;

          if (!verdict || item.feedbackId) return;

          const buttons =
            body.querySelectorAll(
              "[data-feedback-modal-verdict]"
            );

          buttons.forEach((candidate) => {
            candidate.disabled = true;
          });

          try {
            const result =
              await submitClassificationFeedback(
                item,
                {
                  verdict,
                  originalHidden:
                    Boolean(
                      item.hidden &&
                      !item.manualRevealed
                    ),
                }
              );

            if (
              result?.needsLogin ||
              result?.cancelled
            ) {
              buttons.forEach((candidate) => {
                candidate.disabled = false;
              });

              return;
            }

            renderPanel();
            renderFeedbackModal(item);
          } catch (error) {
            console.error(
              "[WeLivedIt] modal feedback failed",
              error
            );

            setStatus(
              `Feedback failed: ${String(
                error?.message || error
              )}`
            );

            buttons.forEach((candidate) => {
              candidate.disabled = false;
            });
          }
        }
      );
    });


  body
    .querySelectorAll(
      "[data-feedback-modal-reason]"
    )
    .forEach((button) => {
      button.addEventListener(
        "click",
        async (event) => {
          event.preventDefault();
          event.stopPropagation();

          const reasonChip =
            button.dataset.feedbackModalReason;

          if (
            !reasonChip ||
            !item.feedbackId
          ) {
            return;
          }

          try {
            button.disabled = true;

            const result =
              await updateClassificationFeedback(
                item,
                { reasonChip }
              );

            if (result?.ok) {
              renderPanel();
              renderFeedbackModal(item);
            }
          } catch (error) {
            console.error(
              "[WeLivedIt] modal feedback reason failed",
              error
            );

            setStatus(
              `Feedback update failed: ${String(
                error?.message || error
              )}`
            );

            button.disabled = false;
          }
        }
      );
    });


  body
    .querySelector(
      "[data-feedback-modal-save-note]"
    )
    ?.addEventListener(
      "click",
      async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const textarea =
          document.getElementById(
            "welivedit-feedback-note"
          );

        const note =
          String(textarea?.value || "")
            .trim()
            .slice(0, 140);

        try {
          event.currentTarget.disabled = true;

          const result =
            await updateClassificationFeedback(
              item,
              { note }
            );

          if (result?.ok) {
            renderPanel();
            renderFeedbackModal(item);
          }
        } catch (error) {
          console.error(
            "[WeLivedIt] modal feedback note failed",
            error
          );

          setStatus(
            `Feedback update failed: ${String(
              error?.message || error
            )}`
          );

          event.currentTarget.disabled = false;
        }
      }
    );
}


function ensureFeedbackModal() {
  const panel =
    document.getElementById("welivedit-panel");

  if (!panel) return null;

  let overlay =
    document.getElementById(
      "welivedit-feedback-overlay"
    );

  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "welivedit-feedback-overlay";
  overlay.setAttribute("aria-hidden", "true");

  overlay.style.cssText = `
    position:absolute;
    inset:0;
    z-index:10040;
    display:none;
    background:rgba(238,246,240,.98);
  `;

  overlay.innerHTML = `
    <div
      id="welivedit-feedback-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welivedit-feedback-title"
      style="
        box-sizing:border-box;
        width:100%;
        height:100%;
        display:flex;
        flex-direction:column;
        background:#eef6f0;
      "
    >
      <div class="welivedit-settings-header">
        <div>
          <h3 id="welivedit-feedback-title">
            Feedback
          </h3>

          <small>
            Help improve how WeLivedIt handles grey areas.
          </small>
        </div>

        <button
          id="welivedit-feedback-close"
          type="button"
          aria-label="Close feedback"
        >×</button>
      </div>

      <div
        id="welivedit-feedback-body"
        style="
          overflow:auto;
          flex:1;
          padding:10px;
        "
      ></div>
    </div>
  `;

  panel.appendChild(overlay);

  const style = document.createElement("style");
  style.textContent = `
    #welivedit-feedback-overlay.is-open {
      display:block !important;
    }

    #welivedit-feedback-overlay button {
      cursor:pointer;
    }

    #welivedit-feedback-overlay
      [data-feedback-modal-reason][aria-pressed="true"] {
      background:#3f8f55 !important;
      color:white !important;
    }
  `;

  document.head.appendChild(style);

  overlay.addEventListener(
    "click",
    (event) => {
      if (event.target === overlay) {
        closeFeedbackModal();
      }
    }
  );

  document
    .getElementById("welivedit-feedback-close")
    ?.addEventListener(
      "click",
      closeFeedbackModal
    );

  return overlay;
}


function openFeedbackModal(item) {
  if (!item) return;

  const overlay =
    ensureFeedbackModal();

  if (!overlay) return;

  overlay.dataset.clientKey =
    item.client_key;

  overlay.classList.add("is-open");
  overlay.setAttribute("aria-hidden", "false");

  renderFeedbackModal(item);
}


async function apiPost(path, body) {
  // Client-side persistence guard. /resolve is never sent when the original
  // post owner is outside the selected monitored community. This is business logic in the extension; the
  // backend remains a second line of defense.
  if (path === "/api/extension/x-comments/resolve") {
    const storagePermission = getThreadStoragePermission();
    if (!storagePermission.allowed) {
      throw new Error(`Persistence request blocked by extension: ${storagePermission.reason || "post owner is not registered in the selected community"}`);
    }
  }

  if (path === "/api/extension/x-comments/analyze" && body?.store_in_db !== true) {
    // Normalize analysis-only payloads so account_id can never accidentally
    // be interpreted as a persistence target.
    body = {
      ...body,
      account_id: null,
      store_in_db: false,
      analysis_only: true,
      original_post: body?.original_post ? { ...body.original_post, account_id: null } : null,
      comments: Array.isArray(body?.comments)
        ? body.comments.map((comment) => ({ ...comment, account_id: null }))
        : body?.comments,
    };
  }

  const url = `${state.apiBaseUrl}${path}`;
  logCheckStep("apiPost through background", {
    path,
    url,
    bodyComments: Array.isArray(body?.comments) ? body.comments.length : null,
    communityId: body?.community_id || null,
    accountId: body?.account_id || null,
    storeInDb: body?.store_in_db === true,
    analysisOnly: body?.analysis_only === true,
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
    if (item.manualHidden) {
      applyHidden(
        item.client_key,
        true,
        item.classified && isHarmful(item.classification)
          ? "Message hidden. It may need care."
          : "Message hidden.",
        { force: true }
      );
      continue;
    }
    if (item.manualRevealed) continue;
    if (!item.classified) {
      applyHidden(item.client_key, true, "Message hidden until it is checked.");
      continue;
    }
    const keepHidden = shouldProtectItem(item);
    applyHidden(
      item.client_key,
      keepHidden,
      keepHidden ? protectionLabelForItem(item) : ""
    );
  }
}


function ensureFeedbackControls(item) {
  // Feedback now lives in the WeLivedIt sidebar cards.
  // Keep this function as a no-op while older call sites are removed gradually.
  return;

  const article = item?.element || state.domByKey.get(item?.client_key);
  if (!article || !item?.classified) return;

  let box = article.querySelector(
    `.welivedit-feedback[data-client-key="${CSS.escape(item.client_key)}"]`
  );

  if (!box) {
    box = document.createElement("div");
    box.className = "welivedit-feedback";
    box.dataset.clientKey = item.client_key;

    box.style.cssText = `
      display:flex;
      gap:6px;
      align-items:center;
      flex-wrap:wrap;
      margin:7px 0 4px;
      font:11px Arial,sans-serif;
    `;

    box.innerHTML = `
      <span style="opacity:.72">Was this right?</span>
      <button type="button" data-feedback="agreed">👍 Agree</button>
      <button type="button" data-feedback="corrected">✏️ Incorrect</button>
      <button type="button" data-feedback="needs_discussion">💬 Discuss</button>
    `;

    box.querySelectorAll("button").forEach((button) => {
      button.style.cssText = `
        border:1px solid rgba(0,0,0,.16);
        background:transparent;
        border-radius:7px;
        padding:3px 6px;
        cursor:pointer;
        font:11px Arial,sans-serif;
      `;

      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        event.preventDefault();

        const status = button.dataset.feedback;

        const reviewerTypeOfHarm =
          status === "corrected"
            ? (
                isHarmful(item.classification)
                  ? "none"
                  : "harm"
              )
            : null;

        try {
          box.querySelectorAll("button").forEach((b) => {
            b.disabled = true;
          });

          const result = await submitClassificationFeedback(item, {
            status,
            reviewerTypeOfHarm,
            reason:
              status === "agreed"
                ? "User agreed with the classification."
                : status === "corrected"
                  ? "User marked the binary classification as incorrect."
                  : "User marked this classification for discussion.",
          });

          if (result?.needsLogin || result?.cancelled) {
            box.querySelectorAll("button").forEach((b) => {
              b.disabled = false;
            });
            return;
          }

          box.innerHTML = `<span style="opacity:.8">✓ Feedback sent: ${escapeHtml(status.replaceAll("_", " "))}</span>`;
        } catch (error) {
          console.error("[WeLivedIt] feedback failed", error);

          setStatus(
            `Feedback failed: ${String(error?.message || error)}`
          );

          box.querySelectorAll("button").forEach((b) => {
            b.disabled = false;
          });
        }
      });
    });

    const textEl = article.querySelector('[data-testid="tweetText"]');

    if (textEl?.parentElement) {
      textEl.parentElement.appendChild(box);
    } else {
      article.appendChild(box);
    }
  }

  if (item.feedbackStatus) {
    box.innerHTML = `<span style="opacity:.8">✓ Feedback sent: ${escapeHtml(
      item.feedbackStatus.replaceAll("_", " ")
    )}</span>`;
  }
}

function redactionTargets(article) {
  if (!article) return [];

  const targets = [];

  const textEl = article.querySelector('[data-testid="tweetText"]');
  if (textEl) targets.push(textEl);

  if (state.hideMedia) {
    const mediaSelectors = [
      '[data-testid="tweetPhoto"]',
      '[data-testid="videoPlayer"]',
      '[data-testid="card.wrapper"]',
      'video'
    ];

    for (const selector of mediaSelectors) {
      article.querySelectorAll(selector).forEach((el) => {
        if (!targets.includes(el)) targets.push(el);
      });
    }
  }

  return targets;
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

  const textEl = article.querySelector('[data-testid="tweetText"]');
  if (!textEl) return null;

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

  const parent = textEl.parentElement;
  if (!parent) return null;

  if (cover.parentElement !== parent || cover.previousElementSibling !== textEl) {
    textEl.insertAdjacentElement("afterend", cover);
  }

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

  const item = state.items.get(clientKey);
  const wasProtected =
    Boolean(
      item &&
      shouldProtectItem(item)
    );

  const hideLabel =
    wasProtected ? "Re-hide" : "Hide";

  cover.innerHTML =
    `<button type="button" aria-label="${hideLabel} this reply on X">${hideLabel}</button>`;
  cover.querySelector("button")?.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    const item = state.items.get(clientKey);
    if (!item) return;
    item.manualHidden = true;
    item.manualRevealed = false;
    applyHidden(
      clientKey,
      true,
      shouldProtectItem(item)
        ? protectionLabelForItem(item)
        : "Message hidden.",
      { force: true }
    );
    rememberItem(item, { manual_hidden: true });
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
    applyRedactionShell(article);
    cover.setAttribute("aria-hidden", "false");
    cover.innerHTML = `<div>${escapeHtml(label || "Message hidden.")}</div><button type="button">Show message</button>`;
    positionCover(article, cover);
    cover.querySelector("button")?.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      item.manualHidden = false;
      item.manualRevealed = true;
      rememberItem(item, { manual_hidden: false });
      applyHidden(clientKey, false, "", { manual: true });
      setStatus("Reply shown on X. Use Hide again to conceal it when finished.");
      renderPanel();
    }, { once: true });
  } else {
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
    item.manualHidden = false;
    item.manualRevealed = true;
    rememberItem(item, { manual_hidden: false });
    applyHidden(clientKey, false, "", { manual: true });
  } else {
    item.manualHidden = true;
    item.manualRevealed = false;
    applyHidden(clientKey, true, item.classified && isHarmful(item.classification) ? "Message hidden. It may need care." : "Message hidden.", { force: true });
    rememberItem(item, { manual_hidden: true });
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
  window.setTimeout(() => article.classList.remove("welivedit-focus-highlight"), 5000);
}

async function focusItemOnX(clientKey) {
  const item = state.items.get(clientKey);
  if (!item) return;

  // Fast path: use the DOM node we already know.
  // This makes normal focus react immediately on the first click.
  let article =
    item.element?.isConnected
      ? item.element
      : state.domByKey.get(item.client_key)?.isConnected
        ? state.domByKey.get(item.client_key)
        : exactArticleForItem(item);

  // Only search through the thread if X really virtualized the reply away.
  if (!article) {
    const originalY = window.scrollY;

    const connectedItems = [...state.items.values()]
      .filter((candidate) => exactArticleForItem(candidate))
      .filter((candidate) => Number.isFinite(candidate.dom_order));

    let direction = 1;

    if (Number.isFinite(item.dom_order) && connectedItems.length) {
      const orders = connectedItems.map((candidate) => candidate.dom_order);
      const minOrder = Math.min(...orders);
      const maxOrder = Math.max(...orders);

      if (item.dom_order < minOrder) direction = -1;
      else if (item.dom_order > maxOrder) direction = 1;
    }

    const step = Math.max(350, Math.floor(window.innerHeight * 0.72));

    for (let i = 0; i < 24; i += 1) {
      window.scrollBy({
        top: direction * step,
        left: 0,
        behavior: "auto",
      });

      await new Promise((resolve) => setTimeout(resolve, 120));

      // Let X recycle/render articles, then rescan their identities.
      scanVisibleReplies({ render: false, hide: true });

      article = exactArticleForItem(item);
      if (article) break;

      // Hit a boundary: try the other direction.
      const atTop = window.scrollY <= 5;
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 5;

      if ((direction < 0 && atTop) || (direction > 0 && atBottom)) {
        direction *= -1;

        window.scrollTo({
          top: originalY,
          left: 0,
          behavior: "auto",
        });

        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  }

  if (article) {
    article.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });

    temporarilyHighlightArticle(article);

    window.setTimeout(
      () => temporarilyHighlightArticle(article),
      450
    );

    setStatus(
      `Focused ${item.author_username ? `@${item.author_username}` : "reply"} on X.`
    );
  } else {
    setStatus(
      "Could not find this reply in the currently loaded X conversation."
    );
  }

  renderPanel();
}
function renderPanel() {
  updateCompactPanelSummary();

  updateAuthUi();
  renderThreadAccount();
  updateSendPermissionsUi();

  const summary = document.getElementById("welivedit-summary");
  const content = document.getElementById("welivedit-content");

  if (!summary || !content) return;

  const items = [...state.items.values()].sort(
    (a, b) =>
      (a.dom_order ?? Number.MAX_SAFE_INTEGER) -
      (b.dom_order ?? Number.MAX_SAFE_INTEGER)
  );

  renderCommentClimate(items);

  const active = items.filter(
    (x) => state.inFlight.has(x.client_key)
  ).length;

  const queuedCount = items.filter(
    (x) => state.queued.has(x.client_key)
  ).length;

  const waiting = items.filter(
    (x) =>
      !x.classified &&
      x.status !== "error" &&
      !state.inFlight.has(x.client_key) &&
      !state.queued.has(x.client_key)
  ).length;

  const errors = items.filter(
    (x) => x.status === "error"
  ).length;

  const hidden = items.filter(
    (x) =>
      x.classified &&
      shouldProtectItem(x)
  ).length;

  const safe = items.filter(
    (x) =>
      x.classified &&
      !shouldProtectItem(x)
  ).length;

  summary.textContent =
    `${items.length} replies · ${safe} safe · ${hidden} hidden · ` +
    `${active} active · ${queuedCount} queued` +
    `${errors ? ` · ${errors} failed` : ""}` +
    `${waiting ? ` · ${waiting} waiting` : ""}`;

  content.innerHTML = "";

  if (!items.length) {
    content.innerHTML =
      `<div class="welivedit-empty">` +
      `Open an X post with replies. New replies will appear here in feed order.` +
      `</div>`;

    return;
  }

  for (const item of items) {
    const card = document.createElement("div");

    const status = statusDisplay(item);
    const author =
      item.author_username
        ? `@${item.author_username}`
        : "Reply";

    const matchedRule = blockedWordMatch(item);

    const modelHarmful =
      Boolean(
        item.classified &&
        isHarmful(item.classification)
      );

    const protectedByRule =
      Boolean(matchedRule);

    const protectedItem =
      protectedByRule || modelHarmful;

    let toneClass = "is-pending";

    if (item.status === "error") {
      toneClass = "is-error";
    } else if (protectedByRule) {
      toneClass = "is-user-rule";
    } else if (modelHarmful) {
      toneClass = "is-harmful";
    } else if (item.classified) {
      toneClass = "is-safe";
    }

    card.className =
      `welivedit-card ${toneClass}`;

    let body = "";

    if (protectedByRule) {
      body = `
        <div class="welivedit-card-placeholder welivedit-card-reason is-user-rule">
          <strong>Hidden by your protection rule</strong>
          <span>Matched: “${escapeHtml(String(matchedRule))}”</span>
        </div>
      `;
    } else if (modelHarmful) {
      body = `
        <div class="welivedit-card-placeholder welivedit-card-reason is-harmful">
          <strong>Hidden because it may need care</strong>
          <span>The classifier flagged this reply.</span>
        </div>
      `;
    } else if (item.classified) {
      body =
        `<div class="welivedit-card-text">` +
        `${escapeHtml(item.message)}` +
        `</div>`;
    } else if (item.status === "error") {
      body =
        `<div class="welivedit-card-placeholder">` +
        `${escapeHtml(
          item.lastError ||
          "This reply could not be checked."
        )}` +
        `</div>`;
    } else {
      body =
        `<div class="welivedit-card-placeholder">` +
        `${escapeHtml(coverLabelForItem(item))}` +
        `</div>`;
    }

    const isManualRetry =
      state.retrying.has(item.client_key);

    const retryBusy =
      isManualRetry ||
      state.inFlight.has(item.client_key) ||
      state.queued.has(item.client_key);

    const retryButton =
      (item.status === "error" || isManualRetry)
        ? `<button data-action="retry" ${
            retryBusy
              ? 'disabled aria-disabled="true"'
              : ""
          }>${
            retryBusy ? "Retrying…" : "Retry"
          }</button>`
        : "";

    // Focus NEVER changes visibility.
    const focusButton =
      `<button data-action="focus">Focus on X</button>`;

    let visibilityButton = "";

    if (item.classified) {
      if (item.hidden) {
        if (
          modelHarmful &&
          !protectedByRule &&
          !item.manualHidden
        ) {
          visibilityButton =
            `<button data-action="toggle" data-feedback-wrong="show">Show — it's fine</button>`;
        } else {
          visibilityButton =
            `<button data-action="toggle">Show on X</button>`;
        }
      } else if (
        item.manualRevealed &&
        protectedItem
      ) {
        visibilityButton =
          `<button data-action="toggle">Re-hide on X</button>`;
      } else if (
        !modelHarmful &&
        !item.manualRevealed
      ) {
        visibilityButton =
          `<button data-action="toggle" data-feedback-wrong="hide">Hide this</button>`;
      } else {
        visibilityButton =
          `<button data-action="toggle">Hide on X</button>`;
      }
    }

    const action = `
      <div class="welivedit-card-actions">
        ${retryButton}
        ${focusButton}
        ${visibilityButton}
      </div>
    `;

    card.innerHTML = `
      <div class="welivedit-card-head">
        <span class="welivedit-card-author">
          ${escapeHtml(author)}
        </span>

        <span class="welivedit-badge ${status.className}">
          ${escapeHtml(status.text)}
        </span>
      </div>

      ${body}
      ${action}
      ${feedbackControlsHtml(item)}
    `;

    card
      .querySelector('[data-action="retry"]')
      ?.addEventListener(
        "click",
        () => retryItem(item.client_key)
      );

    card
      .querySelector('[data-action="focus"]')
      ?.addEventListener(
        "click",
        () => focusItemOnX(item.client_key)
      );

    card
      .querySelector('[data-action="toggle"]')
      ?.addEventListener(
        "click",
        async (event) => {
          const button = event.currentTarget;

          const implicitWrong =
            button?.dataset?.feedbackWrong || null;

          const originalHidden =
            Boolean(item.hidden && !item.manualRevealed);

          // Visibility controls always remain usable, even when signed out.
          toggleVisibility(item.client_key);

          // Personal blocked-word rules never become model feedback.
          // Re-hide also never creates a second feedback event.
          if (
            implicitWrong &&
            !protectedByRule &&
            !item.feedbackId
          ) {
            try {
              const result =
                await submitClassificationFeedback(
                  item,
                  {
                    verdict: "wrong",
                    originalHidden,
                  }
                );

              if (result?.ok) {
                renderPanel();
              }
            } catch (error) {
              console.error(
                "[WeLivedIt] implicit feedback failed",
                error
              );

              setStatus(
                `Feedback failed: ${String(
                  error?.message || error
                )}`
              );
            }
          }
        }
      );


    card
      .querySelector('[data-action="feedback"]')
      ?.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();

          openFeedbackModal(item);
        }
      );


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
      <div class="welivedit-climate-label">Original thread safety</div>
      ${climateResultHtml(climate.before, climate.safePercent)}
      <div class="welivedit-climate-label">Currently visible safety</div>
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
