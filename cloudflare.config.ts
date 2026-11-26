import { defineConfig } from "cf/config";

/**
 * Cloudflare Workers Static Assets 首发候选配置（供 `cf deploy ./dist` 读取）。
 *
 * - 纯静态应用，无 Worker 服务端入口（entrypoint）与后端绑定。
 * - `notFoundHandling: "none"`：未知路径与缺失资产返回真实 404，不用 SPA 回退掩盖缺失文件。
 * - `htmlHandling: "auto-trailing-slash"`：保留 Workers Static Assets 默认规则，查询分享参数 `?s=...` 正常工作。
 * - 候选阶段保持 `workersDev: false` 且不配置 `domains`（配合 `deploy/release.json` 的 `stage: "candidate"`）。
 * - 正式发布经所有者验收后，在独立发布 PR 中同步配置 `domains` 与 `deploy/release.json`，
 *   合并到干净目标提交后再按 `docs/RELEASING.md` 执行 `npm run verify:release` 与 `cf deploy ./dist`。
 */
export default defineConfig({
  worker: {
    name: "avatar-studio",
    compatibilityDate: "2026-11-26",
    workersDev: false,
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "none",
    },
  },
});
