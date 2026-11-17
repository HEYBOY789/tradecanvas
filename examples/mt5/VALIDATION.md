# MT5 workspace validation — 2026-11-17

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
