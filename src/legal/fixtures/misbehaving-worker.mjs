// Test double for the Markdown worker: misbehaves according to the text it gets.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, md }) => {
  if (md === 'hang' || md.startsWith('hang\n')) for (;;); // synchronous infinite loop
  if (md === 'throw') throw new Error('boom');
  if (md === 'exit') process.exit(3); // in a worker: ends only that thread
  if (md === 'oom') {
    const hog = [];
    for (;;) hog.push(new Array(100_000).fill(Math.random()));
  }
  parentPort.postMessage({ id, ok: true, facts: [['h', 2, 'Titulo', 1]] });
});
