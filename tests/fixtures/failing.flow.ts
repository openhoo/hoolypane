import { defineFlow } from "@hoolypane/runner";

export default defineFlow(async ({ all }) => {
  await all("navigate", async ({ page }) => page.goto("/"));
  await all("missing locator", async ({ page }) => page.getByTestId("does-not-exist").click({ timeout: 250 }));
});
