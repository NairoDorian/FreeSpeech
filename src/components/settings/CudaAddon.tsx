import { createSignal, onSettled } from "solid-js";
import { relaunch } from "@tauri-apps/plugin-process";
import { useTranslation } from "@/i18n/useTranslation";
import { commands, events } from "@/bindings";
import type { CudaAddonEvent, CudaAddonStatus } from "@/bindings";
import { SettingContainer } from "../ui/SettingContainer";
import { Button } from "../ui/Button";
import { Alert } from "../ui/Alert";

interface CudaAddonProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

const MB = 1024 * 1024;

/**
 * The CUDA add-on (`src-tauri/src/gpu_addons.rs`, docs/GPU_BACKENDS.md): on
 * Windows x64 with an NVIDIA GPU, offers this release's ggml-cuda module for
 * the card (and the CUDA runtime, once) and installs it into the app's data
 * folder; it is registered at the next start. Renders nothing on a machine
 * without an NVIDIA GPU and without an installed add-on.
 */
export const CudaAddon = (props: CudaAddonProps) => {
  const { t } = useTranslation();
  const [status, setStatus] = createSignal<CudaAddonStatus | null>(null);
  const [progress, setProgress] = createSignal<CudaAddonEvent | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const refresh = async (force = false) => {
    try {
      setStatus(await commands.getCudaAddonStatus(force));
    } catch (e) {
      console.error("Failed to read the CUDA add-on status:", e);
    }
  };

  onSettled(() => {
    void refresh();
    const unlisten = events.cudaAddonEvent.listen((event) => {
      const payload = event.payload;
      if (payload.phase === "done" || payload.phase === "error") {
        setProgress(null);
        if (payload.phase === "error") setError(payload.message ?? "");
        void refresh();
      } else {
        setProgress(payload);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  });

  const visible = () => {
    const s = status();
    return (
      !!s &&
      s.supported &&
      (s.gpus.length > 0 || s.installed_arch !== null || s.active !== null)
    );
  };
  const installing = () =>
    progress() !== null || (status()?.installing ?? false);
  const gpuName = () =>
    status()?.gpus[0]?.name || t("settings.advanced.cudaAddon.gpuFallback");

  const install = async (arch: string) => {
    setError(null);
    setBusy(true);
    const result = await commands.installCudaAddon(arch);
    setBusy(false);
    if (result.status === "error") {
      setError(result.error);
    }
    await refresh();
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    const result = await commands.removeCudaAddon();
    setBusy(false);
    if (result.status === "error") {
      setError(result.error);
    }
    await refresh();
  };

  const progressLabel = () => {
    const p = progress();
    if (!p) return t("settings.advanced.cudaAddon.preparing");
    if (p.phase === "verifying")
      return t("settings.advanced.cudaAddon.verifying");
    return p.part === "runtime"
      ? t("settings.advanced.cudaAddon.downloadingRuntime")
      : t("settings.advanced.cudaAddon.downloadingModule");
  };
  const downloaded = () => progress()?.downloaded_bytes ?? 0;
  const total = () => progress()?.total_bytes ?? 0;

  const unavailableText = (s: CudaAddonStatus) => {
    switch (s.unavailable) {
      case "not_published":
        return t("settings.advanced.cudaAddon.unavailable.notPublished");
      case "other_build":
        return t("settings.advanced.cudaAddon.unavailable.otherBuild");
      case "no_package_for_gpu":
        return t("settings.advanced.cudaAddon.unavailable.noPackageForGpu", {
          capability: s.gpus[0]?.compute_capability ?? "",
        });
      case "driver_too_old":
        return t("settings.advanced.cudaAddon.unavailable.driverTooOld", {
          driver: s.driver_cuda ?? "?",
        });
      case "lookup_failed":
        return t("settings.advanced.cudaAddon.unavailable.lookupFailed");
      default:
        return null;
    }
  };

  const removeButton = () => (
    <Button
      variant="danger-ghost"
      size="sm"
      onClick={() => void remove()}
      disabled={busy()}
    >
      {t("settings.advanced.cudaAddon.remove")}
    </Button>
  );

  const body = () => {
    const s = status();
    if (!s) return null;
    if (installing()) {
      return (
        <div>
          <div class="flex justify-between text-xs text-text/70 mb-1">
            <span>{progressLabel()}</span>
            <span class="font-mono">
              {total() > 0
                ? `${Math.round(downloaded() / MB)} / ${Math.round(total() / MB)} MB`
                : ""}
            </span>
          </div>
          <div class="h-1.5 bg-mid-gray/20 overflow-hidden">
            <div
              class="h-full bg-accent transition-[width]"
              style={{
                width:
                  total() > 0
                    ? `${Math.min(100, (downloaded() / total()) * 100)}%`
                    : "100%",
              }}
            />
          </div>
        </div>
      );
    }
    if (s.active === "build") {
      return <p>{t("settings.advanced.cudaAddon.builtIn")}</p>;
    }
    if (s.removal_pending && s.installed_arch === null) {
      return (
        <div class="flex items-center justify-between gap-3">
          <p>{t("settings.advanced.cudaAddon.removalPending")}</p>
          <Button size="sm" onClick={() => void relaunch()}>
            {t("settings.advanced.cudaAddon.restart")}
          </Button>
        </div>
      );
    }
    if (s.active === "addon") {
      return (
        <div class="flex items-center justify-between gap-3">
          <p>
            {t("settings.advanced.cudaAddon.active", {
              gpu: gpuName(),
              arch: s.installed_arch ?? "",
            })}
          </p>
          {removeButton()}
        </div>
      );
    }
    if (s.load_failed) {
      return (
        <div class="space-y-2">
          <Alert variant="warning" contained>
            {t("settings.advanced.cudaAddon.loadFailed")}
          </Alert>
          {removeButton()}
        </div>
      );
    }
    if (s.restart_required) {
      return (
        <div class="flex items-center justify-between gap-3">
          <p>{t("settings.advanced.cudaAddon.restartRequired")}</p>
          <div class="flex gap-2">
            <Button size="sm" onClick={() => void relaunch()}>
              {t("settings.advanced.cudaAddon.restart")}
            </Button>
            {removeButton()}
          </div>
        </div>
      );
    }
    const offer = s.offer;
    if (offer) {
      return (
        <div class="flex items-center justify-between gap-3">
          <div class="space-y-1">
            <p>{t("settings.advanced.cudaAddon.offer", { gpu: offer.gpu })}</p>
            <p class="text-xs text-text/70">
              {offer.runtime_mb > 0
                ? t("settings.advanced.cudaAddon.sizeWithRuntime", {
                    module: offer.module_mb,
                    runtime: offer.runtime_mb,
                  })
                : t("settings.advanced.cudaAddon.size", {
                    module: offer.module_mb,
                  })}
            </p>
            {offer.toolkit_runtime !== null && (
              <p class="text-xs text-text/70">
                {t("settings.advanced.cudaAddon.toolkitRuntime", {
                  version: offer.toolkit_runtime,
                })}
              </p>
            )}
          </div>
          <Button
            size="sm"
            onClick={() => void install(offer.arch)}
            disabled={busy()}
          >
            {t("settings.advanced.cudaAddon.download")}
          </Button>
        </div>
      );
    }
    const text = unavailableText(s);
    if (!text) return null;
    return (
      <div class="flex items-center justify-between gap-3">
        <p class="text-text/70">{text}</p>
        {s.unavailable === "lookup_failed" && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refresh(true)}
          >
            {t("settings.advanced.cudaAddon.retry")}
          </Button>
        )}
      </div>
    );
  };

  return (
    <>
      {visible() && (
        <SettingContainer
          title={t("settings.advanced.cudaAddon.title")}
          description={t("settings.advanced.cudaAddon.description")}
          descriptionMode={props.descriptionMode ?? "tooltip"}
          grouped={props.grouped ?? false}
          layout="stacked"
        >
          <div class="space-y-2 text-sm">
            {body()}
            {error() !== null && (
              <Alert variant="error" contained>
                {t("settings.advanced.cudaAddon.failed", {
                  message: error() ?? "",
                })}
              </Alert>
            )}
          </div>
        </SettingContainer>
      )}
    </>
  );
};
