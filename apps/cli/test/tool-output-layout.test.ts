import assert from 'node:assert/strict';
import test from 'node:test';

import { columnize, layoutToolOutput, layoutToolOutputRows } from '../src/tool-output-layout.js';

const entries = [
  '8888',
  'all',
  'all-ref',
  'all-soft',
  'Android',
  'AndroidStudioProjects',
  'AweSun',
  'bin',
];
const output = ['exit status: 0', 'stdout:', ...entries, 'stderr:', ''].join('\n');

test('plain ls stdout is packed into responsive columns', () => {
  const lines = layoutToolOutput({
    toolName: 'run_command',
    args: JSON.stringify({ command: 'ls' }),
    output,
    width: 60,
  });

  assert.doesNotMatch(lines.join('\n'), /exit status|stdout:|stderr:/);
  assert.ok(lines.length < output.split('\n').length);
  assert.match(lines[0], /8888\s+all\s+all-ref/);
  assert.ok(lines.every((line) => line.length <= 60));
});

test('columnized ls rows retain individual cells for semantic coloring', () => {
  const rows = layoutToolOutputRows({
    toolName: 'run_command',
    args: JSON.stringify({ command: 'ls' }),
    output,
    width: 60,
  });
  assert.deepEqual(rows[0].cells?.slice(0, 3).map((cell) => cell.value), ['8888', 'all', 'all-ref']);
  const fullRows = rows.filter((row) => row.cells?.length === rows[0].cells?.length);
  for (let column = 0; column < (rows[0].cells?.length ?? 0) - 1; column += 1) {
    assert.equal(
      new Set(fullRows.map((row) => row.cells![column].width)).size,
      1,
      `column ${column} must reserve the same width on every row`,
    );
  }
});

test('long, piped, and multi-directory ls output keep their original layout', () => {
  for (const command of ['ls -la', 'ls | head']) {
    assert.deepEqual(
      layoutToolOutput({ toolName: 'run_command', args: JSON.stringify({ command }), output, width: 60 }),
      entries,
    );
  }

  const multipleDirectories = 'exit status: 0\nstdout:\none:\na\n\ntwo:\nb\nstderr:\n';
  assert.deepEqual(
    layoutToolOutput({
      toolName: 'run_command',
      args: JSON.stringify({ command: 'ls one two' }),
      output: multipleDirectories,
      width: 60,
    }),
    ['one:', 'a', '', 'two:', 'b'],
  );
});

test('command envelopes are compact while failures retain useful status and stderr', () => {
  assert.deepEqual(
    layoutToolOutput({
      toolName: 'run_command',
      args: JSON.stringify({ command: 'printf ok' }),
      output: 'exit status: 0\nstdout:\nok\nstderr:\n',
      width: 60,
    }),
    ['ok'],
  );

  const failed = layoutToolOutputRows({
    toolName: 'run_command',
    args: JSON.stringify({ command: 'false' }),
    output: 'exit status: 1\nstdout:\nstderr:\npermission denied\n',
    width: 60,
  });
  assert.deepEqual(failed.map((row) => row.text), ['exit 1', 'permission denied']);
  assert.ok(failed.every((row) => row.tone === 'error'));
});

test('column layout accounts for wide CJK names', () => {
  const lines = columnize(['中文目录', 'abc', '另一个目录', 'xyz'], 20);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^中文目录\s+abc$/);
});
