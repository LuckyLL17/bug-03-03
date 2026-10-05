import { createHash } from 'node:crypto';
import { DomainError } from '../core/errors';
import { TwinStore } from '../domain/store';
import {
  ImpactEdge,
  TopologyEdge,
  TopologyPublishInput,
  TopologyRef,
  TopologyVersion,
} from '../domain/types';
import { AuditService } from './audit-service';

/** 深冻结：新版本入库后，旧版本的节点、边、元数据绝不允许再被任何路径修改 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export class TopologyService {
  constructor(private store: TwinStore, private audit?: AuditService) {}

  /**
   * 发布拓扑。
   * - version 必须连续且不重复；effectiveAt 允许与历史版本相同（窗口内连续发布）
   * - sequence 由服务端按入库顺序单调分配，是同一生效时刻“谁是最新”的唯一裁决依据
   * - 快照在入库瞬间深拷贝并冻结，后续发布或外部操作都无法改动旧版本
   */
  publish(input: TopologyPublishInput): TopologyVersion {
    const expectedVersion = this.store.topology.length + 1;
    if (!Number.isInteger(input.version) || input.version !== expectedVersion) {
      throw new DomainError('VERSION_GAP', `topology version must be sequential, expected ${expectedVersion}`);
    }
    if (!Number.isFinite(input.effectiveAt)) {
      throw new DomainError('INVALID_EFFECTIVE_AT', 'effectiveAt must be a finite number');
    }

    const snapshot: TopologyVersion = deepFreeze({
      version: input.version,
      effectiveAt: input.effectiveAt,
      sequence: ++this.store.topologySequence,
      publishedAt: Date.now(),
      nodes: (input.nodes ?? []).map(n => ({ id: n.id, name: n.name, kind: n.kind, metadata: { ...(n.metadata ?? {}) } })),
      edges: (input.edges ?? []).map(e => ({ from: e.from, to: e.to, weight: e.weight })),
      metadata: { ...(input.metadata ?? {}) },
    });

    this.store.topology.push(snapshot);

    // 发布审计与入库快照共享同一个版本引用；同 effectiveAt 连续发布也可凭 sequence 区分
    this.audit?.record('topology.publish', `topology:${snapshot.version}`, {
      topology: this.toRef(snapshot),
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
    });

    return this.clone(snapshot);
  }

  /** 在业务时刻 at 应生效的拓扑：先按 effectiveAt，同一时刻再按发布序号 sequence 取最新 */
  versionAt(at: number): TopologyVersion {
    let picked: TopologyVersion | undefined;
    for (const candidate of this.store.topology) {
      if (candidate.effectiveAt > at) continue;
      if (
        !picked ||
        candidate.effectiveAt > picked.effectiveAt ||
        (candidate.effectiveAt === picked.effectiveAt && candidate.sequence > picked.sequence)
      ) {
        picked = candidate;
      }
    }
    if (!picked) throw new DomainError('NO_TOPOLOGY', `no effective topology at ${at}`);
    return picked;
  }

  /** 历史版本回看：按发布版本号读取发布当时的完整快照 */
  get(version: number): TopologyVersion {
    const found = this.store.topology.find(v => v.version === version);
    if (!found) throw new DomainError('VERSION_NOT_FOUND', `topology version ${version} not found`);
    return this.clone(found);
  }

  /** 版本目录（元数据），不含节点边明细 */
  list(): TopologyRef[] {
    return this.store.topology.map(v => this.toRef(v));
  }

  /** 资产在某业务时刻的影响边，基于当时生效的版本快照，traceId 对相同版本+边确定性生成 */
  impact(assetId: string, at: number): ImpactEdge[] {
    return this.impactFor(this.versionAt(at), assetId);
  }

  /** 基于指定版本快照计算影响边（根因分析与历史回看共用同一条路径） */
  impactFor(topology: TopologyVersion, assetId: string): ImpactEdge[] {
    return this.sortedEdges(topology.edges)
      .filter(e => e.from === assetId || e.to === assetId)
      .map(e => ({ ...e, traceId: this.traceId(topology, e) }));
  }

  toRef(topology: TopologyVersion): TopologyRef {
    const ref: TopologyRef = {
      version: topology.version,
      sequence: topology.sequence,
      effectiveAt: topology.effectiveAt,
      publishedAt: topology.publishedAt,
    };
    return ref;
  }

  /** 边的全序：权重优先，其次端点，保证同版本重复查询结果逐字节一致 */
  private sortedEdges(edges: readonly TopologyEdge[]): TopologyEdge[] {
    return [...edges].sort((a, b) =>
      b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
    );
  }

  /** traceId 绑定版本与边本身：同版本同边永远同 ID，新版本即便端点相同也得到不同 trace */
  private traceId(topology: TopologyVersion, edge: TopologyEdge): string {
    const digest = createHash('sha1')
      .update(`v${topology.version}:s${topology.sequence}:${edge.from}->${edge.to}:${edge.weight}`)
      .digest('hex')
      .slice(0, 12);
    return `trace_${digest}`;
  }

  /** 对外只给深拷贝：内部冻结快照永不直接外泄，调用方无法篡改历史版本 */
  private clone(v: TopologyVersion): TopologyVersion {
    return structuredClone(v);
  }
}
