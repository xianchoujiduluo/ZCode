// 「获取模型」控件：从 Provider 的 `<baseUrl>/models` 拉取模型列表，供用户点选。
//
// 请求必须经 host 侧（providerSettingsService.listRemoteModels）——
// 浏览器直连供应商地址会被 CORS 拦，host 侧还能复用设置里的代理与自定义 CA。
import { useCallback, useState } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface RemoteModelOption {
  id: string;
  name?: string;
}

export function FetchModelsButton({
  baseUrl,
  apiKey,
  headers,
  disabled,
  onSelect,
}: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  onSelect: (modelId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { providerSettingsService } = useServices();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<RemoteModelOption[]>([]);
  const [requestUrl, setRequestUrl] = useState("");
  const [filter, setFilter] = useState("");

  const canFetch = baseUrl.trim().length > 0 && !disabled;

  const fetchModels = useCallback(async () => {
    if (!canFetch) return;
    setLoading(true);
    setError(null);
    try {
      const result = await providerSettingsService.listRemoteModels({
        baseUrl,
        ...(apiKey?.trim() ? { apiKey } : {}),
        ...(headers ? { headers } : {}),
      });
      setModels([...result.models]);
      setRequestUrl(result.requestUrl);
      setFilter("");
    } catch (e) {
      logger.warn("[FetchModels] 拉取模型列表失败", { baseUrl, error: e });
      setError(e instanceof Error ? e.message : String(e));
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [canFetch, baseUrl, apiKey, headers, providerSettingsService]);

  const handleOpen = useCallback(() => {
    setOpen(true);
    void fetchModels();
  }, [fetchModels]);

  const handlePick = useCallback(
    (modelId: string) => {
      onSelect(modelId);
      setOpen(false);
    },
    [onSelect],
  );

  const normalizedFilter = filter.trim().toLowerCase();
  const visibleModels = normalizedFilter
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(normalizedFilter) ||
          (m.name?.toLowerCase().includes(normalizedFilter) ?? false),
      )
    : models;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={!canFetch || loading}
        title={
          canFetch
            ? undefined
            : intl.formatMessage({ id: "settings.modelProvider.fetchModelsNeedsBaseUrl" })
        }
        onClick={handleOpen}
      >
        {loading ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <RefreshCwIcon className="size-4" />
        )}
        {intl.formatMessage({
          id: loading
            ? "settings.modelProvider.fetchModelsLoading"
            : "settings.modelProvider.fetchModels",
        })}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg gap-0 overflow-hidden p-0">
          <DialogHeader className="gap-1 border-b border-popover-border px-4 py-3 pr-12">
            <DialogTitle>
              {intl.formatMessage({ id: "settings.modelProvider.fetchModelsTitle" })}
            </DialogTitle>
            <DialogDescription className="truncate text-ui-sm text-foreground-subtle">
              {error
                ? error
                : requestUrl
                  ? intl.formatMessage(
                      { id: "settings.modelProvider.fetchModelsDescription" },
                      { count: models.length, url: requestUrl },
                    )
                  : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-col">
            <div className="px-4 pt-3">
              <input
                type="text"
                className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest"
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="max-h-[50vh] min-h-[120px] overflow-y-auto p-4 pt-3">
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2Icon className="size-5 animate-spin text-foreground-subtle" />
                </div>
              ) : null}
              {!loading && visibleModels.length === 0 ? (
                <div className="py-10 text-center text-ui-sm text-foreground-subtle">
                  {error
                    ? error
                    : intl.formatMessage({ id: "settings.modelProvider.fetchModelsEmpty" })}
                </div>
              ) : null}
              {!loading && visibleModels.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {visibleModels.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-surface-hover"
                        onClick={() => handlePick(m.id)}
                      >
                        <span className="truncate font-mono text-ui-base text-foreground">
                          {m.id}
                        </span>
                        {m.name && m.name !== m.id ? (
                          <span className="truncate text-ui-xs text-foreground-subtle">
                            {m.name}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {error ? (
              <div className="border-t border-border px-4 py-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void fetchModels()}
                >
                  <RefreshCwIcon className="size-4" />
                  {intl.formatMessage({ id: "settings.modelProvider.fetchModels" })}
                </Button>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
