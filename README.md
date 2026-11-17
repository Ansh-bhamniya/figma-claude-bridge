# Figma ↔ Claude Bridge

An MCP server plus a Figma plugin that let Claude read and inspect your open Figma file — document and pages, the current selection, design tokens, components, screenshots, and a lint pass for layout, token, contrast and touch-target problems.

## How it works

`server/` is a Node.js MCP server that Claude Code launches over stdio. It also opens a WebSocket on `127.0.0.1:3055`. The Figma plugin in `plugin/` connects to that socket and answers requests using the Figma Plugin API.

Open `how-it-works.html` for the full walkthrough.

## Setup

```bash
cd server && npm install
claude mcp add figma-bridge -- node "$(pwd)/index.js"
```

In Figma: **Plugins → Development → Import plugin from manifest…** and pick `plugin/manifest.json`, then run **Claude Bridge** in the file you want Claude to see.
