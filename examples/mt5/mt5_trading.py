"""MT5 execution boundary. All terminal calls share MarketData's lock."""

import hashlib
import json
import math
import secrets
import sqlite3
from contextlib import closing
from pathlib import Path


class TradingError(ValueError):
    pass


def number(value, label, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise TradingError(f'{label} không hợp lệ.')
    return float(value)


class Mt5Trading:
    def __init__(self, terminal, feed, directory):
        self.mt5, self.feed = terminal, feed
        self.directory = Path(directory)
        key_file = self.directory / '.trading-key'
        try:
            with key_file.open('x', encoding='ascii') as stream:
                stream.write(secrets.token_urlsafe(32))
        except FileExistsError:
            pass
        self.key = key_file.read_text(encoding='ascii').strip()
        self.database = self.directory / '.trading-requests.sqlite3'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, digest TEXT, result TEXT)')

    def authorized(self, key):
        return isinstance(key, str) and secrets.compare_digest(key.encode('utf-8'), self.key.encode('ascii'))

    def account(self):
        self.feed.require_terminal()
        account, terminal = self.mt5.account_info(), self.mt5.terminal_info()
        if account is None or terminal is None:
            raise TradingError('Không đọc được tài khoản MT5.')
        reasons = []
        if not terminal.trade_allowed:
            reasons.append('Bật nút Algo Trading trong MT5 (Ctrl+E).')
        if terminal.tradeapi_disabled:
            reasons.append('Trong MT5 > Tools > Options > Expert Advisors, bỏ chọn Disable automated trading through external Python API.')
        if not account.trade_allowed or not account.trade_expert:
            reasons.append('Tài khoản hoặc broker chưa cho phép giao dịch tự động.')
        identity = hashlib.sha256(f'{account.login}@{account.server}'.encode()).hexdigest()
        return account, dict(id=identity, login=str(account.login), server=account.server,
                             demo=account.trade_mode == self.mt5.ACCOUNT_TRADE_MODE_DEMO,
                             currency=account.currency, balance=account.balance, equity=account.equity,
                             marginFree=account.margin_free, profit=account.profit,
                             leverage=account.leverage, allowed=not reasons, reason=' '.join(reasons))

    def info(self, symbol):
        if not isinstance(symbol, str) or len(symbol) > 80:
            raise TradingError('Mã giao dịch không hợp lệ.')
        info = self.mt5.symbol_info(symbol)
        if info is None or not info.visible:
            raise TradingError('Mã chưa có trong Market Watch của MT5.')
        return info

    def rows(self, method, **query):
        result = getattr(self.mt5, method)(**query)
        if result is None:
            raise TradingError(f'MT5 không đọc được {method} ({self.mt5.last_error()[0]}).')
        return result

    def state(self, symbols):
        with self.feed.lock:
            _, account = self.account()
            quotes = {}
            for symbol in symbols:
                info = self.info(symbol)
                tick = self.mt5.symbol_info_tick(symbol)
                quotes[symbol] = dict(bid=tick.bid if tick else 0, ask=tick.ask if tick else 0,
                                      time=tick.time_msc if tick else 0,
                                      min=info.volume_min, max=info.volume_max, step=info.volume_step,
                                      tickSize=info.trade_tick_size or info.point, digits=info.digits,
                                      stops=info.trade_stops_level * info.point,
                                      contractSize=info.trade_contract_size, orderMode=info.order_mode,
                                      expirationMode=info.expiration_mode)
            positions = [dict(id=str(p.ticket), symbol=p.symbol, side='buy' if p.type == 0 else 'sell',
                              entryPrice=p.price_open, quantity=p.volume, stopLoss=p.sl or None,
                              takeProfit=p.tp or None, profit=p.profit, swap=p.swap)
                         for p in self.rows('positions_get')]
            order_types = self.order_types()
            orders = []
            for o in self.rows('orders_get'):
                if o.type not in order_types:
                    continue
                side, kind = order_types[o.type]
                orders.append(dict(id=str(o.ticket), symbol=o.symbol, side=side, type=kind,
                                   price=o.price_stoplimit if kind == 'stopLimit' else o.price_open, quantity=o.volume_current,
                                   stopPrice=o.price_open if kind in ('stop', 'stopLimit') else None,
                                   stopLoss=o.sl or None, takeProfit=o.tp or None,
                                   draggable=True))
            return dict(account=account, positions=positions, orders=orders, quotes=quotes)

    def order_types(self):
        m = self.mt5
        return {getattr(m, f'ORDER_TYPE_{side.upper()}_{kind}'): (side, value)
                for side in ('buy', 'sell')
                for kind, value in (('LIMIT', 'limit'), ('STOP', 'stop'), ('STOP_LIMIT', 'stopLimit'))}

    def price(self, value, info, label, optional=False):
        if value is None and optional:
            return 0.0
        price = number(value, label, 0)
        if price == 0 and optional:
            return 0.0
        if price <= 0:
            raise TradingError(f'{label} phải lớn hơn 0.')
        step = info.trade_tick_size or info.point
        rounded = round(round(price / step) * step, info.digits)
        if abs(rounded - price) > step * 1e-5:
            raise TradingError(f'{label} phải đúng bước giá {step}.')
        return rounded

    def filling(self, info):
        m = self.mt5
        if info.filling_mode & 1:
            return m.ORDER_FILLING_FOK
        if info.filling_mode & 2:
            return m.ORDER_FILLING_IOC
        if info.trade_exemode != m.SYMBOL_TRADE_EXECUTION_MARKET:
            return m.ORDER_FILLING_RETURN
        raise TradingError('Broker không cung cấp chính sách khớp lệnh phù hợp.')

    def target(self, method, ticket, symbol):
        if not isinstance(ticket, str) or not ticket.isdecimal() or len(ticket) > 20:
            raise TradingError('Ticket không hợp lệ.')
        rows = self.rows(method, ticket=int(ticket))
        if len(rows) != 1 or rows[0].symbol != symbol:
            raise TradingError('Lệnh đã thay đổi hoặc không còn tồn tại. Hãy tải lại.')
        return rows[0]

    def build(self, command):
        if not isinstance(command, dict):
            raise TradingError('Yêu cầu không hợp lệ.')
        _, account = self.account()
        if command.get('account') != account['id']:
            raise TradingError('Tài khoản MT5 đã thay đổi. Hãy kiểm tra lại tài khoản trên chart.')
        if not account['allowed']:
            raise TradingError(account['reason'])
        m, action = self.mt5, command.get('action')
        symbol = command.get('symbol')
        info = self.info(symbol)
        intent = command.get('intent')
        if not isinstance(intent, dict):
            raise TradingError('Thông số lệnh không hợp lệ.')
        if intent.get('trailingStop') is not None:
            raise TradingError('Kết nối này chưa hỗ trợ trailing stop. Hãy dùng SL cố định hoặc trailing trong MT5.')
        request = dict(symbol=symbol)
        if action == 'place':
            side, kind = intent.get('side'), intent.get('type')
            if side not in ('buy', 'sell') or kind not in ('market', 'limit', 'stop', 'stopLimit'):
                raise TradingError('Loại lệnh không được hỗ trợ.')
            if not info.order_mode & {'market': 1, 'limit': 2, 'stop': 4, 'stopLimit': 8}[kind]:
                raise TradingError(f'Broker không hỗ trợ {"Stop Limit" if kind == "stopLimit" else kind} cho mã này.')
            volume = number(intent.get('quantity'), 'Số lot', info.volume_min)
            if volume > info.volume_max or abs(volume / info.volume_step - round(volume / info.volume_step)) > 1e-7:
                raise TradingError(f'Số lot từ {info.volume_min} đến {info.volume_max}, bước {info.volume_step}.')
            request.update(volume=volume, magic=877200, comment='TradeCanvas', deviation=20)
            request.update(sl=self.price(intent.get('stopLoss'), info, 'SL', True),
                           tp=self.price(intent.get('takeProfit'), info, 'TP', True))
            if kind == 'market':
                request.update(action=m.TRADE_ACTION_DEAL, type=m.ORDER_TYPE_BUY if side == 'buy' else m.ORDER_TYPE_SELL,
                               type_filling=self.filling(info))
                self.market_price(request, info, side)
            else:
                tif = intent.get('timeInForce', 'gtc')
                if tif not in ('gtc', 'day'):
                    raise TradingError('Thời hạn lệnh không hợp lệ.')
                flag = 1 if tif == 'gtc' else 2
                if not info.expiration_mode & flag:
                    raise TradingError('Broker không hỗ trợ thời hạn lệnh này.')
                request.update(action=m.TRADE_ACTION_PENDING, type=getattr(m, f'ORDER_TYPE_{side.upper()}_{"STOP_LIMIT" if kind == "stopLimit" else kind.upper()}'),
                               price=self.price(intent.get('stopPrice') if kind == 'stopLimit' else intent.get('price'), info, 'Giá Stop' if kind == 'stopLimit' else 'Giá đặt'),
                               type_time=m.ORDER_TIME_GTC if tif == 'gtc' else m.ORDER_TIME_DAY,
                               type_filling=m.ORDER_FILLING_RETURN)
                if kind == 'stopLimit':
                    request['stoplimit'] = self.price(intent.get('price'), info, 'Giá Limit')
        elif action in ('modifyOrder', 'cancel'):
            order = self.target('orders_get', intent.get('orderId'), symbol)
            request.update(order=order.ticket)
            if action == 'cancel':
                request.update(action=m.TRADE_ACTION_REMOVE)
            else:
                previous_price = number(intent.get('previousPrice'), 'Giá lệnh trước khi sửa')
                if abs(order.price_open - previous_price) > info.point / 2:
                    raise TradingError('Giá lệnh chờ đã thay đổi. Hãy tải lại trước khi sửa.')
                request.update(action=m.TRADE_ACTION_MODIFY, price=self.price(intent.get('newPrice'), info, 'Giá mới'),
                               sl=self.price(intent['stopLoss'], info, 'SL', True) if 'stopLoss' in intent else order.sl,
                               tp=self.price(intent['takeProfit'], info, 'TP', True) if 'takeProfit' in intent else order.tp,
                               type_time=order.type_time,
                               expiration=order.time_expiration,
                               stoplimit=self.price(intent['limitPrice'], info, 'Giá Limit') if 'limitPrice' in intent else order.price_stoplimit)
        elif action in ('modifyPosition', 'close'):
            position = self.target('positions_get', intent.get('positionId'), symbol)
            request.update(position=position.ticket)
            if action == 'close':
                expected = number(intent.get('quantity'), 'Khối lượng đóng', info.volume_min)
                if abs(position.volume - expected) > info.volume_step * 1e-6:
                    raise TradingError('Khối lượng vị thế đã thay đổi. Hãy kiểm tra lại trước khi đóng.')
                side = 'sell' if position.type == m.POSITION_TYPE_BUY else 'buy'
                request.update(action=m.TRADE_ACTION_DEAL, volume=position.volume, deviation=20,
                               type=m.ORDER_TYPE_SELL if side == 'sell' else m.ORDER_TYPE_BUY,
                               type_filling=self.filling(info), comment='TradeCanvas close')
                self.market_price(request, info, side)
            else:
                if not any(k in intent for k in ('stopLoss', 'takeProfit')):
                    raise TradingError('Chưa có SL/TP cần thay đổi.')
                request.update(action=m.TRADE_ACTION_SLTP,
                               sl=self.price(intent['stopLoss'], info, 'SL', True) if 'stopLoss' in intent else position.sl,
                               tp=self.price(intent['takeProfit'], info, 'TP', True) if 'takeProfit' in intent else position.tp)
        else:
            raise TradingError('Thao tác giao dịch không được hỗ trợ.')
        return request, account

    def estimate(self, command):
        """Account-currency estimates, never order_check/order_send or a terminal permission change."""
        with self.feed.lock:
            native, account = self.account()
            if command.get('account') != account['id']:
                raise TradingError('Tài khoản MT5 đã thay đổi. Hãy mở lại phiếu đặt lệnh.')
            info = self.info(command.get('symbol'))
            intent = command.get('intent', {})
            if not isinstance(intent, dict) or intent.get('side') not in ('buy', 'sell'):
                raise TradingError('Chiều lệnh không hợp lệ.')
            side = self.mt5.ORDER_TYPE_BUY if intent['side'] == 'buy' else self.mt5.ORDER_TYPE_SELL
            tick = self.mt5.symbol_info_tick(info.name)
            if intent.get('type') == 'market':
                entry = (tick.ask if side == self.mt5.ORDER_TYPE_BUY else tick.bid) if tick else 0
            else:
                entry = self.price(intent.get('price'), info, 'Giá vào')
            if not entry or entry <= 0:
                raise TradingError('Chưa có giá Bid/Ask hợp lệ.')
            sl = self.price(intent.get('stopLoss'), info, 'SL', True)
            tp = self.price(intent.get('takeProfit'), info, 'TP', True)
            minimum = info.volume_min
            reference_volume = min(info.volume_max, max(minimum, 1.0))
            def profit(close, volume=reference_volume):
                value = self.mt5.order_calc_profit(side, info.name, volume, entry, close)
                return float(value) if value is not None and math.isfinite(value) else None
            risk_unit = profit(sl) if sl else None
            tick_size = info.trade_tick_size or info.point
            # MT5 rounds profit to account-currency decimals. A minimum lot
            # over one tiny tick can round to zero; scale a larger move first.
            reference_move = max(tick_size * 100, entry * .001)
            move_profit = profit(entry + reference_move)
            tick_value = abs(move_profit) / reference_move * tick_size if move_profit is not None else None
            value_per_lot = tick_value / reference_volume / tick_size * entry if tick_value is not None else None
            quantity = number(intent.get('quantity'), 'Khối lượng hoặc mức rủi ro', 0)
            mode = intent.get('quantityMode', 'lots')
            if mode in ('riskAmount', 'riskPercent'):
                if risk_unit is None or risk_unit >= 0:
                    raise TradingError('Đặt Stop Loss ở phía lỗ để tính khối lượng theo rủi ro.')
                budget = native.balance * quantity / 100 if mode == 'riskPercent' else quantity
                quantity = budget / abs(risk_unit) * reference_volume
            elif mode in ('notional', 'balancePercent'):
                if not value_per_lot or value_per_lot <= 0:
                    raise TradingError('MT5 chưa tính được giá trị quy đổi của mã này.')
                budget = native.balance * quantity / 100 if mode == 'balancePercent' else quantity
                quantity = budget / value_per_lot
            elif mode != 'lots':
                raise TradingError('Đơn vị khối lượng không hợp lệ.')
            if mode != 'lots':
                quantity = round(math.floor((quantity + info.volume_step * 1e-8) / info.volume_step) * info.volume_step, 8)
            if quantity < minimum:
                raise TradingError(f'Khối lượng tính được thấp hơn lot tối thiểu {minimum}.')
            if quantity > info.volume_max or abs(quantity / info.volume_step - round(quantity / info.volume_step)) > 1e-7:
                raise TradingError(f'Số lot tối đa {info.volume_max}, bước {info.volume_step}.')
            margin = self.mt5.order_calc_margin(side, info.name, quantity, entry)
            risk = profit(sl, quantity) if sl else None
            reward = profit(tp, quantity) if tp else None
            return dict(quantity=quantity, entry=entry, currency=native.currency,
                        risk=-risk if risk is not None else None, reward=reward,
                        ratio=reward / -risk if risk is not None and risk < 0 and reward is not None else None,
                        margin=float(margin) if margin is not None and math.isfinite(margin) else None,
                        marginFree=native.margin_free, leverage=native.leverage,
                        tickValue=tick_value / reference_volume * quantity if tick_value is not None else None,
                        notional=value_per_lot * quantity if value_per_lot is not None else None)

    def market_price(self, request, info, side):
        tick = self.mt5.symbol_info_tick(info.name)
        price = (tick.ask if side == 'buy' else tick.bid) if tick else 0
        if price <= 0:
            raise TradingError('MT5 chưa có giá Bid/Ask hợp lệ.')
        # Market Execution ignores the requested price; other execution modes require it.
        if info.trade_exemode != self.mt5.SYMBOL_TRADE_EXECUTION_MARKET:
            request['price'] = price

    def checked(self, request):
        result = self.mt5.order_check(request)
        if result is None:
            raise TradingError(f'MT5 không kiểm tra được lệnh ({self.mt5.last_error()[0]}).')
        if result.retcode != 0:
            raise TradingError(f'MT5 {result.retcode}: {result.comment}')
        return result

    def check(self, command):
        with self.feed.lock:
            request, account = self.build(command)
            self.checked(request)
            return dict(ok=True, account=account, request=request)

    def execute(self, command):
        request_id = command.get('requestId')
        if not isinstance(request_id, str) or not 20 <= len(request_id) <= 80 or not all(c.isalnum() or c in '-_' for c in request_id):
            raise TradingError('Mã yêu cầu không hợp lệ.')
        digest = hashlib.sha256(json.dumps(command, sort_keys=True, allow_nan=False).encode()).hexdigest()
        with self.feed.lock, closing(sqlite3.connect(self.database)) as db, db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT digest, result FROM requests WHERE id=?', (request_id,)).fetchone()
            if previous:
                if previous[0] != digest:
                    raise TradingError('Mã yêu cầu đã dùng cho một thao tác khác.')
                if previous[1] is None:
                    raise TradingError('Kết quả yêu cầu trước chưa xác định. Kiểm tra MT5; không gửi lại lệnh này.')
                return json.loads(previous[1])
            request, _ = self.build(command)
            self.checked(request)
            db.execute('INSERT INTO requests VALUES (?, ?, NULL)', (request_id, digest))
            db.commit()  # Record before sending: a crash must never replay a trade.
            _, latest = self.account()
            if latest['id'] != command.get('account') or not latest['allowed']:
                response = dict(ok=False, error='Tài khoản hoặc quyền giao dịch MT5 đã thay đổi sau bước kiểm tra. Chưa gửi lệnh.')
                db.execute('UPDATE requests SET result=? WHERE id=?', (json.dumps(response), request_id))
                return response
            result = self.mt5.order_send(request)
            if result is None:
                response = dict(ok=False, uncertain=True, error='MT5 chưa trả kết quả. Kiểm tra lệnh trong MT5 trước khi đặt tiếp.')
            else:
                ok = result.retcode in (self.mt5.TRADE_RETCODE_DONE, self.mt5.TRADE_RETCODE_PLACED, self.mt5.TRADE_RETCODE_DONE_PARTIAL, self.mt5.TRADE_RETCODE_NO_CHANGES)
                response = dict(ok=ok, retcode=result.retcode, order=str(result.order), deal=str(result.deal),
                                volume=result.volume, price=result.price,
                                partial=result.retcode == self.mt5.TRADE_RETCODE_DONE_PARTIAL,
                                error='' if ok else f'MT5 {result.retcode}: {result.comment}')
            db.execute('UPDATE requests SET result=? WHERE id=?', (json.dumps(response), request_id))
            return response
