#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(projectRoot, '..', '..');
const guiRoot = process.env.MAI_GUI_ROOT || path.join(workspaceRoot, 'apps', 'desktop');
const rustRoot = process.env.MAI_RUST_ROOT || path.join(workspaceRoot, 'crates', 'mai-rust');
const targetTriple = readArgument('--target-triple') || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const pkgTarget = pkgTargetFor(targetTriple);
const extension = targetTriple.includes('windows') ? '.exe' : '';
const outputDir = path.join(guiRoot, 'src-tauri', 'binaries');

mkdirSync(outputDir, { recursive: true });
execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' });

packageEntry('dist/daemon.js', 'mai-daemon');
packageEntry('dist/api-main.js', 'mai-api');
packageEntry('dist/index.js', 'mai-cli');
copySandbox();

function packageEntry(entry, name) {
  const output = path.join(outputDir, `${name}-${targetTriple}${extension}`);
  execFileSync(
    path.join(projectRoot, 'node_modules', '.bin', executableName('pkg')),
    [
      entry,
      '--config',
      'pkg.config.json',
      '--targets',
      pkgTarget,
      '--no-bytecode',
      '--public',
      '--public-packages',
      '*',
      '--output',
      output,
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  );
}

function copySandbox() {
  const explicit = process.env.MAI_SANDBOX_BUILD;
  const candidates = [
    explicit,
    path.join(workspaceRoot, 'target', targetTriple, 'release', `mai-sandbox${extension}`),
    path.join(workspaceRoot, 'target', 'release', `mai-sandbox${extension}`),
    path.join(rustRoot, 'target', targetTriple, 'release', `mai-sandbox${extension}`),
    path.join(rustRoot, 'target', 'release', `mai-sandbox${extension}`),
  ].filter(Boolean);
  const source = candidates.find(existsSync);
  if (!source) {
    throw new Error(
      `mai-sandbox has not been built for ${targetTriple}. Run cargo build --release ` +
        `--bin mai-sandbox${targetTriple === hostTriple() ? '' : ` --target ${targetTriple}`} first.`,
    );
  }
  copyFileSync(source, path.join(outputDir, `mai-sandbox-${targetTriple}${extension}`));
}

function hostTriple() {
  const triples = {
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
    'darwin:x64': 'x86_64-apple-darwin',
    'darwin:arm64': 'aarch64-apple-darwin',
    'win32:x64': 'x86_64-pc-windows-msvc',
    'win32:arm64': 'aarch64-pc-windows-msvc',
  };
  const triple = triples[`${process.platform}:${process.arch}`];
  if (!triple) throw new Error(`Unsupported host platform: ${process.platform}/${process.arch}`);
  return triple;
}

function pkgTargetFor(triple) {
  const arch = triple.startsWith('aarch64') ? 'arm64' : triple.startsWith('x86_64') ? 'x64' : null;
  const platform = triple.includes('windows') ? 'win' : triple.includes('apple-darwin') ? 'macos' : 'linux';
  if (!arch || (!triple.includes('linux') && !triple.includes('windows') && !triple.includes('apple-darwin'))) {
    throw new Error(`Unsupported sidecar target triple: ${triple}`);
  }
  return `node24-${platform}-${arch}`;
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
