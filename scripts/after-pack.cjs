'use strict';

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  require('./build-launcher.cjs')({
    projectDir: context.packager.projectDir,
    appOutDir: context.appOutDir,
    version: context.packager.appInfo.version,
  });
};
