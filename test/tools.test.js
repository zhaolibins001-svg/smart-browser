// Smart Browser MCP — 基础契约测试
//
// 覆盖范围（不启动浏览器，秒级完成）：
//   1. 服务器能通过 stdio 启动并响应 tools/list
//   2. 工具数量与 README 声明一致
//   3. 每个工具都声明了四个 MCP 提示（必须是显式布尔值，OpenAI/Claude 目录硬性要求）
//   4. 会写文件系统或改动页面 DOM 的工具不得标记为 readOnlyHint（防止注解回归）
//
// 运行：npm test（会自动先 build）

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectRoot, "dist", "index.js");

const EXPECTED_TOOL_COUNT = 39;
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

// 这些工具会写文件系统（截图落盘）或注入/移除页面覆盖层，因此不能声称只读
const NOT_READ_ONLY = ["browser_screenshot", "browser_mark_screenshot", "browser_observe"];

async function withServer(run) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverEntry],
        cwd: projectRoot
    });

    const client = new Client({ name: "smart-browser-tests", version: "1.0.0" });

    try {
        await client.connect(transport);
        return await run(client);
    } finally {
        await client.close().catch(() => {});
    }
}

test("server starts over stdio and exposes the documented tools", async () => {
    await withServer(async (client) => {
        const { tools } = await client.listTools();

        assert.equal(
            tools.length,
            EXPECTED_TOOL_COUNT,
            "tool count changed — update this test and the README tool list together"
        );

        const names = new Set(tools.map((t) => t.name));
        for (const required of ["browser_open", "browser_observe", "browser_click", "api_request"]) {
            assert.ok(names.has(required), `missing expected tool: ${required}`);
        }
    });
});

test("every tool declares all four boolean hints", async () => {
    await withServer(async (client) => {
        const { tools } = await client.listTools();

        for (const tool of tools) {
            for (const hint of HINTS) {
                assert.equal(
                    typeof tool.annotations?.[hint],
                    "boolean",
                    `${tool.name} is missing a boolean ${hint}`
                );
            }
        }
    });
});

test("tools that touch the disk or the DOM are not marked read-only", async () => {
    await withServer(async (client) => {
        const { tools } = await client.listTools();

        for (const name of NOT_READ_ONLY) {
            const tool = tools.find((t) => t.name === name);
            assert.ok(tool, `${name} is no longer registered`);

            assert.equal(
                tool.annotations.readOnlyHint,
                false,
                `${name} writes to disk / mutates the page, so readOnlyHint must be false`
            );

            assert.equal(
                tool.annotations.destructiveHint,
                false,
                `${name} only adds files or transient overlays, so destructiveHint must stay false`
            );
        }
    });
});
