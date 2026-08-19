#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import App from './App.js';

const { waitUntilExit } = render(<App />);

waitUntilExit().then(() => {
  process.exit(0);
});
