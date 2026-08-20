#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import App from './App.js';

// `exitOnCtrlC: false` hands Ctrl+C to the app instead of tearing the
// process down on the first press. Ink's default not only exits
// immediately, it also stops forwarding Ctrl+C to `useInput` handlers
// altogether — which quietly made App's "press it twice" confirmation
// (advertised right there in the banner) unreachable.
const { waitUntilExit } = render(<App />, { exitOnCtrlC: false });

waitUntilExit().then(() => {
  process.exit(0);
});
