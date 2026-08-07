const DEFAULT_AUTH_BASE_URL = globalThis.WELIVEDIT_CONFIG?.AUTH_BASE_URL || "https://welivedit-service-server-production-7991.up.railway.app";

const STORAGE_KEYS = {
  authToken: "welivedit_auth_token",
  authSession: "welivedit_auth_session",
  authEmail: "welivedit_auth_email",
  authProfileFetchedAt: "welivedit_auth_profile_fetched_at",
};

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (result) => resolve(result || {})));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, () => resolve()));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, () => resolve()));
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function extractToken(json) {
  return (
    json?.access_token ||
    json?.accessToken ||
    json?.token ||
    json?.jwt ||
    json?.id_token ||
    json?.session_token ||
    json?.data?.access_token ||
    json?.data?.accessToken ||
    json?.data?.token ||
    json?.data?.jwt ||
    json?.data?.id_token ||
    json?.data?.session_token ||
    json?.data?.auth?.access_token ||
    json?.data?.auth?.accessToken ||
    json?.data?.auth?.token ||
    json?.data?.auth?.jwt ||
    json?.data?.auth?.id_token ||
    json?.data?.auth?.session_token ||
    json?.auth?.access_token ||
    json?.auth?.accessToken ||
    json?.auth?.token ||
    json?.auth?.jwt ||
    json?.auth?.id_token ||
    json?.auth?.session_token ||
    json?.session?.access_token ||
    json?.session?.accessToken ||
    json?.session?.token ||
    json?.user?.access_token ||
    json?.user?.accessToken ||
    json?.user?.token ||
    null
  );
}


function extractViewerIdentity(session) {
  const user = session?.data?.user || session?.user || session?.data || null;
  if (!user || typeof user !== "object") {
    return { userId: null, linkedAccounts: [] };
  }
  const accounts = Array.isArray(user.accounts) ? user.accounts : [];
  return {
    userId: user.id || user.user_id || user.userId || null,
    linkedAccounts: accounts.map((account) => ({
      accountId: account.id || account.account_id || account.accountId || null,
      platform: account.platform || account.accountType || null,
      username: account.username || null,
      communities: Array.isArray(account.communities)
        ? account.communities.map((community) => ({
            communityId: community.id || community.community_id || community.communityId || null,
            name: community.communityName || community.name || null,
          }))
        : [],
    })),
  };
}

function parseTextAsJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return { raw: text };
  }
}

function xhrJson({ url, method = "GET", headers = {}, body = null, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = timeoutMs;
    xhr.withCredentials = false;
    xhr.responseType = "text";

    for (const [key, value] of Object.entries(headers || {})) {
      if (value !== undefined && value !== null && value !== "") {
        xhr.setRequestHeader(key, String(value));
      }
    }

    xhr.onload = () => {
      const data = parseTextAsJson(xhr.responseText || "");
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };

    xhr.onerror = () => resolve({ ok: false, status: 0, data: null, error: "Network/CORS error while contacting the community service." });
    xhr.ontimeout = () => resolve({ ok: false, status: 0, data: null, error: "Request timed out while contacting the community service." });
    xhr.onabort = () => resolve({ ok: false, status: 0, data: null, error: "Request was aborted." });

    try {
      xhr.send(body === null || body === undefined ? null : JSON.stringify(body));
    } catch (error) {
      resolve({ ok: false, status: 0, data: null, error: String(error?.message || error) });
    }
  });
}

async function fetchJsonFallback({ url, method = "GET", headers = {}, body = null, timeoutMs = 120000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === null || body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    const data = parseTextAsJson(text || "");
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

function localhostFallbackUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString();
    }
    if (parsed.hostname === "127.0.0.1") {
      parsed.hostname = "localhost";
      return parsed.toString();
    }
  } catch (_) {}
  return null;
}

async function requestJsonWithFallback(args) {
  let result = await xhrJson(args);
  if (result.ok || result.status !== 0) return result;

  result = await fetchJsonFallback(args);
  if (result.ok || result.status !== 0) return result;

  const alternateUrl = localhostFallbackUrl(args.url);
  if (alternateUrl && alternateUrl !== args.url) {
    result = await xhrJson({ ...args, url: alternateUrl });
    if (result.ok || result.status !== 0) return result;
    result = await fetchJsonFallback({ ...args, url: alternateUrl });
  }
  return result;
}

async function fetchAuthProfile(token) {
  if (!token) return null;
  const result = await requestJsonWithFallback({
    url: `${DEFAULT_AUTH_BASE_URL}/api/auth/profile`,
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 30000,
  });
  if (!result.ok || result.data?.success === false) {
    console.warn("[WeLivedIt background] profile lookup failed", result.status, result.data || result.error);
    return null;
  }
  return result.data || null;
}

async function handleAuthStatus() {
  const stored = await storageGet([
    STORAGE_KEYS.authToken,
    STORAGE_KEYS.authSession,
    STORAGE_KEYS.authEmail,
    STORAGE_KEYS.authProfileFetchedAt,
  ]);
  const token = stored[STORAGE_KEYS.authToken] || null;
  let session = stored[STORAGE_KEYS.authSession] || null;
  const lastProfileFetch = Number(stored[STORAGE_KEYS.authProfileFetchedAt] || 0);
  const profileIsStale = !lastProfileFetch || Date.now() - lastProfileFetch > 5 * 60 * 1000;

  if (token && profileIsStale) {
    const profile = await fetchAuthProfile(token);
    if (profile) {
      session = profile;
      await storageSet({
        [STORAGE_KEYS.authSession]: profile,
        [STORAGE_KEYS.authProfileFetchedAt]: Date.now(),
      });
    }
  }

  return {
    ok: true,
    authenticated: Boolean(token),
    email: stored[STORAGE_KEYS.authEmail] || null,
    session,
    viewer: extractViewerIdentity(session),
  };
}

async function handleAuthLogin(payload = {}) {
  const authBaseUrl = DEFAULT_AUTH_BASE_URL;
  const email = String(payload.email || "").trim();
  const password = String(payload.password || "");

  if (!email || !password) {
    return { ok: false, status: 400, message: "Email and password are required to sign in." };
  }

  console.info("[WeLivedIt background] POST", `${authBaseUrl}/api/auth/login`);
  const result = await requestJsonWithFallback({
    url: `${authBaseUrl}/api/auth/login`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { email, password },
  });
  const data = result.data;
  console.info("[WeLivedIt background response]", result.status, data);

  if (!result.ok || data?.success === false) {
    return {
      ok: false,
      status: result.status,
      message: data?.message || result.error || `Sign-in failed (${result.status})`,
      data,
    };
  }

  const token = extractToken(data);
  if (!token) {
    return {
      ok: false,
      status: result.status,
      message: "Sign-in worked, but the service did not return an access token.",
      data,
    };
  }

  const profile = await fetchAuthProfile(token);
  const session = profile || data;
  await storageSet({
    [STORAGE_KEYS.authToken]: token,
    [STORAGE_KEYS.authSession]: session,
    [STORAGE_KEYS.authEmail]: email,
    [STORAGE_KEYS.authProfileFetchedAt]: profile ? Date.now() : 0,
  });

  return {
    ok: true,
    status: result.status,
    authenticated: true,
    email,
    viewer: extractViewerIdentity(session),
    data: session,
  };
}

async function handleAuthLogout() {
  await storageRemove([STORAGE_KEYS.authToken, STORAGE_KEYS.authSession, STORAGE_KEYS.authEmail, STORAGE_KEYS.authProfileFetchedAt]);
  return { ok: true, authenticated: false };
}

async function handleApiRequest(message) {
  const method = message.method || "POST";
  const authRequired = Boolean(message.authRequired);
  const stored = await storageGet([STORAGE_KEYS.authToken]);
  const token = stored[STORAGE_KEYS.authToken] || null;

  if (authRequired && !token) {
    return {
      ok: false,
      status: 401,
      auth_required: true,
      message: "Please sign in from the WeLivedIt extension panel.",
    };
  }

  const headers = { "Content-Type": "application/json", ...(message.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  console.info("[WeLivedIt background]", method, message.url);
  const timeoutMs = Number.isFinite(Number(message.timeoutMs)) ? Math.max(1000, Number(message.timeoutMs)) : 180000;
  const result = await requestJsonWithFallback({
    url: message.url,
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? null : (message.body || {}),
    timeoutMs,
  });
  const data = result.data;
  console.info("[WeLivedIt background response]", result.status, data || result.error);

  if (result.status === 401 || result.status === 403) {
    await storageRemove([STORAGE_KEYS.authToken, STORAGE_KEYS.authSession, STORAGE_KEYS.authEmail, STORAGE_KEYS.authProfileFetchedAt]);
    return {
      ok: false,
      status: result.status,
      auth_required: true,
      message: data?.message || "Your session expired. Please sign in again.",
      data,
    };
  }

  return {
    ok: result.ok && data?.success !== false,
    status: result.status,
    data,
    message: data?.message || result.error || null,
    error: result.error || null,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  const respond = async () => {
    if (message.type === "WELIVEDIT_AUTH_STATUS") return handleAuthStatus();
    if (message.type === "WELIVEDIT_AUTH_LOGIN") return handleAuthLogin(message.payload || {});
    if (message.type === "WELIVEDIT_AUTH_LOGOUT") return handleAuthLogout();
    if (message.type === "WELIVEDIT_API_REQUEST") return handleApiRequest(message);
    return { ok: false, status: 400, message: `Unknown message type: ${message.type}` };
  };

  respond().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, status: 0, error: String(error?.message || error) });
  });

  return true;
});
