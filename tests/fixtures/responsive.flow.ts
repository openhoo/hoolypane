import { defineFlow } from "@hoolypane/runner";

export default defineFlow(async ({ all }) => {
  await all("navigate", async ({ page }) => page.goto("/"));
  await all("fill", async ({ page }) => page.getByTestId("name").fill("Hoolypane"));
  await all("select", async ({ page }) => page.getByTestId("theme").selectOption("dark"));
  await all("check", async ({ page }) => {
    try {
      await page.getByTestId("subscribe").check();
    } catch (error) {
      const box = await page.getByTestId("subscribe").boundingBox().catch(() => null);
      const hit = await page.evaluate(() => { const element = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return element ? element.tagName + "[" + (element.getAttribute("data-testid") ?? "") + "]" : "none"; }).catch(() => "eval-error");
      console.log("CHECK DETAIL", JSON.stringify({ viewport: page.viewportSize(), message: error instanceof Error ? error.message.split("\n").slice(0, 4).join(" | ") : String(error), box, hit }));
      throw error;
    }
  });
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
