#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import App from './App.js';
import { enableEnhancedKeyboard } from './terminal-keyboard.js';
import { runKeyboardDiagnostic } from './key-test.js';

// `exitOnCtrlC: false` hands Ctrl+C to the app instead of tearing the
// process down on the first press. Ink's default not only exits
// immediately, it also stops forwarding Ctrl+C to `useInput` handlers
// altogether — which quietly made App's "press it twice" confirmation
// (advertised right there in the banner) unreachable.
if (process.argv.includes('--key-test')) {
  await runKeyboardDiagnostic();
} else {
  const restoreKeyboard = enableEnhancedKeyboard(process.stdout);
  process.once('exit', restoreKeyboard);

  const { waitUntilExit } = render(<App />, { exitOnCtrlC: false });

  await waitUntilExit().then(
    () => {
      restoreKeyboard();
      process.exitCode = 0;
    },
    () => {
      restoreKeyboard();
      process.exitCode = 1;
    },
  );
}
