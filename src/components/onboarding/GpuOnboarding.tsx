import { createSignal, onSettled } from "solid-js";
import { commands, events } from "@/bindings";
import type { CudaAddonEvent, CudaAddonOffer } from "@/bindings";
import { useTranslation } from "@/i18n/useTranslation";
import { Button } from "../ui/Button";
import BrandLockup from "../icons/BrandLockup";

interface GpuOnboardingProps {
  onComplete: () => void;
  /** Debug preview: shows a sample offer, downloads nothing. */
  preview?: boolean;
}

type Phase = "offer" | "installing" | "done" | "failed";

const MB = 1024 * 1024;

/** What the Debug page's preview shows. */
const SAMPLE_OFFER: CudaAddonOffer = {
  arch: "86",
  gpu: "NVIDIA GeForce RTX 3080",
  module_mb: 48,
  runtime_mb: 382,
  toolkit_runtime: null,
  cuda_version: "13.3.1",
};

/**
 * The first-run GPU step (docs/GPU_BACKENDS.md). The installer carries the
 * CPU and Vulkan backends; on a machine with an NVIDIA GPU this step offers
 * the CUDA add-on the release publishes for the card (and the NVIDIA runtime
 * once). Every other machine never sees it: the step completes itself when
 * the status has nothing to offer. The download runs in the background, so
 * Continue never waits for it; the add-on is used from the next start.
 */
const GpuOnboarding = (props: GpuOnboardingProps) => {
  const { t } = useTranslation();
  const [offer, setOffer] = createSignal<CudaAddonOffer | null>(null);
  const [phase, setPhase] = createSignal<Phase>("offer");
  const [progress, setProgress] = createSignal<CudaAddonEvent | null>(null);

  const finish = () => {
    if (!props.preview) props.onComplete();
  };

  onSettled(() => {
    if (props.preview) {
      setOffer(SAMPLE_OFFER);
      return;
    }
    let cancelled = false;
    commands
      .getCudaAddonStatus(false)
      .then((status) => {
        if (cancelled) return;
        if (status.supported && status.offer !== null && !status.installing) {
          setOffer(status.offer);
        } else {
          props.onComplete();
        }
      })
      .catch(() => {
        if (!cancelled) props.onComplete();
      });
    const unlisten = events.cudaAddonEvent.listen((event) => {
      const payload = event.payload;
      if (payload.phase === "done") setPhase("done");
      else if (payload.phase === "error") setPhase("failed");
      else setProgress(payload);
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  });

  const download = async () => {
    const current = offer();
    if (current === null || props.preview) return;
    setPhase("installing");
    const result = await commands.installCudaAddon(current.arch);
    if (result.status === "error") setPhase("failed");
  };

  const sizeText = () => {
    const current = offer();
    if (current === null) return "";
    return current.runtime_mb > 0
      ? t("onboarding.gpu.sizeWithRuntime", {
          module: current.module_mb,
          runtime: current.runtime_mb,
        })
      : t("onboarding.gpu.size", { module: current.module_mb });
  };
  const downloaded = () => progress()?.downloaded_bytes ?? 0;
  const total = () => progress()?.total_bytes ?? 0;

  return (
    <div class="h-screen w-full flex flex-col p-6 gap-6 items-center justify-center">
      <BrandLockup size={44} />
      {offer() === null ? (
        <p class="text-sm text-text/60">{t("onboarding.gpu.checking")}</p>
      ) : (
        <>
          <div class="max-w-md text-center space-y-2">
            <h1 class="text-lg font-semibold text-text">
              {t("onboarding.gpu.title")}
            </h1>
            <p class="text-sm text-text/60">
              {t("onboarding.gpu.description", { gpu: offer()?.gpu ?? "" })}
            </p>
            <p class="text-xs text-text/45">{sizeText()}</p>
          </div>
          {phase() === "installing" && (
            <div class="w-full max-w-md space-y-1">
              <div class="flex justify-between text-xs text-text/60">
                <span>{t("onboarding.gpu.downloading")}</span>
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
          )}
          {phase() === "done" && (
            <p class="text-sm text-text">{t("onboarding.gpu.done")}</p>
          )}
          {phase() === "failed" && (
            <p class="text-sm text-text max-w-md text-center">
              {t("onboarding.gpu.failed")}
            </p>
          )}
          <p class="text-xs text-text/45 max-w-md text-center">
            {t("onboarding.gpu.later")}
          </p>
          <div class="flex gap-2">
            {phase() === "offer" ? (
              <>
                <Button variant="secondary" onClick={finish}>
                  {t("onboarding.gpu.skip")}
                </Button>
                <Button onClick={() => void download()}>
                  {t("onboarding.gpu.download")}
                </Button>
              </>
            ) : (
              <Button onClick={finish}>{t("onboarding.gpu.continue")}</Button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default GpuOnboarding;
