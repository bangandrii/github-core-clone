import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readBody, makeCtx, HttpError, sendJson } from './src/http.ts';
import { handleRest } from './src/rest.ts';
import { handleSocial } from './src/social.ts';
import { handleGitHttp } from './src/githttp.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const shopToken = process.env.MAKEFUN_SHOP_TOKEN;
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${shopToken}`) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    try {
      const body = await readBody(req);
      const ctx = makeCtx(req, body);

      if (await handleRest(ctx, res)) return;
      if (await handleSocial(ctx, res)) return;
      if (await handleGitHttp(ctx, req, res)) return;
      if (await handleGraphql(ctx, res)) return;
      if (await handleMcp(ctx, res)) return;

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message });
      } else {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      }
    }
  });
}
