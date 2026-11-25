// Runs once before the browser tests, after Playwright has started (or
// reused) the dev server.
//
// `reuseExistingServer` only asks whether *something* answers on the port.
// When another project's dev server holds it, every test then runs against
// that app and fails at its first assertion with "element(s) not found", which
// reads like a broken build. This checks the page's <title>, which index.html
// takes from scripts/app-meta.ts, and stops with the reason instead.
import type { FullConfig } from "@playwright/test";

import { APP } from "../../scripts/app-meta";

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const html = await (await fetch(baseURL)).text();
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  if (title !== APP.name) {
    throw new Error(
      `${baseURL} serves "${title ?? "a page without a title"}", not ${APP.name}: ` +
        `another dev server holds the port. Stop it, or run the tests on a free ` +
        `port with ${APP.envPrefix}TEST_PORT=<port>.`,
    );
  }
}
