const API_URL = "https://api.welivedit.ai/classify/config";

const BATCH_SIZE = 1;
const PAUSE_AFTER_BATCH = 100;
const REQUEST_LIMIT = 50;
const REST_TIME = 30000;

let requestCounter = 0;
let isProcessing = false;

const scannedPosts = new Map();

let selectedCommunity = "lalon_high";

const COMMUNITY_CONFIGS = {
  lalon_high: {
    communityName: "Lalon High",
    description:
      "We are muslim MPs, who experience Islamophobia daily. Our harm looks like jokes about terrorism, extremism, curry and references to go back home. We value healthy debate, but have a strict no tolerance for discrimination and hate .",
    selectedProtections: [
      "Mocking religious practices or beliefs",
      "Twisting religious texts to attack others",
      "Stirring up conflict between religions",
      "Saying one religion is 'replacing' or 'taking over'",
      "Religious conspiracy theories",
      "Calling you 'extremist' with no reason",
      "Claiming you're loyal to other countries",
      "Attacking you personally for your political views",
      "Questioning your right to vote",
      "Encouraging violence because of your politics",
    ],
    intensity:
      "Proactive, strict about all forms of discrimination, even subtle/not overt",
    selectedConsiderations: [],
    additionalNeeds: "",
    agreedToShare: true,
  },
  lalon_low: {
    communityName: "Lalon Low",
    description:
      "We are muslim MPs, who experience Islamophobia daily. Our harm looks like jokes about terrorism, extremism, curry and references to go back home. We value healthy debate, but have a strict no tolerance for discrimination and hate .",
    selectedProtections: [
      "Mocking religious practices or beliefs",
      "Twisting religious texts to attack others",
      "Stirring up conflict between religions",
      "Saying one religion is 'replacing' or 'taking over'",
      "Religious conspiracy theories",
      "Calling you 'extremist' with no reason",
      "Claiming you're loyal to other countries",
      "Attacking you personally for your political views",
      "Questioning your right to vote",
      "Encouraging violence because of your politics",
    ],
    intensity:
      "High tolerance for heated discussions and uncomfortable ideas if civil, but slurs, harassment, and dehumanization not allowed.",
    selectedConsiderations: [],
    additionalNeeds: "",
    agreedToShare: true,
  },

  leftist: {
    communityName: "Leftist DAO",
    description:
      "Leftist DAO  is a place to discuss the intersection between blockchain and the radical Left.  Here, we're interested in talking to others and discussing different view points.",
    selectedProtections: [],
    intensity:
      "Sensitivity/Strictness: High tolerance for heated discussions and uncomfortable ideas if civil, but slurs, harassment, and dehumanization not allowed",
    selectedConsiderations: [],
    additionalNeeds: "",
    agreedToShare: true,
  },

  shespeaks: {
    communityName: "SheSpeaks",
    description:
      "South Asian women discussing political issues and anti-fascist commentary.",
    selectedProtections: [
      "Claims that some races are better/worse than others",
      "Telling people they don't belong here",
      "Mocking religious practices",
      "Religious conspiracy theories",
    ],
    intensity: "Strict about discrimination.",
    selectedConsiderations: [
      "Make MPs British again is hate speech in this community",
    ],
    additionalNeeds: "",
    agreedToShare: false,
  },
};

window.addEventListener("load", () => {
  setTimeout(initExtension, 2000);
});

function initExtension() {
  if (document.getElementById("moderation-ball")) return;
  createFloatingButton();
  createPanel();
  injectStyles();
  processVisibleContent();
  startAutoScan();
}

function createFloatingButton() {
  const button = document.createElement("div");
  button.id = "moderation-ball";

  button.innerHTML = `<img src="https://www.welivedit.ai/assets/Welivedit-Logo-4n8GX-ZR.webp"/>`;

  document.body.appendChild(button);
  button.onclick = togglePanel;
}

function createPanel() {
  const panel = document.createElement("div");
  panel.id = "moderation-panel";

  panel.innerHTML = `
  <div class="panel-header">
      <h3>People Powered Moderation</h3>

      <select id="community-select">
        <option value="lalon_high">Lalon High</option>
        <option value="lalon_low">Lalon Low</option>
        <option value="leftist">Leftist Dao</option>
        <option value="shespeaks">SheSpeaks</option>
      </select>

      <button id="scan-now">Scan Feed</button>
  </div>

  <div id="panel-content"></div>
  `;

  document.body.appendChild(panel);

  document
    .getElementById("scan-now")
    .addEventListener("click", processVisibleContent);

  document
    .getElementById("community-select")
    .addEventListener("change", (e) => {
      selectedCommunity = e.target.value;
      scannedPosts.clear();
      document.getElementById("panel-content").innerHTML = "";
    });
}

function togglePanel() {
  document.getElementById("moderation-panel").classList.toggle("open");
}

function injectStyles() {
  const style = document.createElement("style");

  style.innerHTML = `
#moderation-ball{
position:fixed;
right:20px;
top:50%;
transform:translateY(-50%);
width:65px;
height:65px;
border-radius:50%;
background:#438951;
display:flex;
align-items:center;
justify-content:center;
cursor:pointer;
z-index:999999;
box-shadow:0 8px 25px rgba(0,0,0,0.25);
}

#moderation-ball img{
width:42px;
height:42px;
}

#moderation-panel{
position:fixed;
right:-380px;
top:0;
height:100vh;
width:360px;
background:linear-gradient(135deg,#dfeee2,#ffffff);
transition:right .35s ease;
z-index:999998;
padding:20px;
font-family:Arial;
display:flex;
flex-direction:column;
overflow:hidden;
}

#moderation-panel.open{
right:0;
}

.panel-header{
display:flex;
flex-direction:column;
gap:10px;
}

#panel-content{
flex:1;
overflow-y:auto;
margin-top:12px;
padding-right:6px;
}

.card{
background:white;
border-radius:12px;
padding:10px;
margin-bottom:10px;
box-shadow:0 5px 15px rgba(0,0,0,.1);
}

.card-text{
margin-bottom:8px;
line-height:1.4;
word-break:break-word;
}

.card-footer{
display:flex;
align-items:center;
justify-content:space-between;
}

.card-label{
font-weight:bold;
}

.toggle-icon{
cursor:pointer;
font-size:18px;
}

.flagged-text{
color:#ff3b3b !important;
font-weight:700;
background:rgba(255,0,0,0.08);
padding:3px 6px;
border-radius:4px;
}

.blurred,
.blurred *{
filter:blur(16px)!important;
}

/* New: scanned mark */
.scanned-mark {
  display:inline-block;
  width:18px;
  height:18px;
  margin:6px;
  background-color:#438951;
  border-radius:50%;
  vertical-align:middle;
  position:absolute;
  top:4px;
  right:4px;
  z-index:2;
  pointer-events:none;
}

.scanned-mark::after {
  content: "✓";
  color:white;
  font-size:12px;
  position:absolute;
  top:1px;
  left:3px;
}
`;

  document.head.appendChild(style);
}

function makeStableId(text) {
  return String(text || "")
    .replace(/^✓\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function isHarmLabel(label) {
  const value = String(label || "").toLowerCase();
  return value === "hate_speech" ||
    value === "harmful" ||
    value.includes("hate") ||
    value.includes("dangerous") ||
    value.includes("derogatory") ||
    value.includes("exclusionary") ||
    value.includes("extreme");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function extractVisibleContent() {
  const items = [];

  const articles = document.querySelectorAll("article");

  articles.forEach((article) => {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) return;

    const text = textEl.innerText.trim();
    if (!text) return;

    const id = makeStableId(text);

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

  for (let item of items) {
    if (scannedPosts.has(item.id)) {
      applyExistingModeration(item);
      continue;
    }

    markScanned(item.element);

    if (requestCounter >= REQUEST_LIMIT) {
      console.log("Cooling down 30 seconds...");
      await delay(REST_TIME);
      requestCounter = 0;
    }

    const response = await sendBatch([item]);

    requestCounter++;

    if (response) handleResults([item], response);

    await delay(PAUSE_AFTER_BATCH);
  }

  isProcessing = false;
}

function markScanned(article) {
  if (article.querySelector(":scope > .scanned-mark")) return;

  const mark = document.createElement("span");
  mark.className = "scanned-mark";
  mark.title = "Scanned by Welivedit";
  mark.setAttribute("aria-hidden", "true");

  article.style.position = article.style.position || "relative";
  article.prepend(mark);
}

function applyExistingModeration(item) {
  const data = scannedPosts.get(item.id);
  if (!data) return;

  const textEl = item.element.querySelector('[data-testid="tweetText"]');
  if (!textEl) return;

  if (isHarmLabel(data.label)) {
    textEl.classList.add("flagged-text");

    if (data.blurred) {
      item.element.classList.add("blurred");
    }
  }
}

async function sendBatch(batch) {
  try {
    const messages = batch.map((b) => b.text);

    const payload = {
      message: messages,
      community_config: COMMUNITY_CONFIGS[selectedCommunity],
    };

    if (!payload.community_config) {
      throw new Error(`Missing community config for ${selectedCommunity}`);
    }

    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const proxyResponse = await chrome.runtime.sendMessage({
        type: "WELIVEDIT_CLASSIFY",
        url: API_URL,
        body: payload,
      });

      if (!proxyResponse?.ok) {
        console.error("Welivedit API error", proxyResponse);
        return null;
      }

      return proxyResponse.data;
    }

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error("Welivedit API error", res.status, await res.text());
      return null;
    }

    return await res.json();
  } catch (err) {
    console.log("Batch error:", err);
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
      label,
      element: item.element,
      blurred: isHarmLabel(label),
    });

    applyExistingModeration(item);

    addToPanel(item.id, item.text);
  });
}

function addToPanel(id, text) {
  const container = document.getElementById("panel-content");
  if (!container) return;

  if (document.getElementById("card-" + id)) return;

  const data = scannedPosts.get(id);

  const card = document.createElement("div");
  card.className = "card";
  card.id = "card-" + id;

  card.innerHTML = `
<p class="card-text">${escapeHtml(text)}</p>

<div class="card-footer">
  <span class="card-label" style="color:${isHarmLabel(data.label) ? "red" : "green"}">
    ${escapeHtml(data.label)}
  </span>

  <span class="toggle-icon">👁</span>
</div>
`;

  const icon = card.querySelector(".toggle-icon");

  icon.onclick = () => {
    const state = scannedPosts.get(id);
    const article = state?.element || findArticleById(id);
    if (!article || !state) return;

    state.blurred = !state.blurred;

    if (state.blurred) {
      article.classList.add("blurred");
    } else {
      article.classList.remove("blurred");
    }
  };

  container.appendChild(card);
}

function findArticleById(id) {
  const articles = document.querySelectorAll("article");

  for (let article of articles) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) continue;

    const text = makeStableId(textEl.innerText.trim());
    if (text === id) return article;
  }

  return null;
}

function getResult(response, index) {
  if (Array.isArray(response.data)) return response.data[index];
  if (typeof response.data === "object") return response.data;
  return null;
}

function startAutoScan() {
  const observer = new MutationObserver(() => {
    setTimeout(() => {
      processVisibleContent();

      const items = extractVisibleContent();
      items.forEach(applyExistingModeration);
    }, 1500);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
