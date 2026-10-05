import { FastifyInstance } from 'fastify';
import { DomainError } from '../core/errors';
import { TwinStore } from '../domain/store';
import { TelemetryService } from '../services/telemetry-service';
import { AnomalyService } from '../services/anomaly-service';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';
import { WorkflowService } from '../services/workflow-service';
import { AuditService } from '../services/audit-service';

export function registerRoutes(app:FastifyInstance,store:TwinStore){
  const telemetry=new TelemetryService(store);
  const anomalies=new AnomalyService(store);
  const audit=new AuditService();
  const topology=new TopologyService(store,audit);
  const causes=new RootCauseService(store,topology,audit);
  const workflows=new WorkflowService(store);

  const fail=(res:any,e:any,status=400)=>
    res.code(e instanceof DomainError ? status : 400).send({code:e.code ?? 'ERROR',message:e.message});

  app.get('/health',async()=>({ok:true}));

  app.post('/topology',async(req,res)=>{
    try { return topology.publish(req.body as any); }
    catch(e:any){ return fail(res,e,400); }
  });
  app.get('/topology',async(req,res)=>{
    const q=req.query as any;
    try { return q.at!==undefined ? topology.current(Number(q.at)) : topology.list(); }
    catch(e:any){ return fail(res,e,409); }
  });
  app.get('/topology/:version',async(req,res)=>{
    try { return topology.getVersion(Number((req.params as any).version)); }
    catch(e:any){ return res.code(404).send({code:e.code,message:e.message}); }
  });

  app.post('/telemetry',async(req)=>{
    const e=telemetry.ingest(req.body as any);
    audit.record('telemetry.ingest',e.id,{assetId:e.assetId});
    return e;
  });
  app.get('/telemetry/replay',async(req)=>{
    const q=req.query as any;
    return telemetry.replay(Number(q.from),Number(q.to));
  });
  app.post('/anomalies/detect',async(req)=>{
    const b=req.body as any;
    return anomalies.detect(b.assetId,b.metric,Number(b.threshold));
  });

  app.get('/incidents/:id/root-cause',async(req,res)=>{
    try { return causes.analyze((req.params as any).id); }
    catch(e:any){ return res.code(404).send({code:e.code ?? 'NOT_FOUND',message:e.message}); }
  });
  app.get('/incidents/:id/root-cause/history/:version',async(req,res)=>{
    const p=req.params as any;
    try { return causes.analyzeVersion(p.id,Number(p.version)); }
    catch(e:any){ return res.code(404).send({code:e.code ?? 'NOT_FOUND',message:e.message}); }
  });

  app.post('/work-orders',async(req,res)=>{
    try { return workflows.create((req.body as any).incidentId,(req.body as any).steps||[]); }
    catch(e:any){ return fail(res,e,400); }
  });
  app.post('/work-orders/:id/transition',async(req,res)=>{
    try { return workflows.transition((req.params as any).id,(req.body as any).state); }
    catch(e:any){ return fail(res,e,400); }
  });
  app.get('/audit',async(req)=>audit.list((req.query as any).entityId));
}
