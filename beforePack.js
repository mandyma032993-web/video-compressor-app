const path = require('path');
const fs = require('fs');

// Called by electron-builder before packing each architecture.
// Swaps arch-specific binaries so both x64 and arm64 apps get the right files.
exports.default = async function(context) {
  const { arch } = context;
  // arch: 1=x64, 3=arm64, 6=universal (skip the combined pass)
  if (arch === 6) return;
  const archName = arch === 1 ? 'x64' : 'arm64';

  const root = path.join(__dirname);

  const copy = (src, dst) => {
    if (!fs.existsSync(src)) {
      console.warn(`beforePack: ${src} not found, skipping`);
      return;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, '755');
    console.log(`beforePack [${archName}]: ${path.basename(src)} → ${dst}`);
  };

  copy(
    path.join(root, 'arch-bins', archName, 'server'),
    path.join(root, 'dist', 'server')
  );
  copy(
    path.join(root, 'arch-bins', archName, 'ffmpeg'),
    path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg')
  );
};
