#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const guiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(guiRoot, '..', '..');
const nodeRoot = process.env.MAI_NODE_ROOT || path.join(workspaceRoot, 'apps', 'cli');
const rustRoot = process.env.MAI_RUST_ROOT || path.join(workspaceRoot, 'crates', 'mai-rust');
const target = readArgument('--target') || hostTriple();
const host = hostTriple();

const cargoArgs = ['build', '--release', '--locked', '--bin', 'mai-sandbox'];
if (target !== host) cargoArgs.push('--target', target);
run('cargo', cargoArgs, rustRoot);
run('npm', ['run', 'package:sidecars', '--', '--target-triple', target], nodeRoot);

const tauri = path.join(guiRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const tauriArgs = ['build'];
if (target !== host) tauriArgs.push('--target', target);
run(tauri, tauriArgs, guiRoot);

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
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

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
