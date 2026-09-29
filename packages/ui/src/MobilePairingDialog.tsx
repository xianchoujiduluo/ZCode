import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";

interface PairingLinkState {
  status: "loading" | "ready" | "error";
  url: string;
  errorMessage?: string;
}

async function fetchPairingLink(origin: string): Promise<string> {
  const requestUrl = `/api/pairing-link?origin=${encodeURIComponent(origin)}&path=${encodeURIComponent("/m")}`;
  const response = await fetch(requestUrl);
  if (!response.ok) {
    throw new Error(`pairing-link request failed: ${response.status}`);
  }
  const payload = (await response.json()) as { url?: string; error?: string };
  if (typeof payload.url !== "string" || payload.url.length === 0) {
    throw new Error(payload.error ?? "pairing-link response missing url");
  }
  return payload.url;
}

export function MobilePairingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [state, setState] = useState<PairingLinkState>({ status: "loading", url: "" });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setState({ status: "loading", url: "" });
    setQrDataUrl(null);
    setCopied(false);

    const origin = typeof window === "undefined" ? "" : window.location.origin;
    fetchPairingLink(origin)
      .then(async (url) => {
        const dataUrl = await QRCode.toDataURL(url, { width: 256, margin: 2 });
        if (disposed) return;
        setState({ status: "ready", url });
        setQrDataUrl(dataUrl);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        logger.warn("[MobilePairing] 获取配对链接失败", { error });
        setState({
          status: "error",
          url: "",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      disposed = true;
    };
  }, [open]);

  const handleCopy = useCallback(async () => {
    if (state.status !== "ready" || typeof navigator === "undefined") return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用时静默失败——链接文本本身可见可手动复制。
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-0 overflow-hidden p-0">
        <DialogHeader className="gap-1 border-b border-popover-border px-4 py-3 pr-12">
          <DialogTitle className="truncate">
            {intl.formatMessage({ id: "mobilePairing.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "mobilePairing.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 px-4 py-4">
          {state.status === "loading" ? (
            <div className="flex h-64 w-64 items-center justify-center rounded-lg bg-surface">
              <Loader2Icon className="size-6 animate-spin text-foreground-subtle" />
            </div>
          ) : null}
          {state.status === "error" ? (
            <div className="flex h-64 w-64 items-center justify-center rounded-lg bg-surface px-4 text-center text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "mobilePairing.error" })}
              {state.errorMessage ? (
                <span className="mt-2 block break-all text-ui-xs text-foreground-subtlest">
                  {state.errorMessage}
                </span>
              ) : null}
            </div>
          ) : null}
          {state.status === "ready" && qrDataUrl ? (
            <>
              <img
                src={qrDataUrl}
                alt={intl.formatMessage({ id: "mobilePairing.title" })}
                className="size-64 rounded-lg bg-white p-2"
              />
              <div className="w-full break-all rounded-lg bg-surface p-2 text-ui-xs text-foreground-subtle tabular-nums">
                {state.url}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
                {copied ? (
                  <CheckIcon className="size-4" />
                ) : (
                  <CopyIcon className="size-4" />
                )}
                {intl.formatMessage({
                  id: copied ? "mobilePairing.copied" : "mobilePairing.copy",
                })}
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
