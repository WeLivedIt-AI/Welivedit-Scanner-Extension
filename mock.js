const API_URL = "https://api.welivedit.ai/classify/config";
const BATCH_SIZE = 5;
const PAUSE_AFTER_BATCH = 10000;


let isProcessing = false;
const scannedPosts = new Map();


window.addEventListener("load", () => {
  setTimeout(initExtension, 2000);
});

function initExtension() {
  createPanel();
  processVisibleContent();
  startAutoScan();
}

function createPanel() {
  if (document.getElementById("moderation-panel")) return;

  const panel = document.createElement("div");
  panel.id = "moderation-panel";

  panel.innerHTML = `
    <h3>🔍 Auto Moderation</h3>
    <button id="scan-now">Scan Now</button>
    <div id="panel-content"></div>
  `;

  document.body.appendChild(panel);

  const style = document.createElement("style");

  style.innerHTML = `
    #moderation-panel {
      position: fixed;
      right: 0;
      top: 0;
      width: 340px;
      height: 100vh;
      background: white;
      border-left: 2px solid #ccc;
      padding: 10px;
      overflow-y: auto;
      z-index: 999999;
      font-family: Arial;
    }

    .card {
      border: 1px solid #ddd;
      padding: 8px;
      margin-bottom: 8px;
      border-radius: 6px;
    }

    .blurred,
    .blurred * {
      filter: blur(16px) !important;
      pointer-events: none !important;
      user-select: none !important;
    }

    button {
      margin-top: 5px;
      padding: 4px 6px;
      cursor: pointer;
    }
  `;

  document.head.appendChild(style);

  document
    .getElementById("scan-now")
    .addEventListener("click", processVisibleContent);
}

function extractVisibleContent() {
  const items = [];
  const articles = document.querySelectorAll("article");

  articles.forEach((article) => {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) return;

    const text = textEl.innerText.trim();
    if (!text) return;

    const id = text.slice(0, 120);

    if (scannedPosts.has(id)) return;

    items.push({
      id,
      element: article,
      text,
    });
  });

  return items;
}

async function processVisibleContent() {
  if (isProcessing) return;
  isProcessing = true;

  const items = extractVisibleContent();
  if (!items.length) {
    isProcessing = false;
    return;
  }

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    console.log("🚀 Sending batch:", batch.length);

    const response = await sendBatch(batch);

    if (response) {
      handleResults(batch, response);
    }

    console.log("⏸ Waiting 20 seconds...");
    await delay(PAUSE_AFTER_BATCH);
  }

  isProcessing = false;
}

async function sendBatch(batch) {
  try {
    const messages = batch.map((b) => b.text);

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: messages,
        community_config: {
          communityName: "pppppp",
          description: "rwfwf",
          selectedProtections: [],
          intensity:
            "Filters clear hate speech while allowing respectful debate.",
          selectedConsiderations: [],
          additionalNeeds: "",
          agreedToShare: false,
        },
      }),
    });

    return await res.json();
  } catch (err) {
    console.log("❌ Batch error:", err);
    return null;
  }
}


function handleResults(batch, response) {
  if (!response?.data) return;

  batch.forEach((item, index) => {
    const result = getResult(response, index);
    if (!result) return;

    const label = result.label;

    scannedPosts.set(item.id, {
      element: item.element,
      label,
    });

    if (label === "hate_speech") {
      item.element.classList.add("blurred");
    }

    addToPanel(item.id, item.text);
  });
}


function addToPanel(id, text) {
  const container = document.getElementById("panel-content");
  if (!container) return;

  if (document.getElementById("card-" + id)) return;

  const data = scannedPosts.get(id);
  if (!data) return;

  const label = data.label;
  const card = document.createElement("div");

  card.className = "card";
  card.id = "card-" + id;

  const color = label === "hate_speech" ? "red" : "green";

  card.innerHTML = `
    <p><b>Text:</b></p>
    <p>${text}</p>
    <p style="color:${color}"><b>${label}</b></p>
  `;

  const btn = document.createElement("button");

  updateButtonText(btn, data.element);

  btn.onclick = () => {
    const el = data.element;

    if (el.classList.contains("blurred")) {
      el.classList.remove("blurred");
    } else {
      el.classList.add("blurred");
    }

    updateButtonText(btn, el);
  };

  card.appendChild(btn);
  container.appendChild(card);
}

function updateButtonText(btn, element) {
  if (element.classList.contains("blurred")) {
    btn.innerText = "Unblur";
  } else {
    btn.innerText = "Blur";
  }
}

function getResult(response, index) {
  if (Array.isArray(response.data)) {
    return response.data[index];
  }

  if (response.data && typeof response.data === "object") {
    return response.data;
  }

  return null;
}

function startAutoScan() {
  const main = document.body;

  let timeout;

  const observer = new MutationObserver(() => {
    clearTimeout(timeout);

    timeout = setTimeout(() => {
      processVisibleContent();
    }, 3000);
  });

  observer.observe(main, {
    childList: true,
    subtree: true,
  });

  console.log("👀 Auto scan enabled");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}