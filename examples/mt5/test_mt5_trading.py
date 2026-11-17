"""No real terminal connection or order_send: an in-memory broker double only."""
import json
import tempfile
import unittest
import http.client
from http.server import ThreadingHTTPServer
from threading import Thread
from threading import Lock
from types import SimpleNamespace as NS
from unittest.mock import Mock

from mt5_trading import Mt5Trading, TradingError


class Broker:
    ACCOUNT_TRADE_MODE_DEMO = 0
    SYMBOL_TRADE_EXECUTION_MARKET = 2
    ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
    ORDER_TYPE_BUY, ORDER_TYPE_SELL = 0, 1
    ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_SELL_LIMIT = 2, 3
    ORDER_TYPE_BUY_STOP, ORDER_TYPE_SELL_STOP = 4, 5
    ORDER_TYPE_BUY_STOP_LIMIT, ORDER_TYPE_SELL_STOP_LIMIT = 6, 7
    ORDER_TIME_GTC, ORDER_TIME_DAY = 0, 1
    POSITION_TYPE_BUY = 0
    TRADE_ACTION_DEAL, TRADE_ACTION_PENDING, TRADE_ACTION_SLTP, TRADE_ACTION_MODIFY, TRADE_ACTION_REMOVE = 1, 5, 6, 7, 8
    TRADE_RETCODE_DONE, TRADE_RETCODE_PLACED, TRADE_RETCODE_DONE_PARTIAL, TRADE_RETCODE_NO_CHANGES = 10009, 10008, 10010, 10025

    def __init__(self):
        self.account = NS(login=42, server='Test', trade_mode=0, trade_allowed=True, trade_expert=True,
                          currency='USD', balance=1000, equity=1000, margin_free=1000, profit=0, leverage=100)
        self.terminal = NS(trade_allowed=True, tradeapi_disabled=False)
        self.info = NS(name='TEST', visible=True, volume_min=.01, volume_max=20, volume_step=.01,
                       trade_tick_size=.001, point=.001, digits=3, filling_mode=3, trade_exemode=2,
                       expiration_mode=15, trade_stops_level=10, trade_contract_size=100,
                       order_mode=127, currency_profit='USD')
        self.position = NS(ticket=123, symbol='TEST', type=0, price_open=100, volume=.02, sl=90, tp=110, profit=5, swap=0)
        self.order = NS(ticket=321, symbol='TEST', type=2, price_open=95, volume_current=.01,
                        sl=90, tp=110, type_time=1, time_expiration=123456, price_stoplimit=0)
        self.order_send = Mock(return_value=NS(retcode=10009, comment='Done', order=123, deal=456, volume=.01, price=100))
        self.order_check = Mock(return_value=NS(retcode=0, comment='Done'))

    def account_info(self): return self.account
    def terminal_info(self): return self.terminal
    def symbol_info(self, symbol): return self.info if symbol == 'TEST' else None
    def symbol_info_tick(self, symbol): return NS(bid=100, ask=100.01, time_msc=1234)
    def positions_get(self, **kw): return [self.position] if not kw or kw.get('ticket') == 123 else []
    def orders_get(self, **kw): return [self.order] if not kw or kw.get('ticket') == 321 else []
    def last_error(self): return (-1, 'test')
    def order_calc_profit(self, side, symbol, volume, entry, close): return (close - entry) * volume * 100 * (1 if side == 0 else -1)
    def order_calc_margin(self, side, symbol, volume, entry): return volume * entry


class TradingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.broker = Broker()
        self.feed = NS(lock=Lock(), require_terminal=lambda: None)
        self.service = Mt5Trading(self.broker, self.feed, self.temp.name)
        self.account = self.service.state(['TEST'])['account']['id']

    def tearDown(self): self.temp.cleanup()

    def command(self, action='place', intent=None, **extra):
        return dict(action=action, symbol='TEST', account=self.account, requestId='a' * 32,
                    intent=intent or dict(side='buy', type='market', quantity=.01, price=100), **extra)

    def test_preflight_never_executes_and_market_uses_broker_filling(self):
        request = self.service.check(self.command())['request']
        self.assertEqual(request['volume'], .01)
        self.assertEqual(request['type_filling'], self.broker.ORDER_FILLING_FOK)
        self.assertNotIn('price', request)  # Market Execution
        self.broker.order_send.assert_not_called()

    def test_stop_limit_maps_trigger_and_limit_separately(self):
        for side in ['buy', 'sell']:
            request = self.service.check(self.command(intent=dict(side=side, type='stopLimit', quantity=.02,
                price=100, stopPrice=101 if side == 'buy' else 99, stopLoss=90 if side == 'buy' else 110)))['request']
            self.assertEqual(request['price'], 101 if side == 'buy' else 99)
            self.assertEqual(request['stoplimit'], 100)
            self.assertEqual(request['type'], 6 if side == 'buy' else 7)
        self.broker.info.order_mode = 7
        with self.assertRaisesRegex(TradingError, 'Stop Limit'): self.service.check(self.command(intent=dict(side='buy', type='stopLimit', quantity=.02, price=100, stopPrice=101)))
        self.broker.order_send.assert_not_called()

    def test_broker_currency_risk_sizing_rounds_down_without_trading(self):
        command = dict(account=self.account, symbol='TEST', intent=dict(side='buy', type='limit', price=100,
                       stopLoss=95, takeProfit=110, quantityMode='riskPercent', quantity=1))
        result = self.service.estimate(command)
        self.assertEqual(result['quantity'], .02)
        self.assertEqual(result['risk'], 10)
        self.assertEqual(result['reward'], 20)
        self.assertEqual(result['ratio'], 2)
        self.assertEqual(result['margin'], 2)
        self.broker.order_send.assert_not_called()
        command['intent']['quantity'] = .1
        with self.assertRaisesRegex(TradingError, 'tối thiểu'): self.service.estimate(command)

    def test_estimation_is_allowed_while_algo_trading_is_off_but_not_on_a_changed_account(self):
        self.broker.terminal.trade_allowed = False
        result = self.service.estimate(dict(account=self.account, symbol='TEST', intent=dict(side='sell', type='market', quantityMode='lots', quantity=.02)))
        self.assertEqual(result['quantity'], .02)
        self.assertIsNone(result['risk'])
        self.broker.account.login = 99
        with self.assertRaisesRegex(TradingError, 'Tài khoản'): self.service.estimate(dict(account=self.account, symbol='TEST', intent=dict(side='buy', type='market', quantity=.01)))

    def test_small_tick_values_survive_broker_currency_rounding(self):
        original = self.broker.order_calc_profit
        self.broker.order_calc_profit = lambda *args: round(original(*args), 2)
        result = self.service.estimate(dict(account=self.account, symbol='TEST', intent=dict(side='buy', type='limit', price=100, quantity=.01)))
        self.assertAlmostEqual(result['tickValue'], .001)
        self.assertAlmostEqual(result['notional'], 100)

    def test_account_switch_during_preflight_never_reaches_order_send(self):
        def checked(request):
            self.broker.account.login = 99
            return NS(retcode=0, comment='Done')
        self.broker.order_check.side_effect = checked
        result = self.service.execute(self.command())
        self.assertFalse(result['ok'])
        self.broker.order_send.assert_not_called()

    def test_stop_limit_modification_preserves_trigger_limit_and_explicit_stops(self):
        self.broker.order.type = self.broker.ORDER_TYPE_BUY_STOP_LIMIT
        self.broker.order.price_open, self.broker.order.price_stoplimit = 101, 100
        request = self.service.check(self.command('modifyOrder', dict(orderId='321', previousPrice=101,
            newPrice=102, limitPrice=101, stopLoss=91, takeProfit=111)))['request']
        self.assertEqual((request['price'], request['stoplimit'], request['sl'], request['tp']), (102, 101, 91, 111))
        self.broker.order_send.assert_not_called()

    def test_idempotency_survives_restart_and_rejects_different_payload(self):
        command = self.command()
        result = self.service.execute(command)
        restarted = Mt5Trading(self.broker, self.feed, self.temp.name)
        self.assertEqual(restarted.execute(command), result)
        self.broker.order_send.assert_called_once()
        command['intent']['quantity'] = .02
        with self.assertRaises(TradingError): restarted.execute(command)

    def test_uncertain_outcome_is_not_replayed(self):
        self.broker.order_send.return_value = None
        command = self.command()
        result = self.service.execute(command)
        self.assertTrue(result['uncertain'])
        self.assertEqual(self.service.execute(command), result)
        self.broker.order_send.assert_called_once()

    def test_crash_after_send_is_not_replayed(self):
        self.broker.order_send.side_effect = RuntimeError('simulated crash')
        command = self.command()
        with self.assertRaises(RuntimeError): self.service.execute(command)
        with self.assertRaisesRegex(TradingError, 'chưa xác định'): self.service.execute(command)
        self.broker.order_send.assert_called_once()

    def test_invalid_volume_account_and_blocked_terminal_never_send(self):
        for volume in [0, .001, .015, 25, float('nan'), True]:
            c = self.command(); c['intent']['quantity'] = volume
            with self.assertRaises((ValueError, TradingError)): self.service.execute(c)
        self.broker.account.login = 99
        with self.assertRaisesRegex(TradingError, 'Tài khoản'): self.service.check(self.command())
        self.broker.account.login = 42; self.broker.terminal.trade_allowed = False
        with self.assertRaisesRegex(TradingError, 'Algo Trading'): self.service.check(self.command())
        self.broker.order_send.assert_not_called()

    def test_broker_rejection_does_not_send(self):
        self.broker.order_check.return_value = NS(retcode=10016, comment='Invalid stops')
        with self.assertRaisesRegex(TradingError, '10016'): self.service.execute(self.command())
        self.broker.order_send.assert_not_called()

    def test_pending_orders_keep_time_policy_and_stops(self):
        for side in ['buy', 'sell']:
            for kind in ['limit', 'stop']:
                price = 95 if (side == 'buy') == (kind == 'limit') else 105
                request = self.service.check(self.command(intent=dict(side=side, type=kind, quantity=.01,
                                         price=price, stopLoss=90 if side == 'buy' else 110, takeProfit=110 if side == 'buy' else 90, timeInForce='day')))['request']
                self.assertEqual(request['action'], 5)
                self.assertEqual(request['type_filling'], 2)
                self.assertEqual(request['type_time'], 1)
                self.assertEqual(request['sl'], 90 if side == 'buy' else 110)
                self.assertEqual(request['tp'], 110 if side == 'buy' else 90)

    def test_modify_cancel_sltp_and_hedged_close_ticket(self):
        request = self.service.check(self.command('modifyOrder', dict(orderId='321', newPrice=96, previousPrice=95)))['request']
        self.assertEqual((request['sl'], request['tp'], request['type_time'], request['expiration']), (90, 110, 1, 123456))
        request = self.service.check(self.command('cancel', dict(orderId='321')))['request']
        self.assertEqual((request['action'], request['order']), (8, 321))
        request = self.service.check(self.command('modifyPosition', dict(positionId='123', stopLoss=None)))['request']
        self.assertEqual((request['sl'], request['tp'], request['position']), (0, 110, 123))
        request = self.service.check(self.command('close', dict(positionId='123', quantity=.02)))['request']
        self.assertEqual((request['position'], request['type'], request['volume']), (123, 1, .02))
        self.broker.order_send.assert_not_called()

    def test_stale_wrong_symbol_and_unsupported_intents(self):
        for action, intent in [
            ('close', dict(positionId='123', quantity=.01)),
            ('modifyOrder', dict(orderId='321', newPrice=96, previousPrice=94)),
            ('cancel', dict(orderId='123')),
            ('modifyPosition', dict(positionId='123', trailingStop=5)),
            ('place', dict(side='buy', type='stopLimit', quantity=.01)),
            ('place', dict(side='buy', type='limit', quantity=.01, price=95.0005)),
        ]:
            with self.assertRaises(TradingError): self.service.check(self.command(action, intent))
        self.broker.order_send.assert_not_called()

    def test_http_auth_origin_host_and_preflight_boundary(self):
        from bridge import ChartHandler
        server = ThreadingHTTPServer(('127.0.0.1', 0), ChartHandler)
        server.trading = self.service
        server.feed = self.feed
        server.local_addresses = {'127.0.0.1'}
        server.assets, server.policy = {}, "default-src 'none'"
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        host = f'127.0.0.1:{server.server_port}'

        def request(path, command=None, headers=None):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
            connection.request('POST' if command else 'GET', path,
                               json.dumps(command) if command else None, headers or {})
            response = connection.getresponse(); body = response.read()
            connection.close()
            return response.status, body

        try:
            self.assertEqual(request('/api/trading/state?symbols=TEST')[0], 401)
            self.assertEqual(request('/api/trading/session', headers={'Host': 'attacker.invalid'})[0], 400)
            status, body = request('/api/trading/session')
            self.assertEqual(status, 200)
            key = json.loads(body)['key']
            headers = {'X-MT5-Key': key, 'Content-Type': 'application/json', 'Origin': f'http://{host}'}
            self.assertEqual(request('/api/trading/check', self.command(), headers)[0], 200)
            self.broker.order_send.assert_not_called()
            self.assertEqual(request('/api/trading/execute', self.command(), {**headers, 'Origin': 'https://evil.invalid'})[0], 403)
            self.assertEqual(request('/api/trading/execute', self.command(), {**headers, 'X-MT5-Key': 'wrong'})[0], 401)
            self.broker.order_send.assert_not_called()
            server.local_addresses = set()
            self.assertEqual(request('/api/trading/session')[0], 403)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
