// 拉取 OpenAI 兼容的 `/models` 端点，供设置页的「获取模型」按钮使用。
//
// 为什么放在 host 侧：浏览器直连供应商地址会被 CORS 拦（供应商一般不给
// 第三方站点开 Access-Control-Allow-Origin）；host 侧还能复用设置里的
// httpProxy / noProxy / 自定义 CA，保证与正式模型请求走同一条网络出口。
import type {
  ListRemoteModelsRequest,
  ListRemoteModelsResult,
  RemoteModelEntry,
} from "./providerFacadeServices.js";

export type RemoteModelsFetch = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

export interface ListRemoteModelsOptions {
  fetch: RemoteModelsFetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 供应商可能返回上千个模型；截断保护设置页渲染。 */
const MAX_MODELS = 500;

/** base URL 规范化：去尾部斜杠；已带 /v1 的不重复追加。 */
export function resolveRemoteModelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/models`;
}

function parseModelsPayload(text: string): RemoteModelEntry[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("响应不是合法 JSON");
  }
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new Error("响应缺少 data 数组");
  }
  const models: RemoteModelEntry[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    // OpenAI 兼容字段是 id；少数供应商用 model / name。
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof record.model === "string"
          ? record.model
          : undefined;
    if (!id) continue;
    const name =
      typeof record.name === "string" && record.name.trim().length > 0
        ? record.name.trim()
        : undefined;
    models.push({ id, ...(name ? { name } : {}) });
    if (models.length >= MAX_MODELS) break;
  }
  if (models.length === 0) {
    throw new Error("响应里没有可用的模型条目");
  }
  return models;
}

export async function listRemoteModels(
  input: ListRemoteModelsRequest,
  options: ListRemoteModelsOptions,
): Promise<ListRemoteModelsResult> {
  const requestUrl = resolveRemoteModelsUrl(input.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...input.headers,
    };
    // apiKey 可能已被调用方放进 headers（供应商自定义字段），避免重复加 Authorization。
    const hasAuthHeader = Object.keys(headers).some(
      (key) => key.toLowerCase() === "authorization",
    );
    if (input.apiKey?.trim() && !hasAuthHeader) {
      headers.authorization = `Bearer ${input.apiKey.trim()}`;
    }

    const response = await options.fetch(requestUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim().slice(0, 300);
      throw new Error(
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    return { models: parseModelsPayload(text), requestUrl };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`请求超时（${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
