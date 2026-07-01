chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "WELIVEDIT_CLASSIFY") return false;

  console.log("[Welivedit] Incoming message:", message);

  fetch(message.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(message.headers || {})
    },
    body: JSON.stringify(message.body || {})
  })
    .then(async (res) => {
      console.log("[Welivedit] Response status:", res.status);

      const text = await res.text();

      console.log("[Welivedit] Raw response:", text);

      let data = null;

      try {
        data = text ? JSON.parse(text) : null;
      } catch (err) {
        console.error("[Welivedit] Failed to parse JSON:", err);
        data = { raw: text };
      }

      console.log("[Welivedit] Parsed response:", data);

      sendResponse({
        ok: res.ok,
        status: res.status,
        data
      });
    })
    .catch((error) => {
      console.error("[Welivedit] Fetch failed:", error);

      sendResponse({
        ok: false,
        status: 0,
        error: String(error?.message || error)
      });
    });

  return true;
});