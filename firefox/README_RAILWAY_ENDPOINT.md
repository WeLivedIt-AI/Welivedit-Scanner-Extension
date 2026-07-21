# WeLivedIt X Scanner v4.5 — Railway AI endpoint

## Active services

- AI resolve/analyze: `https://welivedit-ai-servicev2-production.up.railway.app`
- Authentication: `https://welivedit-service-server-production.up.railway.app`

Both `/api/extension/x-comments/resolve` and `/api/extension/x-comments/analyze` are built from `state.apiBaseUrl`, which defaults to the Railway AI endpoint above.

## Endpoint configuration

Edit only `config.js` to change the AI URL, auth URL, community ID, or OpenAI model label.

The extension migrates previously stored development URLs (`localhost`, `127.0.0.1`, the former LAN address, and `api.welivedit.ai`) to the new Railway endpoint on first load.

## Classifier consistency

At startup, the extension requests `/api/classifier/config`. Its preset/signature is included in the local seen-cache key. This prevents results produced by one Railway classifier preset from being reused locally after the service is switched to another grid preset.

## Files retained

- `manifest.json`: Firefox extension definition and host permissions.
- `config.js`: central service/runtime configuration.
- `background.js`: authentication and cross-origin API proxy.
- `content.js`: X scanning, queueing, resolve/analyze, redaction, and UI.
- `icons/`: required by the manifest and floating button.

## Removed

- `mock.js`: prototype not loaded by the manifest.
- `welivedit-bg.png`: not referenced by the manifest, CSS, or JavaScript.
- Dead legacy functions from the old direct-XHR, diagnostics, batch-response, feedback, and payload-copy flows: ensureV39DiagnosticsUi, getItemsFromResponse, contentStorageGet, parseApiText, directCommunityApiGet, runV39LocalApiTest, runV40DebugPostTest, directCommunityApiPost, candidateKeysForServerItem, findLocalForServerItem, applyBackendResponse, finalStatusText, sendFeedback, copyCurrentPayload, startPortalCoverObservers, badgeFor.

## Validation performed

- `manifest.json` parses as JSON.
- `config.js`, `background.js`, and `content.js` pass `node --check`.
- Manifest references only files included in this package.

## Install for Firefox testing

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `manifest.json`.
4. Reload the X tab.

If the extension had stored `http://localhost:8000`, v4.5 automatically replaces it with the Railway AI endpoint.
