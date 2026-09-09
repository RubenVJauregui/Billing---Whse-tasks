import assert from "node:assert/strict";
import { chromium } from "playwright";

const accessToken = (process.env.ITEM_AUTHORIZATION || "").replace(/^Bearer\s+/i, "");
assert(accessToken, "ITEM_AUTHORIZATION is required for the authenticated smoke test");

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const taskRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/tasks?")) taskRequests.push(request.url());
  });

  const initialResponse = await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  assert(initialResponse);
  assert.equal(initialResponse.headers()["x-frame-options"], undefined);
  assert(!/frame-ancestors\s+[^;]*(?:'none'|'self')/i.test(initialResponse.headers()["content-security-policy"] || ""));
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page.getByRole("button", { name: "Sign in" }).click();
  assert.match(await page.locator(".form-error").innerText(), /username and password/i);
  console.log("ok signed-out validation");

  await context.addCookies([
    {
      name: "wise_access",
      value: accessToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None",
    },
  ]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".summary-grid").waitFor({ timeout: 30_000 });
  await page.locator(".table-wrap, .state-panel").first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".error-state").count(), 0);

  const cards = await page.locator(".summary-card").allTextContents();
  assert.equal(cards.length, 5);
  assert.match(cards[0], /FacilityValley View/);
  assert.match(cards[1], /Assigned tasks/);
  assert.match(cards[4], /Date/);
  assert.equal(await page.locator("button svg, .summary-card svg, .table-search svg, .dialog-search svg").count(), 0);
  assert.deepEqual(await page.locator(".view-tabs button").allTextContents(), [
    "Show All",
    "Task Type",
    "Task Subtype",
    "Customer",
    "Customer Name",
    "Task ID",
    "Status",
  ]);
  assert.deepEqual(await page.locator("thead th").allTextContents(), [
    "Task Type",
    "Task Subtype",
    "Customer",
    "Customer Name",
    "Task ID",
    "Status",
  ]);
  console.log("ok Valley View dashboard", cards.join(" | "));

  const assignedTasksCard = page.getByRole("button", { name: /^Assigned tasks/ });
  const customersCard = page.getByRole("button", { name: /^Customers/ });
  const taskTypesCard = page.getByRole("button", { name: /^Task types/ });
  await customersCard.click();
  assert.equal(await customersCard.getAttribute("aria-pressed"), "true");
  assert.deepEqual(await page.locator("thead th").allTextContents(), ["Customer", "Task Count"]);
  await taskTypesCard.focus();
  await page.keyboard.press("Enter");
  assert.equal(await taskTypesCard.getAttribute("aria-pressed"), "true");
  assert.deepEqual(await page.locator("thead th").allTextContents(), ["Task Type", "Task Count"]);
  await page.getByLabel("Search tasks").fill("Load");
  await assignedTasksCard.focus();
  await page.keyboard.press("Space");
  assert.equal(await assignedTasksCard.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByLabel("Search tasks").inputValue(), "");
  assert.deepEqual(await page.locator("thead th").allTextContents(), [
    "Task Type",
    "Task Subtype",
    "Customer",
    "Customer Name",
    "Task ID",
    "Status",
  ]);
  assert.deepEqual(await page.locator(".summary-card").allTextContents(), cards);
  console.log("ok KPI card mouse and keyboard interactions");

  const viewChecks = [
    ["Task Type", ["Task Type", "Task Count"]],
    ["Task Subtype", ["Task Subtype", "Task Count"]],
    ["Customer", ["Customer", "Task Count"]],
    ["Customer Name", ["Customer Name", "Task Count"]],
    ["Task ID", ["Task ID", "Task Count"]],
    ["Status", ["Task ID", "Status"]],
    ["Show All", ["Task Type", "Task Subtype", "Customer", "Customer Name", "Task ID", "Status"]],
  ];
  for (const [index, [label, headers]] of viewChecks.entries()) {
    const control = page.locator(".view-tabs").getByRole("button", { name: label, exact: true });
    if (label === "Show All") await page.getByLabel("Search tasks").fill("Load");
    await control.focus();
    await page.keyboard.press(index % 2 === 0 ? "Enter" : "Space");
    assert.equal(await control.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await page.locator("thead th").allTextContents(), headers);
    if (label === "Show All") assert.equal(await page.getByLabel("Search tasks").inputValue(), "");
  }
  assert.equal(await page.locator('.view-tabs button[aria-pressed="true"]').count(), 1);
  console.log("ok all column navigation views by keyboard");

  await page.locator(".date-card").click();
  await page.getByRole("heading", { name: "Choose a date" }).waitFor();
  const currentMonth = await page.locator(".calendar-navigation strong").innerText();
  assert(await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  const previousMonth = await page.locator(".calendar-navigation strong").innerText();
  assert.notEqual(previousMonth, currentMonth);
  await page.getByRole("button", { name: "Show entire month" }).click();
  await page.locator(".date-dialog").waitFor({ state: "detached" });
  await page.locator(".table-wrap, .state-panel").first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".error-state").count(), 0);
  assert(taskRequests.some((url) => url.includes("month=")));
  assert.match(await page.locator(".date-card").innerText(), new RegExp(previousMonth));
  console.log("ok previous-month task range", previousMonth);

  await page.locator(".date-card").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const latestAvailableDay = page.locator(".calendar-grid button:not(:disabled)").last();
  const selectedDateLabel = await latestAvailableDay.getAttribute("aria-label");
  await latestAvailableDay.click();
  await page.locator(".date-dialog").waitFor({ state: "detached" });
  await page.locator(".table-wrap, .state-panel").first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".error-state").count(), 0);
  assert(taskRequests.some((url) => url.includes("date=")));
  assert(selectedDateLabel);
  console.log("ok facility-local day", selectedDateLabel);

  await page.locator(".facility-card").click();
  await page.getByLabel("Search facilities").fill("Indiana");
  assert((await page.locator(".facility-option").count()) > 0);
  await page.screenshot({ path: "/tmp/wise-facility-picker.png", fullPage: true });
  await page.locator(".facility-option").first().click();
  await page.waitForFunction(
    () => document.querySelector(".page-heading p")?.textContent?.includes("Indiana"),
    undefined,
    { timeout: 30_000 },
  );
  await page.locator(".table-wrap, .state-panel").first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".error-state").count(), 0);
  assert.equal(await page.locator("button svg, .summary-card svg, .table-search svg, .dialog-search svg").count(), 0);
  console.log("ok real facility switch", await page.locator(".page-heading p").innerText());
  await page.screenshot({ path: "/tmp/wise-dashboard-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".summary-grid").waitFor({ timeout: 30_000 });
  await page.locator(".table-wrap, .state-panel").first().waitFor({ timeout: 30_000 });
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.equal(dimensions.scrollWidth, dimensions.clientWidth);
  await page.screenshot({ path: "/tmp/wise-dashboard-mobile.png", fullPage: true });
  console.log("ok mobile layout", JSON.stringify(dimensions));

  assert.deepEqual(consoleErrors, []);
  console.log("ok browser console");
} finally {
  await browser.close();
}
