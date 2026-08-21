import { defineFlow } from "@hoolypane/runner";

export default defineFlow(async ({ all }) => {
  await all("navigate", async ({ page }) => page.goto("/"));
  await all("fill", async ({ page }) => page.getByTestId("name").fill("Hoolypane"));
  await all("select", async ({ page }) => page.getByTestId("theme").selectOption("dark"));
  await all("check", async ({ page }) => page.getByTestId("subscribe").check());
  await all("click", async ({ page }) => page.getByTestId("apply").click());
  await all("press", async ({ page }) => page.getByTestId("command").press("Enter"));
  await all("scroll", async ({ page }) => page.getByTestId("scroller").evaluate((element) => element.scrollTo({ top: element.scrollHeight })));
  await all("result", async ({ id, page }) => {
    const result = await page.evaluate(() => {
      const name = (document.querySelector('[data-testid="name"]') as HTMLInputElement).value;
      const theme = (document.querySelector('[data-testid="theme"]') as HTMLSelectElement).value;
      const subscribed = (document.querySelector('[data-testid="subscribe"]') as HTMLInputElement).checked;
      const status = document.querySelector('[data-testid="status"]')?.textContent;
      const scroller = document.querySelector('[data-testid="scroller"]') as HTMLElement;
      return { name, theme, subscribed, status, scrollRatio: scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) };
    });
    await page.request.post("/result", { data: { id, ...result } });
  });
});
