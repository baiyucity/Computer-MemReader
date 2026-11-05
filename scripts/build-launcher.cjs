'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function csharpString(value) { return '@"' + value.replaceAll('"', '""') + '"'; }

function buildLauncher(options = {}) {
  if (process.platform !== 'win32') throw new Error('The Windows launcher must be built on Windows.');
  const projectDir = path.resolve(options.projectDir || path.join(__dirname, '..'));
  const appOutDir = path.resolve(options.appOutDir || path.join(projectDir, 'release', 'win-unpacked'));
  const version = options.version || JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version;
  const versionNumber = version.match(/^\d+\.\d+\.\d+/)?.[0];
  if (!versionNumber) throw new Error('A numeric application version is required for the launcher.');
  const windowsDir = process.env.WINDIR || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework']
    .map(architecture => path.join(windowsDir, 'Microsoft.NET', architecture, 'v4.0.30319', 'csc.exe'))
    .find(file => fs.existsSync(file));
  if (!compiler) throw new Error('Windows .NET Framework 4 compiler (csc.exe) is required to build Memreader.exe.');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memreader-launcher-'));
  const generatedSource = path.join(temporary, 'LauncherConfiguration.cs');
  const temporaryExe = path.join(temporary, 'Memreader.exe');
  const destination = path.join(projectDir, 'Memreader.exe');
  const relativeExecutable = path.relative(projectDir, path.join(appOutDir, 'Memreader.exe'));
  const source = [
    'using System.Reflection;',
    '[assembly: AssemblyTitle("Memreader")]',
    '[assembly: AssemblyDescription("Memreader 本机磁盘空间查看器")]',
    '[assembly: AssemblyProduct("Memreader")]',
    '[assembly: AssemblyVersion("' + versionNumber + '.0")]',
    '[assembly: AssemblyFileVersion("' + versionNumber + '.0")]',
    'internal static partial class MemreaderLauncher {',
    '  private const string RelativeExecutable = ' + csharpString(relativeExecutable) + ';',
    '}',
  ].join('\n');
  try {
    fs.writeFileSync(generatedSource, '\uFEFF' + source, 'utf8');
    execFileSync(compiler, [
      '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/codepage:65001',
      '/reference:System.Windows.Forms.dll', '/win32icon:' + path.join(projectDir, 'build', 'icon.ico'),
      '/out:' + temporaryExe, path.join(__dirname, 'MemreaderLauncher.cs'), generatedSource,
    ], { stdio: 'pipe', windowsHide: true });
    fs.copyFileSync(temporaryExe, destination);
    const check = spawnSync(destination, ['--check-path'], { windowsHide: true, timeout: 15000 });
    if (check.error) throw check.error;
    if (check.status !== 0) throw new Error('Memreader.exe could not resolve a complete application bundle at ' + appOutDir);
    console.log('Built Memreader.exe → ' + relativeExecutable + ' (path verified, no window opened)');
    return destination;
  } finally {
    // Only the exact files created above are removed; no recursive cleanup.
    for (const file of [generatedSource, temporaryExe]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(temporary);
  }
}

module.exports = buildLauncher;

if (require.main === module) buildLauncher();
