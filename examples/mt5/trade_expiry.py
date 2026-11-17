"""Durable, account-bound trade deadlines. A timer never opens a new position."""
import hashlib
import json
import math
import secrets
import sqlite3
import time
from contextlib import closing


class TradeExpiry:
    def __init__(self, trading, clock=time.time):
        self.trading, self.clock = trading, clock
        with closing(sqlite3.connect(trading.database)) as db, db:
            db.execute('''CREATE TABLE IF NOT EXISTS deadlines (
                id TEXT PRIMARY KEY, account TEXT, symbol TEXT, ticket TEXT, kind TEXT,
                expires REAL, quantity REAL, identifier TEXT, version TEXT, status TEXT, error TEXT)''')

    def validate(self, value):
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= self.clock() * 1000:
            raise ValueError('Thời hạn phải ở tương lai (UTC).')
        return int(value)

    def save(self, db, account, symbol, ticket, kind, expires, quantity, identifier=''):
        key = f'{account}:{kind}:{ticket}'
        if expires is None:
            db.execute('DELETE FROM deadlines WHERE id=?', (key,))
            return
        db.execute('INSERT OR REPLACE INTO deadlines VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                   (key, account, symbol, str(ticket), kind, expires, quantity, str(identifier), secrets.token_hex(8), 'active', ''))

    def rows(self, account):
        with closing(sqlite3.connect(self.trading.database)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute('SELECT * FROM deadlines WHERE account=?', (account,))]

    def status(self, key, status, error=''):
        with closing(sqlite3.connect(self.trading.database)) as db, db:
            db.execute('UPDATE deadlines SET status=?,error=? WHERE id=?', (status, error, key))

    def resolve(self, row):
        t = self.trading
        if row['kind'] == 'order':
            orders = t.rows('orders_get', ticket=int(row['ticket']))
            if orders:
                return 'order', orders[0]
            history = t.mt5.history_orders_get(ticket=int(row['ticket']))
            if history is None:
                raise ValueError('Chưa đọc được lịch sử để xác định vị thế của lệnh hẹn giờ.')
            identifier = next((o.position_id for o in history if getattr(o, 'position_id', 0)), None)
            if not identifier:
                return None, None
        else:
            identifier = row['identifier'] or row['ticket']
        positions = t.rows('positions_get')
        return next((('position', p) for p in positions if str(getattr(p, 'identifier', p.ticket)) == str(identifier)), (None, None))

    def process(self):
        t = self.trading
        try:
            with t.feed.lock:
                _, account = t.account()
            for row in self.rows(account['id']):
                if row['status'] not in ('active', 'waiting') or row['expires'] > self.clock() * 1000:
                    continue
                if not account['allowed']:
                    self.status(row['id'], 'waiting', account['reason'])
                    continue
                try:
                    with t.feed.lock:
                        kind, target = self.resolve(row)
                        if target is None:
                            self.status(row['id'], 'complete'); continue
                        if target.symbol != row['symbol']:
                            raise ValueError('Mã của ticket hẹn giờ không còn khớp.')
                        if kind == 'position' and target.volume > row['quantity'] + 1e-8:
                            raise ValueError('Khối lượng vị thế đã tăng. Cần xác nhận lại thời hạn để đóng khối lượng mới.')
                        intent = {'orderId': str(target.ticket)} if kind == 'order' else {'positionId': str(target.ticket), 'quantity': target.volume}
                    request = dict(action='cancel' if kind == 'order' else 'close', account=row['account'], symbol=row['symbol'], intent=intent,
                                   requestId='expiry-' + hashlib.sha256((row['id'] + row['version']).encode()).hexdigest()[:48])
                    result = t.execute(request)
                    self.status(row['id'], 'partial' if result.get('partial') else 'complete' if result.get('ok') else 'uncertain' if result.get('uncertain') else 'failed',
                                'MT5 chỉ khớp một phần. Kiểm tra khối lượng còn lại.' if result.get('partial') else result.get('error', ''))
                except (ValueError, RuntimeError) as error:
                    # No blind retries after a send/unknown result. A blocked
                    # permission is retried only before any broker submission.
                    self.status(row['id'], 'failed', str(error))
        except (ValueError, RuntimeError, sqlite3.Error):
            # Disconnection preserves every deadline for the next connection.
            return
