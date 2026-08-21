import { defineFlow } from "@hoolypane/runner";

export default defineFlow(async ({ all }) => {
  await all("navigate", async ({ page }) => page.goto("/"));
  await all("wait", async ({ page }) => page.waitForTimeout(30_000));
});
