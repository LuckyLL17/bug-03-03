import { TwinStore } from '../domain/store';
import { ImpactEdge, RootCauseAnalysis, RootCauseCandidate, TopologyVersion } from '../domain/types';
import { AuditService } from './audit-service';
import { TopologyService } from './topology-service';

export class RootCauseService {
  constructor(private store:TwinStore, private topology:TopologyService, private audit?:AuditService){}

  /**
   * Analyze an incident against the topology effective at its detectedAt.
   * The first analysis pins the resolved topology version: the stored result,
   * every impact edge, and the audit record all carry that same version, and
   * repeat queries return the pinned analysis even if newer topologies are
   * published later. Historical analyses can be replayed explicitly via
   * analyzeVersion() for time-travel look-back.
   */
  analyze(incidentId:string):RootCauseAnalysis {
    const pinned = this.store.analyses.get(incidentId);
    if (pinned) return structuredClone(pinned);

    const incident = this.store.incidents.get(incidentId);
    if (!incident) throw new Error('incident not found');

    const topology = this.topology.resolveAt(incident.detectedAt);
    const result = this.build(incidentId, incident.assetIds, incident.detectedAt, topology);

    this.store.analyses.set(incidentId, result);
    this.audit?.record('root-cause.analyze', incidentId, {
      topologyVersion: result.topologyVersion,
      topologyEffectiveAt: result.topologyEffectiveAt,
      candidateCount: result.candidates.length,
      edgeCount: result.impactEdges.length,
      traceIds: result.impactEdges.map(e => e.traceId),
    });
    return structuredClone(result);
  }

  /** Time-travel analysis against an explicitly pinned historical version. */
  analyzeVersion(incidentId:string, version:number):RootCauseAnalysis {
    const incident = this.store.incidents.get(incidentId);
    if (!incident) throw new Error('incident not found');
    const topology = this.topology.resolveAt(incident.detectedAt);
    const historical = this.topology.getVersion(version);
    const result = this.build(incidentId, incident.assetIds, incident.detectedAt, historical);
    this.audit?.record('root-cause.analyze-history', incidentId, {
      requestedVersion: version,
      topologyVersion: result.topologyVersion,
      pinnedAtAnalysis: topology.version,
    });
    return result;
  }

  private build(
    incidentId:string,
    assetIds:string[],
    effectiveAt:number,
    topology:TopologyVersion,
  ):RootCauseAnalysis {
    const impactEdges:ImpactEdge[] = this.dedupeEdges(
      assetIds.flatMap(id => this.topology.impact(id, topology, incidentId)),
    );
    const rootId = assetIds[0];
    const candidates:RootCauseCandidate[] = impactEdges
      .filter(e => e.to === rootId)
      .map(e => ({ assetId:e.from, weight:e.weight, reason:`topology dependency @v${topology.version}` }));
    return {
      incidentId,
      topologyVersion: topology.version,
      topologyEffectiveAt: topology.effectiveAt,
      effectiveAt,
      confidence: Math.min(.99, .55 + candidates.length * .1),
      impactEdges,
      candidates,
    };
  }

  private dedupeEdges(edges:ImpactEdge[]):ImpactEdge[] {
    const byTrace = new Map<string, ImpactEdge>();
    for (const e of edges) if (!byTrace.has(e.traceId)) byTrace.set(e.traceId, e);
    return [...byTrace.values()].sort(
      (a,b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
    );
  }
}
