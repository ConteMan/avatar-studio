import { defineConfig } from "cf/config";

/**
 * Cloudflare Workers Static Assets 首发候选配置（供 `cf deploy ./dist` 读取）。
 *
 * - 纯静态应用，无 Worker 服务端入口（entrypoint）与后端绑定。
 * - `notFoundHandling: "none"`：未知路径与缺失资产返回真实 404，不用 SPA 回退掩盖缺失文件。
 * - `htmlHandling: "auto-trailing-slash"`：保留 Workers Static Assets 默认规则，查询分享参数 `?s=...` 正常工作。
 * - 候选阶段保持 `workersDev: false` 且暂不配置 `domains`；正式发布经所有者验收后，
 *   再按 docs/RELEASING.md 启用目标自定义域名（候选名：avatar.conteman.com）。
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
