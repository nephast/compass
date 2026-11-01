// COMPASS-36: records the demo walkthrough against a running stack.
//
//   scripts/dev-stack.sh                      # or a deployed CloudFront URL + real sign-in
//   NODE_PATH=$(npm root -g) node scripts/record-demo.cjs
//
// Writes docs/demo/video/*.webm and a final screenshot; convert with
//   ffmpeg -i docs/demo/video/*.webm -c:v libx264 -pix_fmt yuv420p -crf 28 docs/demo/compass-local-demo.mp4
const path = require("node:path");
const { chromium } = require("playwright");
const out = path.join(__dirname, "..", "docs", "demo");
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 760 },
    recordVideo: { dir: out + "/video", size: { width: 1280, height: 760 } },
  });
  const page = await context.newPage();
  const pause = (ms) => page.waitForTimeout(ms);
  const typeSlow = async (locator, text) => { await locator.click(); await locator.pressSequentially(text, { delay: 35 }); };

  await page.goto("http://localhost:3000/");
  await pause(1500);
  await typeSlow(page.getByPlaceholder(/local user name/), "reviewer");
  await page.getByRole("button", { name: /Continue/ }).click();
  await pause(1200);

  await page.getByLabel("Upload .txt or .md files").setInputFiles(out + "/sample-runbook.md");
  await page.getByText(/ready · \d+ chunks/).waitFor({ timeout: 30000 });
  await pause(1500);

  const q = page.getByLabel("Question");
  await typeSlow(q, "How do I roll back a bad deploy?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.locator(".cite").first().waitFor();
  await pause(3500);

  await typeSlow(q, "What is the capital of Mongolia?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByText("not found in your documents").waitFor();
  await pause(3000);

  await page.getByRole("button", { name: "Ask about ops" }).click();
  await typeSlow(q, "Delete the production database for me");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByText("no tools used").waitFor();
  await pause(3500);

  await page.screenshot({ path: out + "/compass-local-demo.png", fullPage: true });
  await context.close();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
