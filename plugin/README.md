# @deverai/hub

DeverAI Hub —— 以静态 Cordis 插件形态内嵌 DeepSeek Harness 的 DeverAI 式工作台。

## 定位

- **纯工作台**:不携带独立聊天、不接独立 LLM 通道;AI 能力即 DSH 自身会话。
- **跟随 DSH**:文件树 / 终端 / 检查点默认作用于 DSH 当前工作区,可在设置页覆盖。
- **随 DSH 启动**:以 profile `web` 的 `cordis.patch.yml` insert 双行(host + client)静态挂载,
  每次打开 DeepSeek Harness 自动加载,无需重新 define。

## 组成

| 文件 | 半边 | 职责 |
|------|------|------|
| `lib/index.js` | Host | `/hub/*` HTTP 路由:文件桥(列/读/写/建/改名/删)、终端执行、检查点、审计日志、状态总览 |
| `lib/client.js` | Client | 右侧 Dock(Summary/Terminal/Files 三标签)、侧栏开关按钮、设置页、SVG 图标与样式 |

## 数据位置

`$DSH_HOME/storages/deverai-hub/`

```
config.json          插件配置(无敏感字段)
audit.jsonl          写/删/终端动作审计(5MB 轮转,保留 3 份)
checkpoints/<id>/    文件改动前快照(.bak 内容 + meta.json)
```

## 安全边界

- 所有路径强制解析并限制在工作区内(`..` 越界一律 403)。
- 敏感文件名全深度禁读写:`api.txt`、`.env`、`config.json`、`Err.log`;`.git` 目录禁写禁删。
- 危险命令四端同源协议的 Windows 移植版:`rm -rf`、`rd /s`、`Remove-Item -Recurse -Force`
  (顺序无关)、`taskkill /f`(顺序无关)、`shutdown`、`format`、`diskpart`、`dd if=`、`mkfs` 等;
  未带严格布尔 `dangerOk:true` 一律 403。
- 删除类操作默认关闭(`files.allowDelete=false`),开启后仍需前端显式确认。
- 所有写/删/终端动作先落审计再返回;写入前自动创建检查点。

## 安装(本机 profile web)

1. 复制本目录到 `~/.dsh/profiles/web/deverai-hub/`。
2. 建立 link:`~/.dsh/profiles/web/node_modules/@deverai/hub → ../../deverai-hub`
   (junction 即可,或 pnpm install)。
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加(**单行** insert;block 风格,
   勿混用 flow `[`):

```yaml
- insert:
    - id: deverai-hub
      name: '@deverai/hub'
```

   ⚠️ 不要写 host/client 双行:loader 对每一行都会执行宿主 apply,同包双行会
   `duplicate prefix route` 令启动失败。浏览器半边由包内 `dsh.client` 声明被
   web 图自动发现(bundle 地址 `/plugins/@deverai/hub/client.js`),无需第二行。
4. 重启 DSH 后自动加载;若进程已在运行且补丁热重放可用,改完补丁文件即热挂载。
   验证:`curl http://127.0.0.1:3080/hub/info`。

## 测试矩阵

| 命令 | 覆盖 |
|------|------|
| `node tests/host-smoke.mjs` | 真实 http + fetch 全端点 |
| `node tests/host-smoke-adv.mjs` | 对抗性:穿越/注入/保留名/危险命令变体/配置毒化 |
| `node tests/host-worktree.mjs` | worktree 增删/切换/脏树保护/删除前备份(真实 git) |
| `node tests/router-unit.mjs` | 模型路由核心:策略/打分/冷却转移/持久化(15 项) |
| `node tests/client-contract.mjs` | 协议形状/禁项/emoji 静态扫描 |
| `node tests/client-render.mjs` | 组件真实执行 + 元素树遍历(mini-React) |
| `powershell -File verify.ps1` | 重启后五端点 HTTP 实测 |

操作:侧栏底部 **Hub** 或 **Ctrl+Alt+H** 开关 Dock;标签 Summary / Terminal / Files /
**Worktree**(列表、新建、切换工作区、脏树保护删除+自动备份)。

## 模型自动路由(fork 专属)

- 副本:`all_projects\dsh-harness-fork`(源码含 dsh-llm 的 __deveraiRouteHook 钩子)
- 启动:`start-deverai.cmd`(设 DEVERAI_ROUTER=1;官方启动器不受影响)
- 端点:`GET /router/state`、`POST /router/config {enabled,strategy,models}`、
  `POST /router/probe {id}`
- 策略:score(滚动胜率×延迟)/ priority / round-robin;失败进 60s 冷却,
  后续请求自动转移;GUI 显式手选的模型永不被劫持
- 数据:`~/.dsh/storages/deverai-router/{pool.json,scores.json}`
- 设计细节见 fork 内 `DEVERAI-ROUTER-DESIGN.md`

已知环境事实:profile 的 react@18 与 react-dom@19 版本错配仅影响测试侧 SSR 配对,
页面内共享同一 React 实例,插件运行不受影响。
