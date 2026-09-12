# DeverAI Hub

DeverAI 涓汉涓婚〉銆佹彃浠朵笌鍖呭垎鍙戞灑绾姐€?
## 鍐呭

| 璺緞 | 璇存槑 |
|------|------|
| `profile-web/` | 椤圭洰寮曞椤碉紙闈欐€?HTML锛岄浂鏋勫缓锛屽彲鐩存帴鎵樼锛?|
| `plugin/` | Cordis / DSH 鎻掍欢瀹㈡埛绔?|
| `packages/model-router/` | 妯″瀷璺敱鍖?|
| `deploy.ps1` / `verify.ps1` | 閮ㄧ讲涓庢牎楠岃剼鏈?|
| `tests/` | 濂戠害 / 娓叉煋 / 瀹夸富鍐掔儫 / 璺敱鍗曟祴 |

## 寮曞椤?
`profile-web/index.html` 鏄?DeverAI 鍏ㄩ」鐩叆鍙ｅ湴鍥撅細

- 鎸夌敤閫斿垎绫伙紙AI 宸ヤ綔鍙?/ 鏁欒偛 / 娓告垙 / 宸ュ叿 / 鐮旂┒锛?- 銆屼綘鎯冲仛浠€涔堛€嶉€夊瀷鍣紝鐐归€夊嵆璺虫帹鑽愪粨搴?- 闆朵緷璧栥€佸崟鏂囦欢锛屽弻鍑诲嵆鍙湰鍦伴瑙?
```powershell
# 鏈湴棰勮
start profile-web\index.html

# 鎴栬捣闈欐€佹湇鍔?node -e "const http=require('http'),fs=require('fs'),path=require('path');http.createServer((q,s)=>{const f=path.join(__dirname,'profile-web',q.url==='/'?'index.html':q.url.slice(1));fs.readFile(f,(e,d)=>{if(e){s.writeHead(404);s.end('nf')}else{s.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});s.end(d)}})}).listen(8787,()=>console.log('http://127.0.0.1:8787'))"
```

## 娴嬭瘯

```powershell
node tests/router-unit.mjs
node tests/client-contract.mjs
node tests/host-smoke.mjs
```

## License

瑙佹牴鐩綍 `LICENSE`銆?