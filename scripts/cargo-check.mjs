#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const environment = {
  ...process.env,
  // Normal checks do not build an installer, so packaged sidecars should not
  // be required. Release workflows use the real tauri.conf.json unchanged.
  TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } }),
};

execFileSync('cargo', ['check', '-p', 'maicli', '--locked'], {
  env: environment,
  stdio: 'inherit',
});
execFileSync('cargo', ['check', '-p', 'mai-gui', '--locked'], {
  env: environment,
  stdio: 'inherit',
});
