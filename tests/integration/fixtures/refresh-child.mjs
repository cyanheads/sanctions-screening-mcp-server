/**
 * @fileoverview Disposable child behaviors for supervisor lifecycle and WAL tests.
 * @module tests/integration/fixtures/refresh-child
 */
import { writeFileSync } from 'node:fs';
import { buildScreeningService } from '../../../dist/services/screening/screening-service.js';

const mode = process.env.TEST_REFRESH_MODE;
const marker = `${process.env.SANCTIONS_MIRROR_PATH}.child`;
writeFileSync(marker, JSON.stringify({ pid: process.pid, args: process.execArgv }));
if (mode === 'exit') process.exit(7);
if (mode === 'signal') process.kill(process.pid, 'SIGKILL');
if (mode === 'logs') {
  await new Promise((resolve) =>
    process.stderr.write('refresh log line\n'.repeat(20_000), resolve),
  );
}
if (mode === 'hang') {
  process.stdin.resume();
  setInterval(() => {}, 1_000);
} else if (mode === 'hold' || mode === 'partial') {
  const service = buildScreeningService();
  const raw = await service.designations.raw();
  if (mode === 'partial') {
    /** Leave a committed stale projection before entering an uncommitted write. */
    raw.exec('DELETE FROM name');
    await service.designations.store.writeState({ status: 'in_progress' });
  }
  try {
    raw.transaction(() => {
      raw.exec('DELETE FROM name');
      writeFileSync(`${marker}.locked`, 'locked');
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        mode === 'partial' ? 20_000 : 1_500,
      );
      throw new Error('Roll back the held transaction.');
    });
  } catch (error) {
    if (error.message !== 'Roll back the held transaction.') throw error;
  }
  await service.close();
  process.stdout.write('{}', () => process.exit(0));
} else {
  process.stdout.write('{}', () => process.exit(0));
}
