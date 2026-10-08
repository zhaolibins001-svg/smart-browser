# Changelog

版本号与 `package.json` 保持一致，发布由 GitHub Actions 通过 npm Trusted Publishing（OIDC，无需长期 token）在推送 `v*` 标签时自动完成。

## [1.0.6] — 2026-10-08

### 修复

- **工具注解与实际行为对齐**：`browser_screenshot`（会 `mkdir` 并写入 JPEG）、`browser_mark_screenshot` 与 `browser_observe`（level 2 会注入并清理页面覆盖层）不再声明 `readOnlyHint: true`。把写操作标成只读会让 MCP 客户端与目录审核误判风险等级。
- **依赖安全**：`@modelcontextprotocol/sdk` 由 1.29.0 升级到 1.32.1，修复 [GHSA-6qxp-vccf-f47h](https://osv.dev/vulnerability/GHSA-6qxp-vccf-f47h)（high：SDK 的 OAuth 客户端可能向 MCP 服务器指定的授权服务器发送凭据）。该漏洞在 `>=1.12.0, <1.31.0` 范围内，1.31.0 起修复。
- **发布链路**：`package-lock.json` 中残留的 `registry.npmmirror.com` 地址统一改回官方源，修复 GitHub runner 无法拉取导致的安装失败（`1.0.4` 曾因同样原因未能发布）。

### 新增

- `PRIVACY.md`：隐私政策。逐项列明写入本地的文件、可能包含密钥的文件、网络访问边界与第三方组件，并声明无常驻出站连接与遥测。
- `test/tools.test.js`：契约测试。覆盖工具数量、四个注解提示的完整性，以及"会写文件的工具不得声明只读"的回归防线。运行 `npm test`（会自动先构建）。
- `publish.yml` 增加 lockfile 源归一化步骤，避免本地镜像配置再次污染 CI。

### 变更

- README 徽章区接入 M8ven Verified（Live Monitored，每次推送自动重验）。

## [1.0.5] — 2026-09-21

### 修复

- `package-lock.json` 改用官方 registry 地址，修复新版 npm 的 `EALLOWREMOTE` 安装失败。

## [1.0.4] — 2026-09-21

> 该版本**未发布到 npm**：发布时 CI 因 lock 文件中的镜像地址而失败。

### 修复

- 自动发布链路修正。

## [1.0.3] — 2026-09-21

### 变更

- 自动发布链路验证。

## [1.0.2] — 2026-09-21

### 新增

- 为全部 39 个工具补齐 MCP 工具注解（`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`），满足 Claude / OpenAI 目录对四项显式布尔提示的硬性要求。

## [1.0.1] — 2026-09-15

### 变更

- 刷新 npm 包页面的文档元信息。

## [1.0.0] — 2026-09-15

首个公开版本：基于 Playwright + Chrome DevTools Protocol 的浏览器自动化与接口测试 MCP 服务器。

- 元素编号（ref）与 Set-of-Mark 标注截图，让模型定位节点而非编写脆弱的 CSS 选择器
- `ref` → `selector` → `placeholder` → 可见文本 的多级降级定位
- 流程录制与回放、跨会话元素记忆、人机校验识别与人工接管
- 懒启动 + CDP 复用本机已登录的 Chrome / Edge，保留登录态
- 内置 HTTP 接口测试套件（环境变量、登录态、请求、断言、批量执行）

[1.0.6]: https://github.com/zhaolibins001-svg/smart-browser/releases/tag/v1.0.6
[1.0.5]: https://github.com/zhaolibins001-svg/smart-browser/releases/tag/v1.0.5
[1.0.4]: https://github.com/zhaolibins001-svg/smart-browser/releases/tag/v1.0.4
[1.0.3]: https://github.com/zhaolibins001-svg/smart-browser/releases/tag/v1.0.3
[1.0.2]: https://github.com/zhaolibins001-svg/smart-browser/releases/tag/v1.0.2
[1.0.1]: https://github.com/zhaolibins001-svg/smart-browser/releases/tag/v1.0.1
[1.0.0]: https://github.com/zhaolibins001-svg/smart-browser/releases/tag/v1.0.0
