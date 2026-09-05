import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coalesceStreamFragments,
  estimatePendingRows,
  flushStreamingForScrollback,
  liveRegionLayout,
} from '../src/terminal-layout.js';
import type { Message } from '../src/types.js';

test('live streaming output stays below the terminal height so Ink preserves scrollback', () => {
  for (const rows of [8, 12, 24, 40]) {
    const layout = liveRegionLayout(rows, 10_000);
    // Pending output + worst-case suggestions + composer/status/margin.
    assert.ok(layout.pendingRows + layout.suggestionLimit + 5 < rows);
  }
});

test('long streaming replies use a bounded tail viewport', () => {
  const pending: Message[] = [{
    id: 'stream',
    role: 'assistant',
    content: Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n'),
    streaming: true,
    timestamp: 0,
  }];
  const estimated = estimatePendingRows(pending, 80);
  const layout = liveRegionLayout(24, estimated);

  assert.ok(estimated > layout.pendingRows);
  assert.equal(layout.pendingRows, 10);
  assert.equal(layout.suggestionLimit, 8);
});

test('long streaming replies commit completed prefixes to native scrollback', () => {
  const content = `intro\n\n\`\`\`ts\n${'const value = 1;\n'.repeat(80)}\`\`\`\noutro`;
  const message: Message = {
    id: 'stream', role: 'assistant', content, streaming: true, timestamp: 0,
  };
  const flushed = flushStreamingForScrollback([message], 300);

  assert.ok(flushed.settled.length > 0);
  assert.equal(flushed.pending.length, 1);
  assert.equal(flushed.pending[0].streaming, true);
  assert.equal(flushed.pending[0].continuation, true);
  assert.equal(
    flushed.settled.map((part) => part.content).join('') + flushed.pending[0].content,
    content,
  );

  const combined = coalesceStreamFragments([...flushed.settled, {
    ...flushed.pending[0], streaming: false,
  }]);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].content, content);
  assert.equal(combined[0].continuation, undefined);
});
