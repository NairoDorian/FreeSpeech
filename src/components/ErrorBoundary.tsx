import { Errored } from "solid-js";
import type { JSX } from "@solidjs/web";

import { useTranslation } from "@/i18n/useTranslation";
import { Alert } from "./ui/Alert";

interface ErrorBoundaryProps {
  children: JSX.Element;
  /** What failed, for the console message ("the History page"). */
  context: string;
  /**
   * Show the failure in place, with a retry, instead of rendering nothing.
   * For a whole page: without a boundary there a throw unmounted the entire
   * window and left it blank. Accessory parts (the What's New gate, the
   * footer) stay silent: the window is still usable without them.
   */
  visible?: boolean;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const PageFailure = (props: { error: unknown; reset: () => void }) => {
  const { t } = useTranslation();
  return (
    <div class="w-full max-w-3xl">
      <Alert variant="error">
        <div class="flex items-center justify-between gap-3">
          <span>
            {t("errors.pageFailed", { message: messageOf(props.error) })}
          </span>
          <button
            type="button"
            onClick={() => props.reset()}
            class="shrink-0 rounded-md border border-mid-gray/30 px-2 py-1 text-xs font-medium hover:border-accent cursor-pointer"
          >
            {t("errors.pageFailedRetry")}
          </button>
        </div>
      </Alert>
    </div>
  );
};

export const ErrorBoundary = (props: ErrorBoundaryProps) => {
  return (
    <Errored
      fallback={(error, reset) => {
        console.error(`Error rendering ${props.context}:`, error());
        return props.visible ? (
          <PageFailure error={error()} reset={reset} />
        ) : null;
      }}
    >
      {props.children}
    </Errored>
  );
};
