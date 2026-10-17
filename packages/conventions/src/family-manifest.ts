// 母单清单是关系恢复的依据：先读齐所有认领者再规划，不能边发现子单边改，免得把别的母单的子单抢过来。
import type { Finding } from './findings.ts';
import type { GitHubFamilyReader, GitHubFamilyWriter, GitHubReader, PlanIssue } from './github-api.ts';
import { MOTHER_LABEL } from './labels.ts';
import { readManifest, withManifest } from './mother-manifest.ts';
import { parentField, withParentField } from './parent-field.ts';

interface FamilyResult {
  findings: Finding[];
  notQueried: string[];
}

interface Repair {
  child: number;
  mother: number;
  native: number | undefined;
  link: boolean;
  body: boolean;
  finding: Finding;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const copy = (i: PlanIssue): PlanIssue => ({ ...i, labels: [...i.labels] });
const sorted = (ns: Iterable<number>) => [...ns].sort((a, b) => a - b);
const motherOf = (i: PlanIssue | undefined) => i !== undefined && !i.isPr && i.labels.includes(MOTHER_LABEL);
const labelsOf = (i: PlanIssue) => [...i.labels].sort().join('\n');
const same = (a: PlanIssue, b: PlanIssue) =>
  a.body === b.body &&
  a.parent === b.parent &&
  a.state === b.state &&
  a.isPr === b.isPr &&
  labelsOf(a) === labelsOf(b);

/** 全量集合含已关闭、未排期子单；闭合母单的清单也参与认领，但只维护开放母单。 */
export async function reconcileFamily(
  gh: GitHubReader & GitHubFamilyReader,
  writer?: GitHubFamilyWriter,
): Promise<FamilyResult> {
  const findings: Finding[] = [];
  const notQueried: string[] = [];
  const result = { findings, notQueried };
  const issues = new Map<number, PlanIssue>();
  const native = new Map<number, Set<number>>();
  const manifests = new Map<number, ReturnType<typeof readManifest>>();
  const claims = new Map<number, Set<number>>();
  const missing = new Set<number>();
  let invalid = false;
  const finding = (issue: number | undefined, key: string, text: string): Finding => {
    const f = { issue, key, text };
    findings.push(f);
    return f;
  };
  const addNative = (child: number, mother: number) => {
    const owners = native.get(child) ?? new Set<number>();
    owners.add(mother);
    native.set(child, owners);
  };
  const keep = (i: PlanIssue) => {
    if (i.body === undefined) throw new Error(`接口没给 #${i.number} 的正文`);
    const old = issues.get(i.number);
    if (
      old &&
      (old.body !== i.body || (old.parent !== undefined && i.parent !== undefined && old.parent !== i.parent))
    ) {
      throw new Error(`#${i.number} 的两次读取不一致，可能有人正在改关系`);
    }
    if (!old) issues.set(i.number, copy(i));
    if (i.parent !== undefined) addNative(i.number, i.parent);
  };

  try {
    const all = await gh.allIssues();
    const seen = new Set<number>();
    for (const i of all) {
      if (seen.has(i.number)) throw new Error(`全量单子里 #${i.number} 重复，不能确认读齐了`);
      seen.add(i.number);
      if (!i.isPr) keep(i);
    }
    // 子单列表也是原生关系证据，不能只依赖某个列表回包恰好带没带 parent_issue_url。
    for (const m of [...issues.values()].filter((i) => motherOf(i) && i.state === 'open')) {
      const children = await gh.subIssues(m.number);
      if (m.subIssues !== undefined && m.subIssues !== children.length) {
        throw new Error(`#${m.number} 子单汇总是 ${m.subIssues}，列表却有 ${children.length} 张`);
      }
      const childNumbers = new Set<number>();
      for (const child of children) {
        if (child.isPr || childNumbers.has(child.number))
          throw new Error(`#${m.number} 子单列表含 PR 或重复号`);
        childNumbers.add(child.number);
        keep(child);
        addNative(child.number, m.number);
      }
    }
    for (const m of issues.values()) {
      if (!motherOf(m)) continue;
      const manifest = readManifest(m.body ?? '');
      manifests.set(m.number, manifest);
      if (manifest.kind === 'invalid') {
        invalid = true;
        finding(
          m.number,
          `manifest-invalid:${m.number}`,
          `#${m.number} 的子单 manifest 认不出：${manifest.why}；本轮不改母子关系`,
        );
      } else if (manifest.kind === 'valid') {
        for (const n of manifest.children) {
          const owners = claims.get(n) ?? new Set<number>();
          owners.add(m.number);
          claims.set(n, owners);
        }
      }
    }
    // 全量 issue 列表不含 PR：清单指向未读到的号时再区分不存在和 PR，不能当成合法子单附着。
    for (const n of claims.keys()) {
      if (issues.has(n)) continue;
      const i = await gh.issue(n);
      if (i === undefined) missing.add(n);
      else if (i.isPr) issues.set(n, copy(i));
      else keep(i);
    }
  } catch (e) {
    notQueried.push(`母子清单没核完整（${message(e)}），本轮不写`);
    return result;
  }
  if (invalid) return result;

  const desired = new Map<number, Set<number>>();
  const blocked = new Set<number>();
  const repairs: Repair[] = [];
  const ownership = new Map<number, number>();
  for (const [n, manifest] of manifests) {
    if (issues.get(n)?.state === 'open') {
      desired.set(n, new Set(manifest.kind === 'valid' ? manifest.children : []));
    }
  }
  const childNumbers = new Set([...issues.keys(), ...claims.keys()]);
  for (const n of sorted(childNumbers)) {
    const child = issues.get(n);
    const owners = sorted(claims.get(n) ?? []);
    if (owners.length > 1) {
      for (const owner of owners) blocked.add(owner);
      finding(
        child && !child.isPr ? n : owners[0],
        `manifest-conflict:${n}:${owners.join(',')}`,
        `#${n} 同时被母单 ${owners.map((v) => `#${v}`).join('、')} 的 manifest 认领：本轮不改这些母单的清单和该子单关系`,
      );
      continue;
    }
    if (missing.has(n) || child?.isPr) {
      finding(
        owners[0],
        `manifest-child-invalid:${owners[0]}:${n}`,
        `母单 #${owners[0]} 的 manifest 指向 #${n}，但它${missing.has(n) ? '在 GitHub 上不存在' : '是 PR'}：保留清单原号，不自动附着`,
      );
      continue;
    }
    if (!child) continue;
    const field = parentField(child.body ?? '');
    const natives = sorted(native.get(n) ?? []);
    const authoritative = owners[0];
    let owner = authoritative;
    if (natives.length > 1) {
      for (const v of [...owners, ...natives]) blocked.add(v);
      finding(
        n,
        `family-native-conflict:${n}`,
        `#${n} 的原生母单读取互相矛盾（${natives.map((v) => `#${v}`).join('、')}），本轮不改它的关系`,
      );
      continue;
    }
    const nativeParent = natives[0];
    if (owner === undefined) {
      if (field.kind === 'invalid') {
        finding(
          n,
          `family-parent-invalid:${n}`,
          `#${n} 的 parent 字段认不出，又没有唯一 manifest 可恢复：本轮不改它的关系`,
        );
        if (nativeParent !== undefined) blocked.add(nativeParent);
        continue;
      }
      const bodyParent = field.kind === 'parent' ? field.number : undefined;
      if (nativeParent !== undefined && bodyParent !== undefined && nativeParent !== bodyParent) {
        blocked.add(nativeParent);
        blocked.add(bodyParent);
        finding(
          n,
          `family-unclaimed-conflict:${n}`,
          `#${n} 原生母单 #${nativeParent} 与正文 parent #${bodyParent} 不同，又没有唯一 manifest 可裁定：本轮不改它的关系`,
        );
        continue;
      }
      owner = nativeParent ?? bodyParent;
    }
    if (owner === undefined) continue;
    const mother = issues.get(owner);
    if (!motherOf(mother)) {
      finding(
        n,
        `family-invalid-mother:${n}:${owner}`,
        `#${n} 的母单号 #${owner} 不是可确认的「母单」issue：本轮不自动附着`,
      );
      continue;
    }
    if (owner === n) {
      blocked.add(owner);
      finding(n, `manifest-self:${n}`, `#${n} 把自己当作子单，不能自动附着到自己下面`);
      continue;
    }
    ownership.set(n, owner);
    // 已关闭母单的历史清单只保护归属，不由开放母单的维护任务改写或重新挂接。
    if (mother?.state !== 'open') {
      if (child.state === 'open')
        finding(
          n,
          `manifest-closed-owner:${n}:${owner}`,
          `#${n} 仍开着，但 manifest 或关系归属于已关闭母单 #${owner}：本轮不把它挪给别的母单`,
        );
      continue;
    }
    desired.get(owner)?.add(n);
    const link = nativeParent !== owner;
    const body = field.kind !== 'parent' || field.number !== owner;
    if (link || body) {
      const f = finding(
        n,
        `family-parent-drift:${n}:${owner}`,
        `#${n} 与母单 #${owner} 的 manifest 关系不一致（${[...(link ? ['原生链接缺失或指错'] : []), ...(body ? ['正文 parent 缺失或指错'] : [])].join('、')}）`,
      );
      repairs.push({ child: n, mother: owner, native: nativeParent, link, body, finding: f });
    }
  }

  // GitHub 会拒绝最后一条成环边，但此前的边可能已写成：必须在第一笔写入前查完整归属图。
  const visited = new Set<number>();
  for (const start of ownership.keys()) {
    if (visited.has(start)) continue;
    const path: number[] = [];
    const positions = new Map<number, number>();
    let n: number | undefined = start;
    while (n !== undefined && !visited.has(n)) {
      const position = positions.get(n);
      if (position !== undefined) {
        const cycle = sorted(path.slice(position));
        for (const member of cycle) blocked.add(member);
        finding(
          cycle[0],
          `family-cycle:${cycle.join(',')}`,
          `母子归属形成环（${cycle.map((v) => `#${v}`).join('、')}），本轮不写这些单子的清单或关系`,
        );
        break;
      }
      positions.set(n, path.length);
      path.push(n);
      n = ownership.get(n);
    }
    for (const member of path) visited.add(member);
  }

  const manifestWrites: { number: number; body: string; finding: Finding }[] = [];
  for (const [n, children] of desired) {
    if (blocked.has(n)) continue;
    const m = issues.get(n);
    if (!m || m.body === undefined) continue;
    const old = manifests.get(n);
    if (old?.kind === 'valid' && sorted(old.children).join(',') === sorted(children).join(',')) continue;
    const body = withManifest(m.body, sorted(children));
    const f = finding(
      n,
      `manifest-drift:${n}:${sorted(children).join(',')}`,
      `母单 #${n} 的子单 manifest ${old?.kind === 'absent' ? '缺失' : '与完整子单集合不一致'}，应包含 ${
        sorted(children)
          .map((v) => `#${v}`)
          .join('、') || '空清单 []'
      }`,
    );
    manifestWrites.push({ number: n, body, finding: f });
  }
  if (!writer) return result;

  // 保存副本；每一次写之前复核正文、状态和关系，后续操作可识别我们自己刚写过的更新。
  const expected = new Map([...issues].map(([n, i]) => [n, copy(i)]));
  const fresh = async (n: number): Promise<PlanIssue> => {
    const before = expected.get(n);
    const current = await gh.issue(n);
    if (!before || !current || current.body === undefined || !same(before, current)) {
      throw new Error(`#${n} 在规划后正文、状态或 parent 发生变化，未覆盖并发修改`);
    }
    return copy(current);
  };
  const writeBody = async (n: number, body: string) => {
    const before = await fresh(n);
    await writer.updateIssueBody(n, body);
    const back = await gh.issue(n);
    if (!back || back.body !== body || !same({ ...before, body }, back))
      throw new Error(`#${n} 写正文后回读不一致`);
    expected.set(n, copy(back));
  };
  try {
    // 写前重新核对全部认领者，不能拿过期的「唯一清单」决定迁移。
    for (const n of manifests.keys()) await fresh(n);
  } catch (e) {
    notQueried.push(`母子清单写前核对失败（${message(e)}），本轮不写`);
    return result;
  }
  for (const w of manifestWrites) {
    try {
      await writeBody(w.number, w.body);
      w.finding.text += '；已自动补齐，本轮保留这条差异记录';
    } catch (e) {
      blocked.add(w.number);
      notQueried.push(`母单 #${w.number} manifest 没写成（${message(e)}）`);
    }
  }
  for (const r of repairs) {
    if (blocked.has(r.mother) || blocked.has(r.child)) continue;
    try {
      await fresh(r.mother);
      if (r.native !== undefined && r.native !== r.mother && expected.has(r.native)) await fresh(r.native);
      let child = await fresh(r.child);
      if (r.link) {
        // 只有唯一清单裁定归属才会走迁移；不传 replace_parent 的普通新增不会抢已有原生母单。
        await writer.addSubIssue(r.mother, r.child, r.native !== undefined);
        const back = await gh.issue(r.child);
        const children = await gh.subIssues(r.mother);
        if (
          !back ||
          back.body === undefined ||
          !same({ ...child, parent: back.parent }, back) ||
          (back.parent !== undefined && back.parent !== r.mother) ||
          !children.some((i) => i.number === r.child)
        )
          throw new Error(`#${r.child} 挂接后回读没有确认母单 #${r.mother}`);
        expected.set(r.child, copy(back));
        child = copy(back);
      }
      if (r.body) await writeBody(r.child, withParentField(child.body ?? '', r.mother));
      r.finding.text += '；已按唯一归属自动修复，本轮保留这条差异记录';
    } catch (e) {
      notQueried.push(`#${r.child} 的母单关系没修成（${message(e)}）`);
    }
  }
  return result;
}
