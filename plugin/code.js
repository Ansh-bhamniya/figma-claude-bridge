figma.showUI(__html__, { width: 220, height: 60 });

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function describe(n) {
  const o = { id: n.id, name: n.name, type: n.type };
  if ("x" in n) { o.x = n.x; o.y = n.y; o.width = n.width; o.height = n.height; }
  if ("fills" in n && n.fills !== figma.mixed) o.fills = n.fills;
  if ("characters" in n) o.characters = n.characters;
  if ("children" in n) o.children = n.children.map(describe);
  return o;
}

function pageOf(n) {
  while (n && n.type !== "PAGE") n = n.parent;
  return n ? n.name : null;
}

// Design tokens: variables plus text, effect and paint styles defined in this file
async function tokens() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  const textStyles = await figma.getLocalTextStylesAsync();
  const effectStyles = await figma.getLocalEffectStylesAsync();
  const paintStyles = await figma.getLocalPaintStylesAsync();
  return {
    collections: collections.map((c) => ({ id: c.id, name: c.name, defaultModeId: c.defaultModeId, modes: c.modes })),
    variables: variables.map((v) => ({ id: v.id, name: v.name, type: v.resolvedType,
      collectionId: v.variableCollectionId, scopes: v.scopes, valuesByMode: v.valuesByMode })),
    textStyles: textStyles.map((s) => ({ id: s.id, name: s.name, fontName: s.fontName, fontSize: s.fontSize,
      lineHeight: s.lineHeight, letterSpacing: s.letterSpacing })),
    effectStyles: effectStyles.map((s) => ({ id: s.id, name: s.name, effects: s.effects })),
    paintStyles: paintStyles.map((s) => ({ id: s.id, name: s.name, paints: s.paints })),
  };
}

// Local components on every page. Variants are listed under their component set, not separately.
async function components() {
  await figma.loadAllPagesAsync();
  const nodes = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
  const out = [];
  for (const n of nodes) {
    if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") continue;
    const o = { id: n.id, name: n.name, type: n.type, key: n.key, page: pageOf(n),
      width: Math.round(n.width), height: Math.round(n.height) };
    if (n.description) o.description = n.description;
    try {
      const defs = n.componentPropertyDefinitions;
      if (Object.keys(defs).length) o.properties = defs;
    } catch (e) { /* sets with conflicting variants throw here */ }
    if (n.type === "COMPONENT_SET") o.variants = n.children.map((c) => ({ id: c.id, name: c.name }));
    out.push(o);
  }
  return out;
}

// ---- Lint: find layout, token, contrast and touch-target problems from node numbers ----
const LINT_VECTOR = ["VECTOR", "BOOLEAN_OPERATION", "LINE", "ELLIPSE", "STAR", "POLYGON"];
const LINT_TOUCH = /\b(button|btn|cta|tab|chip|checkbox|radio|toggle|switch|link|back|close|input|field|fab)\b/i;

function lintHex(c, a) {
  const h = "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
  return a !== undefined && a < 0.995 ? h + "@" + Math.round(a * 100) : h;
}
function lintLum(c) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function lintRatio(a, b) {
  const x = lintLum(a), y = lintLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function lintOver(top, a, bottom) {
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a) };
}
function lintPaints(n, key) {
  const p = n[key];
  if (!Array.isArray(p)) return [];
  return p.filter((f) => f.visible !== false && (f.opacity === undefined || f.opacity > 0));
}
function lintPaintBound(f) {
  if (f.type === "SOLID") return !!(f.boundVariables && f.boundVariables.color);
  if (f.type.indexOf("GRADIENT") === 0) return f.gradientStops.every((s) => s.boundVariables && s.boundVariables.color);
  return true; // images and video carry no colour token
}
function lintPaintLabel(f) {
  if (f.type === "SOLID") return lintHex(f.color, f.opacity);
  if (f.type.indexOf("GRADIENT") === 0) return "gradient " + f.gradientStops.map((s) => lintHex(s.color, s.color.a)).join(">");
  return f.type;
}

// Colours behind a text node, nearest layer first. Returns null when an image is in the way.
function lintBackdrop(textNode) {
  const box = textNode.absoluteBoundingBox;
  if (!box) return null;
  const layers = [];
  let unknown = false, opaque = false;
  const contains = (s) => {
    const b = s.absoluteBoundingBox;
    return b && b.x <= box.x + 0.5 && b.y <= box.y + 0.5 && b.x + b.width >= box.x + box.width - 0.5 && b.y + b.height >= box.y + box.height - 0.5;
  };
  const push = (node) => {
    const paints = lintPaints(node, "fills");
    const nodeAlpha = typeof node.opacity === "number" ? node.opacity : 1;
    for (let i = paints.length - 1; i >= 0 && !opaque && !unknown; i--) {
      const f = paints[i], fa = (f.opacity === undefined ? 1 : f.opacity) * nodeAlpha;
      if (f.type === "SOLID") { layers.push({ colors: [f.color], alpha: fa }); if (fa >= 0.99) opaque = true; }
      else if (f.type.indexOf("GRADIENT") === 0) {
        const a = Math.min.apply(null, f.gradientStops.map((s) => s.color.a)) * fa;
        layers.push({ colors: f.gradientStops.map((s) => s.color), alpha: a });
        if (a >= 0.99) opaque = true;
      } else unknown = true;
    }
  };
  let c = textNode, p = c.parent;
  while (p && p.type !== "PAGE" && p.type !== "DOCUMENT" && !opaque && !unknown) {
    const idx = p.children.indexOf(c);
    for (let i = idx - 1; i >= 0 && !opaque && !unknown; i--) {
      const s = p.children[i];
      if (s.visible !== false && "fills" in s && s.type !== "TEXT" && contains(s)) push(s);
    }
    if (!opaque && !unknown && "fills" in p && p.type !== "SECTION") push(p);
    c = p; p = p.parent;
  }
  if (unknown) return null;
  let cands = [{ r: 1, g: 1, b: 1 }];
  for (let i = layers.length - 1; i >= 0; i--) {
    const next = [];
    for (const col of layers[i].colors) for (const base of cands) if (next.length < 16) next.push(lintOver(col, Math.min(1, layers[i].alpha), base));
    cands = next;
  }
  return cands;
}

function lintWalk(n, st, isRoot) {
  if (n.visible === false) return;
  st.nodes++;
  const at = (node, rule, msg) => {
    st.byRule[rule] = (st.byRule[rule] || 0) + 1; st.total++;
    if (st.out.length < st.limit) st.out.push({ id: node.id, name: node.name, rule, msg });
  };
  const isVec = LINT_VECTOR.indexOf(n.type) >= 0;
  const isBox = n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE";
  const frac = (v) => Math.abs(v - Math.round(v)) > 0.01;
  const r2 = (v) => Math.round(v * 100) / 100;
  const kids = "children" in n ? n.children.filter((c) => c.visible !== false) : [];
  const iconLike = kids.length > 0 && kids.every((c) => LINT_VECTOR.indexOf(c.type) >= 0);

  // Whole pixels. Vector shapes are skipped: icon paths legitimately sit on fractions.
  if ("width" in n && !isVec && n.type !== "SECTION" && n.type !== "PAGE")
    for (const k of isRoot ? ["width", "height"] : ["x", "y", "width", "height"])
      if (frac(n[k])) at(n, "whole-pixel", k + "=" + r2(n[k]) + " is not a whole pixel");

  if (n.type !== "INSTANCE") {
    // Spacing: on the grid and bound to a variable
    if ("layoutMode" in n && n.layoutMode !== "NONE") {
      const keys = ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"];
      if (n.primaryAxisAlignItems !== "SPACE_BETWEEN") keys.unshift("itemSpacing");
      for (const k of keys) {
        const v = n[k];
        if (!(v > 0)) continue;
        if (v % st.grid && v !== 2) at(n, "off-grid", k + "=" + r2(v) + " is off the " + st.grid + "px grid");
        if (!(n.boundVariables && n.boundVariables[k])) at(n, "spacing-unbound", k + "=" + r2(v) + " is not bound to a variable");
      }
    }
    // Auto layout
    if ((n.type === "FRAME" || n.type === "COMPONENT") && n.layoutMode === "NONE" && kids.length > 1 && !iconLike)
      at(n, "no-auto-layout", kids.length + " children are positioned by hand, no auto layout");
    if (n.type === "GROUP" && kids.length > 1 && !iconLike)
      at(n, "no-auto-layout", "group of " + kids.length + " children, use an auto layout frame");
    // Text style
    if (n.type === "TEXT" && !n.textStyleId) at(n, "no-text-style", "text has no text style");
    // Colour tokens
    if ("fills" in n && n.fills !== figma.mixed && !n.fillStyleId && n.type !== "SECTION") {
      const bad = lintPaints(n, "fills").filter((f) => !lintPaintBound(f));
      if (bad.length) at(n, "fill-unbound", "fill " + bad.map(lintPaintLabel).join(", ") + " is not bound to a variable or style");
    }
    if ("strokes" in n && !n.strokeStyleId) {
      const bad = lintPaints(n, "strokes").filter((f) => !lintPaintBound(f));
      if (bad.length) at(n, "stroke-unbound", "stroke " + bad.map(lintPaintLabel).join(", ") + " is not bound to a variable or style");
    }
    // Sibling alignment: left edges 1 to 3px apart are almost always a mistake
    if (kids.length > 1 && (!("layoutMode" in n) || n.layoutMode === "NONE") && Math.max(n.width || 0, n.height || 0) > 48) {
      const s = kids.filter((c) => LINT_VECTOR.indexOf(c.type) < 0 && "x" in c).sort((a, b) => a.x - b.x);
      for (let i = 1; i < s.length; i++) {
        const d = s[i].x - s[i - 1].x;
        if (d > 0.01 && d <= 3) at(s[i], "misaligned", "left edge x=" + r2(s[i].x) + " is " + r2(d) + "px off sibling \"" + s[i - 1].name + "\" (x=" + r2(s[i - 1].x) + ")");
      }
    }
  }

  // Contrast (WCAG AA): 4.5:1, or 3:1 for large text
  if (n.type === "TEXT" && n.characters && n.characters.trim() && n.fills !== figma.mixed) {
    const solids = lintPaints(n, "fills").filter((f) => f.type === "SOLID");
    const bg = solids.length ? lintBackdrop(n) : null;
    if (bg) {
      const f = solids[solids.length - 1];
      const a = (f.opacity === undefined ? 1 : f.opacity) * (typeof n.opacity === "number" ? n.opacity : 1);
      let worst = Infinity, worstBg = null;
      for (const b of bg) { const r = lintRatio(lintOver(f.color, a, b), b); if (r < worst) { worst = r; worstBg = b; } }
      const size = n.fontSize === figma.mixed ? 0 : n.fontSize;
      const style = n.fontName === figma.mixed ? "" : n.fontName.style;
      const bold = /bold|black|heavy/i.test(style) && !/semi|demi/i.test(style);
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (worst < need) at(n, "contrast", "contrast " + r2(worst) + ":1 (" + lintHex(f.color, a) + " on " + lintHex(worstBg) + "), needs " + need + ":1");
    }
  }

  // Touch target: interactive by name or by prototype reaction
  if (isBox && (LINT_TOUCH.test(n.name) || (n.reactions && n.reactions.length)) && (n.width < st.minTouch || n.height < st.minTouch))
    at(n, "touch-target", "touch target " + r2(n.width) + "x" + r2(n.height) + " is under " + st.minTouch + "x" + st.minTouch);

  // Instance internals belong to the component: lint the component, not each instance
  if (n.type !== "INSTANCE") for (const c of kids) lintWalk(c, st, false);
}

async function lint(msg) {
  let roots;
  if (msg.nodeId) {
    const n = await figma.getNodeByIdAsync(msg.nodeId);
    if (!n) throw new Error("node not found: " + msg.nodeId);
    let p = n;
    while (p && p.type !== "PAGE") p = p.parent;
    if (p && p.loadAsync) await p.loadAsync();
    roots = [n];
  } else {
    roots = figma.currentPage.selection.slice();
  }
  if (!roots.length) throw new Error("Nothing to lint: pass nodeId or select a node in Figma.");
  const st = { out: [], byRule: {}, total: 0, nodes: 0, limit: msg.limit || 200, minTouch: msg.minTouch || 44, grid: 4 };
  for (const r of roots) lintWalk(r, st, true);
  return { roots: roots.map((r) => ({ id: r.id, name: r.name })), nodesChecked: st.nodes, total: st.total,
    byRule: st.byRule, violations: st.out, truncated: st.total > st.out.length };
}

figma.ui.onmessage = async (msg) => {
  const reply = (data) => figma.ui.postMessage({ id: msg.id, ...data });
  try {
    if (msg.cmd === "selection") {
      reply({ result: figma.currentPage.selection.map(describe) });
    } else if (msg.cmd === "document") {
      reply({ result: { file: figma.root.name, page: figma.currentPage.name,
        pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })) } });
    } else if (msg.cmd === "tokens") {
      reply({ result: await tokens() });
    } else if (msg.cmd === "components") {
      reply({ result: await components() });
    } else if (msg.cmd === "lint") {
      reply({ result: await lint(msg) });
    } else if (msg.cmd === "screenshot") {
      const node = await figma.getNodeByIdAsync(msg.nodeId);
      const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: msg.scale || 1 } });
      reply({ result: { base64: figma.base64Encode(bytes) } });
    } else if (msg.cmd === "eval") {
      const fn = new AsyncFunction("figma", msg.code);
      const out = await fn(figma);
      reply({ result: out === undefined ? null : out });
    } else {
      reply({ error: "unknown cmd " + msg.cmd });
    }
  } catch (e) {
    reply({ error: String(e && e.message || e) });
  }
};
