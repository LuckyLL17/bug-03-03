export type AssetKind = 'pump' | 'valve' | 'sensor' | 'reactor';
export type AssetStatus = 'healthy' | 'degraded' | 'failed';
export type EventType = 'telemetry' | 'alarm' | 'command' | 'ack';
export interface Asset { id:string; name:string; kind:AssetKind; status:AssetStatus; criticality:number; tags:string[] }
export interface Telemetry { assetId:string; metric:string; value:number; unit:string; observedAt:number; quality:'good'|'suspect'|'bad' }
export interface DomainEvent { id:string; type:EventType; assetId:string; timestamp:number; sequence:number; payload:Record<string, unknown> }
export interface Incident { id:string; severity:'low'|'medium'|'high'|'critical'; status:'open'|'investigating'|'contained'|'resolved'; assetIds:string[]; detectedAt:number; evidence:string[] }

export interface TopologyNode { id:string; kind:string; metadata?:Record<string, unknown> }
export interface TopologyEdge { from:string; to:string; weight:number }
export interface ImpactEdge extends TopologyEdge { traceId:string; topologyVersion:number }

/**
 * A topology snapshot as it is stored. `version` is the authoritative,
 * server-assigned publication sequence (1-based, gapless). At any given
 * effectiveAt, the snapshot with the greatest `version` wins; older snapshots
 * are append-only, frozen, and must never change after publication.
 */
export interface TopologyVersion {
  version:number;
  effectiveAt:number;
  publishedAt:number;
  nodes:TopologyNode[];
  edges:TopologyEdge[];
  metadata:Record<string, unknown>;
}

/** What publishers actually send. They do not get to choose the version. */
export interface TopologyPublishInput {
  effectiveAt:number;
  nodes:TopologyNode[];
  edges:TopologyEdge[];
  metadata?:Record<string, unknown>;
}

export interface RootCauseCandidate { assetId:string; weight:number; reason:string }
export interface RootCauseAnalysis {
  incidentId:string;
  topologyVersion:number;
  topologyEffectiveAt:number;
  effectiveAt:number;
  confidence:number;
  impactEdges:ImpactEdge[];
  candidates:RootCauseCandidate[];
}

export interface WorkOrder { id:string; incidentId:string; state:'draft'|'approved'|'executing'|'completed'|'cancelled'; steps:string[]; compensationRequired:boolean }
