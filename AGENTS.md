# 半身像工坊

独立的单页项目。页面在仓库根目录的 `index.html`。

推进前先读 [docs/commander-notes.md](docs/commander-notes.md)。没有后端，不部署到 Dokploy。

维护流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，当前行为见 [docs/DESIGN.md](docs/DESIGN.md)。

- 任务与验收使用 GitHub Issues / PR，不另维护手工全量 STATUS。
- 一分支一个目标；提交采用中文 Conventional Commits，PR 关联对应 Issue。
- 修改后运行 `scripts/selftest.sh` 和 `git diff --check`，记录实际结果与未验证项。
- 保留单文件入口、绘制公式、发型公式和 11 层顺序；不要自行添加 LICENSE。
- 按已批准的六个切片推进；明显手机布局先交所有者验收草稿，正式发布另经所有者验收。
