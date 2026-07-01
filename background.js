chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "WELIVEDIT_CLASSIFY") return false;

  fetch(message.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(message.headers || {})
    },
    body: JSON.stringify(message.body || {})
  })
    .then(async (res) => {
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = { raw: text };
      }

      sendResponse({
        ok: res.ok,
        status: res.status,
        data
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        status: 0,
        error: String(error?.message || error)
      });
    });

  return true;
});
