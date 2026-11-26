# 半身像工坊 · 打包、候选验证与发布指南

记录日期：2026-11-26（2026-11-27 修正发布与撤下流程）。本指南对应 Issue #4，说明纯静态产物 `dist/` 的显式白名单构建、本地预览、双模式校验、`cf` CLI 授权后发布以及回退/撤下流程。当前仅完成首发候选打包与本地/dry-run 校验，`0.1.0` 尚未正式上线。

## 1. 架构决策与官方依据

- **托管目标**：Cloudflare Workers Static Assets（纯静态资产 Worker，无后端、无 Worker 服务端入口 `entrypoint`、不部署到 Dokploy）。
- **CLI 与单一配置**：Cloudflare 远程操作统一使用锁定的 `cf` CLI（`package.json` 中锁定 `cf@1.0.0-rc.1`），配置文件采用 `cloudflare.config.ts`；不并存 `wrangler.jsonc` / `wrangler.toml`，避免与 `cf` 产生配置冲突。
  - 官方文档核对（2026-11-26）：
    - [Develop, build, and deploy (`cf` projects)](https://developers.cloudflare.com/cf/projects/)：确认 `cf deploy ./dist` 可直接部署预构建静态目录并读取 `cloudflare.config.ts` 的 Worker 设置；`--prebuilt` 跳过构建并直接读取已有 `.cloudflare/output/v1/`；`cf deploy --dry-run` 与 `cf workers triggers deploy --dry-run` 不发远端 API 请求、不需要凭据；仅有 `wrangler.jsonc` 而无 `cloudflare.config.ts` 时，`cf` 自动配置不读取 Wrangler 配置。
    - [Programmatic configuration (`cloudflare.config.ts`)](https://developers.cloudflare.com/cf/projects/cloudflare-config/)：确认 `package.json` 需声明 `"type": "module"`；`worker.domains` 接受字符串域名，`worker.workersDev` 可关闭 `*.workers.dev`；`worker.assets.notFoundHandling` 支持 `"none"` / `"404-page"` / `"single-page-application"`；`worker.assets.htmlHandling` 默认 `"auto-trailing-slash"`。
    - [Workers Static Assets Headers](https://developers.cloudflare.com/workers/static-assets/headers/)：确认默认响应头含 `Content-Type`、`ETag`、`Cache-Control: public, max-age=0, must-revalidate`；静态目录中的 `_headers` 由运行时解析且不直接向客户端提供，重叠规则中重复声明 `Cache-Control` 会拼接冲突，故各路径规则不重叠设置 `Cache-Control`。
    - [Workers Static Assets Routing](https://developers.cloudflare.com/workers/static-assets/routing/)：确认 `notFoundHandling: "none"` 且无 Worker 入口脚本时，未知路径与缺失资产返回真实 HTTP `404`。
    - [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)：确认绑定自定义域名时会自动配置 DNS 记录与 TLS 证书，无需手工添加占位 CNAME。
- **路由与 404 策略**：应用无前端路由，分享使用根路径查询参数 `/?s=...`。采用 `htmlHandling: "auto-trailing-slash"` 与 `notFoundHandling: "none"`，确保未知路径与缺失资产返回真实 404，不用 SPA 回退掩盖缺失文件。
- **本地预览方案**：使用零外部依赖的 Node.js 26 脚本 `scripts/preview-dist.mjs` 直接服务 `dist/`，在本地模拟 `auto-trailing-slash`、`notFoundHandling: "none"`、`_headers` 隐藏与头规则、截断 SHA-256 ETag/304 及防路径穿越，因此无需引入 Wrangler 依赖或实验性 Wrangler 配置。本地预览不能替代真实 Cloudflare 边缘验证（真实边缘的 `_headers` 执行、`CF-Cache-Status`、TLS 与自定义域名须在正式发布后的公开地址复核）。

## 2. 显式白名单打包（`dist/`）与阶段清单（`deploy/release.json`）

`dist/` 是生成目录（已在 `.gitignore` 忽略），绝不把仓库根目录直接作为静态资产目录。

`deploy/release.json` 是受版本控制与 PR 评审的阶段及域名白名单配置：

```json
{
  "stage": "candidate",
  "plannedVersion": "0.1.0",
  "allowedDomains": []
}
```

- `scripts/build-dist.mjs` 每次执行都会先清除自身拥有的旧 `dist/` 目录，读取 `deploy/release.json`，再按显式白名单仅写入以下 5 个文件：

| `dist/` 路径 | 来源 | 说明 |
| --- | --- | --- |
| `index.html` | 根目录 `index.html` | 单页应用入口，逐字节一致 |
| `assets/mark.svg` | `assets/mark.svg` | 页头标志与 SVG 站点图标 |
| `assets/favicon-32.png` | `assets/favicon-32.png` | 32×32 PNG 站点图标 |
| `_headers` | `deploy/_headers` | Workers 静态资产响应头规则（不直接对外提供） |
| `build-meta.json` | 构建生成 | 安全元数据（`stage`、`plannedVersion`、`packageVersion`、`released: false`、`sourceCommit`、`sourceDirty` 与资源 SHA-256，不含本机路径或凭据） |

- **重要约束**：静态构建生成的 `dist/build-meta.json` 始终保持 `"released": false`。预发布产物不得在真正部署并完成公开地址验收前宣称已成功发布；`stage` 仅区分经评审的构建目标（`"candidate"` 或 `"release"`），是否上线以实际部署记录与公开地址复测为准。
- 明确排除：`docs/`、`rounds/`、`tests/`、`scripts/`、`.git/`、`.github/`、`node_modules/`、配置文件与任何本机/凭据文件。

## 3. 候选构建、校验与本地预览

前置环境：Node.js 26、POSIX shell。仅执行自检与本地预览不需要 `npm install`；执行 `cf` dry-run 或发布前运行 `npm ci --ignore-scripts --no-audit --no-fund` 安装锁定的 `cf@1.0.0-rc.1`。

```sh
# 1. 原回归自检（含引擎、状态、导出、Logo 与 dist 打包/双模式校验/预览单测）
./scripts/selftest.sh

# 2. 显式构建 dist/ 并运行默认候选门禁（拒绝任何生产 domains 与非 candidate 配置）
npm run build
npm run verify:dist

# 3. 安装锁定 CLI（首次或依赖变更后）并执行 cf 无上传校验
npm ci --ignore-scripts --no-audit --no-fund
npm run cf:dry-run
cat .cloudflare/output/v1/workers/default/worker.config.json
npm run cf:triggers:dry-run

# 4. 启动本地 dist 预览服务器（默认 http://127.0.0.1:8788）
npm run preview
```

自定义端口：`node scripts/preview-dist.mjs --host 127.0.0.1 --port 8788`。

### 候选浏览器验收清单（须对实际 `dist/` 预览地址执行）

- 桌面 `1440×1000` 与手机 `390×844` 均无横向溢出；
- 页头 32px Logo 与 SVG/PNG 站点图标加载成功（200）；
- 随机生成、单项与全锁定随机（全锁定 SVG 逐字节不变）；
- 连续参数滑块、自定义配色与部件缩略图/预设选中态同步；
- 编辑后刷新页面恢复本地草稿；
- 含中文与 emoji 的新版（`v: 1`）与旧版无 `v` 分享链接还原及同图一致；
- 实际下载并打开 SVG 与 1024×1024 PNG；
- `/docs/`、`/rounds/`、`/assets/missing.svg`、`/_headers` 与未知路径均返回 `404`；
- 如未覆盖真机、Safari 或微信内置浏览器，必须如实记录为未验证项。

## 4. 授权后正式发布步骤（待所有者验收后执行）

> 候选阶段不执行以下步骤，也不提前在 `cloudflare.config.ts` 或 `deploy/release.json` 中写入生产域名。

### 关键规则：配置变更必须先进入目标提交，且任何配置变更后必须重生成 Build Output

1. **禁止在干净工作区上临时改配置后直接构建发布**：域名、版本与阶段配置变更必须先经过独立发布 PR 评审与合并，进入目标发布提交 `TARGET_SHA`；随后从干净的 `TARGET_SHA` 检出构建，确保 `dist/build-meta.json` 中的 `sourceCommit === TARGET_SHA` 且 `sourceDirty === false`。
2. **禁止在修改 `cloudflare.config.ts` 后只跑 `npm run build` 就调用 `--prebuilt`**：`npm run build` 只重建 `dist/`，**不会**更新 `.cloudflare/output/v1/workers/default/worker.config.json`。每次 `cloudflare.config.ts` 变更后，必须先执行 `npx cf deploy ./dist --dry-run` 重新生成 `.cloudflare/output/v1/`，并实际检视 `worker.config.json` 内容确认生效，再进行后续 `--prebuilt` 或正式部署操作。

### 发布前核对（待填项不得编造）

- 目标 Cloudflare 账号 / Account ID：`待确认（执行 cf auth whoami 核对）`
- 目标 Worker 名称：候选 `avatar-studio`（待所有者确认）
- 目标公开域名：候选 `avatar.conteman.com`（`conteman.com` 子域名，待所有者确认；当前无 DNS 记录、未配置）
- 认证状态：仅使用已授权的 `cf` 认证上下文，不在仓库写入 Token 或凭据。

### 正式发布顺序（经锁定 `cf@1.0.0-rc.1` 验证）

1. **提交并合并经批准的发布配置 PR**：
   经所有者验收批准后，在独立发布 PR 中同步修改以下受版本控制的文件并合并至 `main`，得到目标发布提交 `TARGET_SHA`：
   - `cloudflare.config.ts`：在 `worker` 中加入获批的自定义域名（保持 `workersDev: false`、`notFoundHandling: "none"`）：
     ```ts
     domains: ["avatar.conteman.com"],
     ```
   - `deploy/release.json`：将 `stage` 更新为 `"release"`，并在 `allowedDomains` 中登记与 `cloudflare.config.ts` 完全一致的获批域名：
     ```json
     {
       "stage": "release",
       "plannedVersion": "0.1.0",
       "allowedDomains": ["avatar.conteman.com"]
     }
     ```
   - 如同步调整 `package.json` 版本号（例如正式发布前准备），亦在同一发布 PR 中提交并随锁文件一致。
2. **在干净的目标提交上构建并执行正式发布门禁**：
   ```sh
   git checkout main && git pull --ff-only
   TARGET_SHA="$(git rev-parse HEAD)"
   test -z "$(git status --porcelain)"

   npm ci --ignore-scripts --no-audit --no-fund
   ./scripts/selftest.sh
   npm run build
   npm run verify:release -- --expect-commit "$TARGET_SHA"
   cat dist/build-meta.json
   ```
   `npm run verify:release`（等价于 `node scripts/verify-dist.mjs --mode release --require-clean`）在保留全部白名单、哈希、`_headers`、`notFoundHandling: "none"` 与 `workersDev: false` 安全检查的前提下，强制核验：
   - `deploy/release.json` 为 `stage: "release"` 且 `allowedDomains` 非空；
   - `cloudflare.config.ts` 的 `domains` 与 `deploy/release.json` 的 `allowedDomains` 完全一致；
   - `dist/build-meta.json` 为 `stage: "release"`、`released: false`、`sourceDirty: false` 且 `sourceCommit === TARGET_SHA`；
   - 当前工作区干净且 `HEAD === TARGET_SHA`。
3. **重生成 Build Output、检视配置输出并执行两次 dry-run**：
   ```sh
   npx cf deploy ./dist --dry-run
   cat .cloudflare/output/v1/workers/default/worker.config.json
   npx cf workers triggers deploy --prebuilt --dry-run
   ```
   肉眼核对 `.cloudflare/output/v1/workers/default/worker.config.json` 中 `name`、`compatibilityDate`、`workersDev: false`、`domains: ["avatar.conteman.com"]` 与 `assets` 字段完全符合预期。
4. **执行正式上传与部署**：
   先核对 `cf auth whoami`，确认目标账号无误后执行：
   ```sh
   npx cf deploy ./dist \
     --tag "sha-$(git rev-parse --short=12 HEAD)" \
     --message "Release avatar-studio from ${TARGET_SHA}"
   ```
   `cf deploy ./dist` 会基于当前 `cloudflare.config.ts` 与 `./dist` 重新生成 `.cloudflare/output/v1/` 并一次性上传静态资产版本及应用触发器（含 Custom Domain 与 `workersDev`）。Cloudflare Custom Domain 会自动创建所需 DNS 与证书，无需手工添加占位 CNAME。

### 线上公开地址复测（不能仅以 HTTP 200 替代）

1. 访问 `https://<公开域名>/build-meta.json`，核对 `sourceCommit` 精确等于 `TARGET_SHA`、`sourceDirty === false`、`stage === "release"`，且响应含 `X-Robots-Tag: noindex`。
2. 核对响应头：`Content-Type`、`Cache-Control`、`ETag`、`CF-Cache-Status`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`。
3. 核对非发布路径返回真实 `404`：`/docs/`、`/rounds/R05-2026-11-26/shu.svg`、`/assets/missing.svg`、`/_headers`、`/unknown-path`。
4. 在公开地址实际执行完整核心流程：Logo/图标、生成/锁定随机、手机编辑同步、刷新草稿恢复、中文/emoji 新旧分享、下载并实际打开 SVG 与 1024×1024 PNG。

### 发布记录模板

正式发布后在对应 Issue / PR 留存：

- 源提交 SHA：`待填`
- Worker 名称：`待填`
- Worker Version ID / Deployment ID：`待填`
- 公开地址：`待填`
- 检查时间（含时区）：`待填`
- 线上核心流程复测结果：`待填`
- 未验证项（如真机 Safari、微信内置浏览器）：`待填`

## 5. 回退与撤下步骤

### 回退到上一可用版本（已有历史版本时）

1. 查看已上传的 Worker 版本列表，定位上一可用 `VERSION_ID`：
   ```sh
   npx cf workers versions list --worker <WORKER_NAME>
   ```
2. 将 100% 流量切回上一可用版本（先 `--dry-run` 核对）：
   ```sh
   npx cf workers deployments create \
     --worker <WORKER_NAME> \
     --strategy percentage \
     --versions '[{"version_id":"<PREV_VERSION_ID>","percentage":100}]' \
     --dry-run

   npx cf workers deployments create \
     --worker <WORKER_NAME> \
     --strategy percentage \
     --versions '[{"version_id":"<PREV_VERSION_ID>","percentage":100}]'
   ```
3. 在公开地址复测 `/build-meta.json` 与首页核心流程，确认已恢复至旧版本。

### 首次发布故障撤下（尚无上一可用版本时）

> 严禁在修改 `cloudflare.config.ts` 后仅执行 `npm run build` 就直接运行 `cf workers triggers deploy --prebuilt`：该做法会读取旧的 `.cloudflare/output/v1/workers/default/worker.config.json`，可能继续保留或重新应用旧的 `domains`。

- **方式 A（仅摘除对外自定义域名，保留 Worker 排查）**：
  1. 在 `cloudflare.config.ts` 移除 `domains` 并保持 `workersDev: false`，同时将 `deploy/release.json` 恢复为 `stage: "candidate"`、`allowedDomains: []`；提交撤下变更进入干净提交 `TAKEDOWN_SHA`（紧急故障如需先现场止血，也必须严格执行下方第 2–4 步重生成并检视输出后再应用，随后补交记录）。
  2. 重建 `dist/` 并运行候选校验（确认不含生产域名且提交绑定干净）：
     ```sh
     TAKEDOWN_SHA="$(git rev-parse HEAD)"
     npm run build
     npm run verify:dist -- --require-clean --expect-commit "$TAKEDOWN_SHA"
     ```
  3. **用 `cf deploy ./dist --dry-run` 重生成 `.cloudflare/output/v1/`，并检视新输出确认 `domains` 已清除**：
     ```sh
     npx cf deploy ./dist --dry-run
     cat .cloudflare/output/v1/workers/default/worker.config.json
     ```
     必须确认输出的 JSON 中不再包含 `domains` 字段且 `"workersDev":false`。
  4. **基于刚重生成并核对过的 Build Output 干跑并应用触发器**（仅更新触发器，不上传新代码版本）：
     ```sh
     npx cf workers triggers deploy --prebuilt --dry-run
     npx cf workers triggers deploy --prebuilt
     ```
     如需连同静态产物一起更新为撤下提交，也可直接执行 `npx cf deploy ./dist`（其本身也会从当前 `cloudflare.config.ts` 与 `./dist` 重新生成 Build Output）。
- **方式 B（彻底删除故障 Worker 及其关联部署/触发器）**：
  先 dry-run 核对，再执行删除（交互终端会提示二次确认；非交互脚本另有 `--force` 可跳过确认）：
  ```sh
  npx cf workers delete <WORKER_NAME> --dry-run
  npx cf workers delete <WORKER_NAME>
  ```
- 撤下后确认公开地址不再提供故障页面，并在 Issue #4 记录撤下时间、原因与受影响版本 ID。
