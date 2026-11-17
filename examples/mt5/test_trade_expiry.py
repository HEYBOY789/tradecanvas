import tempfile
import unittest
from contextlib import closing
from threading import Lock
from types import SimpleNamespace as NS
from unittest.mock import Mock
import sqlite3
from mt5_trading import Mt5Trading
from test_mt5_trading import Broker


class ExpiryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.broker = Broker()
        self.service = Mt5Trading(self.broker, NS(lock=Lock(), require_terminal=lambda: None), self.temp.name)
        self.account = self.service.account()[1]['id']
        self.now = 1000000000
        self.service.expiry.clock = lambda: self.now

    def tearDown(self): self.temp.cleanup()

    def schedule(self, kind='position'):
        with closing(sqlite3.connect(self.service.database)) as db, db:
            self.service.expiry.save(db, self.account, 'TEST', '123' if kind == 'position' else '321', kind,
                                     (self.now + 60) * 1000, .02)

    def test_position_deadline_survives_restart_closes_once_and_binds_account(self):
        self.schedule()
        again = Mt5Trading(self.broker, self.service.feed, self.temp.name)
        again.expiry.clock = lambda: self.now
        self.now += 61
        self.broker.account.login = 99
        again.expiry.process(); self.broker.order_send.assert_not_called()
        self.broker.account.login = 42
        again.expiry.process(); again.expiry.process()
        self.broker.order_send.assert_called_once()
        self.assertEqual(self.broker.order_send.call_args.args[0]['position'], 123)

    def test_disabled_trading_waits_and_unknown_send_is_never_retried(self):
        self.schedule(); self.now += 61
        self.broker.terminal.trade_allowed = False
        self.service.expiry.process(); self.broker.order_send.assert_not_called()
        self.assertEqual(self.service.expiry.rows(self.account)[0]['status'], 'waiting')
        self.broker.terminal.trade_allowed = True
        self.broker.order_send.return_value = None
        self.service.expiry.process(); self.service.expiry.process()
        self.broker.order_send.assert_called_once()
        self.assertEqual(self.service.expiry.rows(self.account)[0]['status'], 'uncertain')

    def test_a_filled_pending_order_follows_its_position_and_does_not_close_an_enlarged_position(self):
        self.schedule('order'); self.now += 61
        self.broker.orders_get = lambda **kw: []
        self.broker.history_orders_get = lambda **kw: [NS(position_id=123)]
        self.broker.position.volume = .03
        self.service.expiry.process(); self.broker.order_send.assert_not_called()
        self.assertEqual(self.service.expiry.rows(self.account)[0]['status'], 'failed')

    def test_existing_pending_deadline_cancels_only_its_ticket(self):
        self.schedule('order'); self.now += 61
        self.service.expiry.process()
        self.broker.order_send.assert_called_once()
        self.assertEqual(self.broker.order_send.call_args.args[0]['order'], 321)

    def test_setting_expiry_is_idempotent_and_does_not_send_to_broker(self):
        command = dict(action='setExpiry', symbol='TEST', account=self.account, requestId='x' * 32,
                       intent=dict(kind='position', ticket='123', expiresAt=(self.now + 120) * 1000))
        self.service.check(command)
        result = self.service.execute(command)
        self.assertEqual(result, self.service.execute(command))
        self.assertEqual(len(self.service.expiry.rows(self.account)), 1)
        self.broker.order_send.assert_not_called()

    def test_invalid_pending_entries_and_live_stops_fail_before_broker_check(self):
        for side, kind, price in [('sell', 'stop', 105), ('buy', 'stop', 95), ('buy', 'limit', 105), ('sell', 'limit', 95)]:
            command = dict(action='place', symbol='TEST', account=self.account, intent=dict(side=side, type=kind, price=price, quantity=.01))
            with self.assertRaisesRegex(ValueError, 'Bid|Ask'): self.service.check(command)
        command = dict(action='modifyPosition', symbol='TEST', account=self.account, intent=dict(positionId='123', stopLoss=101))
        with self.assertRaisesRegex(ValueError, 'SL'): self.service.check(command)
        self.broker.order_check.assert_not_called(); self.broker.order_send.assert_not_called()

    def test_pending_expiry_updates_native_time_and_persists_deadline_through_fill(self):
        expires = (self.now + 120) * 1000
        command = dict(action='setExpiry', symbol='TEST', account=self.account, requestId='y' * 32,
                       intent=dict(kind='order', ticket='321', expiresAt=expires))
        self.service.execute(command)
        sent = self.broker.order_send.call_args.args[0]
        self.assertEqual((sent['order'], sent['expiration'], sent['type_time']), (321, expires // 1000, 2))
        self.service.execute(command); self.broker.order_send.assert_called_once()
        self.assertEqual(self.service.expiry.rows(self.account)[0]['expires'], expires)
