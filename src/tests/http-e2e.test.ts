import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { buildApp } from '../app';
import { FastifyInstance } from 'fastify';

const T = 5000;

const topologyPayload = (version: number, note: string, edge: { from: string; to: string; weight: number }) => ({
  version,
  effectiveAt: T,
  nodes: [
    { id: 'reactor', name: 'R1', kind: 'reactor' },
    { id: edge.from, name: edge.from.toUpperCase(), kind: edge.from === 'pump' ? 'pump' : 'valve' },
  ],
  edges: [edge],
  metadata: { note },
});

describe('HTTP 端到端：发布 → 选择 → 快照 → 根因查询', () => {
  const app: FastifyInstance = buildApp();

  it('同 effectiveAt 连续发布后立刻分析，读到最新版本；历史接口读到旧快照；重复查询一致', async () => {
    // 先造 incident：直接通过遥测+异常检测链路
    await app.inject({
      method: 'POST',
      url: '/telemetry',
      payload: { assetId: 'reactor', metric: 'temp', value: 200, unit: 'C', observedAt: T, quality: 'good' },
    });
    const detected = await app.inject({
      method: 'POST',
      url: '/anomalies/detect',
      payload: { assetId: 'reactor', metric: 'temp', threshold: 100 },
    });
    const incident = detected.json();
    assert.ok(incident.id);

    // 工艺切换窗口：两个生效时间完全相同、节点边不同的拓扑连续发布
    const p1 = await app.inject({ method: 'POST', url: '/topology', payload: topologyPayload(1, 'early', { from: 'pump', to: 'reactor', weight: 0.4 }) });
    const p2 = await app.inject({ method: 'POST', url: '/topology', payload: topologyPayload(2, 'latest', { from: 'valve', to: 'reactor', weight: 0.95 }) });
    assert.equal(p1.statusCode, 200);
    assert.equal(p2.statusCode, 200);
    assert.equal(p1.json().sequence, 1);
    assert.equal(p2.json().sequence, 2);
    assert.equal(p1.json().effectiveAt, p2.json().effectiveAt);

    // 版本选择：同刻稳定取序号最新
    const current = await app.inject({ method: 'GET', url: `/topology?at=${T}` });
    assert.equal(current.json().version, 2);

    // 历史回看：v1 仍是发布当时的完整快照
    const history = await app.inject({ method: 'GET', url: '/topology/1' });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(history.json().edges, [{ from: 'pump', to: 'reactor', weight: 0.4 }]);
    assert.deepEqual(history.json().metadata, { note: 'early' });
    assert.equal(history.json().sequence, 1);

    // 发布后立即根因分析
    const a1 = await app.inject({ method: 'GET', url: `/incidents/${incident.id}/root-cause` });
    assert.equal(a1.statusCode, 200);
    const first = a1.json();
    assert.equal(first.topology.version, 2);
    assert.equal(first.topology.sequence, 2);
    assert.equal(first.candidates[0].assetId, 'valve');
    assert.ok(first.impactChain.some((e: any) => e.from === 'valve'));

    // 再发一个同刻新版本（v3），重复查询必须与首次完全一致
    await app.inject({
      method: 'POST',
      url: '/topology',
      payload: {
        version: 3,
        effectiveAt: T,
        nodes: [{ id: 'reactor', name: 'R1', kind: 'reactor' }],
        edges: [{ from: 'sensor-z', to: 'reactor', weight: 1 }],
        metadata: { note: 'post-analysis' },
      },
    });
    const a2 = await app.inject({ method: 'GET', url: `/incidents/${incident.id}/root-cause` });
    assert.deepStrictEqual(a2.json(), first);

    // 审计：两次拓扑发布 + 一次根因分析，分析审计中的版本与结果一致
    const audit = await app.inject({ method: 'GET', url: `/audit?entityId=${incident.id}` });
    const analyzeEntries = audit.json().filter((e: any) => e.action === 'root-cause.analyze');
    assert.equal(analyzeEntries.length, 1);
    assert.deepEqual(analyzeEntries[0].metadata.topology, first.topology);

    const allAudit = await app.inject({ method: 'GET', url: '/audit' });
    const publishes = allAudit.json().filter((e: any) => e.action === 'topology.publish');
    assert.deepEqual(publishes.map((e: any) => e.metadata.topology.version), [1, 2, 3]);

    // 篡改历史接口返回的快照不可能影响后续查询
    const oldSnap = (await app.inject({ method: 'GET', url: '/topology/1' })).json();
    oldSnap.edges.push({ from: 'hack', to: 'reactor', weight: 0 });
    const oldSnapAgain = (await app.inject({ method: 'GET', url: '/topology/1' })).json();
    assert.deepEqual(oldSnapAgain.edges, [{ from: 'pump', to: 'reactor', weight: 0.4 }]);
  });

  it('错误码：跳号发布 400，未知版本 404，无生效拓扑 404', async () => {
    const gap = await app.inject({ method: 'POST', url: '/topology', payload: { version: 99, effectiveAt: 1, nodes: [], edges: [], metadata: {} } });
    assert.equal(gap.statusCode, 400);
    assert.equal(gap.json().code, 'VERSION_GAP');

    const missing = await app.inject({ method: 'GET', url: '/topology/999' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, 'VERSION_NOT_FOUND');

    const noTopo = await app.inject({ method: 'GET', url: '/topology?at=1' });
    assert.equal(noTopo.statusCode, 404);
    assert.equal(noTopo.json().code, 'NO_TOPOLOGY');
  });

  after(async () => app.close());
});
