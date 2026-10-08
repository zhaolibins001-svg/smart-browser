# Privacy Policy

**Smart Browser MCP is a local, self-hosted MCP server.** It ships no backend, no account system, no telemetry and no analytics. The maintainers receive no data about how you use it.

Last updated: 2026-10-08

---

## 1. What the server never collects

- No usage statistics, crash reports, or telemetry of any kind.
- No data is uploaded to the maintainers or to any third party.
- No advertising or tracking identifiers.

## 2. What is written to your machine

All persistent state is written **inside the working directory from which you launch the server** (`process.cwd()`) — never to a remote service:

| File / directory | Written by | Contents | How to remove |
| --- | --- | --- | --- |
| `browser-screenshots/*.jpg` | `browser_screenshot`, `browser_mark_screenshot` | JPEG screenshots of the page | delete the folder |
| `browser-flows/*.json` | `browser_flow_record` | Recorded interaction steps | delete the file |
| `browser-memory.json` | `browser_remember` | Element ref → selector maps per site | `browser_forget`, or delete the file |
| `api-suites/*.json` | `api_test_suite` (`save: true`) | Saved HTTP request/assertion suites | delete the file |
| `api-env.json` | `api_set_env` | Environment variables for API tests | delete the file |
| In-memory only | `browser_errors`, `api_errors`, flow recording buffer | Errors, refs, recording state | `browser_clear_errors` / `api_clear_errors`, or process exit |

These paths are already listed in the repository's `.gitignore` so they are not committed by accident.

## 3. Credentials and secrets

- `api-env.json` and `api-suites/*.json` **may contain secrets** (tokens, passwords, session IDs) that you passed to `api_set_env` / `api_login`. They are stored **in plain text, locally**. Do not commit them, and treat them like any other local credential file.
- Browser login state lives in the browser profile of the local Chrome / Edge instance that the server connects to over CDP. The server neither copies nor transmits it.
- The server itself never sends credentials anywhere. Credentials only travel to the host **you** explicitly specify as a request target.

## 4. Network access

The server is a client of the pages and endpoints **you** point it at:

- **Browser automation** — requests are issued by your local Chrome / Edge (via Playwright + CDP) and go directly to the sites you visit, exactly like normal browsing. The MCP client (e.g. Claude Code, Claude Desktop, Cursor) decides which URLs are opened.
- **API testing** (`api_request`, `api_login`, `api_suite_run`) — sends HTTP requests to the URL supplied in the tool call.
- **Otherwise idle** — no outbound connections are made at startup or while idle. The browser is launched lazily, only on the first tool call that needs it.

## 5. Cookies and tracking

The server sets no cookies, uses no trackers, and performs no cross-site identification. Sites you visit may set their own cookies in the browser profile, as they would during normal browsing.

## 6. Third-party components

| Component | Role | Privacy impact |
| --- | --- | --- |
| Chrome / Edge (already installed on your machine) | Executes the pages | Governed by Google's / Microsoft's own policies |
| Playwright | Drives the browser over CDP | Local library, no telemetry |
| `@modelcontextprotocol/sdk` | MCP protocol transport (stdio) | Local library, communicates over stdin/stdout only |
| Zod | Input validation | Local library |

No third-party analytics, crash-reporting, or ad SDKs are used.

## 7. Data retention

Data persists until you delete it. Nothing expires automatically, and nothing is backed up remotely.

## 8. Children's privacy

This tool is a developer utility and is not directed at children under 13.

## 9. Changes to this policy

Material changes will be noted in the repository's release notes and reflected in the "Last updated" date above.

## 10. Contact

Questions or concerns: open an issue at
<https://github.com/zhaolibins001-svg/smart-browser/issues>
or <https://gitee.com/zhaolibin001/smart-browser/issues>
