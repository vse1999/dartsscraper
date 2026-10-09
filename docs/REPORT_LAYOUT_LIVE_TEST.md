# Report layout live experiment — 8 October 2026

## Evidence and scope

- Collected 10 DartsOrakel rows each for Niek Tuik, Danny Lauby, William Borland and Danny Trueman through the existing paced bulk statistics reader.
- Sample collection completed at 13:57:39 UTC / 15:57:39 Europe/Budapest. The same saved source sample was reused across layouts; these are presentation comparisons, not independent fixture or upstream-freshness verification.
- Calculated averages: Tuik 85.82, Lauby 72.35, Borland 82.60, Trueman 83.40. Existing analysis retained the Tuik form-advantage and Borland/Trueman no-clear-edge outcomes.
- Sent five silently delivered test messages to the configured owner private chat, not groups or channels. No production deployment, webhook changes, commits or pushes.
- Captured the actual Telegram Desktop results. Delivery receipts and source data are ignored local files under `.tmp/report-layout-lab/`. Screenshot crops omit the unrelated chat list. The comparison sheet adds labels but does not recreate message contents.

## Results

| Approach | API result | Actual client result | Assessment |
| --- | --- | --- | --- |
| Compact digest | Accepted, message 1111 | Fully readable | Cleanest text summary |
| Fixed-width table | Accepted, message 1112 | Columns align at the observed narrow desktop chat width | Efficient comparison; visually resembles code |
| Compact + expandable evidence | Accepted, message 1113; expandable_blockquote entity confirmed | Collapsed summary readable; opening the quote exposes diagnostic evidence | Recommended balance of clarity and traceability |
| Native rich table + details | Accepted, message 1114; rich_message returned | Installed Telegram Desktop displays an unsupported-message warning | Do not enable by default for this client |
| Visual image card | Uploaded, message 1115 | Visible in chat; small supporting text in thumbnail | Better as an optional visual, not sole accessible report |

Image iteration: removed unused screenshot viewport space and edited the same test photo with the tighter body-only capture. No duplicate image message was sent. Attempted viewer inspection reached the viewer, but full viewer capture failed because its window bounds exceeded the captured monitor; no full-screen viewer screenshot is claimed.

## Verification

- TypeScript build passed after the final changes.
- Six new experiment tests passed: HTML escaping, missing values, analytical outcomes, API boundaries, image labels and malformed sample rejection.
- Full suite: 767 passed, one failed (`tests/cache.test.ts`, cache read returned null). Narrow rerun reproduced that existing cache failure; the cache implementation was not modified.
- Five delivered formats and screenshot contents manually inspected. Quote expansion tested by an actual client click. Rich-message acceptance is explicitly not treated as rendering success.
- These tests establish observed delivery and client rendering, not universal mobile compatibility, accessibility conformance or statistically proven reading-speed improvements.

## Reproduce

Run `npx tsx scripts/report-layout-live.ts collect` for a new read-only source sample. Collection does not send messages.

Run `npx tsx scripts/report-layout-live.ts send 0`, `send 1`, `send 2` or `send 3` for the four text/rich approaches. These explicitly send one silent message to the owner configured in `.env.local`.

Run `npx tsx scripts/report-layout-live.ts render-image`, then `send-image` to upload the fifth approach. `edit-image` replaces only the photo identified by the local image receipt. The image renderer currently requires Chrome at the configured Windows path.

Run `npx vitest run tests/report-layouts.test.ts` and `npm run build` for narrow verification.

The default MODUS/PDC formatters and sender remain unchanged. Before integrating a chosen format, add HTML parse-mode support and escaping at the sender boundary, preserve pagination and partial-data warnings, and test affected MODUS/PDC delivery and callbacks. Keep metrics with incomplete coverage visibly qualified rather than hiding consequential warnings in an evidence block.

Official formatting reference: https://core.telegram.org/bots/api#formatting-options and https://core.telegram.org/bots/api#sendrichmessage.
