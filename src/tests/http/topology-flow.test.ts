import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../app';
import { FastifyInstance } from 'fastify';

async function withApp(run:(app:FastifyInstance)=>Promise<void>) {
  const app = buildApp();
  try { await app.ready(); await run(app); } finally { await app.close(); }
}

test('HTTP: same-effectiveAt double publish then immediate analysis is consistent across result, edges and audit', () => withApp(async app => {
  const body = (nodes:string[], edges:any[], meta:string) => ({
    effectiveAt: 1000,
    nodes: nodes.map(id => ({ id, kind: 'pump' })),
    edges,
    metadata: { tag: meta },
  });

  const r1 = await app.inject({ method: 'POST', url: '/topology',
    payload: body(['pump-a', 'reactor'], [{ from: 'pump-a', to: 'reactor', weight: 0.3 }], 'first') });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.json().version, 1, 'server assigns publication sequence');

  const r2 = await app.inject({ method: 'POST', url: '/topology',
    payload: body(['pump-a', 'pump-b', 'reactor'], [
      { from: 'pump-a', to: 'reactor', weight: 0.3 },
      { from: 'pump-b', to: 'reactor', weight: 0.7 },
    ], 'second') });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().version, 2);

  const current = await app.inject({ url: '/topology?at=1000' });
  assert.equal(current.json().version, 2, 'newest publish wins at the shared effectiveAt');

  // telemetry + anomaly at 1000, immediately after the topology window
  for (const v of [10, 20]) {
    const t = await app.inject({ method: 'POST', url: '/telemetry', payload: {
      assetId: 'reactor', metric: 'temp', value: v, unit: 'C', observedAt: 1000, quality: 'good' } });
    assert.equal(t.statusCode, 200);
  }
  const det = await app.inject({ method: 'POST', url: '/anomalies/detect',
    payload: { assetId: 'reactor', metric: 'temp', threshold: 5 } });
  const incidentId = det.json().id;
  assert.ok(incidentId);

  const rc1 = (await app.inject({ url: `/incidents/${incidentId}/root-cause` })).json();
  assert.equal(rc1.topologyVersion, 2, 'analysis binds newest same-effectiveAt version');
  assert.ok(rc1.impactEdges.every((e:any) => e.topologyVersion === 2));
  assert.deepEqual(rc1.candidates.map((c:any)=>c.assetId).sort(), ['pump-a', 'pump-b']);

  const rc2 = (await app.inject({ url: `/incidents/${incidentId}/root-cause` })).json();
  assert.deepEqual(rc2, rc1, 'repeat HTTP queries return identical payload');

  const audits = (await app.inject({ url: `/audit?entityId=${incidentId}` })).json();
  const analyzeAudit = audits.find((a:any) => a.action === 'root-cause.analyze');
  assert.equal(analyzeAudit.metadata.topologyVersion, 2);
  assert.deepEqual(analyzeAudit.metadata.traceIds.sort(), rc1.impactEdges.map((e:any)=>e.traceId).sort());
}));

test('HTTP: historical snapshot and historical root-cause replay keep old version intact', () => withApp(async app => {
  await app.inject({ method: 'POST', url: '/topology', payload: {
    effectiveAt: 100, nodes: [{ id: 'a', kind: 'pump' }, { id: 'b', kind: 'reactor' }],
    edges: [{ from: 'a', to: 'b', weight: 0.5 }], metadata: { rel: 1 } } });
  await app.inject({ method: 'POST', url: '/topology', payload: {
    effectiveAt: 100, nodes: [{ id: 'c', kind: 'pump' }, { id: 'b', kind: 'reactor' }],
    edges: [{ from: 'c', to: 'b', weight: 0.9 }], metadata: { rel: 2 } } });

  const old = (await app.inject({ url: '/topology/1' })).json();
  assert.equal(old.version, 1);
  assert.deepEqual(old.nodes.map((n:any)=>n.id), ['a', 'b']);
  assert.equal(old.metadata.rel, 1);
  assert.equal((await app.inject({ url: '/topology/99' })).statusCode, 404);

  const det = await app.inject({ method: 'POST', url: '/telemetry', payload: {
    assetId: 'b', metric: 'x', value: 9, unit: '', observedAt: 100, quality: 'good' } });
  assert.equal(det.statusCode, 200);
  const inc = (await app.inject({ method: 'POST', url: '/anomalies/detect',
    payload: { assetId: 'b', metric: 'x', threshold: 1 } })).json();

  const live = (await app.inject({ url: `/incidents/${inc.id}/root-cause` })).json();
  assert.equal(live.topologyVersion, 2);
  assert.deepEqual(live.candidates.map((c:any)=>c.assetId), ['c']);

  const hist = (await app.inject({ url: `/incidents/${inc.id}/root-cause/history/1` })).json();
  assert.equal(hist.topologyVersion, 1);
  assert.deepEqual(hist.candidates.map((c:any)=>c.assetId), ['a']);
  assert.equal(hist.impactEdges[0].topologyVersion, 1);

  const pinned = (await app.inject({ url: `/incidents/${inc.id}/root-cause` })).json();
  assert.deepEqual(pinned, live, 'pin remains the live analysis');
}));
