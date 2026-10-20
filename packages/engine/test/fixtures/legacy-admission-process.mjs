// Fixed synthetic child. Test-only IPC announces barriers; product results still use raw bounded stdout.
import {
  LEGACY_REQUEST_MAX_BYTES,
  LEGACY_RESULT_MAX_BYTES,
  LegacyFrameReader,
  legacyFrame,
} from '../../src/real/legacy-admission-protocol.ts';

const reader = new LegacyFrameReader(LEGACY_REQUEST_MAX_BYTES);
for await (const chunk of process.stdin) reader.push(Buffer.from(chunk));
const request = reader.finish(),
  mode = process.env.LEGACY_FIXTURE_MODE;
const result = {
  version: 1,
  id: request.id,
  result: {
    kind: 'allowed',
    status: 'admitted',
    admissionId: '11111111-1111-4111-8111-111111111111',
    postCommitWarnings: [],
  },
};
if (process.connected) process.send({ ready: true });
const frame = legacyFrame(result, LEGACY_RESULT_MAX_BYTES);
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
  process.stdout.write(Buffer.alloc(8192));
  setInterval(() => {}, 1000);
} else if (mode === 'extra') done(Buffer.concat([frame, frame]));
else if (mode === 'truncated') done(frame.subarray(0, frame.length - 1));
else if (mode === 'wrong-id')
  done(legacyFrame({ ...result, id: '22222222-2222-4222-8222-222222222222' }, 4096));
else if (mode === 'bad-result')
  done(legacyFrame({ ...result, result: { kind: 'allowed', databaseUrl: 'private' } }, 4096));
else done(frame);
