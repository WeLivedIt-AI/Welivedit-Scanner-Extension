# Analysis versus database storage

- Any X post can be analyzed after sign-in and original-post detection.
- Replies are stored only when the original post belongs to an X account linked to the authenticated WeLivedIt user and that account belongs to the selected community.
- Non-owned posts send `store_in_db: false` and `account_id: null`; the backend returns classifications without inserting posts, comments, or classifications.
- Owned posts send `store_in_db: true` and the viewer-owned linked `account_id`; the backend independently verifies ownership through `/api/auth/profile` before writing.


## v5.2.1: extension-side validation

The extension now makes the persistence decision itself before sending requests:

- own linked X post -> `/resolve` may be called, then `/analyze` with `store_in_db=true`;
- any other post -> `/resolve` is skipped completely and `/analyze` is called directly with `store_in_db=false`, `analysis_only=true`, and no `account_id`;
- analysis is therefore still performed for non-owned posts, but the extension never sends a DB-store request for them.

The backend ownership check remains as defense in depth.
