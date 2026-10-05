# 工业过程数字孪生与异常根因推理服务

纯后端 Node.js + TypeScript + Fastify 项目，使用内存状态运行，不依赖 Docker、数据库或消息队列。

## 运行

```bash
npm install
npm test
npm start
```

## 业务闭环

设备拓扑版本 → 遥测接入 → 时间序列重放 → 阈值异常检测 → 拓扑影响分析 → 根因候选 → 工单状态机 → 审计追踪。

关键不变量：拓扑版本连续且按生效时间选择，同一生效时刻的连续发布以服务端单调发布序号（sequence）决出最新版本；拓扑快照（节点、边、元数据）在发布瞬间深拷贝冻结，历史回看按版本号读取发布当时的完整快照，新版本发布不可改变旧版本；根因分析首次执行时将实际使用的版本（version/sequence/effectiveAt/publishedAt）钉入分析记录，候选根因、影响链与审计共享同一个版本引用，重复查询返回完全一致的结果；遥测事件按业务时间和序列号重放；工单只能沿合法状态机迁移；所有重要操作产生审计记录。

### 拓扑相关接口

- `POST /topology` 发布版本（body 含 `version`、`effectiveAt`、`nodes`、`edges`、`metadata`；`sequence`/`publishedAt` 由服务端分配）
- `GET /topology?at=<业务时刻>` 查询当时生效版本（同 `effectiveAt` 稳定取发布序号最新者）
- `GET /topology/:version` 按版本号回看发布当时的完整快照
- `GET /topology/versions` 版本目录（仅版本元数据）
- `GET /incidents/:id/root-cause` 根因分析，结果含 `topology` 版本引用、`candidates`、确定性 `impactChain`
