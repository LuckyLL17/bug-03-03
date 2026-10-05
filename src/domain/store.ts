import { Asset, DomainEvent, Incident, RootCauseAnalysis, Telemetry, TopologyVersion, WorkOrder } from './types';
export class TwinStore {
  assets = new Map<string,Asset>();
  telemetry:Telemetry[]=[];
  events:DomainEvent[]=[];
  incidents=new Map<string,Incident>();
  workOrders=new Map<string,WorkOrder>();
  /** Append-only, frozen topology snapshots ordered by publication sequence. */
  topology:TopologyVersion[]=[];
  /** First analysis per incident pins the topology version actually used. */
  analyses=new Map<string,RootCauseAnalysis>();
}
