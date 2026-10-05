import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditService } from '../../services/audit-service';
import { RootCauseService } from '../../services/root-cause-service';
import { TopologyService } from '../../services/topology-service';
import { TwinStore } from '../../domain/store';
import { Incident, TopologyPublishInput } from '../../domain/types';

function setup() {
  const store = new TwinStore();
  const audit = new AuditService();
  const topology = new TopologyService(store, audit);
  const causes = new RootCauseService(store, topology, audit);
  return { store, audit, topology, causes };
}

function topo(effectiveAt:number, nodeIds:string[], edges:TopologyPublishInput['edges']):TopologyPublishInput {
  return {
    effectiveAt,
    nodes: nodeIds.map(id => ({ id, kind: 'pump' })),
    edges,
    metadata: { publishedFor: `v@${effectiveAt}:${edges.length}` },
  };
}

const incident = (detectedAt:number):Incident => ({
  id: 'inc_1', severity: 'high', status: 'open',
  assetIds: ['R1'], detectedAt, evidence: [],
});

test('consecutive publishes with identical effectiveAt: latest publication sequence wins, deterministically', () => {
  const { store, topology } = setup();

  const v1 = topology.publish(topo(100, ['P1', 'R1'], [{ from: 'P1', to: 'R1', weight: 0.4 }]));
  const v2 = topology.publish(topo(100, ['P1', 'P2', 'R1'], [
    { from: 'P1', to: 'R1', weight: 0.4 },
    { from: 'P2', to: 'R1', weight: 0.8 },
  ]));

  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(v1.effectiveAt, v2.effectiveAt);

  for (let i = 0; i < 10; i++) {
    const picked = topology.resolveAt(100);
    assert.equal(picked.version, 2, 'same-effectiveAt tie must always resolve to newest publication');
  }
  // A later business time still picks v2; an earlier time has no topology.
  assert.equal(topology.resolveAt(500).version, 2);
  assert.throws(() => topology.resolveAt(99), (e:any) => e.code === 'NO_TOPOLOGY');
});

test('historical look-back reads the full snapshot exactly as published', () => {
  const { topology } = setup();
  topology.publish(topo(100, ['P1', 'R1'], [{ from: 'P1', to: 'R1', weight: 0.4 }]));
  topology.publish(topo(200, ['P1', 'P2', 'R1'], [{ from: 'P2', to: 'R1', weight: 0.9 }]));

  const old = topology.getVersion(1);
  assert.equal(old.effectiveAt, 100);
  assert.deepEqual(old.nodes.map(n => n.id), ['P1', 'R1']);
  assert.deepEqual(old.edges, [{ from: 'P1', to: 'R1', weight: 0.4 }]);
  assert.equal(old.metadata.publishedFor, 'v@100:1');

  const atTime = topology.current(150);
  assert.equal(atTime.version, 1);
  assert.deepEqual(atTime.edges, [{ from: 'P1', to: 'R1', weight: 0.4 }]);
  assert.equal(topology.current(200).version, 2);
});

test('new publication never mutates previously released versions (nodes, edges, metadata)', () => {
  const { topology } = setup();
  const input = topo(100, ['P1', 'R1'], [{ from: 'P1', to: 'R1', weight: 0.5 }]);
  const v1 = topology.publish(input);

  // caller mutating its own request object after publish must not touch the snapshot
  input.nodes.push({ id: 'GHOST', kind: 'sensor' });
  input.edges[0].weight = 0.01;
  (input.metadata as any).publishedFor = 'tampered';

  const reread = topology.getVersion(1);
  assert.deepEqual(reread.nodes.map(n => n.id), ['P1', 'R1']);
  assert.equal(reread.edges[0].weight, 0.5);
  assert.equal(reread.metadata.publishedFor, 'v@100:1');

  // returned snapshot is frozen; in-place tampering fails in strict mode
  assert.throws(() => { (v1.edges as any).push({ from: 'X', to: 'Y', weight: 1 }); }, TypeError);

  topology.publish(topo(100, ['P9'], [{ from: 'P9', to: 'P9', weight: 1 }]));
  assert.equal(topology.getVersion(1).edges.length, 1, 'v1 untouched after same-effectiveAt republish');
});

test('publish immediately followed by analysis binds candidates, impact edges and audit to the same version', () => {
  const { store, topology, causes, audit } = setup();
  topology.publish(topo(100, ['P1', 'R1'], [{ from: 'P1', to: 'R1', weight: 0.4 }]));
  topology.publish(topo(100, ['P1', 'P2', 'R1'], [
    { from: 'P1', to: 'R1', weight: 0.4 },
    { from: 'P2', to: 'R1', weight: 0.8 },
  ]));
  store.incidents.set('inc_1', incident(100));

  const a = causes.analyze('inc_1');
  assert.equal(a.topologyVersion, 2);
  assert.equal(a.impactEdges.length, 2);
  assert.ok(a.impactEdges.every(e => e.topologyVersion === 2));
  assert.deepEqual(a.candidates.map(c => c.assetId).sort(), ['P1', 'P2']);
  assert.ok(a.candidates.every(c => c.reason.endsWith('@v2')));

  const entry = audit.list('inc_1').find(e => e.action === 'root-cause.analyze');
  assert.ok(entry, 'analysis must write an audit record');
  assert.equal(entry!.metadata.topologyVersion, 2);
  assert.deepEqual(
    [...(entry!.metadata.traceIds as string[])].sort(),
    a.impactEdges.map(e => e.traceId).sort(),
    'audit trace ids match the actual impact edges',
  );

  const publishAudit = audit.list('topology:v2')[0];
  assert.equal(publishAudit.metadata.version, 2);
});

test('repeat queries are identical and stay pinned even after a newer publish', () => {
  const { store, causes, topology } = setup();
  topology.publish(topo(100, ['P1', 'R1'], [{ from: 'P1', to: 'R1', weight: 0.4 }]));
  store.incidents.set('inc_1', incident(100));

  const first = causes.analyze('inc_1');
  assert.equal(first.topologyVersion, 1);

  topology.publish(topo(100, ['P1', 'P2', 'R1'], [{ from: 'P2', to: 'R1', weight: 0.9 }]));
  topology.publish(topo(300, ['P3', 'R1'], [{ from: 'P3', to: 'R1', weight: 0.2 }]));

  for (let i = 0; i < 5; i++) {
    const again = causes.analyze('inc_1');
    assert.deepEqual(again, first, 'repeated root-cause queries must return identical results');
  }

  // historical replay over v2 snapshot is explicitly available and distinct
  const replayV2 = causes.analyzeVersion('inc_1', 2);
  assert.equal(replayV2.topologyVersion, 2);
  assert.deepEqual(replayV2.candidates.map(c => c.assetId), ['P2']);
  // replay does not move the pin
  assert.deepEqual(causes.analyze('inc_1'), first);
});
