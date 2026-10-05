export type AssetKind = 'pump' | 'valve' | 'sensor' | 'reactor';
export type AssetStatus = 'healthy' | 'degraded' | 'failed';
export type EventType = 'telemetry' | 'alarm' | 'command' | 'ack';
export interface Asset { id:string; name:string; kind:AssetKind; status:AssetStatus; criticality:number; tags:string[] }
export interface Telemetry { assetId:string; metric:string; value:number; unit:string; observedAt:number; quality:'good'|'suspect'|'bad' }
export interface DomainEvent { id:string; type:EventType; assetId:string; timestamp:number; sequence:number; payload:Record<string, unknown> }
export interface Incident { id:string; severity:'low'|'medium'|'high'|'critical'; status:'open'|'investigating'|'contained'|'resolved'; assetIds:string[]; detectedAt:number; evidence:string[] }

export interface TopologyNode { id:string; name:string; kind:AssetKind; metadata?:Record<string, unknown> }
export interface TopologyEdge { from:string; to:string; weight:number }
export interface ImpactEdge extends TopologyEdge { traceId:string }

/**
 * 拓扑版本快照。
 * version      连续的版本号（业务编号，发布时必须 +1）
 * effectiveAt  生效时间（业务时间，允许多个版本相同）
 * sequence     服务端分配的单调发布序号：同一生效时刻的连续发布，sequence 较大者为最新
 * publishedAt  实际入库的物理时间
 * nodes/edges/metadata 发布当时的完整快照，发布后不可变
 */
export interface TopologyVersion {
  version:number;
  effectiveAt:number;
  sequence:number;
  publishedAt:number;
  nodes:TopologyNode[];
  edges:TopologyEdge[];
  metadata:Record<string, unknown>;
}

/** 发布请求：调用方只提供版本号、生效时间和快照内容；sequence/publishedAt 由服务端分配 */
export type TopologyPublishInput = Partial<Omit<TopologyVersion,'version'|'effectiveAt'>> & Pick<TopologyVersion,'version'|'effectiveAt'>;

/** 实际使用的拓扑版本引用，根因结果 / 影响链 / 审计三处共享同一个对象 */
export interface TopologyRef { version:number; sequence:number; effectiveAt:number; publishedAt:number }

export interface RootCauseCandidate { assetId:string; weight:number; reason:string }
export interface RootCauseAnalysis {
  incidentId:string;
  topology:TopologyRef;
  confidence:number;
  candidates:RootCauseCandidate[];
  impactChain:ImpactEdge[];
  analyzedAt:number;
}

export interface WorkOrder { id:string; incidentId:string; state:'draft'|'approved'|'executing'|'completed'|'cancelled'; steps:string[]; compensationRequired:boolean }
