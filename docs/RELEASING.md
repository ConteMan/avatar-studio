# 半身像工坊 · 打包、候选验证与发布指南

记录日期：2026-11-26（2026-11-27 经所有者正式授权启用 `0.1.0` 发布配置）。本指南对应 Issue #4，说明纯静态产物 `dist/` 的显式白名单构建、本地预览、双模式校验与 PR CI 门禁、`cf` CLI 授权后发布以及回退/撤下流程。当前已完成 `0.1.0` 正式发布配置（目标 Worker `avatar-studio`、域名 `avatar.conteman.com`），尚未执行正式部署与公开地址复测。

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

`deploy/release.json` 是受版本控制与 PR 评审的阶段及域名白名单配置（当前 `0.1.0` 授权发布配置示例）：

```json
{
  "stage": "release",
  "plannedVersion": "0.1.0",
  "allowedDomains": [
    "avatar.conteman.com"
  ]
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

## 3. 候选构建、校验、PR CI 门禁与本地预览

前置环境：Node.js 26、POSIX shell。仅执行自检与本地预览不需要 `npm install`；执行 `cf` dry-run 或发布前运行 `npm ci --ignore-scripts --no-audit --no-fund` 安装锁定的 `cf@1.0.0-rc.1`。

### 三个校验入口的职责划分

- `npm run verify:dist`（默认候选模式）：强制要求 `stage === "candidate"`、`allowedDomains` 为空且 `cloudflare.config.ts` 不含 `domains`；在任何带有生产 `domains` 或 `stage: "release"` 的树上均非零退出。
- `npm run verify:release -- --expect-commit "$TARGET_SHA"`（显式正式发布模式）：保留全部白名单、哈希、`_headers`、`notFoundHandling: "none"`、`workersDev: false` 与防 Wrangler 冲突检查，并强制核对 `stage === "release"`、`released === false`、`cloudflare.config.ts` 的 `domains` 与 `deploy/release.json` 的 `allowedDomains` 完全一致、工作区干净（`sourceDirty === false` 且当前 `git status --porcelain` 为空）以及 `sourceCommit === HEAD === TARGET_SHA`。
- `npm run verify:ci`（PR CI 清单驱动门禁，`scripts/verify-manifest-gate.mjs`）：依据受版本控制的 `deploy/release.json` 中的 `stage` 严格选择 `candidate` 或 `release` 校验器（`stage` 缺失、未知或与配置不一致时立即非零退出），并始终以当前实际检出提交 `git rev-parse HEAD` 绑定 `requireClean: true` 与 `expectCommit`（适配 GitHub PR 合并提交检出，绝不混用 PR head SHA）。PR CI 仅执行只读检查与 dry-run，不自动部署。

```sh
# 1. 原回归自检（含引擎、状态、导出、Logo 与 dist 打包/双模式校验/预览单测）
./scripts/selftest.sh

# 2. 显式构建 dist/ 并运行默认候选门禁
npm run build
npm run verify:dist

# 3. 运行与 PR CI 相同的清单驱动门禁与 cf 无上传干跑
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:ci
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
- 如未覆盖真机、Safari、微信内置浏览器或系统剪贴板真实写入，必须如实记录为未验证项。

## 4. 授权后正式发布步骤（2026-11-27 已获所有者授权，待合并后执行部署）

> 候选阶段不启用生产域名；2026-11-27 所有者已明确授权 `0.1.0` 正式发布（目标 Worker `avatar-studio`、域名 `avatar.conteman.com`），本发布配置仍须经评审、CI 通过与合并进入干净目标提交后，再执行真实部署与公开地址复测。

### 关键规则：配置变更先经 PR 进入目标提交，配置变更后必须重生成 Build Output

1. **禁止在干净工作区上临时改配置后直接构建发布**：域名、版本与阶段配置变更必须先经过独立发布 PR（通过 `selftest` 与 `workers-assets-gate` 全部 CI 门禁、不同模型独立评审与所有者批准）合并进入目标发布提交 `TARGET_SHA`；随后从干净的 `TARGET_SHA` 检出构建，确保 `dist/build-meta.json` 中的 `sourceCommit === TARGET_SHA` 且 `sourceDirty === false`。
2. **禁止在修改 `cloudflare.config.ts` 后只跑 `npm run build` 就调用 `--prebuilt`**：`npm run build` 只重建 `dist/`，**不会**更新 `.cloudflare/output/v1/workers/default/worker.config.json`。每次 `cloudflare.config.ts` 变更后，必须先执行 `npx cf deploy ./dist --dry-run` 重新生成 `.cloudflare/output/v1/` 并检视 `worker.config.json` 内容确认生效，再进行后续 `--prebuilt` 校验或正式部署。

### 发布前核对（待填项不得编造）

- 目标 Cloudflare 账号：发布前执行 `cf auth whoami` 核对当前授权账号（不在仓库写入账号 ID、Token 或凭据）
- 目标 Worker 名称：`avatar-studio`（2026-11-27 所有者确认；只读核对尚未创建）
- 目标公开域名：`avatar.conteman.com`（`conteman.com` 子域名，2026-11-27 所有者确认；只读核对尚未占用 DNS/Custom Domain，尚未上线）
- 认证状态：仅使用已授权的 `cf` 认证上下文，不在仓库写入 Token 或凭据。

### 正式发布顺序（经锁定 `cf@1.0.0-rc.1` 静态与干跑验证）

1. **提交并合并经批准的发布配置 PR**：
   经所有者验收批准后，在独立发布 PR 中同步修改以下受版本控制的文件，通过 PR CI（`selftest` + `workers-assets-gate`）与评审后合并至 `main`，得到目标发布提交 `TARGET_SHA`：
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
   - 如同步调整 `package.json` 版本号，亦在同一发布 PR 中提交并保持锁文件一致。
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
   确认 `dist/build-meta.json` 为 `stage: "release"`、`released: false`、`sourceDirty: false` 且 `sourceCommit === TARGET_SHA`。（注：此时若执行默认候选门禁 `npm run verify:dist`，预期非零拒绝，以防候选保护失效。）
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
   `cf deploy ./dist` 会基于当前 `cloudflare.config.ts` 与 `./dist` 重新生成 `.cloudflare/output/v1/` 并上传静态资产版本与应用触发器（含非空 `domains` 的 Custom Domain 绑定与 `workersDev`）。Cloudflare Custom Domain 会自动创建所需 DNS 与证书，无需手工添加占位 CNAME。

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
- 未验证项（如真机、Safari、微信内置浏览器、系统剪贴板写入）：`待填`

## 5. 回退与紧急撤下步骤

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

### 首次发布紧急撤下（尚无上一可用版本时）

> **重要限制说明（基于锁定 `cf@1.0.0-rc.1` 源码与命令静态核对）**：
> - `cf@1.0.0-rc.1` 在 `domains` 为空时跳过唯一的 `publishCustomDomains` 调用，因此**从 `cloudflare.config.ts` 移除 `domains` 后执行 `cf deploy ./dist` 或 `cf workers triggers deploy --prebuilt` 都不会解绑已部署的自定义域名**。
> - `cf@1.0.0-rc.1` 亦无独立的 `cf workers domains` 解绑子命令。
> - 因此，首次发布遇到故障且无可用旧版本时，**唯一经锁定 CLI 契约（`cf schema workers delete` 与 `--dry-run`）明确支持的紧急撤下路径为删除整个故障 Worker**。

#### 影响范围与资源身份要求

- **影响范围**：`cf workers delete <WORKER_NAME>` 调用 `DELETE /accounts/{account_id}/workers/workers/{worker_id}`，按锁定 CLI 说明与官方文档范围删除该 Worker 及其关联资源（versions、deployments 等）；自定义域名绑定与 DNS 记录是否同步清理不得预设为已证明结果，必须以下方第 4 步现场复核及必要时的显式清理为准。本应用为纯静态无后端页面，用户草稿保存在各自浏览器的 `localStorage`，删除 Worker 不丢失服务端数据。
- **身份与权限要求**：执行者需在当前 `cf` 认证上下文下对目标 Cloudflare 账号具备 Workers 管理/删除权限，且必须先核对账号与精确 Worker 名称，严禁跨账号或误删其他 Worker。

#### 紧急撤下顺序

1. **核对认证身份与精确目标 Worker**：
   ```sh
   npx cf auth whoami
   npx cf workers get <WORKER_NAME>
   ```
   对照 Issue #4 登记的账号、Worker 名称与公开域名，确认目标完全一致。
2. **无副作用干跑核对删除请求**：
   ```sh
   npx cf workers delete <WORKER_NAME> --dry-run
   ```
   核对输出 JSON 中的 `method: "DELETE"`、`url` 路径以及 `pathParams.worker` 精确等于 `<WORKER_NAME>`。
3. **执行删除**：
   ```sh
   npx cf workers delete <WORKER_NAME>
   ```
   交互终端会提示二次确认；非交互应急脚本另有 `--force` 可跳过确认（谨慎使用）。
4. **撤下后入口与 DNS 复核**：
   - Worker 核对：`npx cf workers get <WORKER_NAME>`（预期返回不存在）或 `npx cf workers list` 确认已移除。
   - 公开入口复核：访问 `https://<公开域名>/` 与 `https://<公开域名>/build-meta.json`，确认不再返回故障应用页面。
   - DNS 只读核对：执行 `npx cf dns records list --zone <ZONE_DOMAIN> --name <PUBLIC_HOSTNAME>` 核查是否残留该子域名的 DNS 记录；若平台存在残留记录或控制台仍可见孤立域名绑定，立即在 Cloudflare 控制台清理后再次复测公开入口。
5. **同步仓库状态与事故记录**：
   - 通过 PR 将 `cloudflare.config.ts` 移除 `domains`、将 `deploy/release.json` 恢复为 `stage: "candidate"` 与 `allowedDomains: []`（确保候选门禁重新生效），并在 Issue #4 记录撤下时间、原因、受影响 Version ID 与复核结果。

#### 撤下后的恢复上线步骤

故障修复并合入干净的目标提交后，按第 4 节完整流程重新执行发布（发布 PR 评审合并 → `npm run build` → `npm run verify:release -- --expect-commit "$TARGET_SHA"` → `npx cf deploy ./dist --dry-run` 检视 `worker.config.json` → `npx cf deploy ./dist`），重新创建 Worker 并发起 Custom Domain 绑定，其 DNS 与 TLS 证书的创建、生效情况以实际部署结果及公开地址对 `/build-meta.json` 与核心功能流程的复测为准。

> **验证边界声明**：本候选阶段未执行真实远端删除或域名解绑。上述撤下命令与 API 路径仅基于锁定 `cf@1.0.0-rc.1` 的 `--help`、`cf schema workers delete`、`cf workers delete <name> --dry-run` 输出及包内源码静态核对；真实删除及自定义域名/DNS 自动清理行为须在实际授权撤下演练或操作时现场复核。
