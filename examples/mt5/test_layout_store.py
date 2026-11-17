import http.client
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.server import ThreadingHTTPServer
from threading import Thread

from layout_store import LayoutStore, LayoutConflict, LayoutError


def layout(layout_id='layout-one', name='Bố cục máy chính', zone='Asia/Ho_Chi_Minh'):
    content = dict(v=1, kind='grid', layout='1x1', active=0, sync=dict(symbol=True), cells=[
        dict(v=1, symbol='XAUUSDm', timeframe='5m', scaleMode='normal', invertScale=False,
             chart={}, settings=dict(timezone=zone))])
    return dict(id=layout_id, name=name, kind='grid', updatedAt=100, symbol='XAUUSDm', timeframe='5m', content=json.dumps(content))


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = LayoutStore(self.temp.name)

    def tearDown(self): self.temp.cleanup()

    def save(self, value=None, revision=None):
        return self.store.mutate(dict(action='save', layout=value or layout(), revision=revision))['layout']

    def test_persistence_and_catalog_survive_server_restart(self):
        saved = self.save()
        other = LayoutStore(self.temp.name)
        self.assertEqual(other.load(saved['id']), saved)
        self.assertEqual(other.catalog()['storeId'], self.store.catalog()['storeId'])
        self.assertNotIn('content', other.catalog()['layouts'][0])
        self.assertGreater(saved['updatedAt'], 100)

    def test_simultaneous_edits_accept_only_one_and_keep_history(self):
        original = self.save()
        a, b = layout(zone='UTC'), layout(zone='Asia/Tokyo')

        def save(value):
            try: return self.save(value, original['revision'])
            except LayoutConflict: return None

        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(save, [a, b]))
        self.assertEqual(sum(result is not None for result in results), 1)
        with closing(sqlite3.connect(self.store.path)) as db:
            archived = json.loads(db.execute('SELECT data FROM history').fetchone()[0])
        self.assertEqual(archived, original)

    def test_stale_delete_and_recreation_cannot_erase_new_work(self):
        first = self.save()
        second = self.save(layout(name='Tên mới'), first['revision'])
        with self.assertRaises(LayoutConflict):
            self.store.mutate(dict(action='remove', id=first['id'], revision=first['revision']))
        self.store.mutate(dict(action='remove', id=first['id'], revision=second['revision']))
        self.assertIsNone(self.store.load(first['id']))
        with self.assertRaises(LayoutConflict): self.save(layout(), second['revision'])

    def test_migration_is_idempotent_preserves_both_conflicting_browser_copies(self):
        original = self.save()
        before = self.store.catalog()['generation']
        same = self.store.mutate(dict(action='migrate', layout=layout()))
        self.assertEqual(same['id'], original['id'])
        self.assertEqual(self.store.catalog()['generation'], before)
        different = layout(zone='Europe/London')
        imported = self.store.mutate(dict(action='migrate', layout=different))
        self.assertNotEqual(imported['id'], original['id'])
        self.assertEqual(self.store.load(original['id']), original)
        self.assertEqual(self.store.mutate(dict(action='migrate', layout=different)), imported)
        self.store.mutate(dict(action='remove', id=imported['id'], revision=imported['layout']['revision']))
        self.assertIsNone(self.store.mutate(dict(action='migrate', layout=different))['layout'], 'deleted migration must not reappear')

    def test_migration_keeps_original_save_dates_and_recent_order(self):
        for layout_id, saved_at in [('new', 300), ('old', 100), ('middle', 200)]:
            self.store.mutate(dict(action='migrate', layout={**layout(layout_id=layout_id), 'updatedAt': saved_at}))
        self.assertEqual([(row['id'], row['updatedAt']) for row in self.store.catalog()['layouts']],
                         [('new', 300), ('middle', 200), ('old', 100)])

    def test_invalid_layouts_and_revisions_are_rejected(self):
        for change in [dict(name=''), dict(content='NaN'), dict(content='{}'), dict(id=''), dict(content='x' * (8 * 1024 * 1024 + 1))]:
            with self.assertRaises(LayoutError): self.save({**layout(), **change})
        saved = self.save()
        for revision in [None, True, -1, '1']:
            with self.assertRaises(LayoutError): self.save(layout(), revision)
        self.assertEqual(self.store.load(saved['id']), saved)

    def test_http_shared_storage_requires_same_origin_but_no_trading_access(self):
        from bridge import ChartHandler
        server = ThreadingHTTPServer(('127.0.0.1', 0), ChartHandler)
        server.layouts, server.assets, server.policy = self.store, {}, "default-src 'none'"
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        host = f'127.0.0.1:{server.server_port}'

        def request(command=None, headers=None, path='/api/layouts'):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
            connection.request('POST' if command else 'GET', path, json.dumps(command) if command else None, headers or {})
            response = connection.getresponse(); body = response.read(); connection.close()
            return response.status, body

        try:
            command = dict(action='save', layout=layout(), revision=None)
            headers = {'Origin': f'http://{host}', 'Content-Type': 'application/json', 'X-MT5-Layouts': '1'}
            self.assertEqual(request(command, {**headers, 'Origin': 'http://evil.invalid'})[0], 403)
            self.assertEqual(request(command, {**headers, 'X-MT5-Layouts': 'wrong'})[0], 400)
            self.assertEqual(request(headers={'Host': 'evil.invalid'})[0], 400)
            self.assertEqual(request(command, headers)[0], 200)
            self.assertEqual(request(command, headers)[0], 409)
            self.assertEqual(len(json.loads(request()[1])['layouts']), 1)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
