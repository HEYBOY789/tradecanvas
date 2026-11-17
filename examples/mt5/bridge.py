"""Serve TradeCanvas with MT5 market data and authenticated order routing."""

import argparse
import base64
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from threading import Lock, Thread, Event
from urllib.parse import parse_qs, urlsplit

from cvd_volume import RecentTicks, TARGETS, read_cvd

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, os.environ.get('MT5_CHART_DEPS', str(ROOT.parent / '.deps')))
import MetaTrader5 as mt5
from mt5_trading import Mt5Trading, TradingError
from layout_store import LayoutStore, LayoutError

FRAMES = {
    f'{n}{unit}': getattr(mt5, f'TIMEFRAME_{unit.upper()}{n}')
    for unit, numbers in (('m', (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30)),
                          ('h', (1, 2, 3, 4, 6, 8, 12)), ('d', (1,)), ('w', (1,)))
    for n in numbers
}
FRAMES['1M'] = mt5.TIMEFRAME_MN1
BAR_COUNT = 10000000
PAGE_SIZE = min(600, BAR_COUNT)
LIBRARIES = ('chart', 'core', 'commons')
MODULE = 'text/javascript; charset=utf-8'
DAY_MS = 86_400_000


def browser_assets():
    index = (ROOT / 'index.html').read_bytes()
    import_map = index.split(b'<script type="importmap">', 1)[1].split(b'</script>', 1)[0]
    map_hash = base64.b64encode(hashlib.sha256(import_map).digest()).decode('ascii')
    policy = (
        f"default-src 'none'; script-src 'self' 'sha256-{map_hash}'; "
        "style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; "
        "worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
    assets = {'/': ('text/html; charset=utf-8', index)}
    for name in ('app.js', 'session-levels.js', 'session-settings.js', 'session-dst.js', 'cvd.js', 'pane-scale.js', 'pane-crosshair.js', 'layout-persistence.js', 'layout-transfer.js', 'mt5-trading.js', 'shared-layouts.js', 'order-model.js', 'order-projection.js', 'order-gestures.js', 'order-ticket.js', 'order-rules.js', 'order-time.js', 'chart-preferences.js', 'expiry-chart.js', 'order-display.js', 'order-label-layout.js', 'quote-lines.js'):
        assets[f'/{name}'] = (MODULE, (ROOT / name).read_bytes())
    assets['/order-ticket.css'] = ('text/css; charset=utf-8', (ROOT / 'order-ticket.css').read_bytes())
    for name in LIBRARIES:
        directory = ROOT / 'node_modules' / '@tradecanvas' / name / 'dist'
        if not (directory / 'index.js').is_file():
            raise FileNotFoundError(f'@tradecanvas/{name} is missing. Run npm ci first.')
        for asset in directory.rglob('*.js'):
            route = PurePosixPath('/vendor', name, asset.relative_to(directory).as_posix())
            assets[str(route)] = (MODULE, asset.read_bytes())
    return assets, policy


def broker_name():
    account = mt5.account_info()
    return account.server if account else 'MT5'


def candle_rows(rows):
    return [dict(time=int(row['time']) * 1000, open=float(row['open']), high=float(row['high']),
                 low=float(row['low']), close=float(row['close']), volume=int(row['tick_volume']))
            for row in rows] if rows is not None else []


def merge_forex_days(candles):
    """Carry the Sunday opening segment into Monday's trading day."""
    days = []
    for bar in candles:
        date = int(bar['time']) // DAY_MS * DAY_MS
        weekday = datetime.fromtimestamp(date / 1000, timezone.utc).weekday()
        if weekday == 5:
            continue
        trading_day = date + DAY_MS if weekday == 6 else date
        current = dict(bar, time=bar.get('sessionStart', bar['time']), tradingDay=trading_day)
        if days and days[-1]['tradingDay'] == trading_day:
            previous = days[-1]
            previous.update(high=max(previous['high'], current['high']), low=min(previous['low'], current['low']),
                            close=current['close'], volume=previous['volume'] + current['volume'])
        else:
            days.append(current)
    return days


def running_terminal():
    command = '''
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$session = (Get-Process -Id $PID).SessionId
Get-Process -Name terminal64,terminal,metatrader64,metatrader -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq $session -and $_.Path } |
    Sort-Object @{Expression={$_.MainWindowHandle -ne 0};Descending=$true},
                @{Expression={$_.StartTime};Descending=$true} |
    Select-Object -First 1 -ExpandProperty Path
exit 0
'''
    result = subprocess.run(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
        capture_output=True, encoding='utf-8', timeout=5, check=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return result.stdout.strip()


class MarketData:
    def __init__(self):
        self.lock = Lock()
        self.retry_at = 0
        self.connection_error = 'MT5 đang kết nối lại.'
        self.volume_sources = {}
        self.recent_ticks = RecentTicks()
        self.day_starts = {}

    def require_terminal(self):
        terminal = mt5.terminal_info()
        if terminal is None:
            if time.monotonic() < self.retry_at:
                raise RuntimeError(self.connection_error)
            self.retry_at = time.monotonic() + 4
            path = running_terminal()
            if not path:
                self.connection_error = 'Hãy mở MetaTrader 5 để nhận dữ liệu.'
                raise RuntimeError(self.connection_error)
            mt5.shutdown()
            if not mt5.initialize(path, timeout=4000):
                self.connection_error = f'Chưa kết nối được MT5 ({mt5.last_error()[0]}).'
                raise RuntimeError(self.connection_error)
            terminal = mt5.terminal_info()
        if terminal is None or not terminal.connected:
            raise RuntimeError('MT5 chưa kết nối với máy chủ của broker.')

    def config(self):
        with self.lock:
            self.require_terminal()
            server = broker_name()
            symbols = sorted((info for info in mt5.symbols_get() or () if info.visible),
                             key=lambda info: info.name)
            if not symbols:
                raise RuntimeError('Hãy thêm mã vào Market Watch trong MT5.')
            preferred = next((info.name for info in symbols if info.name.startswith('XAUUSD')),
                             symbols[0].name)
            return dict(symbols=[dict(symbol=info.name, description=info.description,
                                      exchange=server, pricePrecision=int(info.digits),
                                      minTick=float(info.trade_tick_size or info.point))
                                 for info in symbols], frames=list(FRAMES), symbol=preferred,
                        frame='5m', server=server, count=BAR_COUNT, pageSize=PAGE_SIZE)

    def daily_bars(self, symbol, info, server):
        forex = 'forex' in info.path.casefold().split('\\')
        days = candle_rows(mt5.copy_rates_from_pos(symbol, FRAMES['1d'], 0, 10 if forex else 7))
        if not forex:
            return days
        for bar in days:
            if datetime.fromtimestamp(bar['time'] / 1000, timezone.utc).weekday() != 6:
                continue
            key = (server, symbol, bar['time'])
            if key not in self.day_starts:
                opening = mt5.copy_rates_range(symbol, FRAMES['1h'], bar['time'] // 1000,
                                              (bar['time'] + DAY_MS) // 1000 - 1)
                if opening is not None and len(opening):
                    self.day_starts[key] = int(opening[0]['time']) * 1000
            bar['sessionStart'] = self.day_starts.get(key, bar['time'])
        return merge_forex_days(days)[-7:]

    def bars(self, symbol, frame, since, broker, include_periods, before, count, cvd_targets):
        if frame not in FRAMES:
            raise ValueError('Khung thời gian không hợp lệ.')
        if not 1 <= count <= PAGE_SIZE:
            raise ValueError(f'Số nến mỗi lần phải nằm trong khoảng 1–{PAGE_SIZE}.')
        with self.lock:
            self.require_terminal()
            info = mt5.symbol_info(symbol)
            if info is None or not info.visible:
                raise ValueError('Mã không có trong Market Watch.')
            server = broker_name()
            if before is not None:
                # MT5 includes the cutoff, so use the second just before the cursor.
                bars = mt5.copy_rates_from(symbol, FRAMES[frame], before, count)
            else:
                bars = mt5.copy_rates_from_pos(symbol, FRAMES[frame], 0, count)
                if bars is None or not len(bars):
                    raise RuntimeError(f'Chưa đọc được nến {symbol} {frame}. MT5 sẽ thử lại.')

            periods = None
            if include_periods and before is None:
                periods = {key: candle_rows(mt5.copy_rates_from_pos(symbol, FRAMES[period], 0, count))
                           for key, period, count in (('week', '1w', 2), ('month', '1M', 2))}
                periods['day'] = self.daily_bars(symbol, info, server)

            real_volume = False
            if cvd_targets and bars is not None and len(bars):
                real_volume = self.volume_sources.setdefault((server, symbol), bool(bars['real_volume'].any()))

            # Keep the old current bar so its closed OHLC and CVD survive rollover.
            reset = True
            if before is None and since and broker == server:
                index = int(bars['time'].searchsorted(since))
                if index < len(bars) and bars['time'][index] == since:
                    reset = False
                    bars = bars[index:]
            delta = None
            if cvd_targets:
                live_key = (server, symbol, real_volume) if before is None else None
                delta = read_cvd(mt5, symbol, frame, bars, cvd_targets, FRAMES, real_volume, self.recent_ticks, live_key)

        result = dict(reset=reset, server=server, bars=candle_rows(bars))
        if periods is not None:
            result['periods'] = periods
        if delta is not None:
            result['cvd'] = delta
        return result


class ChartHandler(BaseHTTPRequestHandler):
    def valid_host(self):
        port = self.server.server_port
        address = self.connection.getsockname()[0]
        allowed_hosts = {f'{address}:{port}'}
        if address == '127.0.0.1':
            allowed_hosts.add(f'localhost:{port}')
        if self.headers.get('Host') not in allowed_hosts:
            self.send_error(HTTPStatus.BAD_REQUEST)
            return False
        return True

    def trading_auth(self):
        if not self.server.trading.authorized(self.headers.get('X-MT5-Key')):
            self.send_json(HTTPStatus.UNAUTHORIZED, dict(error='Cần mã kết nối giao dịch từ máy đang chạy MT5.'))
            return False
        return True

    def do_GET(self):
        if not self.valid_host():
            return

        request = urlsplit(self.path)
        if request.path == '/api/layouts':
            try:
                query = parse_qs(request.query)
                data = (dict(layout=self.server.layouts.load(query['id'][0])) if 'id' in query
                        else self.server.layouts.catalog())
                self.send_json(HTTPStatus.OK, data)
            except LayoutError as error:
                self.send_json(error.status, dict(error=str(error)))
            return
        if request.path == '/api/trading/session':
            if self.client_address[0] not in self.server.local_addresses:
                self.send_json(HTTPStatus.FORBIDDEN, dict(error='Mở chart trên máy MT5 để lấy mã kết nối.'))
            else:
                self.send_json(HTTPStatus.OK, dict(key=self.server.trading.key))
            return
        if request.path == '/api/trading/state':
            if not self.trading_auth():
                return
            try:
                symbols = parse_qs(request.query).get('symbols', [''])[0].split(',')
                if not 1 <= len(symbols) <= 9:
                    raise TradingError('Chỉ đọc tối đa 9 mã cùng lúc.')
                self.send_json(HTTPStatus.OK, self.server.trading.state(symbols))
            except (ValueError, RuntimeError) as error:
                self.send_json(HTTPStatus.BAD_REQUEST, dict(error=str(error)))
            return
        if request.path in self.server.assets:
            content_type, body = self.server.assets[request.path]
            self.send_body(HTTPStatus.OK, content_type, body)
        elif request.path in ('/api/config', '/api/bars'):
            try:
                if request.path == '/api/config':
                    data = self.server.feed.config()
                else:
                    query = parse_qs(request.query)
                    symbol = query.get('symbol', [''])[0]
                    frame = query.get('frame', [''])[0]
                    since = int(query.get('since', ['0'])[0]) // 1000
                    broker = query.get('broker', [''])[0]
                    include_periods = query.get('periods') == ['1']
                    before = (int(query['before'][0]) - 1) // 1000 if 'before' in query else None
                    count = int(query.get('count', [str(PAGE_SIZE)])[0])
                    values = query.get('cvd', [''])[0]
                    targets = set(values.split(',')) if values else set()
                    if not targets <= TARGETS:
                        raise ValueError('Độ phân giải CVD không hợp lệ.')
                    data = self.server.feed.bars(symbol, frame, since, broker, include_periods, before, count, targets)
            except ValueError as error:
                self.send_json(HTTPStatus.BAD_REQUEST, dict(error=str(error)))
            except RuntimeError as error:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, dict(error=str(error)))
            except subprocess.SubprocessError:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, dict(error='Chưa tìm được cửa sổ MT5.'))
            else:
                self.send_json(HTTPStatus.OK, data)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        if not self.valid_host():
            return
        if self.headers.get('Origin') != f'http://{self.headers.get("Host")}':
            self.send_json(HTTPStatus.FORBIDDEN, dict(error='Nguồn gửi yêu cầu không hợp lệ.'))
            return
        path = urlsplit(self.path).path
        if path == '/api/layouts':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if (not 1 <= length <= 10 * 1024 * 1024 or self.headers.get_content_type() != 'application/json'
                        or self.headers.get('X-MT5-Layouts') != '1'):
                    raise LayoutError('Yêu cầu lưu bố cục không hợp lệ.')
                command = json.loads(self.rfile.read(length))
                self.send_json(HTTPStatus.OK, self.server.layouts.mutate(command))
            except LayoutError as error:
                self.send_json(error.status, dict(error=str(error)))
            except (ValueError, RecursionError):
                self.send_json(HTTPStatus.BAD_REQUEST, dict(error='Yêu cầu JSON bố cục không hợp lệ.'))
            return
        if not self.trading_auth():
            return
        if path not in ('/api/trading/check', '/api/trading/execute', '/api/trading/estimate'):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 8192 or self.headers.get_content_type() != 'application/json':
                raise TradingError('Yêu cầu JSON không hợp lệ.')
            command = json.loads(self.rfile.read(length), parse_constant=lambda _: None)
            if not isinstance(command, dict):
                raise TradingError('Yêu cầu giao dịch không hợp lệ.')
            method = (self.server.trading.check if path.endswith('/check') else
                      self.server.trading.estimate if path.endswith('/estimate') else self.server.trading.execute)
            self.send_json(HTTPStatus.OK, method(command))
        except (ValueError, RuntimeError) as error:
            self.send_json(HTTPStatus.BAD_REQUEST, dict(error=str(error)))

    def send_json(self, status, data):
        self.send_body(status, 'application/json; charset=utf-8',
                       json.dumps(data, ensure_ascii=False, allow_nan=False).encode('utf-8'))

    def send_body(self, status, content_type, body):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', self.server.policy)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def log_request(self, code='-', size='-'):
        if str(code).startswith('5') and not self.path.startswith('/api/'):
            super().log_request(code, size)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8772)
    parser.add_argument('--open', action='store_true', help='open the chart in the default browser')
    parser.add_argument('--layout-dir', type=Path, default=ROOT / 'layouts', help='shared layout database directory')
    args = parser.parse_args()
    try:
        assets, policy = browser_assets()
    except FileNotFoundError as error:
        parser.exit(1, f'{error}\n')

    with ThreadingHTTPServer((args.host, args.port), ChartHandler) as server:
        server.feed = MarketData()
        server.layouts = LayoutStore(args.layout_dir)
        server.trading = Mt5Trading(mt5, server.feed, ROOT)
        stopping = Event()
        def expire_trades():
            while not stopping.wait(1):
                server.trading.expiry.process()
        expiry_thread = Thread(target=expire_trades, daemon=True)
        expiry_thread.start()
        server.local_addresses = {'127.0.0.1', '::1'} | {
            address[4][0] for address in socket.getaddrinfo(socket.gethostname(), None)
        }
        server.assets = assets
        server.policy = policy
        address = '127.0.0.1' if args.host == '0.0.0.0' else args.host
        url = f'http://{address}:{server.server_port}/'
        print(f'MT5 chart: {url} (listening on {server.server_address[0]}:{server.server_port})', flush=True)
        if args.open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            stopping.set()
            expiry_thread.join(timeout=5)
            with server.feed.lock:
                mt5.shutdown()


if __name__ == '__main__':
    main()
