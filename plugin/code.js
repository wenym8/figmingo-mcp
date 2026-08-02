"use strict";
/**
 * figmingo companion plugin (sandbox half).
 *
 * Architecture (fixed): code.js runs in Figma's restricted sandbox where
 * `new WebSocket()` is unavailable. The WebSocket connection to the local
 * figmingo-mcp server (ws://127.0.0.1:39220) therefore lives in the UI
 * iframe (ui.html). This file:
 *   - shows the UI (small connection-status panel),
 *   - answers the UI's init request (fileName / editorType / sessionId),
 *   - receives command envelopes from the UI via figma.ui.onmessage,
 *   - executes them against the Plugin API (handlers below, unchanged),
 *   - posts results back to the UI, which relays them over the socket.
 */
const PROTOCOL = 1;
const PLUGIN_VERSION = '0.1.0';
const sessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
function log(...args) {
    console.log('[figmingo]', ...args);
}
function findNode(id) {
    if (!id)
        throw new Error('node id required');
    const node = figma.currentPage.findOne((n) => n.id === id) ?? (figma.currentPage.id === id ? figma.currentPage : null);
    if (!node)
        throw new Error(`node not found on current page: ${id}`);
    return node;
}
function parentOf(params, vars) {
    let ref = params.parentId;
    if (typeof ref === 'string' && ref.startsWith('$')) {
        const resolved = vars.get(ref.slice(1));
        // Never silently fall back to the page for an unresolved $var — that writes
        // nodes to the wrong parent. Batch vars live only within one envelope.
        if (!resolved) {
            throw new Error(`unresolved batch variable "${ref}": variables captured with "as" only live within a single batch envelope; reference the node id directly or capture it in the same batch`);
        }
        ref = resolved;
    }
    if (!ref)
        return figma.currentPage;
    const node = findNode(ref);
    if (!('children' in node))
        throw new Error(`node ${ref} cannot have children`);
    return node;
}
function substitute(value, vars) {
    if (typeof value === 'string' && value.startsWith('$'))
        return vars.get(value.slice(1)) ?? value;
    if (Array.isArray(value))
        return value.map((v) => substitute(v, vars));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value))
            out[k] = substitute(v, vars);
        return out;
    }
    return value;
}
/**
 * figma.loadFontAsync is only guaranteed to reject for missing fonts — in
 * practice it can also HANG (never settle) for unavailable families such as
 * PingFang SC ExtraBold, especially in long-lived degraded plugin sessions.
 * A hang here used to freeze the whole batch: the awaited command never
 * returned, no heartbeat was posted, and the server idle-timed-out. Race
 * every attempt against a timeout so a hang degrades into the fallback
 * chain instead of freezing the batch.
 */
const FONT_LOAD_TIMEOUT_MS = 8000;
// Successfully loaded "family style" keys — loadFontAsync is only needed once
// per font per session (item: font load cache).
const loadedFonts = new Set();
// loadFont resolution cache: requested key (+ fallback chain) → resolved font.
const resolvedFontCache = new Map();
function tryLoadFont(font) {
    const key = `${font.family} ${font.style}`;
    if (loadedFonts.has(key))
        return Promise.resolve();
    return Promise.race([
        figma.loadFontAsync(font).then(() => {
            loadedFonts.add(key);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`loadFontAsync timed out after ${FONT_LOAD_TIMEOUT_MS}ms`)), FONT_LOAD_TIMEOUT_MS)),
    ]);
}
async function loadFont(fontName, fallbackStyles, beat) {
    const font = fontName ?? { family: 'Inter', style: 'Regular' };
    const cacheKey = `${font.family}|${font.style}|${(fallbackStyles ?? []).join(',')}`;
    const cached = resolvedFontCache.get(cacheKey);
    if (cached)
        return cached;
    const finish = (out) => {
        resolvedFontCache.set(cacheKey, out);
        return out;
    };
    try {
        beat?.();
        await tryLoadFont(font);
        return finish({ font, fallback: undefined });
    }
    catch {
        const attempts = [];
        // Same-family nearest styles first (e.g. SemiBold → Medium/Bold/Regular),
        // then family Regular, then Inter AT THE REQUESTED WEIGHT (preserves the
        // visual weight when the whole family is unavailable), then Inter Regular.
        for (const style of fallbackStyles ?? [])
            attempts.push({ family: font.family, style });
        attempts.push({ family: font.family, style: 'Regular' });
        if (font.family !== 'Inter')
            attempts.push({ family: 'Inter', style: font.style });
        attempts.push({ family: 'Inter', style: 'Regular' });
        // Figma's bundled Inter (and many other families) name compound styles
        // with a space ("Semi Bold", "Extra Light") while CSS-facing tooling uses
        // the camel form ("SemiBold") — try both spellings for every candidate.
        const spaced = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2');
        const withSpellings = [];
        for (const f of attempts) {
            withSpellings.push(f);
            const alt = spaced(f.style);
            if (alt !== f.style)
                withSpellings.push({ family: f.family, style: alt });
        }
        const seen = new Set([`${font.family} ${font.style}`]);
        for (const f of withSpellings) {
            const key = `${f.family} ${f.style}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            try {
                beat?.();
                await tryLoadFont(f);
                return finish({ font: f, fallback: `requested ${font.family} ${font.style} unavailable` });
            }
            catch {
                /* try next */
            }
        }
        throw new Error(`font unavailable: ${font.family} ${font.style}`);
    }
}
// Content-hash → figma image.hash cache for the insert_image hash-reuse protocol.
const imageHashCache = new Map();
/** Uniform number or [topLeft, topRight, bottomRight, bottomLeft]. */
function applyCornerRadius(node, radius) {
    if (Array.isArray(radius)) {
        const [tl, tr, br, bl] = radius.map((v) => Math.max(0, Number(v) || 0));
        node.topLeftRadius = tl;
        node.topRightRadius = tr;
        node.bottomRightRadius = br;
        node.bottomLeftRadius = bl;
    }
    else if (typeof radius === 'number' && Number.isFinite(radius)) {
        node.cornerRadius = Math.max(0, radius);
    }
}
function applyStroke(node, params) {
    if (params.strokes !== undefined)
        node.strokes = params.strokes;
    if (params.strokeWeight !== undefined)
        node.strokeWeight = params.strokeWeight;
    if (params.strokeAlign !== undefined)
        node.strokeAlign = params.strokeAlign;
    if (params.dashPattern !== undefined)
        node.dashPattern = params.dashPattern;
}
function applyFills(node, fills) {
    if (Array.isArray(fills))
        node.fills = fills;
}
/** Params use degrees (CSS-like); the Plugin API stores radians. */
function applyRotation(node, degrees) {
    if (typeof degrees === 'number' && Number.isFinite(degrees)) {
        node.rotation = (degrees * Math.PI) / 180;
    }
}
// ---- command handlers ----
const handlers = {
    async create_frame(params, vars) {
        const parent = parentOf(params, vars);
        const frame = figma.createFrame();
        frame.name = params.name ?? 'Frame';
        parent.appendChild(frame);
        frame.x = params.x ?? 0;
        frame.y = params.y ?? 0;
        frame.resize(Math.max(1, params.width ?? 100), Math.max(1, params.height ?? 100));
        if (params.clipsContent !== undefined)
            frame.clipsContent = !!params.clipsContent;
        if (params.cornerRadius !== undefined)
            applyCornerRadius(frame, params.cornerRadius);
        if (params.opacity !== undefined)
            frame.opacity = params.opacity;
        if (params.effects)
            frame.effects = params.effects;
        if (params.fills)
            applyFills(frame, params.fills);
        applyStroke(frame, params);
        applyRotation(frame, params.rotation);
        if (params.autoLayout)
            await handlers.set_auto_layout({ nodeId: frame.id, ...params.autoLayout }, vars);
        return { nodeId: frame.id };
    },
    async create_text(params, vars, ctx) {
        const parent = parentOf(params, vars);
        const { font, fallback } = await loadFont(params.fontName, params.fallbackStyles, ctx?.beat);
        const text = figma.createText();
        parent.appendChild(text);
        text.fontName = font;
        text.characters = String(params.characters ?? '');
        text.name = params.name ?? text.characters.slice(0, 40);
        text.x = params.x ?? 0;
        text.y = params.y ?? 0;
        if (params.fontSize)
            text.fontSize = params.fontSize;
        if (params.letterSpacing)
            text.letterSpacing = params.letterSpacing;
        if (params.lineHeight)
            text.lineHeight = params.lineHeight;
        if (params.textCase)
            text.textCase = params.textCase;
        if (params.textAlignHorizontal)
            text.textAlignHorizontal = params.textAlignHorizontal;
        if (params.textAlignVertical)
            text.textAlignVertical = params.textAlignVertical;
        if (params.opacity !== undefined)
            text.opacity = params.opacity;
        if (params.fills)
            applyFills(text, params.fills);
        const autoResize = params.textAutoResize ?? (params.width || params.height ? 'NONE' : undefined);
        if (autoResize)
            text.textAutoResize = autoResize;
        if (params.width || params.height) {
            if (autoResize === 'HEIGHT') {
                // Fixed width; height follows content (paragraph text).
                text.resize(Math.max(1, params.width ?? text.width), text.height);
            }
            else if (autoResize !== 'WIDTH_AND_HEIGHT') {
                // NONE (legacy path): fixed box, may wrap/clip.
                text.textAutoResize = 'NONE';
                text.resize(Math.max(1, params.width ?? text.width), Math.max(1, params.height ?? text.height));
            }
            // WIDTH_AND_HEIGHT: Figma sizes the box from the content — a fixed
            // resize would fight auto-width (Chromium→Figma metric drift otherwise
            // wraps single-line text into two lines).
        }
        // Post-layout re-anchoring for auto-sized single-line text (WIDTH_AND_HEIGHT
        // only): Figma sized the box from content AFTER our x/y were applied, and
        // with fallback fonts / AUTO line height that box differs from the
        // Chromium-measured rect. Re-anchor so what the extractor pinned survives:
        //  - anchorRight: keep the original RIGHT edge (right-aligned prices/labels
        //    otherwise grow rightward past the container and get clipsContent-cut).
        //  - vertical center: keep the box centered on the original slot (the
        //    browser vertically centers the glyph em-box in the line box; Figma's
        //    AUTO-height box must be recentered the same way or icon+text rows
        //    drift apart). No-op when the heights already match.
        // Metric compensation: a fallback font renders WIDER than the Chromium-
        // measured rect the spec carries (Roobert → Inter ≈ +5-8%). With
        // WIDTH_AND_HEIGHT the box grows that much and collides with the next
        // inline sibling (icon / "(1 Item)" / info badge), which the absolute
        // layout still places at the old x. Shrink letter-spacing so the rendered
        // width matches the extracted width — layout-preserving, unlike moving
        // siblings. Only compensates growth, never stretches.
        const metricCompensate = () => {
            if (autoResize !== 'WIDTH_AND_HEIGHT')
                return;
            if (!params.width || !text.characters)
                return;
            const charCount = Array.from(text.characters).length;
            if (charCount < 3)
                return;
            const overflow = text.width - params.width;
            if (overflow < 1)
                return; // smaller than extraction is harmless
            const fontSize = typeof text.fontSize === 'number' ? text.fontSize : 16;
            const existing = typeof text.letterSpacing === 'object' && text.letterSpacing.unit === 'PIXELS' ? text.letterSpacing.value : 0;
            // Per-char spacing that removes the overflow, clamped to stay readable.
            const adjust = Math.min(0, Math.max(-0.08 * fontSize, existing - overflow / charCount));
            if (Math.abs(adjust - existing) < 0.05)
                return;
            text.letterSpacing = { unit: 'PIXELS', value: Math.round(adjust * 100) / 100 };
        };
        metricCompensate();
        const reanchor = () => {
            if (autoResize !== 'WIDTH_AND_HEIGHT')
                return;
            if (params.anchorRight && params.width) {
                const dx = text.width - params.width;
                if (Math.abs(dx) >= 0.25)
                    text.x = params.x - dx;
            }
            if (params.height) {
                const dy = (text.height - params.height) / 2;
                if (Math.abs(dy) >= 0.25)
                    text.y = params.y - dy;
            }
        };
        reanchor();
        // Styled runs (merged inline-formatting text): per-range fonts/fills.
        // Degradation ladder: a run that fails keeps the node-wide base font +
        // warning; a wholesale failure of the runs loop leaves the legacy
        // single-font text intact + warning.
        const runWarnings = [];
        if (Array.isArray(params.runs) && params.runs.length) {
            try {
                for (const run of params.runs) {
                    try {
                        const rf = await loadFont(run.fontName, run.fallbackStyles, ctx?.beat);
                        text.setRangeFontName(run.start, run.end, rf.font);
                        if (run.fills)
                            text.setRangeFills(run.start, run.end, run.fills);
                        if (rf.fallback)
                            runWarnings.push(`run [${run.start},${run.end}) ${rf.fallback}`);
                    }
                    catch (err) {
                        runWarnings.push(`styled run [${run.start},${run.end}) failed: ${err instanceof Error ? err.message : String(err)}; kept base font`);
                    }
                }
            }
            catch (err) {
                runWarnings.push(`styled runs failed entirely: ${err instanceof Error ? err.message : String(err)}; kept base font`);
            }
        }
        // Runs may have changed the measured box (per-range fonts differ) —
        // re-apply the same re-anchoring once more after run styling.
        if (params.runs?.length)
            reanchor();
        return {
            nodeId: text.id,
            fontApplied: font,
            ...(fallback ? { fontFallback: fallback } : {}),
            ...(runWarnings.length ? { warnings: runWarnings } : {}),
        };
    },
    async create_rectangle(params, vars) {
        const parent = parentOf(params, vars);
        const rect = figma.createRectangle();
        rect.name = params.name ?? 'Rectangle';
        parent.appendChild(rect);
        rect.x = params.x ?? 0;
        rect.y = params.y ?? 0;
        rect.resize(Math.max(1, params.width ?? 100), Math.max(1, params.height ?? 100));
        if (params.cornerRadius !== undefined)
            applyCornerRadius(rect, params.cornerRadius);
        if (params.opacity !== undefined)
            rect.opacity = params.opacity;
        if (params.effects)
            rect.effects = params.effects;
        if (params.fills)
            applyFills(rect, params.fills);
        applyStroke(rect, params);
        applyRotation(rect, params.rotation);
        return { nodeId: rect.id };
    },
    async set_fills(params) {
        const node = findNode(params.nodeId);
        if (!('fills' in node))
            throw new Error(`node ${params.nodeId} has no fills`);
        const requested = params.fills ?? [];
        node.fills = requested;
        // Bridge quirk guard: some nodes (observed on certain top-level frames)
        // report ok but silently keep their previous fills. Read back and warn.
        // NOTE: Figma normalizes paints on assignment (adds visible/opacity/
        // blendMode, rounds channels), so raw JSON comparison false-positives.
        // Compare semantically: count + per-paint type/color/opacity.
        const norm = (paints) => {
            if (!Array.isArray(paints))
                return String(paints);
            return paints
                .map((p) => {
                if (!p || typeof p !== 'object')
                    return String(p);
                const c = p.color
                    ? [p.color.r, p.color.g, p.color.b].map((v) => (typeof v === 'number' ? v.toFixed(3) : v)).join(',')
                    : '';
                return `${p.type}:${c}:${p.opacity ?? 1}:${p.visible ?? true}`;
            })
                .join('|');
        };
        let warning;
        try {
            if (norm(node.fills) !== norm(requested)) {
                warning = `set_fills did not stick on ${node.id} (${node.type}): Figma kept the previous fills`;
            }
        }
        catch {
            /* fills not serializable (mixed values) — skip verification */
        }
        return { nodeId: node.id, ...(warning ? { warning } : {}) };
    },
    async set_effects(params) {
        const node = findNode(params.nodeId);
        if (!('effects' in node))
            throw new Error(`node ${params.nodeId} has no effects`);
        // Figma Effect[] e.g. [{type:'DROP_SHADOW', color:{r,g,b,a}, offset:{x,y}, radius, spread, visible:true, blendMode:'NORMAL'}]
        node.effects = params.effects ?? [];
        return { nodeId: node.id };
    },
    async set_auto_layout(params) {
        const node = findNode(params.nodeId);
        if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'INSTANCE') {
            throw new Error(`auto-layout requires a frame-like node, got ${node.type}`);
        }
        const mode = params.mode ?? params.layoutMode ?? 'HORIZONTAL';
        node.layoutMode = mode === 'NONE' ? 'NONE' : mode === 'VERTICAL' || mode === 'column' ? 'VERTICAL' : 'HORIZONTAL';
        if (node.layoutMode !== 'NONE') {
            if (params.itemSpacing !== undefined)
                node.itemSpacing = params.itemSpacing;
            if (params.counterAxisSpacing !== undefined && 'counterAxisSpacing' in node)
                node.counterAxisSpacing = params.counterAxisSpacing;
            const p = params.padding;
            if (p !== undefined) {
                if (typeof p === 'number') {
                    node.paddingTop = node.paddingRight = node.paddingBottom = node.paddingLeft = p;
                }
                else {
                    if (p.top !== undefined)
                        node.paddingTop = p.top;
                    if (p.right !== undefined)
                        node.paddingRight = p.right;
                    if (p.bottom !== undefined)
                        node.paddingBottom = p.bottom;
                    if (p.left !== undefined)
                        node.paddingLeft = p.left;
                }
            }
            if (params.primaryAxisAlignItems)
                node.primaryAxisAlignItems = params.primaryAxisAlignItems;
            if (params.counterAxisAlignItems)
                node.counterAxisAlignItems = params.counterAxisAlignItems;
            // Sizing modes: SPACE_BETWEEN needs primaryAxisSizingMode FIXED (the
            // default hug makes it a no-op); HUG/FILL for counter axis.
            if (params.primaryAxisSizingMode)
                node.primaryAxisSizingMode = params.primaryAxisSizingMode;
            if (params.counterAxisSizingMode)
                node.counterAxisSizingMode = params.counterAxisSizingMode;
            if (params.layoutWrap && 'layoutWrap' in node)
                node.layoutWrap = params.layoutWrap;
            if (params.layoutGrow !== undefined)
                node.layoutGrow = params.layoutGrow;
        }
        return { nodeId: node.id };
    },
    async insert_image(params, vars) {
        const parent = parentOf(params, vars);
        // Hash-reuse protocol: the server content-hashes image bytes; duplicates
        // send only `imageHash` and we reuse the previously created figma Image.
        let imageHash = params.imageHash ? imageHashCache.get(String(params.imageHash)) : undefined;
        if (!imageHash) {
            if (!params.bytesBase64) {
                throw new Error(`insert_image: unknown imageHash "${params.imageHash}" and no bytesBase64 supplied ` +
                    '(the plugin session may have restarted — resend the bytes)');
            }
            const bytes = figma.base64Decode(params.bytesBase64);
            // figma.createImage only accepts raster bytes (PNG/JPG/GIF/WebP). SVG
            // payloads decode "successfully" but render as grey boxes — reject early.
            let head = '';
            const sniff = Math.min(bytes.length, 256);
            for (let i = 0; i < sniff; i++)
                head += String.fromCharCode(bytes[i]);
            if (/^\s*</.test(head) && /<svg[\s>]/i.test(head)) {
                throw new Error('insert_image: SVG payloads are not supported by figma.createImage (rasterize the SVG to PNG first)');
            }
            const image = figma.createImage(bytes);
            imageHash = image.hash;
            if (params.imageHash)
                imageHashCache.set(String(params.imageHash), imageHash);
        }
        const rect = figma.createRectangle();
        rect.name = params.name ?? 'Image';
        parent.appendChild(rect);
        rect.x = params.x ?? 0;
        rect.y = params.y ?? 0;
        rect.resize(Math.max(1, params.width ?? 100), Math.max(1, params.height ?? 100));
        if (params.cornerRadius !== undefined)
            applyCornerRadius(rect, params.cornerRadius);
        if (params.opacity !== undefined)
            rect.opacity = params.opacity;
        applyStroke(rect, params);
        rect.fills = [{ type: 'IMAGE', imageHash, scaleMode: params.scaleMode ?? 'FILL' }];
        return { nodeId: rect.id, imageHash };
    },
    async move_node(params) {
        const node = findNode(params.nodeId);
        if (params.x !== undefined)
            node.x = params.x;
        if (params.y !== undefined)
            node.y = params.y;
        return { nodeId: node.id, x: node.x, y: node.y };
    },
    async resize_node(params) {
        const node = findNode(params.nodeId);
        if (!('resize' in node))
            throw new Error(`node ${params.nodeId} cannot be resized`);
        // Missing dimension keeps the node's current size instead of forcing 100.
        const w = params.width ?? node.width ?? 100;
        const h = params.height ?? node.height ?? 100;
        node.resize(Math.max(1, w), Math.max(1, h));
        return { nodeId: node.id };
    },
    async delete_node(params) {
        const node = findNode(params.nodeId);
        node.remove();
        return { deleted: params.nodeId };
    },
    async get_selection() {
        return {
            selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type })),
            page: { id: figma.currentPage.id, name: figma.currentPage.name },
            file: figma.root.name,
        };
    },
    async get_file_info() {
        return {
            // figma.fileKey is undefined only for never-saved local files.
            fileKey: figma.fileKey ?? null,
            fileName: figma.root.name,
            editorType: figma.editorType,
            page: { id: figma.currentPage.id, name: figma.currentPage.name },
        };
    },
    async get_page_children(params) {
        const parent = params?.nodeId ? findNode(params.nodeId) : figma.currentPage;
        if (!('children' in parent))
            throw new Error(`node ${params?.nodeId} cannot have children`);
        return {
            parent: { id: parent.id, name: parent.name, type: parent.type },
            children: parent.children.map((n) => ({
                id: n.id,
                name: n.name,
                type: n.type,
                x: n.x,
                y: n.y,
                width: n.width,
                height: n.height,
                childCount: 'children' in n ? n.children.length : 0,
            })),
        };
    },
    async export_node(params) {
        const node = findNode(params.nodeId);
        const format = (params.format ?? 'PNG');
        // SCALE constraint is only valid for raster formats; SVG/PDF reject it.
        const settings = format === 'SVG' || format === 'PDF'
            ? { format }
            : { format, constraint: { type: 'SCALE', value: params.scale ?? 1 } };
        const bytes = await node.exportAsync(settings);
        return { nodeId: node.id, format, base64: figma.base64Encode(bytes) };
    },
    async batch(params, vars, ctx) {
        const results = [];
        const commands = params.commands ?? [];
        const total = commands.length;
        const stopOnError = params.stopOnError !== false;
        // Parallel font preload: scan the batch for every font a create_text might
        // need (primary + same-family fallbacks + styled-run fonts) and load them
        // up front; the load cache then makes per-command loadFont calls instant.
        const preload = new Map();
        const offer = (family, style) => {
            if (!family || !style)
                return;
            preload.set(`${family} ${style}`, { family, style });
        };
        for (const cmd of commands) {
            if (cmd.command !== 'create_text')
                continue;
            const p = cmd.params ?? {};
            const fam = p.fontName?.family;
            offer(fam, p.fontName?.style);
            for (const st of p.fallbackStyles ?? [])
                offer(fam, st);
            for (const run of p.runs ?? []) {
                offer(run.fontName?.family, run.fontName?.style);
                for (const st of run.fallbackStyles ?? [])
                    offer(run.fontName?.family, st);
            }
        }
        if (preload.size > 1) {
            await Promise.all(Array.from(preload.values()).map((f) => tryLoadFont(f).catch(() => undefined)));
        }
        let aborted = false;
        let abortError;
        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i];
            // Liveness heartbeat at command start: heartbeats otherwise only fire
            // after a command finishes, so a slow command would trip the server
            // idle timer even while perfectly healthy.
            ctx?.beat?.();
            const handler = cmd.command === 'batch' ? undefined : handlers[cmd.command];
            if (!handler) {
                const error = cmd.command === 'batch' ? 'nested batch is not supported' : `unknown command ${cmd.command}`;
                results.push({ index: i, command: cmd.command, ok: false, error });
                ctx?.reportProgress?.({ index: i, total, command: String(cmd.command), ok: false });
                if (stopOnError) {
                    aborted = true;
                    abortError = error;
                    break;
                }
                continue;
            }
            try {
                const substituted = substitute(cmd.params ?? {}, vars);
                const result = await handler(substituted, vars, ctx);
                if (cmd.as && result?.nodeId)
                    vars.set(cmd.as, result.nodeId);
                results.push({ index: i, command: cmd.command, ok: true, result });
                ctx?.reportProgress?.({ index: i, total, command: String(cmd.command), ok: true });
            }
            catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                results.push({ index: i, command: cmd.command, ok: false, error });
                // Heartbeat even for the failed command: the server learns exactly how
                // far the batch got before aborting.
                ctx?.reportProgress?.({ index: i, total, command: String(cmd.command), ok: false });
                if (stopOnError) {
                    aborted = true;
                    abortError = error;
                    break;
                }
            }
        }
        // Always return the per-command results array — even on abort the caller
        // can see exactly which commands ran (and which one failed) instead of
        // getting a bare exception with no canvas state.
        return { executed: results.length, total, aborted, ...(abortError ? { error: abortError } : {}), results };
    },
};
async function dispatch(command, params, ctx) {
    const handler = handlers[command];
    if (!handler)
        throw new Error(`unknown command: ${command}`);
    return handler(params, new Map(), ctx);
}
// ---- UI bridge ----
// The WebSocket lives in ui.html (sandboxed code.js cannot open sockets).
// UI → code.js: ui-ready / bridge-state / command
// code.js → UI: init / command-result
figma.showUI(__html__, { width: 280, height: 120, title: 'figmingo' });
figma.ui.onmessage = async (msg) => {
    if (!msg || typeof msg !== 'object')
        return;
    if (msg.type === 'ui-ready') {
        figma.ui.postMessage({
            type: 'init',
            protocol: PROTOCOL,
            sessionId,
            pluginVersion: PLUGIN_VERSION,
            fileName: figma.root.name,
            editorType: figma.editorType,
        });
        return;
    }
    if (msg.type === 'bridge-state') {
        if (msg.state === 'connected')
            figma.notify('figmingo: connected to local MCP server');
        if (msg.state === 'failed')
            figma.notify(`figmingo: bridge connection failed (${msg.error ?? 'unknown'})`, { error: true });
        return;
    }
    if (msg.type === 'command' && typeof msg.id === 'string' && typeof msg.command === 'string') {
        log('command', msg.command, msg.id);
        try {
            const ctx = {
                reportProgress: (info) => figma.ui.postMessage({ type: 'command-progress', id: msg.id, ...info }),
                // Index-less progress message: the server treats any progress as a
                // liveness heartbeat and resets its idle timer without recording a
                // completed command index.
                beat: () => figma.ui.postMessage({ type: 'command-progress', id: msg.id }),
            };
            const result = await dispatch(msg.command, msg.params ?? {}, ctx);
            figma.ui.postMessage({ type: 'command-result', id: msg.id, ok: true, result: result ?? null });
        }
        catch (err) {
            figma.ui.postMessage({
                type: 'command-result',
                id: msg.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
};
