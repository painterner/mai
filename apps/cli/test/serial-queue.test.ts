import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialQueue, type QueueSnapshot } from '../src/serial-queue.js';

test('processes enqueued items one at a time in FIFO order', async () => {
  const started: string[] = [];
  const finished: string[] = [];
  const releases: Array<() => void> = [];
  let concurrent = 0;
  let maxConcurrent = 0;

  const queue = new SerialQueue<string>(async (item) => {
    started.push(item);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise<void>((resolve) => releases.push(resolve));
    concurrent -= 1;
    finished.push(item);
  });

  queue.enqueue('first');
  queue.enqueue('second');
  queue.enqueue('third');
  await waitUntil(() => releases.length === 1);

  assert.deepEqual(started, ['first']);
  assert.equal(queue.waiting, 2);
  releases.shift()!();
  await waitUntil(() => releases.length === 1 && started.length === 2);
  releases.shift()!();
  await waitUntil(() => releases.length === 1 && started.length === 3);
  releases.shift()!();
  await queue.waitForIdle();

  assert.deepEqual(started, ['first', 'second', 'third']);
  assert.deepEqual(finished, ['first', 'second', 'third']);
  assert.equal(maxConcurrent, 1);
  assert.equal(queue.running, false);
});

test('continues with later items when a worker rejects', async () => {
  const processed: string[] = [];
  const errors: Array<{ message: string; item: string }> = [];
  const queue = new SerialQueue<string>(
    async (item) => {
      processed.push(item);
      if (item === 'bad') throw new Error('failed');
    },
    undefined,
    (error, item) => errors.push({ message: (error as Error).message, item }),
  );

  queue.enqueue('first');
  queue.enqueue('bad');
  queue.enqueue('last');
  await queue.waitForIdle();

  assert.deepEqual(processed, ['first', 'bad', 'last']);
  assert.deepEqual(errors, [{ message: 'failed', item: 'bad' }]);
});

test('reports the active item separately from waiting items', async () => {
  const snapshots: QueueSnapshot[] = [];
  let release!: () => void;
  const queue = new SerialQueue<string>(
    () => new Promise<void>((resolve) => (release = resolve)),
    (snapshot) => snapshots.push(snapshot),
  );

  queue.enqueue('active');
  queue.enqueue('waiting');
  await waitUntil(() => queue.running && queue.waiting === 1);

  assert.deepEqual(snapshots.at(-1), { running: true, waiting: 1 });
  release();
  await waitUntil(() => queue.waiting === 0);
  release();
  await queue.waitForIdle();
  assert.deepEqual(snapshots.at(-1), { running: false, waiting: 0 });
});

test('clears waiting items without interrupting the active worker', async () => {
  const processed: string[] = [];
  let release!: () => void;
  const queue = new SerialQueue<string>(async (item) => {
    processed.push(item);
    await new Promise<void>((resolve) => (release = resolve));
  });

  queue.enqueue('active');
  queue.enqueue('discard one');
  queue.enqueue('discard two');
  await waitUntil(() => queue.running && queue.waiting === 2);
  assert.deepEqual(queue.clearWaiting(), ['discard one', 'discard two']);
  release();
  await queue.waitForIdle();

  assert.deepEqual(processed, ['active']);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}
