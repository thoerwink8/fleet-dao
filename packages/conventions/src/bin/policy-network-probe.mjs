// Temporary branch-only diagnostic. No status writer, retries, or production credentials.
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { policyHead, policyRepo } from '../../../shared/src/ci-policy-bridge.ts';
import { policyReader } from '../ci-policy-bridge.ts';
import { ghApi } from '../gh-api.ts';
import { gateGitHub } from '../merge-gate.ts';

const repoSlug = 'thoerwink8/fleet-dao';
const number = 3267;
const expectedHead = '718e46def06aa8ae9f8766a3c0b76aedb43a1eb7';
const scope = new AsyncLocalStorage();
const trace = { phase: 'metadata', started: 0, events: [], sockets: [] };
const safeCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'EPROTO',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'TimeoutError',
  'AbortError',
]);
function codes(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 4) return [];
  return [
    ...(safeCodes.has(error.code) ? [error.code] : []),
    ...(safeCodes.has(error.name) ? [error.name] : []),
    ...codes(error.cause, depth + 1),
    ...(Array.isArray(error.errors) ? error.errors.slice(0, 8).flatMap((e) => codes(e, depth + 1)) : []),
  ];
}
function mark(phase, error) {
  trace.phase = phase;
  trace.events.push({ phase, elapsedMs: Math.round(performance.now() - trace.started), codes: codes(error) });
}
const socketChannel = channel('net.client.socket');
function onSocket({ socket }) {
  if (scope.getStore() !== trace) return;
  mark('dns-or-tcp');
  const lookup = (error) => mark(error ? 'dns-error' : 'tcp', error);
  const connect = () => mark(socket.encrypted ? 'tls' : 'response-headers');
  const secureConnect = () => mark('response-headers');
  socket.on('lookup', lookup);
  socket.on('connect', connect);
  socket.on('secureConnect', secureConnect);
  trace.sockets.push(() => {
    socket.off('lookup', lookup);
    socket.off('connect', connect);
    socket.off('secureConnect', secureConnect);
  });
}
let policyCalls = 0;
const policyFetch = async (url, init) => {
  if (++policyCalls !== 1) throw new Error('Probe must read policy HTTP exactly once');
  if (new Headers(init.headers).has('authorization')) throw new Error('Policy HTTP must omit authorization');
  trace.started = performance.now();
  mark('response-headers-unobserved-connection');
  socketChannel.subscribe(onSocket);
  try {
    const response = await scope.run(trace, () => fetch(url, init));
    mark('response-body');
    return response;
  } finally {
    socketChannel.unsubscribe(onSocket);
    for (const remove of trace.sockets) remove();
  }
};
try {
  const api = ghApi({ GITHUB_REPOSITORY: repoSlug, GITHUB_TOKEN: process.env.GITHUB_TOKEN });
  const repo = policyRepo(await api.get(''));
  const head = policyHead(await api.get(`/pulls/${number}`), repo);
  if (repo.repo !== repoSlug || !repo.public || !head.open || head.fork || head.head !== expectedHead)
    throw new Error('Probe current repository/head precondition changed');
  const policy = await policyReader(api, gateGitHub(api), repoSlug, policyFetch)(number, expectedHead);
  if (policyCalls !== 1) throw new Error('Probe did not exercise real policy HTTP');
  console.log(
    JSON.stringify({
      type: 'network-probe',
      number,
      head: expectedHead,
      result: 'verified',
      policy,
      elapsedMs: Math.round(performance.now() - trace.started),
      events: trace.events,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      type: 'network-probe',
      number,
      head: expectedHead,
      result: 'failed',
      phase: trace.phase,
      elapsedMs: trace.started ? Math.round(performance.now() - trace.started) : null,
      codes: [...new Set(codes(error))],
      events: trace.events,
    }),
  );
  process.exitCode = 1;
}
