/**
 * Figma URL parsing helpers.
 *
 * Supported shapes:
 *   https://www.figma.com/design/<fileKey>/<slug>?node-id=1-2&m=dev
 *   https://www.figma.com/file/<fileKey>/<slug>?node-id=1-2
 *   https://www.figma.com/proto/<fileKey>/...
 *   https://www.figma.com/board/<fileKey>/... (FigJam; parsed but unsupported by tools)
 * Node ids in URLs use "-" as separator ("1-2"); the REST API uses ":" ("1:2").
 */

export interface ParsedFigmaUrl {
  fileKey?: string;
  nodeId?: string;
  kind?: 'design' | 'file' | 'proto' | 'board' | 'community' | 'other';
}

const PATH_KINDS = new Set(['design', 'file', 'proto', 'board', 'community']);

export function parseFigmaUrl(input: string): ParsedFigmaUrl {
  const out: ParsedFigmaUrl = {};
  if (!input) return out;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    // Not a URL — maybe a bare file key or node id.
    if (/^[\w-]{10,}$/.test(input.trim())) out.fileKey = input.trim();
    return out;
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) return out;

  const parts = url.pathname.split('/').filter(Boolean);
  const kind = parts[0];
  if (kind && PATH_KINDS.has(kind)) {
    out.kind = kind as ParsedFigmaUrl['kind'];
    if (parts[1]) out.fileKey = parts[1];
  }
  const nodeId = url.searchParams.get('node-id');
  if (nodeId) out.nodeId = normalizeNodeId(nodeId);
  return out;
}

/** "1-2" -> "1:2"; already-normalized ids pass through. */
export function normalizeNodeId(id: string): string {
  return decodeURIComponent(id).replace(/-/g, ':');
}

/** "1:2" -> "1-2" (URL-encoded form used by figma.com). */
export function encodeNodeId(id: string): string {
  return id.replace(/:/g, '-');
}

export function isFigmaUrl(input: string): boolean {
  return /figma\.com\/(design|file|proto|board)\//.test(input);
}
