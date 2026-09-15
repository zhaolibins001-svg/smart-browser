# Smart Browser MCP

> 面向 AI 编程助手（Claude Code / Claude Desktop / Cursor 等）的浏览器自动化 + 接口测试 MCP 服务器。
> 基于 Playwright + Chrome DevTools Protocol，让大模型像人一样"看得懂"页面、点得准按钮、跑得通流程。
> 模仿ego-lite 的windows智能浏览器工具

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License](https://img.shields.io/badge/license-ISC-green)

---

## 为什么需要它

传统浏览器自动化的痛点是：AI 只能拿到一大堆 HTML，靠猜测写 CSS 选择器，元素一变就全盘失效。

Smart Browser MCP 把「页面理解」这件事做成了模型的原生能力：

- **看得懂**：把可交互元素扫描出来并编号（`e1`、`e2`…），模型直接点编号，不再手写脆弱选择器；
- **看得见**：提供 Set-of-Mark（SoM）标注截图，元素框选 + 序号叠加在图上，视觉模型也能直接读懂；
- **记得住**：页面元素映射可持久化，下次访问同一站点无需重新扫描；
- **可复用**：一次录制、随时回放，把探索过程沉淀成可重跑的自动化流程；
- **闭环**：内置 HTTP 接口测试工具，UI 与 API 双向验证。

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 元素引用（ref）机制 | `browser_observe` 扫描后返回带编号元素，后续点击/输入直接用 `e1`、`e2` |
| Set-of-Mark 截图 | 截图上叠加元素边框与序号，视觉模型可直接定位 |
| 智能兜底选择 | 支持 `ref` → `selector` → `placeholder` → 可见文本 多级降级定位 |
| 页面结构分析 | 文本抽取、DOM 快照、页面语义分析、站点地图提取 |
| 流程录制与回放 | `browser_flow_record` 录制 → `browser_flow_run` 重放 |
| 元素记忆 | `browser_remember` / `browser_recall` 跨会话保存站点元素映射 |
| 人机校验识别 | 自动检测验证码 / 人机验证，暂停并等待人工处理后继续 |
| 非阻塞式懒启动 | 首次调用工具时才拉起浏览器，不在 MCP 启动阶段占用资源 |
| 多标签页管理 | 列出、切换、新建标签页 |
| 控制台错误采集 | 自动收集页面运行时错误，支持读取与清空 |
| 接口测试套件 | 环境变量、登录态、请求发送、断言、套件批量执行 |
| 高度可配置 | 浏览器路径、用户数据目录、CDP 端口均可通过环境变量指定 |

---

## 快速开始

### 1. 安装（当前请使用源码方式）

> 本项目**尚未发布到 npm**，`npm install -g @han/claude-browser-mcp` 暂时不可用，请按下面的源码方式安装。

**环境要求**：Node.js ≥ 18

```bash
git clone https://gitee.com/zhaolibin001/smart-browser.git
cd smart-browser
npm install          # 安装依赖
npm run build        # 构建到 dist/
npm link             # 注册全局命令 claude-browser-mcp / browser-mcp（可选）
```

`npm link` 只是为了在任意目录使用 `claude-browser-mcp` 这个命令。如果不执行它，可以在 MCP 配置里直接用 `node` 指向 `dist/index.js` 的绝对路径（见下一节）。

> 可选加速：本项目通过 CDP 连接你本机已安装的 Chrome / Edge，不需要 Playwright 自带的浏览器。若 `npm install` 下载浏览器过慢，可跳过下载：
>
> ```powershell
> $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm install
> ```

### 2. 配置 MCP 客户端

以 Claude Code 的 `settings.json` 为例：

```json
{
  "mcpServers": {
    "browser": {
      "command": "claude-browser-mcp",
      "env": {
        "BROWSER_PATH": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "BROWSER_USER_DATA_DIR": "D:\\Projects\\AIchrome-profile",
        "BROWSER_CDP_PORT": "9222"
      }
    }
  }
}
```

如果 `claude-browser-mcp` 不在 PATH 中，改用绝对路径：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["D:/Projects/smart-browser/dist/index.js"],
      "env": {
        "BROWSER_PATH": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      }
    }
  }
}
```

### 3. 开始对话

配置完成后重启客户端，直接对 AI 说：

```
打开 https://example.com，帮我把顶部搜索框填上 "MCP"，然后点击搜索按钮
```

AI 会自动调用 `browser_open` → `browser_observe` → `browser_fill` → `browser_click` 完成操作。

---

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `BROWSER_PATH` | 浏览器可执行文件路径 | 自动探测 Chrome / Edge |
| `BROWSER_USER_DATA_DIR` | 浏览器用户数据目录（保留登录态） | `D:\Projects\AIchrome-profile` |
| `BROWSER_CDP_PORT` | Chrome DevTools Protocol 调试端口 | `9222` |

> 自动探测顺序：Chrome（Program Files）→ Chrome（Program Files x86）→ Edge（Program Files）→ Edge（Program Files x86）。

---

## 工具清单

### 页面理解

| 工具 | 用途 |
| --- | --- |
| `browser_observe` | **核心工具**。level 1 返回带编号的可交互元素，level 2 额外返回标注截图 |
| `browser_elements` | 扫描并列出可交互元素，生成 ref 编号 |
| `browser_mark_screenshot` | 生成 Set-of-Mark 标注截图 |
| `browser_analyze_page` | 分析页面语义结构（标题、表单、导航、主要内容） |
| `browser_text` | 提取页面文本内容 |
| `browser_snapshot` | 获取页面 DOM 快照 |
| `browser_extract_site_map` | 提取站点导航 / 链接结构 |

### 页面交互

| 工具 | 用途 |
| --- | --- |
| `browser_open` | 打开 URL（首次调用触发浏览器启动） |
| `browser_click` | 点击元素（优先 `ref`，其次 `selector` / 文本） |
| `browser_fill` | 填写输入框（`ref` → `selector` → `placeholder`） |
| `browser_select` | 选择下拉框选项 |
| `browser_hover` | 鼠标悬停 |
| `browser_press` | 键盘按键 |
| `browser_scroll` | 滚动页面 |
| `browser_wait_human` | 等待人工处理（验证码等） |

### 标签页与截图

| 工具 | 用途 |
| --- | --- |
| `browser_tabs` | 列出所有标签页 |
| `browser_switch_tab` | 切换到指定标签页 |
| `browser_new_tab` | 新建标签页 |
| `browser_screenshot` | 页面截图 |
| `browser_set_viewport` | 设置视口尺寸 |

### 调试与流程

| 工具 | 用途 |
| --- | --- |
| `browser_errors` | 读取页面运行时错误 |
| `browser_clear_errors` | 清空错误记录 |
| `browser_flow_record` | 开始 / 停止录制操作流程 |
| `browser_flow_run` | 回放已录制流程 |
| `browser_flow_list` | 列出已保存流程 |
| `browser_auto_test` | 按步骤序列执行自动化测试 |
| `browser_remember` | 保存站点元素映射 |
| `browser_recall` | 载入已保存的元素映射 |
| `browser_memory_list` | 列出所有记忆站点 |
| `browser_forget` | 删除指定站点记忆 |

### 接口测试

| 工具 | 用途 |
| --- | --- |
| `api_set_env` | 设置接口测试环境变量（如 baseUrl、token） |
| `api_login` | 执行登录接口并自动保存凭证 |
| `api_request` | 发送任意 HTTP 请求 |
| `api_assert` | 对响应结果做断言 |
| `api_test_suite` | 定义测试套件 |
| `api_suite_run` | 批量执行测试套件 |
| `api_suite_list` | 列出已保存套件 |
| `api_errors` / `api_clear_errors` | 读取 / 清空接口错误记录 |

---

## 工作机制

```
AI 助手 ──stdio──> Smart Browser MCP ──Playwright/CDP──> Chrome / Edge
                          │
                          ├── 懒启动：首次工具调用才拉起浏览器
                          ├── 复用已有 CDP 实例：保留登录态与扩展
                          ├── ref 映射表：ref(selector, 兜底定位) 双向绑定
                          └── 产物落盘：截图 / 流程 / 记忆 / 套件
```

1. **懒启动 + CDP 复用**：先探测目标端口是否已有可用 CDP 实例，有则直接接管，无则按配置拉起浏览器，避免重复打开窗口、丢失登录态。
2. **元素扫描**：注入脚本遍历 DOM，筛选可见且有交互能力的元素，按序编号并记录多重定位策略。
3. **ref 绑定**：所有交互工具优先消费 `ref`，失效时自动降级到 selector、placeholder、可见文本，大幅提升稳定性。
4. **持久化**：流程、记忆、接口套件均以 JSON 存于当前工作目录，便于版本管理与团队共享。

---

## 运行产物

MCP 在当前工作目录下生成以下内容（默认已在 `.gitignore` 中忽略）：

| 路径 | 内容 |
| --- | --- |
| `browser-screenshots/` | 截图文件 |
| `browser-flows/` | 录制流程 JSON |
| `browser-memory.json` | 站点元素记忆 |
| `api-env.json` | 接口测试环境变量 |
| `api-suites/` | 接口测试套件 |

---

## 开发

```bash
npm install

npm run dev           # 直接从源码运行
npm run build         # 构建到 dist/
npm run build:minify  # 构建并压缩
npm start             # 运行构建产物
```

技术栈：Node.js ≥ 18 · [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk) · [Playwright](https://playwright.dev/) · [Zod](https://zod.dev/) · esbuild

---

## 常见问题

**Q：浏览器没有自动启动？**
A：检查 `BROWSER_PATH` 是否指向真实存在的可执行文件；未设置时会自动探测 Chrome / Edge 的默认安装路径。

**Q：登录态丢失？**
A：确保 `BROWSER_USER_DATA_DIR` 指向固定目录，该目录即持久化用户数据目录。

**Q：端口被占用 / 连接失败？**
A：确认 `BROWSER_CDP_PORT` 未被其他进程占用；同一端口同时只应存在一个 CDP 实例。

**Q：元素点击失效？**
A：页面变动后重新调用 `browser_observe` 刷新 ref 映射，或先用 `browser_wait_human` / `browser_scroll` 确保元素进入可视区域。

---

## 贡献

欢迎提交 Issue 与 Pull Request。

1. Fork 本仓库
2. 创建分支：`git checkout -b feature/your-feature`
3. 提交改动：`git commit -m "feat: 你的改动"`
4. 推送分支：`git push origin feature/your-feature`
5. 发起 Pull Request

---

## 许可证

[ISC License](./LICENSE)
