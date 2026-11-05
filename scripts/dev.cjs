'use strict';

const { spawn, execFile } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1'], { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true });
let electron = null;
let ending = false;
let timer = null;
let viteReady = false;
let viteOutput = '';
vite.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  viteOutput = (viteOutput + chunk.toString()).replace(/\u001b\[[0-9;]*m/g, '').slice(-4096);
  if (/Local:\s+http:\/\/127\.0\.0\.1:5173\//.test(viteOutput)) viteReady = true;
});
const stopChild = child => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Kill only this launcher's known child tree, including Chromium/esbuild.
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { if (!child.killed) child.kill(); });
  } else child.kill();
};
const stop = code => {
  if (ending) return;
  ending = true; clearTimeout(timer);
  stopChild(electron);
  stopChild(vite);
  process.exitCode = code || 0;
};
vite.on('error', error => { console.error(error.message); stop(1); });
vite.on('exit', code => { if (!ending) stop(code || 1); });
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
const started = Date.now();
function waitForVite() {
  if (ending) return;
  if (Date.now() - started > 30000) { console.error('Vite 启动超时。'); stop(1); return; }
  if (!viteReady) { timer = setTimeout(waitForVite, 250); return; }
  const request = http.get('http://127.0.0.1:5173', response => {
    response.resume();
    if (ending) return;
    if (response.statusCode !== 200) { timer = setTimeout(waitForVite, 250); return; }
    const environment = { ...process.env, MEMREADER_DEV_URL: 'http://127.0.0.1:5173' };
    // Some host tools set this; carrying it into Electron prevents the GUI.
    delete environment.ELECTRON_RUN_AS_NODE;
    electron = spawn(require('electron'), ['.'], { cwd: root, stdio: 'inherit', windowsHide: true, env: environment });
    electron.on('error', error => { console.error(error.message); stop(1); });
    electron.on('exit', code => { if (!ending) stop(code || 0); });
  });
  request.setTimeout(1000, () => request.destroy());
  request.on('error', () => { if (!ending) timer = setTimeout(waitForVite, 250); });
}
waitForVite();
