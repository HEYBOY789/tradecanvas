"""Shared named layouts, with atomic writes and optimistic concurrency."""

import hashlib
import json
import math
import secrets
import sqlite3
import time
from contextlib import closing
from pathlib import Path

MAX_CONTENT = 8 * 1024 * 1024
SHAPES = {'1x1': 1, '1x2': 2, '2x1': 2, '1x3': 3, '3x1': 3, '1+2': 3, '2+1': 3,
          '1/2': 3, '2/1': 3, '2x2': 4, '1x4': 4, '4x1': 4, '1+3': 4, '1/3': 4,
          '2x3': 6, '3x2': 6, '2x4': 8, '3x3': 9}


class LayoutError(ValueError):
    status = 400


class LayoutConflict(LayoutError):
    status = 409


def identifier(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 160 or any(ord(c) < 32 for c in value):
        raise LayoutError('Mã bố cục không hợp lệ.')
    return value


def clean_layout(value):
    if not isinstance(value, dict):
        raise LayoutError('Bố cục không hợp lệ.')
    result = {'id': identifier(value.get('id')), 'kind': 'grid'}
    name = value.get('name')
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        raise LayoutError('Tên bố cục phải từ 1 đến 80 ký tự.')
    result['name'] = ' '.join(name.split())
    content = value.get('content')
    if not isinstance(content, str) or len(content.encode('utf-8')) > MAX_CONTENT:
        raise LayoutError('Nội dung bố cục vượt quá 8 MB hoặc không hợp lệ.')
    try:
        layout = json.loads(content, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, RecursionError):
        raise LayoutError('Nội dung bố cục không phải JSON hợp lệ.') from None
    if not isinstance(layout, dict) or type(layout.get('v')) is not int or layout['v'] != 1 or layout.get('kind') != 'grid':
        raise LayoutError('Chỉ lưu bố cục lưới TradeCanvas phiên bản 1.')
    cells = layout.get('cells')
    if not isinstance(cells, list) or not 1 <= len(cells) <= 9 or not isinstance(layout.get('layout'), str):
        raise LayoutError('Bố cục phải có từ 1 đến 9 ô chart.')
    count = SHAPES.get(layout['layout'])
    active = layout.get('active', 0)
    if (count is None or len(cells) < count or isinstance(active, bool) or not isinstance(active, int)
            or not 0 <= active < count):
        raise LayoutError('Cách chia hoặc ô đang chọn của bố cục không hợp lệ.')
    for cell in cells:
        if not isinstance(cell, dict) or (cell.get('chart') is not None and not isinstance(cell['chart'], dict)):
            raise LayoutError('Ô chart không hợp lệ.')
        if not isinstance(cell.get('symbol'), str) or not cell['symbol'] or not isinstance(cell.get('timeframe'), str):
            raise LayoutError('Ô chart thiếu mã hoặc khung thời gian.')
    result['content'] = content
    for field in ('symbol', 'timeframe'):
        if field in value:
            if not isinstance(value[field], str) or len(value[field]) > 100:
                raise LayoutError('Thông tin mã hoặc khung thời gian không hợp lệ.')
            result[field] = value[field]
    return result


class LayoutStore:
    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / 'layouts.sqlite3'
        with self.connection() as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            db.execute('INSERT OR IGNORE INTO meta VALUES (?, ?)', ('storeId', secrets.token_hex(16)))
            db.execute('INSERT OR IGNORE INTO meta VALUES (?, ?)', ('generation', '0'))
            db.execute('CREATE TABLE IF NOT EXISTS layouts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS history (id TEXT, revision INTEGER, data TEXT NOT NULL, PRIMARY KEY(id, revision))')
            db.execute('CREATE TABLE IF NOT EXISTS migrations (digest TEXT PRIMARY KEY, id TEXT NOT NULL)')

    def connection(self):
        return closing(sqlite3.connect(self.path, timeout=10))

    def catalog(self):
        with self.connection() as db:
            db.execute('BEGIN')
            metadata = dict(db.execute('SELECT key,value FROM meta'))
            layouts = []
            for data, in db.execute('SELECT data FROM layouts ORDER BY revision DESC'):
                layout = json.loads(data)
                layouts.append({k: v for k, v in layout.items() if k != 'content'})
            layouts.sort(key=lambda layout: layout['updatedAt'], reverse=True)
            return dict(storeId=metadata['storeId'], generation=int(metadata['generation']), layouts=layouts)

    def load(self, layout_id):
        with self.connection() as db:
            return self._load(db, identifier(layout_id))

    @staticmethod
    def _load(db, layout_id):
        row = db.execute('SELECT data FROM layouts WHERE id=?', (layout_id,)).fetchone()
        return json.loads(row[0]) if row else None

    @staticmethod
    def generation(db):
        value = int(db.execute("SELECT value FROM meta WHERE key='generation'").fetchone()[0]) + 1
        db.execute("UPDATE meta SET value=? WHERE key='generation'", (str(value),))
        return value

    def _write(self, db, layout, imported_at=None):
        old = self._load(db, layout['id'])
        if old:
            db.execute('INSERT OR IGNORE INTO history VALUES (?, ?, ?)',
                       (old['id'], old['revision'], json.dumps(old, ensure_ascii=False)))
        layout = dict(layout, revision=self.generation(db),
                      updatedAt=(imported_at if imported_at is not None else
                                 max(int(time.time() * 1000), (old or {}).get('updatedAt', 0) + 1)))
        db.execute('INSERT OR REPLACE INTO layouts VALUES (?, ?, ?)',
                   (layout['id'], layout['revision'], json.dumps(layout, ensure_ascii=False)))
        return layout

    @staticmethod
    def check_revision(current, expected):
        if expected is not None and (isinstance(expected, bool) or not isinstance(expected, int) or expected < 1):
            raise LayoutError('Phiên bản bố cục không hợp lệ.')
        if (current or {}).get('revision') != expected:
            raise LayoutConflict('Bố cục đã được lưu hoặc xóa từ máy khác. Mở bản máy chính hoặc lưu thành bản mới để giữ thay đổi của bạn.')

    def mutate(self, command):
        if not isinstance(command, dict):
            raise LayoutError('Yêu cầu bố cục không hợp lệ.')
        action = command.get('action')
        if action not in ('save', 'remove', 'migrate'):
            raise LayoutError('Thao tác bố cục không hợp lệ.')
        layout = clean_layout(command.get('layout')) if action != 'remove' else None
        layout_id = layout['id'] if layout else identifier(command.get('id'))
        with self.connection() as db, db:
            db.execute('BEGIN IMMEDIATE')
            current = self._load(db, layout_id)
            if action == 'migrate':
                digest = hashlib.sha256(json.dumps(layout, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                migrated = db.execute('SELECT id FROM migrations WHERE digest=?', (digest,)).fetchone()
                if migrated:
                    return dict(id=migrated[0], layout=self._load(db, migrated[0]))
                if current and any(current.get(k) != layout.get(k) for k in ('name', 'content')):
                    layout['id'] = f'browser-{digest[:40]}'
                    layout['name'] = (layout['name'][:58] + ' (từ trình duyệt)')[:80]
                    current = self._load(db, layout['id'])
                imported_at = command['layout'].get('updatedAt')
                if (isinstance(imported_at, bool) or not isinstance(imported_at, (int, float))
                        or not math.isfinite(imported_at) or imported_at < 0):
                    imported_at = None
                elif imported_at is not None:
                    imported_at = min(int(imported_at), int(time.time() * 1000))
                result = current or self._write(db, layout, imported_at)
                db.execute('INSERT INTO migrations VALUES (?, ?)', (digest, result['id']))
                return dict(id=result['id'], layout=result)
            self.check_revision(current, command.get('revision'))
            if action == 'save':
                return dict(layout=self._write(db, layout))
            if current:
                db.execute('INSERT OR IGNORE INTO history VALUES (?, ?, ?)',
                           (current['id'], current['revision'], json.dumps(current, ensure_ascii=False)))
                db.execute('DELETE FROM layouts WHERE id=?', (layout_id,))
                self.generation(db)
            return dict(ok=True)
