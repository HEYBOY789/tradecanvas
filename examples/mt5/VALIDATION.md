# MT5 workspace validation — 2026-11-17

## Order controls update

- Added account-bound, durable trade deadlines to new trades and existing orders/positions. Tests cover restart persistence, native pending expiration, following a filled pending order, disabling Algo Trading, changed accounts, increased volume and an uncertain send without retries.
- Added chart-zone date/time entry with explicit 12/24-hour format and DST validation; a draggable vertical marker edits the same UTC timestamp. Browser checks verify an AM/PM time in Asia/Ho_Chi_Minh maps to the intended UTC instant.
- Moved One-click to trading settings, placed captions below Bid/Ask prices, added provisional TP/SL switches, and retained native close/cancel/remove-stop actions. Preview toggles do not send or set a broker/draft level; release commits it.
- Added immediate pending-entry and exit guards in the form, gesture projection and backend. Draft crossings can change side/type; placed orders retain their MT5 side/type and filled positions cannot reverse through a drag. The real closing quote, not historical entry, constrains position SL/TP.
- Added independent Bid/Ask display under Symbol/Last price, layout persistence and Cancel rollback. Existing settings dialogs render in the widget portal, so the host extension observes that portal.
- Added Fibonacci 0/100 endpoint labels/colors, period-line outlines, and migration of the old midpoint control to Fibo 50%.

Validation: **30 Python tests, 12 unit tests, 17 mocked trading browser tests and 11 UI compatibility cases**; the visual case checks 18 width/theme/look combinations. UI fixtures supply bars/quotes and intercept all trading mutations. No real broker order is sent by tests. A normal-mode crosshair is used for the exact cursor-price grid assertion so a fixture candle within magnet distance does not change the price under test; a separate case still covers magnet mode. Fixture startup waits for shared layout restoration before inspecting execution state.

## Upstream and packages

- Merged `bonguynvan/tradecanvas` main through `e2e047efbc9282410fc14dd837504ece616e8f9b`, with no merge conflicts. Fetched upstream again after the merge and verified it is an ancestor of the workspace branch.
- Pinned the browser runtime and its core/commons dependencies to the latest published `2.13.1`.
- Installation used `--ignore-scripts`. `npm audit` reported zero known vulnerabilities; `npm audit signatures` verified registry signatures and attestations for all five installed packages. These checks establish package provenance and known vulnerability status, not an absolute malware guarantee.

## Stop-edit diagnosis

The initial browser regression command was `node --test order-regression.test.cjs`. All three cases failed before the fixes:

1. An MT5 rejection restored the old SL but polling replaced the status message; there was no persistent visible error.
2. Shift while placing a drawing could modify an order. Both the custom pointer handler and the native trading handler competed with chart tools.
3. A state read begun before an accepted edit could satisfy the post-edit refresh and restore the old SL. The fixture accepted `3783.361`, but the chart reverted to `3790`.

The post-execution read now waits for any earlier read and starts a new one. A rejected action keeps its error visible until dismissed. The dedicated, per-chart **SL/TP** button replaces the conflicting Shift binding. Reserved modifiers and drawing/eraser/zoom tools retain their native gestures. The native trading handler is disabled only during a protected press and restored after event dispatch.

With **SL/TP** on, dragging Entry creates or replaces the exit on that side. With it off, dragging a pending Entry translates the bracket and preserves distances/R:R. A direct SL/TP drag changes only that exit in either mode. Filled Entry prices remain fixed. Escape, selecting a tool, changing account or symbol resets the mode; it is never saved or restored as armed.

## Checks

- 23 Python broker/HTTP/layout tests, with a fake broker replacing `order_send`.
- 9 unit tests for order geometry, CVD backfill and Fibonacci rendering/history.
- 11 mocked trading browser tests, including rejection/rollback, stale polling, modifier conflicts, pending and filled orders, sell-side exits, Stop Limit, review/one-click modes and account changes. The visual case checks 18 combinations of width, theme and look.
- 4 layout/crosshair browser tests, including timezone restoration, import/export, parked chart cells and independent LAN clients with concurrent writes.
- Sessions compatibility tests passed for settings/dropdowns, independent instances, separate/merged CVD panes, period levels and Fibonacci selection. These legacy tests require an empty test layout store for each file. Running them against one shared store exposed fixture contamination; the pane test also needed its search selector scoped to the searchbox after the quick-lot input was added.

Trading browser fixtures intercept every trading route, and unknown routes abort. No actual broker order was submitted for these checks. The current terminal reports Algo Trading disabled; live trade edits require the user to enable it in MT5. Application startup does not change that terminal setting.

## Workspace skill snapshots

The upstream merge also updated the repository's TradeCanvas skill recipe. The full skill trees before and after the merge were reconstructed from their Git commits into the following timestamped backups, then every file was verified against a SHA-256 manifest:

- `D:/mt5/skill-backups/tradecanvas-20261117-182614-before-upstream-merge` — source `88bdf3e`.
- `D:/mt5/skill-backups/tradecanvas-20261117-182614-after-upstream-merge` — source `cc93a74`.

The manifests record that these snapshots were reconstructed from Git; earlier backups were retained.
