// TokenGate：Web 端首屏 token 输入页。
//
// 服务开启鉴权时，首次访问弹出输入框；校验通过后 cookie 已由服务端种上
// （HttpOnly），URL 中的 ?token= 参数被 history.replaceState 移除，
// 地址栏不再暴露 token。刷新/重开凭 cookie 直达主应用。
//
// 如果 URL 已带 ?token=（旧链接/扫码进入），自动提交校验，用户无感通过。
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, LockIcon } from "lucide-react";

const isZh = typeof navigator !== "undefined" && navigator.language.startsWith("zh");
const T = {
  title: isZh ? "ZCode" : "ZCode",
  subtitle: isZh ? "请输入访问令牌" : "Enter access token",
  placeholder: isZh ? "访问令牌…" : "Access token…",
  submit: isZh ? "进入" : "Enter",
  verifying: isZh ? "校验中…" : "Verifying…",
  invalid: isZh ? "令牌错误，请重试" : "Invalid token, please try again",
  failed: isZh ? "校验失败，请检查网络后重试" : "Verification failed, check your connection",
};

interface VerifyResult {
  ok: boolean;
  authRequired: boolean;
  error?: string;
}

export async function verifyToken(token: string): Promise<VerifyResult> {
  const response = await fetch("/api/verify-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (response.status === 401) {
    return { ok: false, authRequired: true, error: "invalid" };
  }
  if (!response.ok) {
    return { ok: false, authRequired: true, error: `http-${response.status}` };
  }
  return (await response.json()) as VerifyResult;
}

/** 清掉 URL 中的 ?token= 参数（不影响其他 query 参数）。 */
export function stripTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) return;
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url.toString());
}

export function TokenGate({ onPass }: { onPass: () => void }) {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "verifying" | "invalid" | "failed">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);

  const submit = useCallback(
    async (token: string) => {
      const trimmed = token.trim();
      if (!trimmed || submittedRef.current) return;
      submittedRef.current = true;
      setStatus("verifying");
      try {
        const result = await verifyToken(trimmed);
        if (result.ok) {
          stripTokenFromUrl();
          onPass();
          return;
        }
        if (result.error === "invalid") {
          setStatus("invalid");
        } else {
          setStatus("failed");
        }
      } catch {
        setStatus("failed");
      } finally {
        submittedRef.current = false;
      }
    },
    [onPass],
  );

  // URL 已带 ?token=（旧链接/扫码）→ 自动提交，用户无感
  useEffect(() => {
    const urlToken = new URLSearchParams(window.location.search).get("token");
    if (urlToken) {
      void submit(urlToken);
      return;
    }
    inputRef.current?.focus();
  }, [submit]);

  return (
    <main className="flex h-dvh items-center justify-center bg-background px-4 text-foreground">
      <section className="w-full max-w-xs rounded-2xl border border-popover-border bg-background p-8 shadow-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-surface">
            <LockIcon className="size-6 text-foreground-subtle" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
          <p className="text-ui-base/relaxed text-foreground-subtle">{T.subtitle}</p>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(input);
          }}
        >
          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground outline-none focus:border-brand placeholder:text-foreground-subtlest"
            placeholder={T.placeholder}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (status === "invalid" || status === "failed") setStatus("idle");
            }}
            disabled={status === "verifying"}
          />
          <button
            type="submit"
            className="flex h-10 items-center justify-center rounded-xl bg-brand text-ui-base font-medium text-white transition-opacity active:opacity-80 disabled:opacity-50"
            disabled={!input.trim() || status === "verifying"}
          >
            {status === "verifying" ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : null}
            {status === "verifying" ? T.verifying : T.submit}
          </button>
        </form>
        {status === "invalid" ? (
          <p className="mt-3 text-center text-ui-sm text-destructive">{T.invalid}</p>
        ) : null}
        {status === "failed" ? (
          <p className="mt-3 text-center text-ui-sm text-destructive">{T.failed}</p>
        ) : null}
      </section>
    </main>
  );
}
