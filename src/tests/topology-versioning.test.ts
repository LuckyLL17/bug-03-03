import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TwinStore } from '../domain/store';
import { Incident } from '../domain/types';
import { AuditService } from '../services/audit-service';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';

const T = 1000;

function incident(store: TwinStore, id: string, detectedAt: number, assetIds = ['reactor']) {
  const inc: Incident = { id, severity: 'high', status: 'open', assetIds, detectedAt, evidence: [] };
  store.incidents.set(id, inc);
  return inc;
}

function harness() {
  const store = new TwinStore();
  const audit = new AuditService();
  const topology = new TopologyService(store, audit);
  const causes = new RootCauseService(store, topology, audit);
  return { store, audit, topology, causes };
}

const v1 = () => ({
  version: 1,
  effectiveAt: T,
  nodes: [{ id: 'reactor', name: 'R1', kind: 'reactor' as const }, { id: 'pump', name: 'P1', kind: 'pump' as const }],
  edges: [{ from: 'pump', to: 'reactor', weight: 0.5 }],
  metadata: { releasedBy: 'team-a', note: 'first' },
});

const v2 = () => ({
  version: 2,
  effectiveAt: T,
  nodes: [{ id: 'reactor', name: 'R1', kind: 'reactor' as const }, { id: 'valve', name: 'V1', kind: 'valve' as const }],
  edges: [{ from: 'valve', to: 'reactor', weight: 0.9 }],
  metadata: { releasedBy: 'team-b', note: 'second-same-effective-at' },
});

describe('相同 effectiveAt 的连续发布', () => {
  it('按服务端发布序号稳定选择最新版本，而不是依赖数组位置', () => {
    const { topology } = harness();
    topology.publish(v1());
    topology.publish(v2());

    const picked = topology.versionAt(T);
    assert.equal(picked.version, 2);
    assert.equal(picked.sequence, 2);

    // 任何 >= T 的时刻都稳定选中 v2
    assert.equal(topology.versionAt(T + 5_000).version, 2);
    // 生效时间之前没有可用拓扑
    assert.throws(() => topology.versionAt(T - 1), (e: any) => e.code === 'NO_TOPOLOGY');
  });

  it('更早 effectiveAt 的新版本不会顶替同刻最新版本（生效时间优先，序号仅在同刻裁决）', () => {
    const { topology } = harness();
    topology.publish(v1());
    topology.publish(v2());
    topology.publish({
      version: 3,
      effectiveAt: T - 500,
      nodes: [{ id: 'x', name: 'X', kind: 'sensor' }],
      edges: [{ from: 'x', to: 'reactor', weight: 1 }],
      metadata: {},
    });

    // T 时刻：v1/v2 同刻，sequence 裁决为 v2；v3 生效时间更早，不参与同刻比较
    assert.equal(topology.versionAt(T).version, 2);
    // T-500：v3 已生效，成为该时刻最新
    assert.equal(topology.versionAt(T - 500).version, 3);
    // T-501：只有 v1（effectiveAt T）？—— v1 生效于 T，此时刻尚未生效
    assert.throws(() => topology.versionAt(T - 501), (e: any) => e.code === 'NO_TOPOLOGY');
  });

  it('版本号必须连续，相同 effectiveAt 也不例外', () => {
    const { topology } = harness();
    topology.publish(v1());
    assert.throws(() => topology.publish({ ...v2(), version: 3 }), (e: any) => e.code === 'VERSION_GAP');
  });
});

describe('历史版本回看', () => {
  it('按版本号读取发布当时的完整快照（节点、边、元数据）', () => {
    const { topology } = harness();
    topology.publish(v1());
    topology.publish(v2());

    const old = topology.get(1);
    assert.deepEqual(old.edges, [{ from: 'pump', to: 'reactor', weight: 0.5 }]);
    assert.deepEqual(old.nodes.map(n => n.id), ['reactor', 'pump']);
    assert.deepEqual(old.metadata, { releasedBy: 'team-a', note: 'first' });
    assert.equal(old.sequence, 1);
    assert.equal(old.effectiveAt, T);

    const latest = topology.get(2);
    assert.deepEqual(latest.metadata, { releasedBy: 'team-b', note: 'second-same-effective-at' });

    const refs = topology.list();
    assert.deepEqual(refs.map(r => r.version), [1, 2]);
    assert.ok(!('nodes' in refs[0]));
  });
});

describe('新版本发布后旧版本不可变', () => {
  it('篡改发布返回值或后续发布都不能改变历史快照', () => {
    const { topology, store } = harness();
    const returned = topology.publish(v1());

    // 调用方修改发布接口返回的对象
    returned.edges.push({ from: 'intruder', to: 'reactor', weight: 99 });
    returned.edges[0].weight = 999;
    returned.nodes.length = 0;
    (returned.metadata as any).hacked = true;

    // 之后又发布了新版本
    topology.publish(v2());

    const old = topology.get(1);
    assert.deepEqual(old.edges, [{ from: 'pump', to: 'reactor', weight: 0.5 }]);
    assert.equal(old.nodes.length, 2);
    assert.deepEqual(old.metadata, { releasedBy: 'team-a', note: 'first' });

    // 内部存储同样被冻结，无法通过 store 直接改写
    assert.ok(Object.isFrozen(store.topology[0]));
    assert.ok(Object.isFrozen(store.topology[0].edges));
    assert.throws(() => {
      'use strict';
      (store.topology[0].metadata as any).hacked = true;
    }, TypeError);
  });
});

describe('发布与分析紧邻发生', () => {
  it('同一生效时刻连续发布后立即分析，根因绑定发布序号最新的版本', () => {
    const { store, topology, causes, audit } = harness();
    topology.publish(v1());
    topology.publish(v2()); // 发布完成后同步立即可见，分析不会读到较早拓扑
    incident(store, 'inc-1', T);

    const result = causes.analyze('inc-1');

    assert.equal(result.topology.version, 2);
    assert.equal(result.topology.sequence, 2);
    assert.deepEqual(result.candidates.map(c => c.assetId), ['valve']);
    assert.equal(result.candidates[0].weight, 0.9);
    assert.ok(result.impactChain.every(e => e.traceId.includes('trace_')));
    assert.ok(result.impactChain.some(e => e.from === 'valve' && e.to === 'reactor'));
    assert.ok(!result.impactChain.some(e => e.from === 'pump'), 'v1 的边不得出现在基于 v2 的影响链里');

    // 审计记录绑定同一个实际使用的版本
    const entries = audit.list('inc-1').filter(e => e.action === 'root-cause.analyze');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].metadata.topology, result.topology);

    // 两次发布各自有审计，且同 effectiveAt 可凭 sequence 区分
    const publishAudits = audit.list().filter(e => e.action === 'topology.publish');
    assert.deepEqual(publishAudits.map(e => (e.metadata as any).topology.sequence), [1, 2]);
    assert.deepEqual(new Set(publishAudits.map(e => (e.metadata as any).topology.effectiveAt)), new Set([T]));
  });

  it('拓扑发布晚于 incident 检测时刻时，分析使用检测时刻已生效的版本', () => {
    const { store, topology, causes } = harness();
    topology.publish(v1()); // effectiveAt T
    incident(store, 'inc-old', T);
    causes.analyze('inc-old'); // 钉在 v1

    topology.publish(v2()); // 同刻再发 v2
    topology.publish({
      version: 3,
      effectiveAt: T + 100,
      nodes: [{ id: 'x', name: 'X', kind: 'sensor' }],
      edges: [{ from: 'x', to: 'reactor', weight: 1 }],
      metadata: {},
    });

    // 老 incident 已钉住 v1；全新 incident 在 T+100 检测时解析到 v3
    assert.equal(causes.analyze('inc-old').topology.version, 1);
    incident(store, 'inc-new', T + 100);
    assert.equal(causes.analyze('inc-new').topology.version, 3);
  });
});

describe('重复查询结果一致', () => {
  it('结果、影响链、审计版本在重复查询间完全一致，期间发布新版本也不改变', () => {
    const { store, topology, causes, audit } = harness();
    topology.publish(v1());
    topology.publish(v2());
    incident(store, 'inc-1', T);

    const first = causes.analyze('inc-1');
    topology.publish({
      version: 3,
      effectiveAt: T, // 又一次同刻发布
      nodes: [{ id: 'reactor', name: 'R1', kind: 'reactor' }],
      edges: [{ from: 'sensor-a', to: 'reactor', weight: 1 }],
      metadata: { note: 'after-first-analysis' },
    });
    const second = causes.analyze('inc-1');
    const third = causes.analyze('inc-1');

    assert.deepStrictEqual(second, first);
    assert.deepStrictEqual(third, first);
    assert.equal(first.topology.version, 2, '首次分析后版本被钉住，后续发布不影响');

    // 确定性 traceId：同版本同边每次查询完全相同
    assert.deepEqual(first.impactChain.map(e => e.traceId), second.impactChain.map(e => e.traceId));

    // 只产生一次分析审计，且与结果同版本
    const analyses = audit.list('inc-1').filter(e => e.action === 'root-cause.analyze');
    assert.equal(analyses.length, 1);
    assert.equal((analyses[0].metadata as any).topology.version, 2);
  });

  it('调用方无法通过修改查询结果反向污染钉住的分析记录', () => {
    const { store, topology, causes } = harness();
    topology.publish(v1());
    topology.publish(v2());
    incident(store, 'inc-1', T);

    const result = causes.analyze('inc-1');
    (result as any).candidates.push({ assetId: 'fake' });
    result.topology.version = 999;
    result.impactChain.length = 0;

    const again = causes.analyze('inc-1');
    assert.equal(again.topology.version, 2);
    assert.equal(again.impactChain.length, 1);
    assert.deepEqual(again.candidates.map(c => c.assetId), ['valve']);
  });
});
