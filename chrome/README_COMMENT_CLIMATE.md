# Comment climate emoji configuration

Edit `config.js` and change only these values:

```js
COMMENT_CLIMATE: {
  HAPPY_MIN_SAFE_PERCENT: 70,
  VERY_HAPPY_MIN_SAFE_PERCENT: 90,
  FORCE_NEUTRAL_WHEN_DANGEROUS: true,
}
```

Default interpretation:

- 😐 below 70% safe
- 🙂 from 70% to 89% safe
- 😄 from 90% safe

The panel shows both the climate before protection and the climate of replies currently visible after harmful replies are hidden. Percentages use only replies that have already received a classification.


## v5.1.2 scroll owner lock

The original post owner is now pinned once per `/status/:id`. The extension uses the article time permalink as the canonical tweet ID, ignores owner drift caused by X DOM recycling, treats query-string changes as the same thread, and never replaces the owner with the first visible reply after scrolling.
