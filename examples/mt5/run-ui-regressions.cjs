// Each file gets its own temporary layout store and server; personal layouts
// and production ports are never touched by this compatibility runner.
const { spawn } = require('node:child_process');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const python = process.env.MT5_CHART_PYTHON || 'python';
const files = process.argv.slice(2);
(async () => {
  for (const file of files) {
    const directory = await mkdtemp(join(tmpdir(), 'tradecanvas-ui-'));
    const server = spawn(python, ['-X', 'utf8', 'bridge.py', '--host', '127.0.0.1', '--port', '0', '--layout-dir', directory],
      { cwd: __dirname, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    server.stderr.on('data', data => { errors += data; });
    try {
      const url = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Test server startup timed out')), 10000);
        server.once('error', error => { clearTimeout(timeout); reject(error); });
        server.once('exit', () => { clearTimeout(timeout); reject(new Error(errors || 'Test server exited')); });
        server.stdout.on('data', data => { const value = String(data).match(/http:\/\/127\.0\.0\.1:\d+\//); if (value) { clearTimeout(timeout); resolve(value[0]); } });
      });
      const test = spawn(process.execPath, ['--test', file], { cwd: __dirname, windowsHide: true, stdio: 'inherit',
        env: { ...process.env, TRADECANVAS_URL: url } });
      const code = await new Promise(resolve => test.once('exit', resolve));
      if (code !== 0) throw new Error(`UI regression failed: ${file}`);
    } finally { server.kill(); }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
