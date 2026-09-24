# dsh-cron

> Native scheduling for DeepSeek Harness: when the clock says so, run a saved prompt in a
> brand-new session — with a persisted task table, run history and a small REST surface.
>
> DSH 原生定时任务：到点在**全新会话**里跑保存的 prompt，带持久化任务表、运行历史与一套克制的 REST 接口。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **状态：host 侧已跑通，管理 UI 尚未实现。** 现在通过 REST 使用（见下）。

---

## 它做什么

- 到点触发：在**全新会话**里跑你保存的 prompt（不是往当前会话发提醒）。
- 三种计划：`once`（指定时间一次）、`every`（固定间隔，**最少 5 分钟**）、`daily` / `weekly`（周内 0-6）。
- 任务表落盘：状态原子写到 `~/.dsh/dsh-cron/tasks.json`，重启不丢。
- 运行历史：每个任务保留最近 **20** 条 run（时间、状态、assistant 摘要）。
- 补跑：启动 5 秒后检查一次错过的计划；ticker 每 **30 秒**轮询。
- 无人值守：执行时对该 agent 设 `approval = never`，不会卡在审批上。
- 任务级设置：每次运行的 `cwd`（默认家目录）、权限档（默认 `workspace-write`）、`enabled` 开关。

## 安装

```bash
dsh plugin --profile <profile> add github:jipika/dsh-cron
```

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: dsh-cron
      name: @jipika/dsh-cron
```

重启 host 进程后，host 日志里能看到路由挂载。`desktop` profile 被 Electron 独占，
需要手改 `package.json` + `pnpm install`，且**重启应用才生效**。

## REST 接口

前缀 `/dsh-cron`，全部走 `ctx.webServer.register({ kind: 'prefix', path: '/dsh-cron' })`：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 存活探测 |
| GET | `/state` | 全部任务 + 运行历史快照 |
| POST | `/tasks` | 新建任务 |
| GET / PATCH / DELETE | `/tasks/:id` | 读 / 改 / 删单个任务 |
| POST | `/tasks/:id/run` | 立即跑一次 |
| POST | `/tasks/:id/clear-history` | 清空该任务历史 |

安全护栏：同源校验（Origin 白名单 `127.0.0.1` / `localhost` / `::1`，并看 `sec-fetch-site`）、
请求体上限 256 KB、prompt 上限 20000 字符；HTTP 监听器与 ticker 都在 `ctx.effect` 里注册，卸载即回收。

```bash
curl -s http://127.0.0.1:<port>/dsh-cron/state | jq .
```

## 实现要点

- **刻意不用** `ctx.connection.rpc.handle()`：core 0.1.5-rc.2 上它会抛
  `cannot get property "webServer" without inject`（见 DSH 插件生态里同类插件的 boot 失败）。
  改用官方稳定的事件/服务 API：`webServer.register` + `agents.create` + `followup`。
- `inject = ['webServer','agents','sessions','workspaceRegistry','agentDefaultModel','permissionPresets','approval']`。
- 零 npm 依赖；不 import 裸包名（`link:` 安装时解析不到 profile 的 `node_modules`）。
- 权限预设 id 硬编码为 `cron`，取自 `~/.dsh/.agent-presets/cron`。
- client 半边目前只是个返回 `null` 的占位组件，**不注册任何 slot**。

## 已知限制

- 没有管理界面：目前只能通过 REST 增删改查。
- 计划粒度就到「固定间隔 / 每日 / 每周几」，没有完整 cron 表达式。
- 冷启动语义：宿主要活着，任务才会按时触发。

## License

MIT © 2026 jipika
