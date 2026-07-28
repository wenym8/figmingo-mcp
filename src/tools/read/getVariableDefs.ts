import { z } from 'zod';
import { FigmaApiError } from '../../figma/client';
import { rgbToHex, walkRaw } from '../../figma/simplify';
import { resolveTarget, targetSchema, type ToolDef, textContent } from '../common';

/**
 * get_variable_defs: try GET /v1/files/:key/variables/local (Enterprise only).
 * On 403 fall back to GET /v1/files/:key/styles plus tokens inferred from node
 * styles in the document. Output always marks `source`.
 */
export const getVariableDefs: ToolDef = {
  name: 'get_variable_defs',
  description:
    'Get design tokens: tries the Enterprise variables/local endpoint first; on 403 falls back to published ' +
    'styles + tokens inferred from node fills/text styles. Every output is marked with source.',
  schema: {
    ...targetSchema,
    includeInferred: z.boolean().optional().default(true).describe('Include tokens inferred from node styles in fallback mode.'),
  },
  handler: async (ctx, args) => {
    const client = ctx.getClient();
    const { fileKey } = resolveTarget(args);

    try {
      const res: any = await client.getLocalVariables(fileKey);
      const meta = res?.meta ?? {};
      const variables = Object.values(meta.variables ?? {}).map((v: any) => ({
        id: v.id,
        name: v.name,
        key: v.key,
        resolvedType: v.resolvedType,
        variableCollectionId: v.variableCollectionId,
        valuesByMode: v.valuesByMode,
        description: v.description,
      }));
      const collections = Object.values(meta.variableCollections ?? {}).map((c: any) => ({
        id: c.id,
        name: c.name,
        modes: c.modes,
        defaultModeId: c.defaultModeId,
      }));
      return textContent({ source: 'variables', fileKey, collections, variables });
    } catch (err) {
      if (!(err instanceof FigmaApiError && err.status === 403)) throw err;
    }

    // ---- 403 fallback: styles + inferred tokens ----
    const stylesRes: any = await client.getStyles(fileKey).catch(() => ({ meta: { styles: [] } }));
    const styles = (stylesRes?.meta?.styles ?? []).map((s: any) => ({
      key: s.key,
      nodeId: s.node_id,
      name: s.name,
      type: s.style_type,
      description: s.description,
    }));

    let inferred: Record<string, unknown> = {};
    if (args.includeInferred !== false) {
      const file: any = await client.getFile(fileKey, { depth: 20 });
      const colors = new Map<string, number>();
      const textStyles = new Map<string, number>();
      walkRaw(file.document, (n) => {
        for (const f of n.fills ?? []) {
          if (f?.type === 'SOLID' && f.visible !== false) {
            const key = `${rgbToHex(f.color)}${(f.color?.a ?? 1) < 1 ? `@${f.color.a.toFixed(2)}` : ''}`;
            colors.set(key, (colors.get(key) ?? 0) + 1);
          }
        }
        if (n.type === 'TEXT' && n.style) {
          const s = n.style;
          const key = `${s.fontFamily}/${s.fontStyle ?? s.fontWeight}/${s.fontSize}px`;
          textStyles.set(key, (textStyles.get(key) ?? 0) + 1);
        }
      });
      inferred = {
        colors: Array.from(colors.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([value, count]) => ({ value, count })),
        textStyles: Array.from(textStyles.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([value, count]) => ({ value, count })),
      };
    }

    return textContent({
      source: args.includeInferred !== false ? 'styles+inferred' : 'styles',
      note: 'variables/local returned 403 (Enterprise-only endpoint on this plan). ' +
        'Falling back to published styles and tokens inferred from node styles.',
      fileKey,
      styles,
      inferred,
    });
  },
};
