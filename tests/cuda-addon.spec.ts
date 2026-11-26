import { test, expect } from "./harness/fixtures";
import type { Page } from "@playwright/test";

// The CUDA add-on panel on the Advanced page (`CudaAddon.tsx`), driven through
// the states `get_cuda_addon_status` reports. The generated fixture answers
// with `supported: false`, which hides the panel; each test here replaces that
// answer before the app boots.

type Status = Record<string, unknown>;

const base: Status = {
  supported: true,
  gpus: [{ name: "NVIDIA GeForce RTX 3080", compute_capability: "8.6" }],
  driver_cuda: "13.5",
  active: null,
  installed_arch: null,
  restart_required: false,
  load_failed: false,
  removal_pending: false,
  offer: null,
  unavailable: null,
  installing: false,
};

async function openAdvanced(page: Page, status: Status) {
  // Per-test replies, read by the mock at call time (`tauri-mock.js`).
  await page.addInitScript((answer) => {
    (window as unknown as Record<string, unknown>).__TAURI_MOCK_REPLIES__ = {
      get_cuda_addon_status: answer,
      install_cuda_addon: null,
    };
  }, status);
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Advanced", exact: true })
    .click();
  await expect(page.getByText("Start Hidden")).toBeVisible();
}

const panel = (page: Page) => page.getByText("CUDA acceleration");

test("hidden without an NVIDIA GPU", async ({ page }) => {
  await openAdvanced(page, {
    ...base,
    gpus: [],
    unavailable: "no_nvidia_gpu",
  });
  await expect(panel(page)).toHaveCount(0);
});

test("offers the module for the card, with the runtime's size", async ({
  page,
}) => {
  await openAdvanced(page, {
    ...base,
    offer: {
      arch: "86",
      gpu: "NVIDIA GeForce RTX 3080",
      module_mb: 48,
      runtime_mb: 382,
      toolkit_runtime: null,
      cuda_version: "13.3.1",
    },
  });
  await expect(panel(page)).toBeVisible();
  await expect(
    page.getByText("NVIDIA GeForce RTX 3080 can run speech models with CUDA."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Download: 48 MB, plus 382 MB for the NVIDIA CUDA runtime (once)",
    ),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/cuda-addon-offer.png" });

  await page.getByRole("button", { name: "Download", exact: true }).click();
  const installs = await page.evaluate(() =>
    (
      window as unknown as { __TAURI_CALLS__: { cmd: string; args: any }[] }
    ).__TAURI_CALLS__.filter((call) => call.cmd === "install_cuda_addon"),
  );
  expect(installs).toEqual([
    { cmd: "install_cuda_addon", args: { arch: "86" } },
  ]);
});

test("asks for a restart once installed", async ({ page }) => {
  await openAdvanced(page, {
    ...base,
    installed_arch: "86",
    restart_required: true,
  });
  await expect(page.getByText("Installed. Restart to use CUDA.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restart now", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/cuda-addon-restart.png" });
});

test("says when the driver is too old", async ({ page }) => {
  await openAdvanced(page, {
    ...base,
    driver_cuda: "12.4",
    unavailable: "driver_too_old",
  });
  await expect(
    page.getByText(
      "Update the NVIDIA driver to use the CUDA add-on (this one supports CUDA 12.4).",
    ),
  ).toBeVisible();
});

test("the onboarding step offers the add-on (Debug preview)", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Debug", exact: true })
    .click();
  await page.getByRole("button", { name: "GPU", exact: true }).click();
  await expect(page.getByText("Faster on your NVIDIA GPU")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download CUDA", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/cuda-addon-onboarding.png" });
});
