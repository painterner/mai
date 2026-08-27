#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const guiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(guiRoot, '..');
const nodeRoot = process.env.MAI_NODE_ROOT || path.join(workspaceRoot, 'mai-cli-node');
const rustRoot = process.env.MAI_RUST_ROOT || path.join(workspaceRoot, 'mail-cli-rust');
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
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const match = output.match(/^host:\s+(.+)$/m);
  if (!match) throw new Error('Could not determine the Rust host target triple.');
  return match[1].trim();
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
