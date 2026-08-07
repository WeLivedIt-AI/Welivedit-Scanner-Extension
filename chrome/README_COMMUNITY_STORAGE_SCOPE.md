# Community-scoped persistence (v5.2.2)

Analysis is available for any X post after sign-in. Database persistence is decided by the original post account's membership in the selected community, not by equality with the viewer's account_id.

- Community-monitored post: `/resolve` + `/analyze`, `store_in_db=true`, account_id = original post owner's monitored account id.
- Post outside the selected community: skip `/resolve`, call `/analyze` directly with `store_in_db=false` and no account_id.
- The account/community lookup is awaited before the persistence decision.
- A monitored X account may be stored even if its owner has no WeLivedIt platform user.
