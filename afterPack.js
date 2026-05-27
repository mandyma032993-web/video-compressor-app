const path = require('path');
const fs = require('fs');

// Runs after each architecture's app is fully packed.
// Injects arch-specific binaries directly into the built app bundle,
// avoiding race conditions with the shared node_modules source path.
exports.default = async function(context) {
  const { arch, appOutDir } = context;
  // arch: 1=x64, 3=arm64, 6=universal (skip)
  if (arch === 6) return;
  const archName = arch === 1 ? 'x64' : 'arm64';

  const root = __dirname;
  const resourcesDir = path.join(appOutDir, 'Video Compressor.app', 'Contents', 'Resources');

  const inject = (srcFile, dstRelative) => {
    const src = path.join(root, 'arch-bins', archName, srcFile);
    const dst = path.join(resourcesDir, dstRelative);
    if (!fs.existsSync(src)) { console.warn(`afterPack: missing ${src}`); return; }
    if (!fs.existsSync(path.dirname(dst))) { console.warn(`afterPack: dst dir missing ${path.dirname(dst)}`); return; }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, '755');
    console.log(`afterPack [${archName}]: ${srcFile} → ${dst}`);
  };

  inject('server', 'server');
  inject('ffmpeg',  'bin/ffmpeg');
};
