# Own-post-only sending and exact X focus (v5.1.3)

## Sending rule

The extension sends replies to `/resolve` and `/analyze` only when the original post owner `account_id` exactly matches one of the authenticated platform user's linked X `account_id` values. There is no username or viewer-account fallback.

- Own post: manual send and auto-check are allowed.
- Another monitored account's post: the send button and auto-check are disabled.
- Unidentified account: nothing is sent.
- The same rule is checked again immediately before every resolve/analyze HTTP request.

This is a client-side safety control. The backend should enforce the same ownership rule using the JWT and `account_id`.

## Focus on X

Each reply card includes `Show & focus on X` when hidden, or `Focus on X` when already visible.

- If the exact reply article is still loaded in the X DOM, it is revealed, scrolled to the center, and highlighted temporarily.
- If X virtualized it out of the current scroll, the exact reply URL is opened in a new tab.
