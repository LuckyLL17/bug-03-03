import { DomainError } from '../core/errors';
import { TwinStore } from '../domain/store';
import { ImpactEdge, RootCauseAnalysis, TopologyRef } from '../domain/types';
import { AuditService } from './audit-service';
import { TopologyService } from './topology-service';

export class RootCauseService {
  constructor(
    private store: TwinStore,
    private topology: TopologyService,
    private audit: AuditService
  ) {}

  /**
   * 分析 incident 的根因。
   * 首次分析时按 incident.detectedAt 解析生效拓扑（同 effectiveAt 取发布序号最新者），
   * 并把“实际使用的版本”钉在分析记录上：候选根因、影响链、审计全部引用同一个 TopologyRef。
   * 此后即使有更新的拓扑发布，重复查询仍返回首次钉住的同一份结果，保证一致。
   */
  analyze(incidentId: string): RootCauseAnalysis {
    const pinned = this.store.analyses.get(incidentId);
    if (pinned) return structuredClone(pinned);

    const incident = this.store.incidents.get(incidentId);
    if (!incident) throw new DomainError('INCIDENT_NOT_FOUND', 'incident not found');

    const graph = this.store.topology.length
      ? this.topology.versionAt(incident.detectedAt)
      : undefined;
    if (!graph) throw new DomainError('NO_TOPOLOGY', 'no effective topology for incident');

    // 基于钉住版本的快照计算影响边；同一条边被多个 incident 资产命中时只保留一次
    const seenTrace = new Set<string>();
    const impactChain: ImpactEdge[] = [];
    for (const assetId of incident.assetIds) {
      for (const edge of this.topology.impactFor(graph, assetId)) {
        if (!seenTrace.has(edge.traceId)) {
          seenTrace.add(edge.traceId);
          impactChain.push(edge);
        }
      }
    }

    const anchor = incident.assetIds[0];
    const upstream = impactChain
      .filter(e => e.to === anchor)
      .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from));

    const topologyRef: TopologyRef = this.topology.toRef(graph);
    const result: RootCauseAnalysis = {
      incidentId,
      topology: topologyRef,
      confidence: Math.min(0.99, 0.55 + upstream.length * 0.1),
      candidates: upstream.map(e => ({
        assetId: e.from,
        weight: e.weight,
        reason: 'topology dependency',
      })),
      impactChain,
      analyzedAt: Date.now(),
    };
    Object.freeze(result);
    Object.freeze(result.topology);
    Object.freeze(result.candidates);
    Object.freeze(result.impactChain);

    this.store.analyses.set(incidentId, result);

    // 审计与分析结果绑定同一个实际使用的版本引用，避免审计版本与候选/影响边对不上
    this.audit.record('root-cause.analyze', incidentId, {
      topology: topologyRef,
      candidateCount: result.candidates.length,
      impactEdgeCount: result.impactChain.length,
      confidence: result.confidence,
    });

    return structuredClone(result);
  }
}
