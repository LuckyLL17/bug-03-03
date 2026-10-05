import { DomainError } from '../core/errors';
import { deepFreeze } from '../core/freeze';
import { stableId } from '../core/id';
import { TwinStore } from '../domain/store';
import { ImpactEdge, TopologyEdge, TopologyPublishInput, TopologyVersion } from '../domain/types';
import { AuditService } from './audit-service';

export class TopologyService {
  constructor(private store:TwinStore, private audit?:AuditService){}

  /**
   * Publish a topology snapshot. The publication sequence (`version`) is
   * assigned here — never by the caller — so consecutive publishes sharing the
   * same effectiveAt receive distinct, ordered versions. A deep, frozen copy
   * is stored, and the same frozen content is returned; later publications
   * cannot alter a previously released version.
   */
  publish(input:TopologyPublishInput):TopologyVersion {
    if (!input || typeof input.effectiveAt !== 'number' || !Number.isFinite(input.effectiveAt)) {
      throw new DomainError('INVALID_TOPOLOGY', 'effectiveAt must be a finite number');
    }
    const nodes = input.nodes ?? [];
    const edges = input.edges ?? [];
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      throw new DomainError('INVALID_TOPOLOGY', 'nodes and edges must be arrays');
    }
    const known = new Set(nodes.map(n => n.id));
    for (const e of edges) {
      if (typeof e.from !== 'string' || typeof e.to !== 'string' || typeof e.weight !== 'number') {
        throw new DomainError('INVALID_TOPOLOGY', 'edge needs string from/to and numeric weight');
      }
      if (known.size && (!known.has(e.from) || !known.has(e.to))) {
        throw new DomainError('INVALID_TOPOLOGY', `edge ${e.from}->${e.to} references unknown node`);
      }
    }

    const snapshot:TopologyVersion = deepFreeze({
      version: this.store.topology.length + 1,
      effectiveAt: input.effectiveAt,
      publishedAt: Date.now(),
      nodes: structuredClone(nodes),
      edges: structuredClone(edges),
      metadata: deepFreeze(structuredClone(input.metadata ?? {})),
    });
    this.store.topology.push(snapshot);
    this.audit?.record('topology.publish', `topology:v${snapshot.version}`, {
      version: snapshot.version,
      effectiveAt: snapshot.effectiveAt,
      publishedAt: snapshot.publishedAt,
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
    });
    return snapshot;
  }

  /**
   * Resolve the snapshot effective at `at`. Tie-break for identical
   * effectiveAt is the publication sequence: the latest publish wins.
   * Scanning in reverse publication order makes that selection stable
   * regardless of array quirks.
   */
  resolveAt(at:number):TopologyVersion {
    // Reverse publication order: for identical effectiveAt, the later publish
    // (higher authoritative sequence) is encountered first and deterministically wins.
    for (let i = this.store.topology.length - 1; i >= 0; i--) {
      if (this.store.topology[i].effectiveAt <= at) return this.store.topology[i];
    }
    throw new DomainError('NO_TOPOLOGY', `no effective topology at ${at}`);
  }

  /** Public read at a business time; returns a detached copy of the snapshot. */
  current(at:number):TopologyVersion {
    return structuredClone(this.resolveAt(at));
  }

  /** Historical look-back: read exactly the snapshot that was published under a version. */
  getVersion(version:number):TopologyVersion {
    const v = this.store.topology.find(t => t.version === version);
    if (!v) throw new DomainError('VERSION_NOT_FOUND', `topology version ${version} not found`);
    return structuredClone(v);
  }

  list():TopologyVersion[] {
    return this.store.topology.map(v => structuredClone(v));
  }

  /**
   * Impact edges derived from a specific resolved snapshot. Each edge carries
   * the topology version it came from. traceId is deterministic in
   * (incident, edge) so repeat analyses over the same snapshot are identical.
   */
  impact(assetId:string, atOrVersion:number|TopologyVersion, incidentId?:string):ImpactEdge[] {
    const t:TopologyVersion = typeof atOrVersion === 'number' ? this.resolveAt(atOrVersion) : atOrVersion;
    const seen = new Set<string>();
    const picked:TopologyEdge[] = [];
    for (const e of t.edges) {
      if ((e.from === assetId || e.to === assetId) && !seen.has(`${e.from}->${e.to}`)) {
        seen.add(`${e.from}->${e.to}`);
        picked.push(e);
      }
    }
    return picked
      .sort((a,b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      .map(e => ({ ...e, traceId: this.traceId(incidentId, t.version, e), topologyVersion: t.version }));
  }

  private traceId(incidentId:string|undefined, version:number, e:TopologyEdge):string {
    const scope = incidentId ?? 'adhoc';
    return stableId('trace', scope, version, e.from, e.to);
  }
}
