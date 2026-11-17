import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

const PORT = 3055;
let plugin = null;
let seq = 0;
const pending = new Map();

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (ws) => {
  plugin = ws;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  ws.on("close", () => { if (plugin === ws) plugin = null; });
});

function call(payload) {
  return new Promise((resolve, reject) => {
    if (!plugin || plugin.readyState !== 1) return reject(new Error("Figma plugin not connected. Run Plugins > Development > Claude Bridge in Figma."));
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, 90000);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    plugin.send(JSON.stringify({ id, ...payload }));
  });
}
const text = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
const wrap = (fn) => async (a) => { try { return await fn(a); } catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; } };

const server = new McpServer({ name: "figma-claude-bridge", version: "0.1.0" });
server.tool("figma_document", "Current Figma file name, current page and page list", {}, wrap(async () => text(await call({ cmd: "document" }))));
server.tool("figma_selection", "Nodes currently selected in Figma, with children, geometry, fills and text", {}, wrap(async () => text(await call({ cmd: "selection" }))));
server.tool("figma_tokens", "Design tokens defined in the file: variable collections and variables (with values per mode), text styles, effect styles and paint styles. Read this before designing so colors, spacing and type are bound to existing tokens, not hardcoded.", {}, wrap(async () => text(await call({ cmd: "tokens" }))));
server.tool("figma_components", "Local components and component sets on every page, with id, key, page, size, properties and variants. Read this before designing so existing components are instanced, not redrawn. The first call loads all pages and can take several seconds.", {}, wrap(async () => text(await call({ cmd: "components" }))));
server.tool("figma_lint", "Check a node and everything inside it for design violations, computed from node numbers: fractional pixels, spacing off the 4px grid or not bound to a variable, frames without auto layout, text without a text style, fills and strokes not bound to a variable or style, text contrast under WCAG AA, touch targets under the minimum size, and sibling left edges 1 to 3px apart. Lints the current selection when nodeId is omitted. Returns counts per rule and the first `limit` violations. Run this after building or editing a design; the target is zero violations.",
  { nodeId: z.string().optional(), limit: z.number().optional().describe("Max violations listed, default 200"), minTouch: z.number().optional().describe("Minimum touch target in px, default 44") },
  wrap(async ({ nodeId, limit, minTouch }) => text(await call({ cmd: "lint", nodeId, limit, minTouch }))));
server.tool("figma_screenshot", "PNG screenshot of a node by id", { nodeId: z.string(), scale: z.number().optional() },
  wrap(async ({ nodeId, scale }) => {
    const r = await call({ cmd: "screenshot", nodeId, scale });
    return { content: [{ type: "image", data: r.base64, mimeType: "image/png" }] };
  }));
server.tool("figma_eval", "Run JavaScript against the Figma Plugin API. Body of an async function with `figma` in scope; use `return` to send a JSON-serialisable value back. Can create and edit anything.",
  { code: z.string() }, wrap(async ({ code }) => text(await call({ cmd: "eval", code }))));

await server.connect(new StdioServerTransport());
