import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import readXlsxFile from "read-excel-file/node";

async function readExcelDownload(download) {
  assert.match(download.suggestedFilename(), /\.xlsx$/i);
  const downloadPath = await download.path();
  assert(downloadPath);
  const contents = await readFile(downloadPath);
  assert.equal(contents.subarray(0, 2).toString(), "PK");

  const sheets = await readXlsxFile(downloadPath);
  assert.equal(sheets.length, 1);
  const rows = sheets[0].data;
  assert(rows.length > 0);
  return {
    headers: rows[0].map(String),
    rowCount: rows.length - 1,
  };
}

async function exportWorkbook(page, button) {
  const downloadPromise = page.waitForEvent("download");
  await button.click();
  return readExcelDownload(await downloadPromise);
}

const accessToken = (process.env.ITEM_AUTHORIZATION || "").replace(/^Bearer\s+/i, "");
const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3000";
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

  const initialResponse = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
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
    "Task Charge",
  ]);
  const displayedTaskRows = page.locator(".table-wrap .task-data-row");
  assert.equal(await displayedTaskRows.count(), await page.locator(".table-wrap .task-charge").count());
  assert((await page.locator(".table-wrap .task-charge.unavailable").allTextContents()).every(
    (value) => value.includes("Rate not available at task level"),
  ));
  assert.equal(
    await page.locator(".table-wrap .task-charge.available, .table-wrap .task-charge.unavailable").count(),
    await displayedTaskRows.count(),
  );
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
    "Task Charge",
  ]);
  assert.deepEqual(await page.locator(".summary-card").allTextContents(), cards);
  console.log("ok KPI card mouse and keyboard interactions");

  const viewChecks = [
    ["Task Type", ["Task Type", "Task Count"]],
    ["Task Subtype", ["Task Subtype", "Task Count"]],
    ["Customer", ["Customer", "Task Count"]],
    ["Customer Name", ["Customer Name", "Task Count"]],
    ["Task ID", ["Task ID", "Status", "Task Charge"]],
    ["Status", ["Status", "Task Count"]],
    ["Show All", ["Task Type", "Task Subtype", "Customer", "Customer Name", "Task ID", "Status", "Task Charge"]],
  ];
  for (const [index, [label, headers]] of viewChecks.entries()) {
    const control = page.locator(".view-tabs").getByRole("button", { name: label, exact: true });
    if (label === "Show All") await page.getByLabel("Search tasks").fill("Load");
    await control.focus();
    await page.keyboard.press(index % 2 === 0 ? "Enter" : "Space");
    assert.equal(await control.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await page.locator("thead th").allTextContents(), headers);
    if (label === "Show All") assert.equal(await page.getByLabel("Search tasks").inputValue(), "");
    const displayedRowCount = await page.locator(".table-wrap tbody tr").count();
    assert(displayedRowCount > 0);
    const rowButton = page.locator(".table-wrap tbody tr").first().locator(".task-row-button");
    await rowButton.focus();
    await page.keyboard.press(index % 2 === 0 ? "Space" : "Enter");
    const rowDialog = page.getByRole("dialog").last();
    await rowDialog.waitFor();
    await page.keyboard.press("Escape");
    await rowDialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("task-row-button"));
    assert(await rowButton.evaluate((element) => element === document.activeElement));
    const exportedView = await exportWorkbook(
      page,
      page.getByRole("button", { name: "Export to Excel", exact: true }),
    );
    assert.deepEqual(exportedView.headers, headers);
    assert.equal(exportedView.rowCount, displayedRowCount);
    await page.locator(".page-actions .export-feedback.success").filter({ hasText: "Excel export downloaded." }).waitFor();
  }
  assert.equal(await page.locator('.view-tabs button[aria-pressed="true"]').count(), 1);
  console.log("ok all column navigation views and Excel downloads");

  await page.getByLabel("Search tasks").fill("__no_matching_task__");
  await page.getByRole("button", { name: "Export to Excel", exact: true }).click();
  assert.match(await page.locator(".page-actions .export-feedback.error").innerText(), /no displayed data/i);
  await page.getByLabel("Search tasks").fill("");
  console.log("ok empty export feedback");

  const firstTaskRow = page.locator(".task-data-row").first();
  const expectedTaskDetails = [
    ...await firstTaskRow.locator("td").evaluateAll((cells) => cells.slice(0, 5).map((cell) => cell.textContent || "")),
    await firstTaskRow.locator(".status").innerText(),
  ];
  const expectedTaskCharge = await firstTaskRow.locator(".task-charge").innerText();
  await firstTaskRow.click();
  const taskDialog = page.getByRole("dialog", { name: "Task details" });
  await taskDialog.waitFor();
  assert.deepEqual(await taskDialog.locator("dt").allTextContents(), [
    "Task Type",
    "Task Subtype",
    "Customer",
    "Customer Name",
    "Task ID",
    "Status",
  ]);
  assert.deepEqual(await taskDialog.locator("dd").allTextContents(), expectedTaskDetails);
  assert.equal(await taskDialog.locator(".task-charge-detail > span").textContent(), "Task Charge");
  assert.equal(await taskDialog.locator(".task-charge-detail strong").innerText(), expectedTaskCharge);
  const closeTaskDialog = taskDialog.getByRole("button", { name: "Close", exact: true });
  assert(await closeTaskDialog.evaluate((element) => element === document.activeElement));
  const exportedTask = await exportWorkbook(
    page,
    taskDialog.getByRole("button", { name: "Export to Excel", exact: true }),
  );
  assert.deepEqual(exportedTask.headers, [
    "Task Type",
    "Task Subtype",
    "Customer",
    "Customer Name",
    "Task ID",
    "Status",
    "Task Charge",
  ]);
  assert.equal(exportedTask.rowCount, 1);
  await page.screenshot({ path: "/tmp/wise-task-detail-dialog.png", fullPage: true });
  await closeTaskDialog.click();
  await taskDialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("task-row-button"));

  const firstTaskButton = firstTaskRow.locator(".task-row-button");
  await firstTaskButton.focus();
  await page.keyboard.press("Enter");
  await taskDialog.waitFor();
  await page.keyboard.press("Escape");
  await taskDialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("task-row-button"));

  await firstTaskButton.focus();
  await page.keyboard.press("Space");
  await taskDialog.waitFor();
  await page.keyboard.press("Tab");
  assert(await taskDialog.getByRole("button", { name: "Export to Excel", exact: true }).evaluate((element) => element === document.activeElement));
  await page.keyboard.press("Escape");
  await taskDialog.waitFor({ state: "detached" });
  console.log("ok task row mouse and keyboard detail dialog");

  await page.locator(".view-tabs").getByRole("button", { name: "Customer Name", exact: true }).click();
  const customerGroupRow = page.locator(".task-group-row").first();
  const customerGroupName = await customerGroupRow.locator("td").first().innerText();
  const customerGroupCount = Number((await customerGroupRow.locator("td").nth(1).innerText()).replaceAll(",", ""));
  await customerGroupRow.locator("td").nth(1).click();
  const customerGroupDialog = page.getByRole("dialog", { name: customerGroupName, exact: true });
  await customerGroupDialog.waitFor();
  assert.match(await customerGroupDialog.locator(".customer-group-count").innerText(), new RegExp(`^${customerGroupCount.toLocaleString()} tasks?$`));
  assert.deepEqual(await customerGroupDialog.locator("thead th").allTextContents(), [
    "Task Type",
    "Task Subtype",
    "Customer",
    "Customer Name",
    "Task ID",
    "Status",
    "Task Charge",
  ]);
  assert.equal(await customerGroupDialog.locator("tbody tr").count(), customerGroupCount);
  assert((await customerGroupDialog.locator("tbody tr td:nth-child(4)").allTextContents()).every((name) => name === customerGroupName));
  const closeCustomerGroup = customerGroupDialog.getByRole("button", { name: "Close", exact: true });
  assert(await closeCustomerGroup.evaluate((element) => element === document.activeElement));
  const exportedCustomerGroup = await exportWorkbook(
    page,
    customerGroupDialog.getByRole("button", { name: "Export to Excel", exact: true }),
  );
  assert.deepEqual(exportedCustomerGroup.headers, [
    "Task Type",
    "Task Subtype",
    "Customer",
    "Customer Name",
    "Task ID",
    "Status",
    "Task Charge",
  ]);
  assert.equal(exportedCustomerGroup.rowCount, customerGroupCount);
  await page.screenshot({ path: "/tmp/wise-customer-name-group.png", fullPage: false });
  await closeCustomerGroup.click();
  await customerGroupDialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("task-group-button"));

  const customerGroupButton = customerGroupRow.locator(".task-group-button");
  await customerGroupButton.focus();
  await page.keyboard.press("Enter");
  await customerGroupDialog.waitFor();
  await page.keyboard.press("Escape");
  await customerGroupDialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("task-group-button"));
  console.log("ok customer-name group mouse and keyboard drill-down", customerGroupName, customerGroupCount);

  await page.locator(".date-card").click();
  await page.getByRole("heading", { name: "Choose a date" }).waitFor();
  const currentMonth = await page.locator(".calendar-navigation strong").innerText();
  assert(await page.getByRole("button", { name: "Next", exact: true }).isDisabled());
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  const previousMonth = await page.locator(".calendar-navigation strong").innerText();
  assert.notEqual(previousMonth, currentMonth);
  await page.getByRole("button", { name: "Show entire month" }).click();
  await page.locator(".date-dialog").waitFor({ state: "detached" });
  await page.locator(".table-wrap, .state-panel").first().waitFor({ timeout: 60_000 });
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
  await page.locator(".task-row-button").first().click();
  const mobileDialog = page.getByRole("dialog", { name: "Task details" });
  await mobileDialog.waitFor();
  const dialogBounds = await mobileDialog.boundingBox();
  assert(dialogBounds);
  assert(dialogBounds.y >= 0 && dialogBounds.y + dialogBounds.height <= 844);
  assert.equal(await mobileDialog.locator(".task-detail-item").count(), 6);
  await page.screenshot({ path: "/tmp/wise-task-detail-mobile.png", fullPage: false });
  await mobileDialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({ path: "/tmp/wise-dashboard-mobile.png", fullPage: true });
  console.log("ok mobile layout", JSON.stringify(dimensions));

  assert.deepEqual(consoleErrors, []);
  console.log("ok browser console");
} finally {
  await browser.close();
}
