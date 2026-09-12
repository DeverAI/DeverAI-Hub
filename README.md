# DeverAI Hub

DeverAI 个人主页、插件与包分发枢纽。

## 内容

| 路径 | 说明 |
|------|------|
| `profile-web/` | 项目引导页（静态 HTML，零构建，可直接托管） |
| `plugin/` | Cordis / DSH 插件客户端 |
| `packages/model-router/` | 模型路由包 |
| `deploy.ps1` / `verify.ps1` | 部署与校验脚本 |
| `tests/` | 契约 / 渲染 / 宿主冒烟 / 路由单测 |

## 引导页

`profile-web/index.html` 是 DeverAI 全项目入口地图：

- 按用途分类（AI 工作台 / 教育 / 游戏 / 工具 / 研究）
- 「你想做什么」选型器，点选即跳推荐仓库
- 零依赖、单文件，双击即可本地预览

```powershell
# 本地预览
start profile-web\index.html

# 或起静态服务
node -e "const http=require('http'),fs=require('fs'),path=require('path');http.createServer((q,s)=>{const f=path.join(__dirname,'profile-web',q.url==='/'?'index.html':q.url.slice(1));fs.readFile(f,(e,d)=>{if(e){s.writeHead(404);s.end('nf')}else{s.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});s.end(d)}})}).listen(8787,()=>console.log('http://127.0.0.1:8787'))"
```

## 测试

```powershell
node tests/router-unit.mjs
node tests/client-contract.mjs
node tests/host-smoke.mjs
```

## License

见根目录 `LICENSE`。
