import { Asset, DomainEvent, Incident, RootCauseAnalysis, Telemetry, TopologyVersion, WorkOrder } from './types';

export class TwinStore {
  assets = new Map<string, Asset>();
  telemetry: Telemetry[] = [];
  events: DomainEvent[] = [];
  incidents = new Map<string, Incident>();
  workOrders = new Map<string, WorkOrder>();
  topology: TopologyVersion[] = [];
  /** 每个 incident 实际使用的根因分析（含拓扑版本引用），首次分析后钉住，保证重复查询一致 */
  analyses = new Map<string, RootCauseAnalysis>();
  /** 已分配的最大发布序号；同 effectiveAt 的连续发布依此决出最新版本 */
  topologySequence = 0;
}
