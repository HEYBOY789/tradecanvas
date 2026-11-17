# TradeCanvas · MT5

![MT5 order panel, dark](screenshots/order-panel-dark.png)

[Light theme](screenshots/order-panel-light.png) · [Phone layout](screenshots/order-panel-phone.png). These screenshots use a mocked trading account; no account keys or personal balances are included.

Run `start.cmd` with MetaTrader 5 already open. The chart listens on `0.0.0.0:8772` and refreshes candles, CVD, quotes, positions and pending orders every second.

## Setup on Windows

Use 64-bit Python 3.11+ and Node 20.19+. Open MetaTrader 5 in the same Windows session, with the symbols you need visible in Market Watch.

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
npm ci --ignore-scripts
start.cmd
```

The launcher prefers `.venv`; an existing Codex Python runtime or `python` on PATH is the fallback. A separate installed dependency directory can be supplied with `MT5_CHART_DEPS`. Open `http://localhost:8772` on the host or `http://<host-LAN-IP>:8772` on another device. The chart attaches to the terminal already running; it does not require storing account passwords in source files.

## Trading

- **Đặt lệnh MT5** opens a resizable-chart sidebar ticket with live Buy/Ask and Sell/Bid prices, Market/Limit/Stop/Stop Limit tabs, fixed exits, GTC/Day validity and local order presets. Unsupported order types/validity are disabled according to the MT5 symbol's flags.
- Choose quantity in **lots**, account-currency value, percent of balance, account-currency risk or percent-of-balance risk. MT5 `order_calc_profit` and `order_calc_margin` provide account-currency estimates. Risk sizing requires an SL and rounds volume down to the broker's step. Estimates exclude commission, swap and slippage; margin estimates do not net the current positions.
- Right-click a **Long/Short Position** drawing and choose **Tạo lệnh giới hạn MT5 từ vị thế…** to copy Entry, SL, TP, side and the risk mode. The order draft and the linked drawing update each other. The drawing tool's abstract quantity is never interpreted as broker lots.
- Right-click the chart or use the price-axis plus menu to prepare Buy/Sell Limit, Stop or Stop Limit orders at the selected price.
- **Shift + drag Entry** pulls out SL on the loss side or TP on the profit side. Repeat it to replace that level. A normal Entry drag moves SL/TP by the same price difference and preserves their distances and reward/risk ratio; Stop Limit also moves its activation price. Drag an SL/TP line directly without Shift to change only that exit. The same gestures work on a client-only draft and on an already placed pending order; Shift can also add exits to an open position. A filled position's entry price stays fixed.
- **Vị thế MT5** shows the current terminal account, broker-reported P&L, positions and pending orders across symbols. Use it to modify SL/TP, modify a pending order's price, cancel an order or close a full position. Chart order/position lines also route changes through this connection.
- **One-click trading** is off by default. The chart's red Sell / lot input / blue Buy controls open the ticket while it is off. Enabling **1 nhấp** on the chart or the ticket's settings makes trade buttons and completed live-order drags submit immediately, including modify/cancel/close actions. The choice is per account and browser tab, retained on reload, and disarmed if the account changes. Draft edits and drawing operations never submit on their own.
- Every submission still calls MT5 `order_check` and verifies the account again immediately before `order_send`. With One-click off, the exact account, symbol, lots and action appear for review; **Gửi tới MT5** submits it. There is no automatic retry after a send failure. Check the terminal before creating another request if a result is uncertain.
- MT5 **Algo Trading** must be enabled. In Tools → Options → Expert Advisors, the external Python trading API must also be allowed. The chart reports the current permission state; it does not change MT5 permissions.
- There is no chart-managed trailing stop or automatic position reversal in this connection.

Trading requests require a key, exact same-origin JSON requests and a matching current account. Browsers on the MT5 computer connect automatically. For another LAN device, open **Vị thế MT5 → Mã kết nối máy khác** on the MT5 computer to view the key, then enter it on that device. The key is stored in `.trading-key`; it is not included in exported chart layouts. `.trading-requests.sqlite3` records request IDs to prevent a repeated submission, including across server restarts. Keep these files private and retain the request database.

## Sessions Fibonacci history

In All-In-One Sessions → **Fibonacci phiên trước**, enable **Giữ Fibo phiên cũ**. Each completed session retains its selected levels inside its own time range. This is separate from **Giữ hộp phiên cũ** and is saved independently for each Sessions indicator instance and layout. Incomplete CVD history does not produce invented Fibo extremes.

## Shared layouts over LAN

Named layouts are stored on the MT5 host in `layouts/layouts.sqlite3`, independently of any browser. Every LAN client uses the same save/open/rename/delete menu and sees updates to the shared list within about one second. A fresh browser opens the most recently saved layout; each browser subsequently remembers which layout it opened.

The first load of this version uploads the browser's existing named layouts. The original browser records remain intact. If two browser archives have different versions of the same ID, both are preserved, with a separate shared ID for the conflicting copy. Original save dates and browser timezone/Sessions settings are retained. A migration is idempotent and does not recreate a layout subsequently deleted from the shared store.

Opening a chart on one device does not move another device's chart or discard its edits. When the same saved layout changes remotely, **Mở bản máy chính** loads the newer version and **Lưu thành bản mới** keeps the local chart as another layout. Saving an older version over a newer one is rejected. Auto-save uses the same revision checks. The database retains previous saved versions and deleted content in its internal history table.

The **Xuất bố cục / Nhập bố cục** JSON controls still work with this shared store. To back up the complete shared collection and its history, stop the host and copy the `layouts` directory. `bridge.py --layout-dir PATH` selects another data directory, including a separate empty one for isolated browser tests. Layout sharing does not grant access to MT5 trading; trading keeps its separate connection key.

## Verification

```powershell
.venv\Scripts\python -m unittest -v test_mt5_trading.py test_layout_store.py
npm run test:unit
$env:TRADECANVAS_URL='http://127.0.0.1:8773/'
npm run test:trading
npm run test:layouts
```

Start an isolated test server on 8773 with `bridge.py --host 127.0.0.1 --port 8773 --layout-dir <empty-test-directory>` so browser tests never write into personal shared layouts. The trading browser fixtures intercept **every** trading route; the Python tests replace the terminal with a fake broker, including `order_send`. They never send a real terminal order. UI tests use an installed Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`; the visual check covers phone, laptop and wide screens, light/dark themes and Print/Studio/Terminal looks. Mock-account screenshots are under `screenshots/`.

## Sources and notices

The application uses published `@tradecanvas/chart@2.12.0`. Its order UI is an independent implementation based on TradingView's public [Order Ticket documentation](https://www.tradingview.com/charting-library-docs/latest/trading_terminal/order-ticket/) and [order-projection behavior](https://www.tradingview.com/support/solutions/43000736178-chart-trading-order-projection/). The [Lightweight Charts source](https://github.com/tradingview/lightweight-charts/tree/c29c51e1e5bc61981da5832c97797cb8283d120f) was inspected; it is a chart renderer and does not supply this ticket. No proprietary TradingView Trading Platform source is included.

`cvd.js` and `cvd_volume.py` retain their MPL 2.0 notices and attribution to TradingView's CVD Candle script. `session-levels.js` retains the attribution to Texmoonbeam's Pine indicator supplied for the port. The indicator ports are JavaScript/Python implementations over MT5 data, not a Pine Script runtime. Broker tick-volume CVD is an estimate from quote direction, not exchange-provided bid/ask trade delta.
