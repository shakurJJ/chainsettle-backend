/**
 * Typed ChainSettle API client built on the generated OpenAPI schema.
 * Regenerate schema with: npm run generate:sdk
 */
import type { paths } from './schema';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ClientOptions {
  /** API origin, e.g. https://api.example.com (no trailing slash) */
  baseUrl: string;
  /** Bearer JWT (or impersonation token) */
  accessToken?: string;
  /** Optional fetch implementation (defaults to global fetch) */
  fetch?: typeof fetch;
}

type Path = keyof paths;
type PathMethods<P extends Path> = keyof paths[P] & HttpMethod;

type Operation<P extends Path, M extends PathMethods<P>> = paths[P][M] extends {
  responses: infer _R;
}
  ? paths[P][M]
  : never;

type ResponseJson<P extends Path, M extends PathMethods<P>> = Operation<
  P,
  M
> extends {
  responses: { 200: { content: { 'application/json': infer J } } };
}
  ? J
  : Operation<P, M> extends {
      responses: { 201: { content: { 'application/json': infer J } } };
    }
    ? J
    : unknown;

type RequestBody<P extends Path, M extends PathMethods<P>> = Operation<
  P,
  M
> extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : undefined;

function joinUrl(base: string, p: string): string {
  return `${base.replace(/\/$/, '')}${p.startsWith('/') ? p : `/${p}`}`;
}

/**
 * Create a typed client for the ChainSettle REST API.
 * Paths follow the OpenAPI document (e.g. `/api/v1/shipments`).
 */
export function createClient(options: ClientOptions) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<P extends Path, M extends PathMethods<P>>(
    apiPath: P,
    method: M,
    init?: {
      body?: RequestBody<P, M>;
      query?: Record<string, string | number | boolean | undefined>;
      headers?: Record<string, string>;
      pathParams?: Record<string, string | number>;
    },
  ): Promise<ResponseJson<P, M>> {
    let resolvedPath = String(apiPath);
    if (init?.pathParams) {
      for (const [key, value] of Object.entries(init.pathParams)) {
        resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(String(value)));
      }
    }

    let url = joinUrl(options.baseUrl, resolvedPath);

    if (init?.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    };
    if (options.accessToken) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }

    let body: string | undefined;
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }

    const res = await fetcher(url, {
      method: String(method).toUpperCase(),
      headers,
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `API ${String(method).toUpperCase()} ${resolvedPath} failed (${res.status}): ${text}`,
      );
    }

    if (res.status === 204) {
      return undefined as ResponseJson<P, M>;
    }

    return (await res.json()) as ResponseJson<P, M>;
  }

  return {
    request,
    /** Convenience helpers for common v1 endpoints */
    v1: {
      getShipments: (query?: Record<string, string | number | boolean | undefined>) =>
        request('/api/v1/shipments' as Path, 'get' as PathMethods<Path>, { query }),
      getShipment: (id: string) =>
        request('/api/v1/shipments/{id}' as Path, 'get' as PathMethods<Path>, {
          pathParams: { id },
        }),
      getNotifications: (
        query?: Record<string, string | number | boolean | undefined>,
      ) =>
        request('/api/v1/notifications' as Path, 'get' as PathMethods<Path>, {
          query,
        }),
      getHealth: () =>
        request('/api/v1/health' as Path, 'get' as PathMethods<Path>),
    },
  };
}

export type ChainSettleClient = ReturnType<typeof createClient>;
