'use strict';

const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const encoded = script => Buffer.from(script, 'utf16le').toString('base64');

function runPowerShell(script, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(script)],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: options.timeout ?? 60000, signal: options.signal }, (error, stdout, stderr) => {
        if (error) {
          if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return reject(error);
          return reject(new Error(`Windows 信息读取失败：${stderr.trim() || error.message}`));
        }
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]')); }
        catch { reject(new Error('Windows 返回的数据无法读取。')); }
      });
  });
}

async function getDrives(options = {}) {
  const data = await runPowerShell(`
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $items = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
      [pscustomobject]@{ path = ($_.DeviceID + '\\'); name = $(if ($_.VolumeName) { $_.VolumeName } else { '本地磁盘' });
        total = [double]$_.Size; free = [double]$_.FreeSpace; used = [double]($_.Size - $_.FreeSpace); fileSystem = $_.FileSystem; volumeId = [string]$_.VolumeSerialNumber }
    })
    ConvertTo-Json -InputObject $items -Compress
  `, options);
  return Array.isArray(data) ? data : [data];
}

async function getSoftware() {
  const data = await runPowerShell(`
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
      foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $base = $null; $uninstall = $null
        try {
          $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
          $uninstall = $base.OpenSubKey('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
          if ($null -eq $uninstall) { continue }
          foreach ($keyName in $uninstall.GetSubKeyNames()) {
            $key = $null
            try {
              $key = $uninstall.OpenSubKey($keyName)
              $name = [string]$key.GetValue('DisplayName', '')
              if (!$name -or $key.GetValue('SystemComponent', 0) -eq 1 -or $key.GetValue('ParentKeyName', '')) { continue }
              $items.Add([pscustomobject]@{
                registryId = "$hive/$view/$keyName"; name = $name; publisher = [string]$key.GetValue('Publisher', '');
                version = [string]$key.GetValue('DisplayVersion', ''); installLocation = [string]$key.GetValue('InstallLocation', '');
                estimatedKb = [double]$key.GetValue('EstimatedSize', 0)
              })
            } catch {} finally { if ($key) { $key.Dispose() } }
          }
        } catch {} finally { if ($uninstall) { $uninstall.Dispose() }; if ($base) { $base.Dispose() } }
      }
    }
    ConvertTo-Json -InputObject @($items.ToArray()) -Compress -Depth 3
  `);
  return normalizeSoftware(Array.isArray(data) ? data : [data]);
}

function normalizeInstallLocation(location) {
  if (typeof location !== 'string') return '';
  return location.trim().replace(/^"|"$/g, '').replace(/\//g, '\\');
}

function softwareLocationGuard(location) {
  const normalized = normalizeInstallLocation(location);
  if (!/^[a-zA-Z]:\\/.test(normalized) || normalized.includes('\0')) return { safe: false, reason: '没有独立的本地安装文件夹。' };
  const parsed = path.win32.parse(normalized);
  const resolved = path.win32.resolve(normalized).replace(/\\+$/, '');
  const root = parsed.root.replace(/\\+$/, '');
  if (resolved.toLowerCase() === root.toLowerCase()) return { safe: false, reason: '不能把整个磁盘作为软件安装目录。' };
  const fragments = resolved.slice(parsed.root.length).split('\\').filter(Boolean);
  const top = fragments[0]?.toLowerCase();
  const genericRoots = new Set(['program files', 'program files (x86)', 'programdata', 'windows', 'users', 'documents and settings', 'apps', 'programs', 'software']);
  if (fragments.length === 1 && genericRoots.has(top)) return { safe: false, reason: '这是多个软件共用的目录，无法归属给单个软件。' };
  if (/^program files( \(x86\))?$/.test(top) && fragments.length === 2 && /^(common files|microsoft|windowsapps)$/i.test(fragments[1])) return { safe: false, reason: '这是多个软件共用的目录，无法归属给单个软件。' };
  if (top === 'windows' && (fragments.length <= 2 || /^(system32|syswow64|winsxs)$/i.test(fragments[1] || ''))) return { safe: false, reason: '这是 Windows 共用的系统目录。' };
  // User profile, Local, Roaming and their common Programs roots are shared.
  if (top === 'users' && (fragments.length <= 2 || (fragments[2]?.toLowerCase() === 'appdata' && fragments.length <= 4) || (fragments[4]?.toLowerCase() === 'programs' && fragments.length <= 5))) {
    return { safe: false, reason: '这是用户共用的目录。' };
  }
  if (top === 'users' && fragments.length === 3 && /^(desktop|documents|downloads|pictures|music|videos|favorites|saved games)$/i.test(fragments[2])) return { safe: false, reason: '这是用户共用的目录。' };
  return { safe: true, path: path.win32.resolve(normalized) };
}

function normalizeSoftware(rows) {
  const deduped = new Map();
  for (const raw of rows) {
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    const location = normalizeInstallLocation(raw.installLocation);
    const identity = [raw.name.trim(), raw.publisher || '', raw.version || '', location.toLowerCase()].join('|').toLowerCase();
    const size = Math.max(0, Number(raw.estimatedKb) || 0) * 1024;
    const software = {
      id: createHash('sha256').update(identity).digest('hex').slice(0, 24), name: raw.name.trim(),
      publisher: String(raw.publisher || ''), version: String(raw.version || ''), installLocation: location,
      size, sizeSource: size > 0 ? 'estimated' : 'unknown', shared: location ? !softwareLocationGuard(location).safe : false,
    };
    const previous = deduped.get(identity);
    if (!previous || size > previous.size) deduped.set(identity, software);
  }
  const result = [...deduped.values()];
  const locations = new Map();
  for (const item of result) {
    if (!item.installLocation) continue;
    const key = item.installLocation.toLowerCase().replace(/\\+$/, '');
    const group = locations.get(key) || [];
    group.push(item); locations.set(key, group);
  }
  for (const group of locations.values()) if (group.length > 1) for (const item of group) item.shared = true;
  const orderedLocations = [...locations.keys()].sort();
  for (let i = 0; i < orderedLocations.length; i++) {
    for (let j = i + 1; j < orderedLocations.length; j++) {
      if (orderedLocations[j].startsWith(orderedLocations[i] + '\\')) for (const item of [...locations.get(orderedLocations[i]), ...locations.get(orderedLocations[j])]) item.shared = true;
    }
  }
  return result.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

// One hidden process per scan avoids thousands of process launches. Attributes
// are read without opening content, so cloud placeholders are never hydrated.
function createReparseInspector() {
  const script = `
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    while ($null -ne ($line = [Console]::ReadLine())) {
      try {
        $request = ConvertFrom-Json $line
        $attrs = [System.IO.File]::GetAttributes([string]$request.path)
        $isReparse = (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
        $skip = New-Object System.Collections.Generic.List[string]
        if (!$isReparse) {
          foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries([string]$request.path)) {
            try {
              $entryAttrs = [System.IO.File]::GetAttributes($entry)
              if (($entryAttrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $skip.Add([System.IO.Path]::GetFileName($entry)) }
            } catch { $skip.Add([System.IO.Path]::GetFileName($entry)) }
          }
        }
        [Console]::WriteLine((ConvertTo-Json -InputObject @{ isReparse=$isReparse; skipNames=@($skip.ToArray()) } -Compress -Depth 3))
      } catch {
        [Console]::WriteLine((ConvertTo-Json -InputObject @{ error=$_.Exception.Message } -Compress))
      }
    }
  `;
  const child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(script)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  let pending = null;
  let closed = false;
  const fail = error => {
    closed = true;
    if (pending) { const request = pending; pending = null; clearTimeout(request.timer); request.reject(error); }
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('文件属性读取进程已结束。')));
  child.stdin.on('error', fail);
  child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) { fail(new Error('文件属性响应过大。')); child.kill(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/^\uFEFF/, '').trim(); buffer = buffer.slice(index + 1);
      if (!line || !pending) continue;
      const request = pending; pending = null; clearTimeout(request.timer);
      try {
        const result = JSON.parse(line);
        if (result.error) request.reject(new Error(result.error));
        else request.resolve({ isReparse: !!result.isReparse, skipNames: new Set((result.skipNames || []).map(name => name.toLowerCase())) });
      } catch (error) { request.reject(error); }
    }
  });
  return {
    inspect(location, signal) {
      if (signal?.aborted) return Promise.reject(new Error('扫描已取消。'));
      if (closed) return Promise.reject(new Error('文件属性读取进程不可用。'));
      if (pending) return Promise.reject(new Error('不能同时读取多个文件夹属性。'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(new Error('文件属性读取超时。')); child.kill(); }, 30000);
        pending = { resolve, reject, timer };
        child.stdin.write(JSON.stringify({ path: location }) + '\n');
      });
    },
    close() { if (closed) return; fail(new Error('扫描已结束。')); child.stdin.end(); child.kill(); },
  };
}

module.exports = { getDrives, getSoftware, normalizeSoftware, normalizeInstallLocation, softwareLocationGuard, createReparseInspector };
