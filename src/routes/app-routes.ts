import { FastifyInstance } from 'fastify';
import { TwinStore } from '../domain/store';
import { DomainError } from '../core/errors';
import { TelemetryService } from '../services/telemetry-service';
import { AnomalyService } from '../services/anomaly-service';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';
import { WorkflowService } from '../services/workflow-service';
import { AuditService } from '../services/audit-service';

const NOT_FOUND_CODES = new Set(['INCIDENT_NOT_FOUND', 'VERSION_NOT_FOUND', 'NO_TOPOLOGY']);

export function registerRoutes(app: FastifyInstance, store: TwinStore) {
  const telemetry = new TelemetryService(store);
  const anomalies = new AnomalyService(store);
  const audit = new AuditService();
  const topology = new TopologyService(store, audit);
  const causes = new RootCauseService(store, topology, audit);
  const workflows = new WorkflowService(store);

  const sendError = (res: any, e: any) => {
    if (e instanceof DomainError) {
      return res.code(NOT_FOUND_CODES.has(e.code) ? 404 : 400).send({ code: e.code, message: e.message });
    }
    return res.code(500).send({ message: e?.message ?? 'internal error' });
  };

  app.get('/health', async () => ({ ok: true }));

  app.post('/topology', async (req, res) => {
    try {
      return topology.publish(req.body as any);
    } catch (e: any) {
      return sendError(res, e);
    }
  });

  // 版本目录：按发布序号排列的全部版本元数据
  app.get('/topology/versions', async () => topology.list());

  // 历史版本回看：按版本号读取发布当时的完整快照（节点、边、元数据）
  app.get('/topology/:version', async (req, res) => {
    try {
      return topology.get(Number((req.params as any).version));
    } catch (e: any) {
      return sendError(res, e);
    }
  });

  // 某业务时刻生效的版本：同 effectiveAt 的连续发布稳定取发布序号最新者
  app.get('/topology', async (req, res) => {
    try {
      return topology.versionAt(Number((req.query as any).at));
    } catch (e: any) {
      return sendError(res, e);
    }
  });

  app.post('/telemetry', async (req) => {
    const e = telemetry.ingest(req.body as any);
    audit.record('telemetry.ingest', e.id, { assetId: e.assetId });
    return e;
  });

  app.get('/telemetry/replay', async (req) => {
    const q = req.query as any;
    return telemetry.replay(Number(q.from), Number(q.to));
  });

  app.post('/anomalies/detect', async (req) => {
    const b = req.body as any;
    return anomalies.detect(b.assetId, b.metric, Number(b.threshold));
  });

  app.get('/incidents/:id/root-cause', async (req, res) => {
    try {
      return causes.analyze((req.params as any).id);
    } catch (e: any) {
      return sendError(res, e);
    }
  });

  app.post('/work-orders', async (req, res) => {
    try {
      return workflows.create((req.body as any).incidentId, (req.body as any).steps || []);
    } catch (e: any) {
      return sendError(res, e);
    }
  });

  app.post('/work-orders/:id/transition', async (req, res) => {
    try {
      return workflows.transition((req.params as any).id, (req.body as any).state);
    } catch (e: any) {
      return res.code(400).send({ message: e.message });
    }
  });

  app.get('/audit', async (req) => audit.list((req.query as any).entityId));
}
