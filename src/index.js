#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import http from "http";

let browser;
let context;
let page;

// 当前 Claude 项目目录
const projectRoot = process.cwd();

// 截图目录
const screenshotDir = path.join(projectRoot, "browser-screenshots");

let errors = [];
const MAX_ERRORS = 200;

// ref -> {selector, backupType, backupValue} 映射
// （由 browser_observe / browser_elements / browser_mark_screenshot 重建）
let refMap = {};
let refCounter = 0;

// 流程录制状态（record & replay）
let recording = null; // {name, steps: []}

const listenedPages = new Set();


// -------------------------
// Chrome 自启动配置
// -------------------------

// 对应 start-ai-chrome.ps1 中的配置
const DEFAULT_BROWSER_PATHS = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];

const CHROME_USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR || "D:\\Projects\\AIchrome-profile";
const CDP_PORT = parseInt(process.env.BROWSER_CDP_PORT, 10) || 9222;
const CDP_URL = `http://localhost:${CDP_PORT}`;

let chromeProcess = null;

function findBrowser() {
    const envPath = process.env.BROWSER_PATH;
    if (envPath) {
        if (fs.existsSync(envPath)) return envPath;
        console.error(`BROWSER_PATH set but not found: ${envPath}`);
    }

    for (const p of DEFAULT_BROWSER_PATHS) {
        if (fs.existsSync(p)) return p;
    }

    return null;
}

function cdpReady() {
    return new Promise((resolve) => {
        const req = http.get(`${CDP_URL}/json/version`, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(1000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function waitForCdp(maxMs = 30000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (await cdpReady()) return true;
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

async function startChrome() {
    if (await cdpReady()) {
        console.error("Browser already listening on CDP port", CDP_PORT);
        return;
    }

    const browserPath = findBrowser();
    if (!browserPath) {
        throw new Error(
            "未找到浏览器程序。请按以下方式之一配置：\n" +
            "1. 设置环境变量 BROWSER_PATH，例如：\n" +
            "   BROWSER_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n" +
            "2. 在 Claude Code 的 settings.json 中配置 env：\n" +
            '   "env": { "BROWSER_PATH": "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe" }\n' +
            "3. 支持 Chrome / Edge 等 Chromium 内核浏览器\n" +
            "\n其他可配置项：\n" +
            "BROWSER_USER_DATA_DIR  用户数据目录（默认 D:\\Projects\\AIchrome-profile）\n" +
            "BROWSER_CDP_PORT       CDP 调试端口（默认 9222）"
        );
    }

    console.error("Using browser:", browserPath);

    const args = [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${CHROME_USER_DATA_DIR}`,
        "--disable-features=Translate",
        "--no-first-run",
        "--no-default-browser-check"
    ];

    console.error("Starting browser...");
    chromeProcess = spawn(browserPath, args, {
        detached: false,
        stdio: "ignore"
    });

    chromeProcess.on("exit", (code) => {
        console.error("Browser process exited, code:", code);
        chromeProcess = null;
    });

    const ready = await waitForCdp(30000);
    if (!ready) {
        throw new Error(`Browser did not become ready on CDP port ${CDP_PORT}`);
    }
    console.error("Browser started and CDP ready");
}

function shutdownChrome() {
    if (chromeProcess) {
        chromeProcess.kill();
        chromeProcess = null;
    }
}

process.on("SIGINT", shutdownChrome);
process.on("SIGTERM", shutdownChrome);


// -------------------------
// 浏览器连接 & 错误监听
// -------------------------

function pushError(e) {
    errors.push(e);
    if (errors.length > MAX_ERRORS) {
        errors = errors.slice(-MAX_ERRORS);
    }
}

function attachListeners(p) {
    if (listenedPages.has(p)) return;
    listenedPages.add(p);

    // JS console 错误
    p.on("console", msg => {
        if (msg.type() === "error") {
            pushError({ type: "console", message: msg.text() });
        }
    });

    // 页面异常
    p.on("pageerror", err => {
        pushError({ type: "javascript", message: err.message });
    });

    // 网络错误
    p.on("response", res => {
        if (res.status() >= 400) {
            pushError({ type: "http", status: res.status(), url: res.url() });
        }
    });

    // 原生弹窗（alert/confirm/prompt）— 自动接受防止 action 卡死，并记录
    p.on("dialog", async d => {
        pushError({ type: "dialog", message: d.type() + ": " + d.message() });
        try { await d.accept(); } catch {}
    });
}

let browserInitPromise = null;

// 连接断开后清空全部浏览器状态，使下次调用走完整重连流程
function resetBrowserState() {
    browser = null;
    context = null;
    page = null;
    listenedPages.clear();
    resetRefs();
}

async function ensureBrowser() {
    // 修复2：Chrome 被关闭/崩溃后 isConnected() 为 false，重置状态以便重连
    if (browser && !browser.isConnected()) {
        console.error("Browser connection lost, resetting state");
        resetBrowserState();
    }

    if (!browser) {
        // 修复1：finally 中清空 promise —— 失败后下次调用可重新发起初始化，
        // 不再永久缓存 rejected promise
        if (!browserInitPromise) {
            browserInitPromise = initBrowser().finally(() => {
                browserInitPromise = null;
            });
        }
        await browserInitPromise;
    }

    await ensurePage();
}

// 修复3：保证 context / page 可用 —— page 被用户手动关闭或从未存在时自动恢复
async function ensurePage() {
    if (!context) {
        context = browser.contexts()[0] || await browser.newContext();
        context.on("page", p => {
            attachListeners(p);
            p.setDefaultTimeout(10000);
        });
    }

    if (!page || page.isClosed()) {
        const pages = context.pages();
        page = pages[pages.length - 1] || await context.newPage();
        attachListeners(page);
        page.setDefaultTimeout(10000);
        await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
        console.error("Active page recovered:", page.url());
    }
}

async function initBrowser() {
    await startChrome();
    browser = await chromium.connectOverCDP(CDP_URL);

    // 修复2：浏览器进程退出/连接断开时清空状态，下次工具调用自动重连
    browser.on("disconnected", () => {
        console.error("Browser disconnected — will reconnect on next tool call");
        resetBrowserState();
    });

    // 修复3：CDP 连接时默认 context 理论上恒存在，兜底创建一个
    context = browser.contexts()[0] || await browser.newContext();

    context.pages().forEach(p => {
        attachListeners(p);
        p.setDefaultTimeout(10000);
    });
    context.on("page", p => {
        attachListeners(p);
        p.setDefaultTimeout(10000);
    });

    page = context.pages()[0];
    if (page) {
        await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    }

    console.error("Chrome connected");
}


// -------------------------
// 通用工具函数
// -------------------------

function result(text) {
    return { content: [{ type: "text", text }] };
}

function ensureDir() {
    if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
    }
}

// 统一截图：viewport、JPEG、10s 超时，并禁用页面动画避免阻塞
async function captureScreenshot(options = {}) {
    // 注入禁用动画样式（重复调用幂等）
    await page.evaluate(() => {
        const id = "mcp-disable-animation";
        if (document.getElementById(id)) return;
        const style = document.createElement("style");
        style.id = id;
        style.innerHTML = `
            *, *::before, *::after {
                animation: none !important;
                transition: none !important;
                animation-play-state: paused !important;
            }
        `;
        document.head.appendChild(style);
    }).catch(() => {});

    return await page.screenshot({
        fullPage: false,
        type: "jpeg",
        quality: 70,
        timeout: 10000,
        ...options
    });
}

function resetRefs() {
    refMap = {};
    refCounter = 0;
}

function addRef(entry) {
    refCounter += 1;
    const ref = "e" + refCounter;
    refMap[ref] = entry; // {selector, backupType, backupValue}
    return ref;
}

// ref 优先，其次原始 selector；返回 {selector, backupType?, backupValue?}
function resolveTarget({ ref, selector }) {
    if (ref) {
        const t = refMap[ref];
        if (!t) {
            throw new Error(
                `Unknown ref "${ref}" — run browser_observe or browser_mark_screenshot first`
            );
        }
        return t;
    }
    return selector ? { selector } : null;
}

// selector 失效时用文本兜底（ref 双备份）
async function clickWithBackup(t) {
    try {
        await page.click(t.selector, { timeout: 5000 });
    } catch (e) {
        if (t.backupType === "text" && t.backupValue) {
            await page.getByText(t.backupValue, { exact: true }).first().click();
            return " (via text fallback)";
        }
        throw e;
    }
    return "";
}

// selector 失效时用 placeholder 兜底
async function fillWithBackup(t, value) {
    try {
        await page.fill(t.selector, value);
    } catch (e) {
        if (t.backupType === "placeholder" && t.backupValue) {
            await page.getByPlaceholder(t.backupValue).fill(value);
            return " (via placeholder fallback)";
        }
        throw e;
    }
    return "";
}

// 录制当前动作（browser_flow_record start 后生效）
function recordStep(step) {
    if (recording) recording.steps.push(step);
}

// 执行 step 序列（browser_auto_test / browser_flow_run 共用）
async function runSteps(steps) {
    let log = [];

    for (const step of steps) {
        try {
            switch (step.action) {

                case "open":
                    await page.goto(step.url, { waitUntil: "networkidle" });
                    log.push("opened: " + step.url);
                    break;

                case "click": {
                    const t = resolveTarget({ ref: step.ref, selector: step.selector });
                    if (t) {
                        await clickWithBackup(t);
                        log.push("clicked: " + (step.ref || step.selector));
                    } else {
                        await page.getByText(step.text, { exact: true }).first().click();
                        log.push("clicked: " + step.text);
                    }
                    break;
                }

                case "fill": {
                    const t = resolveTarget({ ref: step.ref, selector: step.selector });
                    if (t) {
                        await fillWithBackup(t, step.value);
                        log.push("filled: " + (step.ref || step.selector));
                    } else {
                        await page.getByPlaceholder(step.placeholder).fill(step.value);
                        log.push("filled: " + step.placeholder);
                    }
                    break;
                }

                case "press":
                    await page.keyboard.press(step.value || "Enter");
                    log.push("pressed: " + (step.value || "Enter"));
                    break;

                case "scroll": {
                    const px = Number(step.value || 600);
                    await page.mouse.wheel(0, px);
                    await page.waitForTimeout(500);
                    log.push("scrolled: " + px + "px");
                    break;
                }

                case "wait":
                    await page.waitForTimeout(Number(step.value || 1000));
                    log.push("wait");
                    break;

                case "screenshot": {
                    ensureDir();
                    const file = path.join(
                        screenshotDir,
                        (step.name || "step") + ".jpg"
                    );
                    try {
                        const buf = await captureScreenshot();
                        fs.writeFileSync(file, buf);
                        log.push("screenshot: " + file);
                    } catch (e) {
                        log.push("screenshot failed: " + e.message);
                    }
                    break;
                }
            }
        } catch (e) {
            log.push("ERROR: " + e.message);
        }
    }

    return log;
}

// 行动后自动反馈：URL 变化 / 新增错误 / 页面是否稳定
async function actionFeedback(before) {
    let settle;
    try {
        await page.waitForLoadState("networkidle", { timeout: 3000 });
        settle = "page settled";
    } catch {
        settle = "page still loading (network not idle after 3s)";
    }

    const lines = [];

    const now = page.url();
    if (now !== before.url) {
        lines.push(`URL changed: ${before.url} -> ${now}`);
    }

    const fresh = errors.slice(before.errorCount);
    if (fresh.length) {
        lines.push(
            fresh.length + " new error(s): " +
            fresh.map(e => e.message || (e.status + " " + e.url)).join(" | ")
        );
    }

    lines.push(settle);

    // 验证码检测
    const captcha = await detectCaptcha();
    if (captcha.widgets.length) {
        lines.push(
            "⚠️ CAPTCHA detected (" + captcha.widgets.join(" | ") + ")\n" +
            "Ask the user to solve it manually in the browser, " +
            "then call browser_wait_human to continue."
        );
    } else if (captcha.hints.length) {
        lines.push(
            "⚠️ Possible verification step (" + captcha.hints.join(" | ") + ")\n" +
            "If a code input is required, ask the user for the code and fill it with browser_fill; " +
            "if it's an interactive captcha, ask the user to solve it, then call browser_wait_human."
        );
    }

    return lines.join("\n");
}


// -------------------------
// 注入页面的元素枚举脚本
// -------------------------

const ELEMENT_HELPERS = `
function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);

    var testid = el.getAttribute("data-testid") || el.getAttribute("data-test");
    if (testid) {
        return el.tagName.toLowerCase() + '[data-testid="' + testid + '"]';
    }

    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
        var part = node.tagName.toLowerCase();
        var parent = node.parentElement;
        if (parent) {
            var same = Array.from(parent.children).filter(function (c) {
                return c.tagName === node.tagName;
            });
            if (same.length > 1) {
                part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
            }
        }
        parts.unshift(part);
        node = parent;
    }
    return parts.join(" > ");
}

function visible(el) {
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}
`;

// 枚举可交互元素（不绘制覆盖层）
const COLLECT_ELEMENTS = `(function () {
${ELEMENT_HELPERS}
    var clickable = Array.from(
        document.querySelectorAll('button, a[href], [role="button"], input[type="submit"]')
    ).filter(visible).slice(0, 100).map(function (el) {
        return {
            text: (el.innerText || el.value || "").trim().substring(0, 50),
            tag: el.tagName.toLowerCase(),
            selector: cssPath(el)
        };
    }).filter(function (x) { return x.text; });

    var inputs = Array.from(
        document.querySelectorAll('input:not([type="submit"]):not([type="hidden"]), textarea, select')
    ).filter(visible).slice(0, 50).map(function (el) {
        return {
            name: el.name || "",
            placeholder: el.placeholder || "",
            type: el.type || el.tagName.toLowerCase(),
            selector: cssPath(el)
        };
    });

    return { clickable: clickable, inputs: inputs };
})()`;

// 枚举可交互元素 + 绘制 Set-of-Mark 编号覆盖层
const MARK_ELEMENTS = `(function () {
${ELEMENT_HELPERS}
    document.querySelectorAll(".mcp-mark-overlay").forEach(function (x) { x.remove(); });

    var els = Array.from(
        document.querySelectorAll(
            'button, a[href], [role="button"], input:not([type="hidden"]), textarea, select, summary, [onclick]'
        )
    ).filter(visible).slice(0, 60);

    return els.map(function (el, i) {
        var n = i + 1;
        var rect = el.getBoundingClientRect();

        var box = document.createElement("div");
        box.className = "mcp-mark-overlay";
        box.style.cssText =
            "position:fixed;left:" + rect.left + "px;top:" + rect.top + "px;" +
            "width:" + rect.width + "px;height:" + rect.height + "px;" +
            "border:2px solid #e0245e;z-index:2147483647;pointer-events:none;box-sizing:border-box;";

        var label = document.createElement("div");
        label.textContent = n;
        label.style.cssText =
            "position:absolute;top:-18px;left:-2px;background:#e0245e;color:#fff;" +
            "font:bold 12px monospace;padding:0 4px;border-radius:2px;";
        box.appendChild(label);
        document.body.appendChild(box);

        return {
            n: n,
            text: (el.innerText || el.value || el.placeholder || el.name || "").trim().substring(0, 50),
            tag: el.tagName.toLowerCase(),
            selector: cssPath(el)
        };
    });
})()`;


// -------------------------
// 验证码检测脚本
// -------------------------

const DETECT_CAPTCHA = `(function () {
    var widgets = [];
    var hints = [];

    // 交互式验证组件：iframe（reCAPTCHA / hCaptcha / 极验 / Cloudflare）
    Array.from(document.querySelectorAll("iframe")).forEach(function (f) {
        var src = (f.src || "").toLowerCase();
        if (/recaptcha|hcaptcha|geetest|captcha|challenges\\.cloudflare|cf-chl/.test(src)) {
            var r = f.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                widgets.push("iframe: " + f.src.substring(0, 80));
            }
        }
    });

    // 交互式验证组件：元素（滑块 / 拼图 / 点选）
    Array.from(document.querySelectorAll(
        "[class*='captcha'], [id*='captcha'], [class*='geetest'], [id*='geetest'], " +
        "[class*='nc_wrapper'], [id*='nc_'], [class*='slider-captcha'], [class*='verify-slider']"
    )).forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            widgets.push("element: " + el.tagName.toLowerCase() +
                (el.id ? "#" + el.id : ""));
        }
    });

    // 文本提示（可能是短信/图片验证码输入框）
    var m = (document.body.innerText || "").match(
        /验证码|人机验证|安全验证|滑动验证|拖动滑块|拖动下方滑块|captcha|i'm not a robot|我不是机器人/i
    );
    if (m) hints.push("text: " + m[0]);

    function dedup(arr) { return Array.from(new Set(arr)).slice(0, 10); }

    return { widgets: dedup(widgets), hints: dedup(hints) };
})()`;

async function detectCaptcha() {
    try {
        return await page.evaluate(DETECT_CAPTCHA);
    } catch {
        return { widgets: [], hints: [] };
    }
}


// -------------------------
// 观察核心（browser_elements / browser_observe 共用）
// -------------------------

// Level 1：交互元素清单 + ref
async function observeElements() {
    const data = await page.evaluate(COLLECT_ELEMENTS);

    resetRefs();

    const buttons = data.clickable.map(el => ({
        ref: addRef({
            selector: el.selector,
            backupType: "text",
            backupValue: el.text
        }),
        text: el.text,
        tag: el.tag,
        selector: el.selector
    }));

    const inputs = data.inputs.map(el => ({
        ref: addRef({
            selector: el.selector,
            backupType: "placeholder",
            backupValue: el.placeholder
        }),
        name: el.name,
        placeholder: el.placeholder,
        type: el.type,
        selector: el.selector
    }));

    return result(JSON.stringify({ buttons, inputs }, null, 2));
}

// Level 2：Set-of-Mark 标注截图（JPEG 压缩降低 token）
async function markScreenshot() {
    const marks = await page.evaluate(MARK_ELEMENTS);

    resetRefs();

    const mapping = marks.map(m => ({
        n: m.n,
        ref: addRef({
            selector: m.selector,
            backupType: "text",
            backupValue: m.text
        }),
        text: m.text,
        tag: m.tag
    }));

    try {
        const buf = await captureScreenshot({
            type: "jpeg",
            quality: 60
        });

        return {
            content: [
                { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" },
                { type: "text", text: JSON.stringify(mapping, null, 2) }
            ]
        };
    } finally {
        // 修复4：截图失败也要清理覆盖层，避免红框残留在页面上干扰后续操作
        await page.evaluate(() => {
            document.querySelectorAll(".mcp-mark-overlay").forEach(x => x.remove());
        }).catch(() => {});
    }
}


const server = new McpServer({
    name: "browser-agent",
    version: "2.0.0"
});

// 自动为需要浏览器的 tool 注入 ensureBrowser()
const _registerTool = server.registerTool.bind(server);
const noBrowserTools = new Set([
    "browser_errors",
    "browser_clear_errors",
    "browser_flow_list",
    "browser_flow_record",
    "browser_memory_list",
    "browser_forget",
    // Web API 测试工具：纯 HTTP 请求，不涉及浏览器，跳过 ensureBrowser()
    "api_set_env",
    "api_login",
    "api_request",
    "api_assert",
    "api_test_suite",
    "api_suite_run",
    "api_suite_list",
    "api_errors",
    "api_clear_errors"
]);
server.registerTool = (name, meta, handler) => {
    if (noBrowserTools.has(name)) {
        return _registerTool(name, meta, handler);
    }
    return _registerTool(name, meta, async (args) => {
        await ensureBrowser();
        return handler(args);
    });
};


// -------------------------
// 打开网页
// -------------------------

server.registerTool("browser_open", {
    description: "Open website",
    inputSchema: { url: z.string() }
}, async ({ url }) => {
    const before = { url: page.url(), errorCount: errors.length };
    await page.goto(url, { waitUntil: "networkidle" });
    recordStep({ action: "open", url });
    const fb = await actionFeedback(before);
    return result("Opened " + url + "\n" + fb);
});


// -------------------------
// 获取页面文字
// -------------------------

server.registerTool("browser_text", {
    description: "Get page text",
    inputSchema: {}
}, async () => {
    const text = await page.locator("body").innerText();
    return result(text.substring(0, 5000));
});


// -------------------------
// 页面快照
// -------------------------

server.registerTool("browser_snapshot", {
    description: "Get page structure (title/url/button texts/inputs)",
    inputSchema: {}
}, async () => {
    const data = await page.evaluate(() => {
        return {
            title: document.title,
            url: location.href,
            buttons: [...document.querySelectorAll("button,a")]
                .map(x => x.innerText.trim())
                .filter(Boolean)
                .slice(0, 50),
            inputs: [...document.querySelectorAll("input")]
                .map(x => ({ placeholder: x.placeholder, type: x.type }))
        };
    });

    return result(JSON.stringify(data, null, 2));
});


// -------------------------
// 页面分析（结构化信息）
// -------------------------

server.registerTool("browser_analyze_page", {
    description:
        "Analyze current page and return structured information: title, url, " +
        "text, inputs, buttons, links, menus and recent console errors. " +
        "Use this instead of screenshot when you only need to understand the page.",
    inputSchema: {}
}, async () => {
    if (!page) throw new Error("Browser not opened");

    const data = await page.evaluate(() => {
        function clean(arr) {
            return [...new Set(
                arr.map(x => x.trim()).filter(x => x.length > 0)
            )];
        }

        function getMenus() {
            const selectors = [
                "nav a", ".menu a", ".sidebar a", ".ant-menu-item a",
                "[class*='menu'] a", "[class*='nav'] a", "[class*='sidebar'] a",
                "header a", "aside a"
            ];
            const seen = new Map();
            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(a => {
                    const text = a.innerText.trim();
                    if (text && a.href && !seen.has(a.href)) {
                        seen.set(a.href, { text, href: a.href });
                    }
                });
            });
            return [...seen.values()].slice(0, 50);
        }

        return {
            title: document.title,
            url: location.href,
            text: document.body.innerText.slice(0, 5000),
            inputs: [...document.querySelectorAll("input, textarea, select")]
                .map(e => ({
                    tag: e.tagName,
                    type: e.type || e.tagName.toLowerCase(),
                    placeholder: e.placeholder,
                    value: e.value,
                    name: e.name
                })),
            buttons: clean(
                [...document.querySelectorAll(
                    "button, input[type='button'], input[type='submit']"
                )].map(e => e.innerText || e.value)
            ),
            links: clean(
                [...document.querySelectorAll("a")].map(e => e.innerText)
            ),
            menus: getMenus()
        };
    });

    const recentErrors = errors.slice(-20);
    return result(JSON.stringify(
        { ...data, errors: recentErrors },
        null,
        2
    ));
});


// -------------------------
// 站点地图提取（导航菜单/链接）
// -------------------------

server.registerTool("browser_extract_site_map", {
    description:
        "Extract the navigation menu / link structure of the current system. " +
        "Returns text/href pairs useful for building a site map or feature map.",
    inputSchema: {}
}, async () => {
    if (!page) throw new Error("Browser not opened");

    const links = await page.evaluate(() => {
        const selectors = [
            "nav a",
            ".menu a",
            ".sidebar a",
            ".ant-menu-item a",
            "[class*='menu'] a",
            "[class*='nav'] a",
            "[class*='sidebar'] a",
            "header a",
            "aside a",
            "a"
        ];
        const seen = new Set();
        const items = [];
        selectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(a => {
                const text = a.innerText.trim();
                const href = a.href;
                if (!text || !href || seen.has(href)) return;
                seen.add(href);
                items.push({ text, href });
            });
        });
        return items.slice(0, 100);
    });

    return result(JSON.stringify(links, null, 2));
});


// -------------------------
// 元素清单（带 ref + selector）
// -------------------------

server.registerTool("browser_elements", {
    description:
        "List visible clickable elements and inputs. Each gets a short ref (e1, e2...) " +
        "usable in browser_click/browser_fill/browser_select/browser_hover — " +
        "prefer ref over raw selector or text to avoid ambiguity.",
    inputSchema: {}
}, async () => {
    return observeElements();
});


// -------------------------
// Set-of-Mark 标注截图
// -------------------------

server.registerTool("browser_mark_screenshot", {
    description:
        "Screenshot the viewport with numbered boxes drawn over interactive elements " +
        "(Set-of-Mark). Returns the image plus number/ref -> selector mapping. " +
        "Then use browser_click with the ref (e.g. e3).",
    inputSchema: {}
}, async () => {
    return markScreenshot();
});


// -------------------------
// 分层观察
// -------------------------

server.registerTool("browser_observe", {
    description:
        "Layered observation — use the cheapest level that suffices. " +
        "level 0: lightweight status (url/title/error count/captcha flag, ~50 tokens). " +
        "level 1: interactive elements with refs (same as browser_elements). " +
        "level 2: annotated screenshot (same as browser_mark_screenshot).",
    inputSchema: {
        level: z.number().optional()
    }
}, async ({ level }) => {
    const lv = level || 0;

    if (lv === 1) return observeElements();
    if (lv === 2) return markScreenshot();

    // Level 0
    const captcha = await detectCaptcha();
    const data = {
        url: page.url(),
        title: await page.title(),
        errors: errors.length,
        captcha: captcha.widgets.length > 0,
        tabs: context.pages().length
    };
    return result(JSON.stringify(data, null, 2));
});


// -------------------------
// 点击
// -------------------------

server.registerTool("browser_click", {
    description:
        "Click element. Prefer 'ref' (from browser_elements/browser_mark_screenshot), " +
        "then 'selector', then 'text'. Returns what changed after the click.",
    inputSchema: {
        ref: z.string().optional(),
        selector: z.string().optional(),
        text: z.string().optional()
    }
}, async ({ ref, selector, text }) => {
    const before = { url: page.url(), errorCount: errors.length };

    const t = resolveTarget({ ref, selector });
    let targetDesc;
    let note = "";

    if (t) {
        note = await clickWithBackup(t);
        targetDesc = ref || selector;
        recordStep({ action: "click", selector: t.selector });
    } else if (text) {
        await page.getByText(text, { exact: true }).first().click();
        targetDesc = text;
        recordStep({ action: "click", text });
    } else {
        throw new Error("Provide 'ref', 'selector' or 'text'");
    }

    const fb = await actionFeedback(before);
    return result("Clicked " + targetDesc + note + "\n" + fb);
});


// -------------------------
// 输入
// -------------------------

server.registerTool("browser_fill", {
    description:
        "Fill input. Prefer 'ref' (from browser_elements), then 'selector', then 'placeholder'.",
    inputSchema: {
        ref: z.string().optional(),
        selector: z.string().optional(),
        placeholder: z.string().optional(),
        value: z.string()
    }
}, async ({ ref, selector, placeholder, value }) => {
    const before = { url: page.url(), errorCount: errors.length };

    const t = resolveTarget({ ref, selector });
    let targetDesc;
    let note = "";

    if (t) {
        note = await fillWithBackup(t, value);
        targetDesc = ref || selector;
        recordStep({ action: "fill", selector: t.selector, value });
    } else if (placeholder) {
        await page.getByPlaceholder(placeholder).fill(value);
        targetDesc = placeholder;
        recordStep({ action: "fill", placeholder, value });
    } else {
        throw new Error("Provide 'ref', 'selector' or 'placeholder'");
    }

    const fb = await actionFeedback(before);
    return result("Filled " + targetDesc + note + "\n" + fb);
});


// -------------------------
// 键盘按键
// -------------------------

server.registerTool("browser_press", {
    description:
        "Press a keyboard key, e.g. Enter, Escape, Tab, ArrowDown, Control+a. " +
        "Useful for submitting forms or closing dialogs.",
    inputSchema: { key: z.string() }
}, async ({ key }) => {
    const before = { url: page.url(), errorCount: errors.length };
    await page.keyboard.press(key);
    recordStep({ action: "press", value: key });
    const fb = await actionFeedback(before);
    return result("Pressed " + key + "\n" + fb);
});


// -------------------------
// 滚动
// -------------------------

server.registerTool("browser_scroll", {
    description: "Scroll the page to load lazy content.",
    inputSchema: {
        direction: z.enum(["up", "down"]),
        amount: z.number().optional()
    }
}, async ({ direction, amount }) => {
    const px = (amount || 600) * (direction === "up" ? -1 : 1);
    await page.mouse.wheel(0, px);
    recordStep({ action: "scroll", value: String(px) });
    await page.waitForTimeout(500);
    return result("Scrolled " + direction + " " + Math.abs(px) + "px");
});


// -------------------------
// 下拉框选择
// -------------------------

server.registerTool("browser_select", {
    description: "Select an option in a <select> dropdown by value or visible label.",
    inputSchema: {
        ref: z.string().optional(),
        selector: z.string().optional(),
        value: z.string()
    }
}, async ({ ref, selector, value }) => {
    const t = resolveTarget({ ref, selector });
    if (!t) throw new Error("Provide 'ref' or 'selector'");

    await page.selectOption(t.selector, { label: value }).catch(() =>
        page.selectOption(t.selector, value)
    );

    return result("Selected " + value + " in " + (ref || selector));
});


// -------------------------
// 悬停
// -------------------------

server.registerTool("browser_hover", {
    description: "Hover over an element to trigger hover menus.",
    inputSchema: {
        ref: z.string().optional(),
        selector: z.string().optional(),
        text: z.string().optional()
    }
}, async ({ ref, selector, text }) => {
    const t = resolveTarget({ ref, selector });

    if (t) {
        await page.hover(t.selector);
        return result("Hovered " + (ref || selector));
    }
    if (text) {
        await page.getByText(text, { exact: true }).first().hover();
        return result("Hovered " + text);
    }
    throw new Error("Provide 'ref', 'selector' or 'text'");
});


// -------------------------
// Tab 管理
// -------------------------

server.registerTool("browser_tabs", {
    description: "List all browser tabs (index, title, url, active).",
    inputSchema: {}
}, async () => {
    const pages = context.pages();
    const list = await Promise.all(
        pages.map(async (p, i) => ({
            index: i,
            active: p === page,
            title: await p.title(),
            url: p.url()
        }))
    );
    return result(JSON.stringify(list, null, 2));
});

server.registerTool("browser_switch_tab", {
    description: "Switch to a tab by index (from browser_tabs).",
    inputSchema: { index: z.number() }
}, async ({ index }) => {
    const pages = context.pages();
    if (index < 0 || index >= pages.length) {
        throw new Error("Tab index out of range: " + index);
    }
    page = pages[index];
    await page.bringToFront();
    return result("Switched to tab " + index + ": " + page.url());
});

server.registerTool("browser_new_tab", {
    description: "Open a new tab, optionally with a URL.",
    inputSchema: { url: z.string().optional() }
}, async ({ url }) => {
    page = await context.newPage();
    attachListeners(page);
    if (url) {
        await page.goto(url, { waitUntil: "networkidle" });
    }
    return result("New tab: " + page.url());
});


// -------------------------
// 等待人工完成验证
// -------------------------

server.registerTool("browser_wait_human", {
    description:
        "Wait for the user to manually solve a CAPTCHA / human-verification widget " +
        "in the browser. Polls until the widget disappears or timeout (default 120s). " +
        "Always tell the user you are waiting before calling this.",
    inputSchema: {
        timeout: z.number().optional()
    }
}, async ({ timeout }) => {
    const seconds = timeout || 120;
    const deadline = Date.now() + seconds * 1000;

    while (Date.now() < deadline) {
        const captcha = await detectCaptcha();
        if (!captcha.widgets.length) {
            return result(
                "Captcha cleared — human verification done, you can continue."
            );
        }
        await page.waitForTimeout(2000);
    }

    return result(
        "Timeout: captcha still present after " + seconds + "s. " +
        "Ask the user if they need more time, then call browser_wait_human again."
    );
});


// -------------------------
// 截图
// -------------------------

server.registerTool("browser_screenshot", {
    description: "Save viewport screenshot in current project (JPEG, 10s timeout, with fallback)",
    inputSchema: {
        name: z.string().optional(),
        fullPage: z.boolean().optional()
    }
}, async ({ name, fullPage }) => {
    ensureDir();

    const fileName = (name || `shot-${Date.now()}`) + ".jpg";
    const file = path.join(screenshotDir, fileName);

    try {
        const buf = await captureScreenshot({ fullPage: !!fullPage });
        fs.writeFileSync(file, buf);

        return {
            content: [
                {
                    type: "image",
                    data: buf.toString("base64"),
                    mimeType: "image/jpeg"
                },
                { type: "text", text: "Screenshot saved:\n" + file }
            ]
        };
    } catch (e) {
        const text = await page.locator("body").innerText().catch(() => "");
        return result(
            "Screenshot failed: " + e.message +
            "\n\nPage text fallback:\n" + text.substring(0, 3000)
        );
    }
});


// -------------------------
// 设置浏览器视口
// -------------------------

server.registerTool("browser_set_viewport", {
    description: "Set browser viewport size. Recommended: 1440x900.",
    inputSchema: {
        width: z.number().optional(),
        height: z.number().optional()
    }
}, async ({ width, height }) => {
    await page.setViewportSize({
        width: width || 1440,
        height: height || 900
    });
    return result(`Viewport set to ${width || 1440}x${height || 900}`);
});


// -------------------------
// 查看错误
// -------------------------

server.registerTool("browser_errors", {
    description: "Get browser errors",
    inputSchema: {}
}, async () => {
    return result(
        errors.length ? JSON.stringify(errors, null, 2) : "No errors"
    );
});


// -------------------------
// 清空错误
// -------------------------

server.registerTool("browser_clear_errors", {
    description: "Clear collected browser errors",
    inputSchema: {}
}, async () => {
    errors = [];
    return result("Errors cleared");
});


// -------------------------
// 自动测试
// -------------------------

server.registerTool("browser_auto_test", {
    description:
        "Run browser test steps and save screenshots/errors. " +
        "click/fill steps accept ref (from browser_observe), selector, or text/placeholder. " +
        "For repeated flows prefer browser_flow_record/browser_flow_run.",
    inputSchema: {
        steps: z.array(
            z.object({
                action: z.enum([
                    "open", "click", "fill", "press",
                    "scroll", "wait", "screenshot"
                ]),
                url: z.string().optional(),
                text: z.string().optional(),
                ref: z.string().optional(),
                selector: z.string().optional(),
                placeholder: z.string().optional(),
                value: z.string().optional(),
                name: z.string().optional()
            })
        )
    }
}, async ({ steps }) => {
    const log = await runSteps(steps);
    let report = log.join("\n");

    // 自动追加页面分析、截图与错误汇总
    try {
        const analyzeData = await page.evaluate(() => {
            function clean(arr) {
                return [...new Set(
                    arr.map(x => x.trim()).filter(x => x.length > 0)
                )];
            }
            return {
                title: document.title,
                url: location.href,
                text: document.body.innerText.slice(0, 2000),
                buttons: clean(
                    [...document.querySelectorAll(
                        "button, input[type='button'], input[type='submit']"
                    )].map(e => e.innerText || e.value)
                ),
                inputs: [...document.querySelectorAll("input, textarea, select")]
                    .map(e => e.placeholder || e.name)
                    .filter(Boolean)
            };
        });
        report += "\n\n--- Page Analysis ---\n" + JSON.stringify(analyzeData, null, 2);
    } catch (e) {
        report += "\n\nPage analysis failed: " + e.message;
    }

    try {
        ensureDir();
        const file = path.join(screenshotDir, `auto-test-${Date.now()}.jpg`);
        const buf = await captureScreenshot();
        fs.writeFileSync(file, buf);
        report += "\n\nScreenshot saved: " + file;
    } catch (e) {
        report += "\n\nScreenshot failed: " + e.message;
    }

    const freshErrors = errors.slice(-10);
    if (freshErrors.length) {
        report += "\n\nRecent errors:\n" + JSON.stringify(freshErrors, null, 2);
    }

    return result(report);
});


// -------------------------
// 流程录制 & 回放
// -------------------------

const flowsDir = path.join(projectRoot, "browser-flows");

server.registerTool("browser_flow_record", {
    description:
        "Record browser actions into a named reusable flow. " +
        "mode=start begins recording (open/click/fill/press/scroll are captured with selectors); " +
        "mode=stop saves the flow to disk for later replay with browser_flow_run.",
    inputSchema: {
        name: z.string(),
        mode: z.enum(["start", "stop"])
    }
}, async ({ name, mode }) => {
    if (mode === "start") {
        recording = { name, steps: [] };
        return result(
            "Recording started: " + name +
            "\nPerform the task now, then call browser_flow_record with mode=stop."
        );
    }

    if (!recording) throw new Error("No active recording");

    const steps = recording.steps;
    const fname = recording.name;
    recording = null;

    if (!fs.existsSync(flowsDir)) {
        fs.mkdirSync(flowsDir, { recursive: true });
    }

    const file = path.join(flowsDir, fname + ".json");
    fs.writeFileSync(file, JSON.stringify(steps, null, 2));

    return result(
        "Flow saved: " + file + " (" + steps.length + " steps)\n" +
        "Replay it later with browser_flow_run {name: \"" + fname + "\"}"
    );
});

server.registerTool("browser_flow_run", {
    description: "Replay a recorded flow by name (from browser_flow_record).",
    inputSchema: { name: z.string() }
}, async ({ name }) => {
    const file = path.join(flowsDir, name + ".json");
    if (!fs.existsSync(file)) {
        throw new Error("Flow not found: " + name + " (check browser_flow_list)");
    }

    const steps = JSON.parse(fs.readFileSync(file, "utf8"));
    const log = await runSteps(steps);

    return result(
        "Flow " + name + " (" + steps.length + " steps):\n" + log.join("\n")
    );
});

server.registerTool("browser_flow_list", {
    description: "List recorded flows.",
    inputSchema: {}
}, async () => {
    if (!fs.existsSync(flowsDir)) return result("No flows recorded");

    const names = fs.readdirSync(flowsDir)
        .filter(f => f.endsWith(".json"))
        .map(f => f.replace(/\.json$/, ""));

    return result(names.length ? names.join("\n") : "No flows recorded");
});


// -------------------------
// 页面元素记忆（语义化 ref 持久化）
// -------------------------

const memoryFile = path.join(projectRoot, "browser-memory.json");

function loadMemory() {
    if (!fs.existsSync(memoryFile)) return {};
    try {
        return JSON.parse(fs.readFileSync(memoryFile, "utf8"));
    } catch {
        return {};
    }
}

function saveMemory(mem) {
    fs.writeFileSync(memoryFile, JSON.stringify(mem, null, 2));
}

server.registerTool("browser_remember", {
    description:
        "Save current refs under a semantic page name for later reuse. " +
        "Refs are resolved to durable selectors (+ backups) before saving, " +
        "so they survive page reloads. Example: " +
        "{name: \"loginPage\", refs: {username: \"e1\", password: \"e2\", submit: \"e3\"}}. " +
        "Recall later with browser_recall.",
    inputSchema: {
        name: z.string(),
        refs: z.record(z.string())
    }
}, async ({ name, refs }) => {
    const elements = {};
    const missing = [];

    for (const [key, ref] of Object.entries(refs)) {
        const t = refMap[ref];
        if (t) {
            elements[key] = {
                selector: t.selector,
                backupType: t.backupType || null,
                backupValue: t.backupValue || null
            };
        } else {
            missing.push(key + "(" + ref + ")");
        }
    }

    if (missing.length) {
        throw new Error(
            "Unknown refs: " + missing.join(", ") +
            " — run browser_observe level 1 first"
        );
    }

    const mem = loadMemory();
    mem[name] = {
        urlPattern: new URL(page.url()).pathname,
        elements
    };
    saveMemory(mem);

    return result(
        "Saved " + name + " (" + Object.keys(elements).length +
        " elements, urlPattern: " + mem[name].urlPattern + ")"
    );
});

server.registerTool("browser_recall", {
    description:
        "Load a saved page element map (from browser_remember) and register " +
        "fresh refs for it, skipping re-observation. Returns key -> new ref mapping " +
        "plus any elements whose selector no longer exists on the page.",
    inputSchema: {
        name: z.string()
    }
}, async ({ name }) => {
    const mem = loadMemory();
    const entry = mem[name];
    if (!entry) {
        throw new Error("No memory named: " + name + " (check browser_memory_list)");
    }

    // URL 校验（防串页）
    const currentPath = new URL(page.url()).pathname;
    const urlNote = currentPath === entry.urlPattern
        ? null
        : "⚠️ URL mismatch: saved for " + entry.urlPattern +
          ", current is " + currentPath;

    // 快速校验 selector 是否仍在页面上
    const keys = Object.keys(entry.elements);
    const sels = keys.map(k => entry.elements[k].selector);
    const valid = await page.evaluate(selectors =>
        selectors.map(s => {
            try { return !!document.querySelector(s); }
            catch { return false; }
        }), sels);

    // 注册新 ref
    const mapping = {};
    const stale = [];
    keys.forEach((key, i) => {
        const ref = addRef(entry.elements[key]);
        mapping[key] = ref;
        if (!valid[i]) stale.push(key);
    });

    const lines = [JSON.stringify(mapping, null, 2)];
    if (urlNote) lines.push(urlNote);
    if (stale.length) {
        lines.push(
            "⚠️ selectors not found on page: " + stale.join(", ") +
            " (they may still work via backup; otherwise re-observe)"
        );
    }

    return result(lines.join("\n"));
});

server.registerTool("browser_memory_list", {
    description: "List saved page element memories.",
    inputSchema: {}
}, async () => {
    const mem = loadMemory();
    const names = Object.keys(mem);
    if (!names.length) return result("No memories saved");

    const list = names.map(n =>
        n + " [" + mem[n].urlPattern + "]: " +
        Object.keys(mem[n].elements).join(", ")
    );
    return result(list.join("\n"));
});

server.registerTool("browser_forget", {
    description: "Delete a saved page element memory.",
    inputSchema: { name: z.string() }
}, async ({ name }) => {
    const mem = loadMemory();
    if (!mem[name]) throw new Error("No memory named: " + name);
    delete mem[name];
    saveMemory(mem);
    return result("Forgot " + name);
});


// -------------------------
// Web API 测试能力
// -------------------------
//
// 与浏览器 MCP 互补：浏览器测的是"UI 表现"，这里测的是"接口本身"。
// 不依赖浏览器/CDP，注册进 noBrowserTools，调用时不会触发 ensureBrowser()。

const apiEnvFile = path.join(projectRoot, "api-env.json");
const apiSuitesDir = path.join(projectRoot, "api-suites");

let apiErrors = [];
const MAX_API_ERRORS = 200;

function pushApiError(e) {
    apiErrors.push({ time: new Date().toISOString(), ...e });
    if (apiErrors.length > MAX_API_ERRORS) {
        apiErrors = apiErrors.slice(-MAX_API_ERRORS);
    }
}

function loadApiEnv() {
    if (!fs.existsSync(apiEnvFile)) return { baseUrl: "", defaultHeaders: {} };
    try {
        const env = JSON.parse(fs.readFileSync(apiEnvFile, "utf8"));
        return { baseUrl: env.baseUrl || "", defaultHeaders: env.defaultHeaders || {} };
    } catch {
        return { baseUrl: "", defaultHeaders: {} };
    }
}

function saveApiEnv(env) {
    fs.writeFileSync(apiEnvFile, JSON.stringify(env, null, 2));
}

// 简单 dot-path 取值，支持数组下标，如 "data.list.0.id"
function getByPath(obj, pathStr) {
    if (!pathStr) return obj;
    return pathStr.split(".").reduce(
        (cur, key) => (cur == null ? undefined : cur[key]),
        obj
    );
}

// 敏感值遮蔽（token/密码等只在日志里露出首尾几位）
function mask(value) {
    if (typeof value !== "string" || value.length <= 10) return "***";
    return value.slice(0, 6) + "..." + value.slice(-4);
}

// 核心请求函数：api_request / api_assert / api_login / suite 运行共用
async function doApiRequest({ method = "GET", url, headers = {}, body, query, timeout = 15000 }) {
    const env = loadApiEnv();
    let fullUrl = /^https?:\/\//i.test(url) ? url : (env.baseUrl || "") + url;

    if (query && Object.keys(query).length) {
        const qs = new URLSearchParams(query).toString();
        fullUrl += (fullUrl.includes("?") ? "&" : "?") + qs;
    }

    const mergedHeaders = { ...(env.defaultHeaders || {}), ...(headers || {}) };

    let payload;
    const hasBody = body !== undefined && body !== null;
    if (hasBody) {
        if (typeof body === "string") {
            payload = body;
        } else {
            payload = JSON.stringify(body);
            if (!Object.keys(mergedHeaders).some(k => k.toLowerCase() === "content-type")) {
                mergedHeaders["Content-Type"] = "application/json";
            }
        }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const start = Date.now();

    let res;
    try {
        res = await fetch(fullUrl, {
            method,
            headers: mergedHeaders,
            body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : payload,
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timer);
        const isAbort = e.name === "AbortError";
        const msg = isAbort
            ? `Request timed out after ${timeout}ms (url: ${fullUrl})`
            : `Request failed: ${e.message} (url: ${fullUrl})`;
        pushApiError({ type: "network", method, url: fullUrl, message: msg });
        throw new Error(msg);
    }
    clearTimeout(timer);

    const durationMs = Date.now() - start;
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }

    const respHeaders = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });

    if (res.status >= 400) {
        pushApiError({
            type: "http", method, url: fullUrl,
            status: res.status, message: text.slice(0, 300)
        });
    }

    return {
        url: fullUrl, method: method.toUpperCase(), status: res.status, ok: res.ok,
        headers: respHeaders, bodyText: text, bodyJson: json, durationMs
    };
}

// 单条用例（api_assert 逻辑）复用于 api_test_suite / api_suite_run
async function runOneCase(c) {
    const label = c.name || `${(c.method || "GET").toUpperCase()} ${c.url}`;
    try {
        const r = await doApiRequest(c);
        const failures = [];

        if (c.expectStatus !== undefined && r.status !== c.expectStatus) {
            failures.push(`status expected ${c.expectStatus}, got ${r.status}`);
        }
        if (c.expectFields) {
            for (const [fieldPath, expected] of Object.entries(c.expectFields)) {
                const actual = getByPath(r.bodyJson, fieldPath);
                if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                    failures.push(`field "${fieldPath}" expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
                }
            }
        }
        if (c.expectBodyContains && !r.bodyText.includes(c.expectBodyContains)) {
            failures.push(`body does not contain "${c.expectBodyContains}"`);
        }

        const pass = failures.length === 0;
        if (!pass) {
            pushApiError({
                type: "assert", method: r.method, url: r.url,
                status: r.status, message: `${label}: ${failures.join("; ")}`
            });
        }

        return {
            name: label, pass, status: r.status, durationMs: r.durationMs,
            failures, url: r.url
        };
    } catch (e) {
        return { name: label, pass: false, failures: [e.message] };
    }
}

async function runApiCases(cases) {
    const details = [];
    for (const c of cases) {
        details.push(await runOneCase(c));
    }
    const passed = details.filter(d => d.pass).length;
    return { total: details.length, passed, failed: details.length - passed, details };
}

function formatSuiteReport(name, r) {
    const lines = [
        `${name || "suite"}: ${r.passed}/${r.total} passed`
    ];
    r.details.forEach(d => {
        const mark = d.pass ? "✅" : "❌";
        const status = d.status !== undefined ? ` [${d.status}]` : "";
        const time = d.durationMs !== undefined ? ` ${d.durationMs}ms` : "";
        lines.push(`${mark} ${d.name}${status}${time}`);
        if (!d.pass) {
            d.failures.forEach(f => lines.push(`    - ${f}`));
        }
    });
    return lines.join("\n");
}

// --- 环境与鉴权 ---

server.registerTool("api_set_env", {
    description:
        "Set base URL and/or default headers used by all subsequent api_request / " +
        "api_assert / api_test_suite calls. Merges with existing env unless replace=true. " +
        "Typical use: set baseUrl once at the start of a session, e.g. " +
        '{baseUrl: "https://localhost:5001"}.',
    inputSchema: {
        baseUrl: z.string().optional(),
        defaultHeaders: z.record(z.string()).optional(),
        replace: z.boolean().optional()
    }
}, async ({ baseUrl, defaultHeaders, replace }) => {
    const current = loadApiEnv();
    const next = replace
        ? { baseUrl: baseUrl ?? "", defaultHeaders: defaultHeaders ?? {} }
        : {
            baseUrl: baseUrl ?? current.baseUrl,
            defaultHeaders: { ...current.defaultHeaders, ...(defaultHeaders || {}) }
        };
    saveApiEnv(next);

    const shownHeaders = { ...next.defaultHeaders };
    for (const k of Object.keys(shownHeaders)) {
        if (/auth|token|cookie/i.test(k)) shownHeaders[k] = mask(shownHeaders[k]);
    }

    return result(
        "API env saved:\n" + JSON.stringify({ baseUrl: next.baseUrl, defaultHeaders: shownHeaders }, null, 2)
    );
});

server.registerTool("api_login", {
    description:
        "Call a login endpoint, extract a token from the JSON response via tokenPath " +
        "(dot path, e.g. \"data.token\"), and store it into defaultHeaders for all " +
        "subsequent api_request/api_assert calls. Fails loudly if the token path is not found.",
    inputSchema: {
        url: z.string().describe("Login endpoint, absolute or relative to baseUrl"),
        method: z.enum(["GET", "POST", "PUT", "PATCH"]).optional(),
        body: z.any().optional().describe("Login credentials, e.g. {username, password}"),
        tokenPath: z.string().optional().describe('Default "token"'),
        headerName: z.string().optional().describe('Default "Authorization"'),
        headerPrefix: z.string().optional().describe('Default "Bearer "')
    }
}, async ({ url, method, body, tokenPath, headerName, headerPrefix }) => {
    const r = await doApiRequest({ method: method || "POST", url, body });

    if (!r.ok) {
        throw new Error(`Login failed: HTTP ${r.status}\n${r.bodyText.slice(0, 500)}`);
    }

    const path_ = tokenPath || "token";
    const token = getByPath(r.bodyJson, path_);
    if (!token) {
        throw new Error(
            `Login response did not contain a value at "${path_}". ` +
            `Response body: ${r.bodyText.slice(0, 500)}`
        );
    }

    const env = loadApiEnv();
    env.defaultHeaders = {
        ...env.defaultHeaders,
        [headerName || "Authorization"]: (headerPrefix ?? "Bearer ") + token
    };
    saveApiEnv(env);

    return result(
        `Login OK (${r.durationMs}ms). Token stored as "${headerName || "Authorization"}": ${mask(token)}`
    );
});

// --- 请求与断言 ---

server.registerTool("api_request", {
    description:
        "Send a single HTTP request to a web API (relative URLs resolve against the " +
        "baseUrl set by api_set_env) and return status, headers and body. Use this for " +
        "one-off exploration; use api_assert when you also want pass/fail checks.",
    inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
        url: z.string(),
        headers: z.record(z.string()).optional(),
        body: z.any().optional(),
        query: z.record(z.string()).optional(),
        timeout: z.number().optional()
    }
}, async ({ method, url, headers, body, query, timeout }) => {
    const r = await doApiRequest({ method, url, headers, body, query, timeout });
    const bodyPreview = r.bodyJson !== undefined
        ? JSON.stringify(r.bodyJson, null, 2)
        : r.bodyText;

    return result(
        `${r.method} ${r.url}\n` +
        `Status: ${r.status} ${r.ok ? "OK" : ""}  (${r.durationMs}ms)\n\n` +
        `Body:\n${bodyPreview.slice(0, 3000)}`
    );
});

server.registerTool("api_assert", {
    description:
        "Send a request and assert on it: expectStatus (exact status code), " +
        "expectFields (dot-path -> expected value, e.g. {\"data.total\": 10}), " +
        "expectBodyContains (substring match on raw response text). Returns a clear " +
        "pass/fail report; failures are also recorded and retrievable via api_errors.",
    inputSchema: {
        name: z.string().optional().describe("Label for this check, shown in the report"),
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
        url: z.string(),
        headers: z.record(z.string()).optional(),
        body: z.any().optional(),
        query: z.record(z.string()).optional(),
        timeout: z.number().optional(),
        expectStatus: z.number().optional(),
        expectFields: z.record(z.any()).optional(),
        expectBodyContains: z.string().optional()
    }
}, async (args) => {
    const d = await runOneCase(args);
    const mark = d.pass ? "✅ PASS" : "❌ FAIL";
    const lines = [`${mark}: ${d.name}`];
    if (d.status !== undefined) lines.push(`Status: ${d.status}  (${d.durationMs}ms)`);
    d.failures.forEach(f => lines.push(`  - ${f}`));
    return result(lines.join("\n"));
});

// --- 用例集：一次跑多条，可选保存/回放 ---

server.registerTool("api_test_suite", {
    description:
        "Run a list of API test cases (same shape as api_assert's inputs) in sequence " +
        "and return an aggregated pass/fail report. Pass save=true with a name to persist " +
        "the case list to disk for later replay via api_suite_run.",
    inputSchema: {
        name: z.string().optional(),
        save: z.boolean().optional(),
        cases: z.array(
            z.object({
                name: z.string().optional(),
                method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
                url: z.string(),
                headers: z.record(z.string()).optional(),
                body: z.any().optional(),
                query: z.record(z.string()).optional(),
                expectStatus: z.number().optional(),
                expectFields: z.record(z.any()).optional(),
                expectBodyContains: z.string().optional()
            })
        )
    }
}, async ({ name, save, cases }) => {
    const r = await runApiCases(cases);

    if (save && name) {
        if (!fs.existsSync(apiSuitesDir)) fs.mkdirSync(apiSuitesDir, { recursive: true });
        fs.writeFileSync(
            path.join(apiSuitesDir, name + ".json"),
            JSON.stringify(cases, null, 2)
        );
    }

    return result(formatSuiteReport(name, r) + (save && name ? `\n\nSaved as suite: ${name}` : ""));
});

server.registerTool("api_suite_run", {
    description: "Replay a previously saved API test suite by name (from api_test_suite with save=true).",
    inputSchema: { name: z.string() }
}, async ({ name }) => {
    const file = path.join(apiSuitesDir, name + ".json");
    if (!fs.existsSync(file)) {
        throw new Error(`Suite not found: ${name} (check api_suite_list)`);
    }
    const cases = JSON.parse(fs.readFileSync(file, "utf8"));
    const r = await runApiCases(cases);
    return result(formatSuiteReport(name, r));
});

server.registerTool("api_suite_list", {
    description: "List saved API test suites.",
    inputSchema: {}
}, async () => {
    if (!fs.existsSync(apiSuitesDir)) return result("No suites saved");
    const names = fs.readdirSync(apiSuitesDir)
        .filter(f => f.endsWith(".json"))
        .map(f => f.replace(/\.json$/, ""));
    return result(names.length ? names.join("\n") : "No suites saved");
});

// --- 错误查看 ---

server.registerTool("api_errors", {
    description: "List recent API errors (network failures, HTTP 4xx/5xx, failed assertions).",
    inputSchema: { limit: z.number().optional() }
}, async ({ limit }) => {
    const recent = apiErrors.slice(-(limit || 20));
    return result(recent.length ? JSON.stringify(recent, null, 2) : "No API errors recorded");
});

server.registerTool("api_clear_errors", {
    description: "Clear the recorded API error list.",
    inputSchema: {}
}, async () => {
    const n = apiErrors.length;
    apiErrors = [];
    return result(`Cleared ${n} API error(s)`);
});


// -------------------------
// 启动
// -------------------------

await server.connect(new StdioServerTransport());
