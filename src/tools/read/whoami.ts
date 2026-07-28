import { type ToolDef, textContent } from '../common';

/**
 * whoami: token sanity check (GET /v1/me) + rate-limit header report + cache status.
 */
export const whoami: ToolDef = {
  name: 'whoami',
  description: 'Token sanity check via GET /v1/me, plus rate-limit observations and disk-cache status.',
  schema: {},
  handler: async (ctx) => {
    const client = ctx.getClient();
    const me: any = await client.getMe();
    return textContent({
      me: { id: me?.id, handle: me?.handle, email: me?.email, img_url: me?.img_url },
      rateLimit: client.rateLimit,
      cache: client.cacheStats(),
      bridge: ctx.bridge.status(),
    });
  },
};
