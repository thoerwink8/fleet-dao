import { type Locker, memoryLocker, type PolicyGitHub } from '@fleet-dao/github';
import type { PolicyHead, PolicyRepo } from '@fleet-dao/shared';
import { createCiPolicyBridge } from '../src/ci-policy-bridge.ts';
import { type Harness, IDS } from './harness.ts';

export const POLICY_ID = 12345;
export const POLICY_SHA = 'a'.repeat(40);
export function attachPolicyBridge(h: Harness, locker: Locker = memoryLocker()) {
  const state = {
    public: true,
    sha: POLICY_SHA,
    failWrite: false,
    closed: false,
    fork: false,
    numbers: [12],
  };
  const writes: { sha: string; context: string; state: string; targetUrl?: string | undefined }[] = [];
  const gh: PolicyGitHub = {
    repo: async (r) => ({ githubId: POLICY_ID, repo: `${r.owner}/${r.name}`, public: state.public }),
    pull: async (_r, number): Promise<PolicyHead> => ({
      number,
      head: state.sha,
      open: !state.closed,
      fork: state.fork,
    }),
    openPulls: async () => state.numbers,
    latest: async (_r, _identity, sha, context) => {
      const w = writes.findLast((x) => x.sha === sha && x.context === context);
      return w ? { state: w.state, target_url: w.targetUrl ?? null } : null;
    },
    write: async (_r, _identity: PolicyRepo, sha, s) => {
      if (state.failWrite) throw new Error('GitHub write unavailable');
      writes.push({ sha, ...s });
    },
  };
  const find = async (r: { owner: string; name: string }) => {
    const row = await h.store.findRepoByName(r.owner, r.name);
    return row ? { ...row, githubId: POLICY_ID } : null;
  };
  const bridge = createCiPolicyBridge({
    origin: h.config.publicUrl.origin,
    gh,
    locker,
    find,
    findByGithubId: async (id) => {
      const r = await h.store.getRepo(IDS.repo);
      return r && id === POLICY_ID ? find(r) : null;
    },
  });
  h.deps.ciPolicyBridge = bridge;
  return { bridge, gh, writes, state };
}
