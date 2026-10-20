// Fixed synthetic child. Test-only IPC announces barriers; product results still use raw bounded stdout.

import { admissionAlertKey } from '@fleet-dao/db';
import { ALERT_FRAME_BYTES } from '../../src/real/admission-alert-protocol.ts';
import { LegacyFrameReader, legacyFrame } from '../../src/real/legacy-admission-protocol.ts';

const reader = new LegacyFrameReader(ALERT_FRAME_BYTES);
for await (const chunk of process.stdin) reader.push(Buffer.from(chunk));
const request = reader.finish(),
  mode = process.env.ALERT_FIXTURE_MODE;
const result = {
  version: 1,
  id: request.id,
  result: {
    kind: 'spooled',
    key: request.observation ? admissionAlertKey(request.observation.identity) : 'a'.repeat(64),
    recordHash: 'b'.repeat(64),
  },
};
if (process.connected) process.send({ ready: true });
const frame = legacyFrame(result, ALERT_FRAME_BYTES);
const done = (bytes) => {
  process.stdout.end(bytes);
  if (process.connected) process.disconnect();
};
if (mode === 'crash') throw new Error('synthetic child failure');
else if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'late') {
  setInterval(() => {}, 1000);
  setTimeout(() => process.stdout.write(frame), 15);
} else if (mode === 'success-hang') {
  process.stdout.write(frame);
  setInterval(() => {}, 1000);
} else if (mode === 'success-crash') {
  process.stdout.write(frame);
  setTimeout(() => {
    throw new Error('after allowed');
  }, 15);
} else if (mode === 'oversize') {
  process.stdout.write(Buffer.alloc(32768));
  setInterval(() => {}, 1000);
} else if (mode === 'extra') done(Buffer.concat([frame, frame]));
else if (mode === 'truncated') done(frame.subarray(0, frame.length - 1));
else if (mode === 'wrong-id')
  done(legacyFrame({ ...result, id: '22222222-2222-4222-8222-222222222222' }, 4096));
else if (mode === 'wrong-key')
  done(legacyFrame({ ...result, result: { ...result.result, key: 'c'.repeat(64) } }, 4096));
else if (mode === 'bad-result')
  done(legacyFrame({ ...result, result: { kind: 'allowed', databaseUrl: 'private' } }, 4096));
else done(frame);
