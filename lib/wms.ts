import { AuthError, getSession, type AuthSession } from "@/lib/session";
import { lookupBnpTaskRate, type BnpTaskRateInput } from "@/lib/bnp";

export type Facility = {
  id: string;
  name: string;
  code: string;
  timeZone: string;
};

export type TaskRow = {
  taskType: string;
  taskSubtype: string;
  customer: string;
  customerName: string;
  taskId: string;
  status: string;
  charge: TaskCharge;
};

export type TaskCharge = {
  available: boolean;
  display: string;
};

export type TaskPeriod = {
  mode: "day" | "month";
  startDate: string;
  endDate: string;
  today: string;
};

type WmsEnvelope<T> = {
  code?: number;
  success?: boolean;
  msg?: string;
  message?: string;
  data?: T;
};

type RawFacility = {
  id?: unknown;
  name?: unknown;
  facilityCode?: unknown;
  status?: unknown;
  timeZone?: unknown;
};

type RawTask = Record<string, unknown>;
type TaskSearchData = Record<string, unknown>;

type GeneralTaskLine = {
  jobPrice?: unknown;
  jobQty?: unknown;
  jobUom?: unknown;
  jobCurrency?: unknown;
};

type GeneralTaskDetail = {
  totalBillableAmount?: unknown;
  generalTaskLines?: GeneralTaskLine[];
};

const FALLBACK_FACILITY_ID = "LT_F1";
const FALLBACK_TIME_ZONE = "America/Los_Angeles";
const RATE_NOT_AVAILABLE = "Rate not available at task level";
const unavailableCharge: TaskCharge = {
  available: false,
  display: RATE_NOT_AVAILABLE,
};
const GURUNANDA_CUSTOMER_ID = "ORG-655875";
const GURUNANDA_RATE_BY_TASK = new Map<string, number>([
  ["LOAD|LIVE LOAD", 7.5],
  ["LOAD|PRE LOAD", 7.5],
  ["PICK|CASE PICK", 0.3],
  ["PICK|PALLET PICK", 5.5],
  ["PUT AWAY|PUT AWAY BY LP", 4.25],
  ["RECEIVE|NOT SET", 5.5],
]);

export class WmsError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

function requiredBaseUrl() {
  const baseUrl = process.env.WMS_API_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    throw new WmsError("Warehouse data is not configured for this site.", 503);
  }
  return baseUrl;
}

function defaultFacilityId() {
  return process.env.DEFAULT_WMS_FACILITY_ID?.trim() || FALLBACK_FACILITY_ID;
}

function defaultTimeZone() {
  return process.env.DEFAULT_WMS_TIMEZONE?.trim() || FALLBACK_TIME_ZONE;
}

async function requestWithSession<T>(
  path: string,
  options: {
    session: AuthSession;
    method: "GET" | "POST";
    facilityId: string;
    timeZone: string;
    body?: object;
    retry?: boolean;
  },
): Promise<T> {
  const response = await fetch(`${requiredBaseUrl()}${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${options.session.accessToken}`,
      "x-tenant-id": options.session.tenantId,
      "x-facility-id": options.facilityId,
      "item-time-zone": options.timeZone,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  if (response.status === 401 && options.retry !== false && options.session.refreshToken) {
    const refreshed = await getSession(true);
    return requestWithSession<T>(path, {
      ...options,
      session: refreshed,
      retry: false,
    });
  }

  const payload = (await response.json().catch(() => null)) as WmsEnvelope<T> | null;
  if (!response.ok || payload?.success !== true || payload.data === undefined) {
    if (response.status === 401) {
      throw new AuthError("Your session has expired. Please sign in again.");
    }
    throw new WmsError(
      payload?.msg || payload?.message || "Warehouse data could not be loaded.",
      response.status >= 400 ? response.status : 502,
    );
  }

  return payload.data;
}

export async function loadFacilities(session: AuthSession): Promise<Facility[]> {
  const data = await requestWithSession<RawFacility[]>("/mdm/facility/search", {
    session,
    method: "POST",
    facilityId: defaultFacilityId(),
    timeZone: defaultTimeZone(),
    body: {
      currentPage: 1,
      pageSize: 1000,
      status: "ENABLE",
      sortingFields: [{ field: "name", orderBy: "ASC" }],
    },
  });

  return data
    .filter((facility) => facility.id && facility.name)
    .map((facility) => ({
      id: String(facility.id),
      name: String(facility.name),
      code: String(facility.facilityCode ?? ""),
      timeZone: String(facility.timeZone || defaultTimeZone()),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function selectInitialFacility(facilities: Facility[]) {
  const preferredId = defaultFacilityId();
  return facilities.find(
    (facility) => facility.id === preferredId || facility.code === preferredId,
  ) ?? facilities[0];
}

function localDate(timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new WmsError("The selected warehouse has an invalid local timezone.", 422);
  }
}

function isValidDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

function monthEnd(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function resolvePeriod(
  facility: Facility,
  selection: { date?: string; month?: string } = {},
): TaskPeriod {
  const today = localDate(facility.timeZone);
  const date = selection.date?.trim();
  const month = selection.month?.trim();

  if (date && month) {
    throw new WmsError("Choose either a date or a month.", 400);
  }

  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month) || !isValidDate(`${month}-01`)) {
      throw new WmsError("Choose a valid month.", 400);
    }
    if (month > today.slice(0, 7)) {
      throw new WmsError("Future months are not available.", 400);
    }
    return {
      mode: "month",
      startDate: `${month}-01`,
      endDate: monthEnd(month),
      today,
    };
  }

  const selectedDate = date || today;
  if (!isValidDate(selectedDate)) {
    throw new WmsError("Choose a valid date.", 400);
  }
  if (selectedDate > today) {
    throw new WmsError("Future dates are not available.", 400);
  }
  return {
    mode: "day",
    startDate: selectedDate,
    endDate: selectedDate,
    today,
  };
}

function strings(...values: unknown[]) {
  const output: string[] = [];
  const add = (value: unknown) => {
    if (value === null || value === undefined || value === "") return;
    const normalized = String(value);
    if (!output.includes(normalized)) output.push(normalized);
  };

  for (const value of values) {
    if (Array.isArray(value)) value.forEach(add);
    else add(value);
  }
  return output;
}

function customerIds(task: RawTask) {
  const stepIds = Array.isArray(task.taskSteps)
    ? task.taskSteps.map((step) =>
        typeof step === "object" && step ? (step as RawTask).customerId : undefined,
      )
    : [];
  const historyIds = Array.isArray(task.putBackTaskHistories)
    ? task.putBackTaskHistories.map((history) =>
        typeof history === "object" && history
          ? (history as RawTask).titleId
          : undefined,
      )
    : [];

  return strings(task.customerId, task.customerIds, task.titleId, stepIds, historyIds);
}

function taskSubtype(task: RawTask) {
  return String(
    task.pickType ??
      task.type ??
      task.putAwayType ??
      task.putBackType ??
      task.loadMode ??
      task.transLoadType ??
      "",
  );
}

function taskTypeFromCollection(collection: string) {
  return collection.endsWith("Tasks") ? collection.slice(0, -5) : collection;
}

function numericValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordValue(source: RawTask, names: string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return Object.entries(source).find(([key]) => wanted.has(key.toLowerCase()))?.[1];
}

function pricingSources(task: RawTask) {
  const sources = [task];
  for (const name of ["taskSteps", "lines", "details", "histories", "putBackTaskHistories"]) {
    const value = task[name];
    if (!Array.isArray(value)) continue;
    for (const candidate of value) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        sources.push(candidate as RawTask);
      }
    }
  }
  return sources;
}

function uniqueText(sources: RawTask[], names: string[]) {
  const candidates = sources.flatMap((source) => {
    const value = recordValue(source, names);
    return Array.isArray(value) ? value : [value];
  }).filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value).trim())
    .filter(Boolean);
  const unique = [...new Set(candidates.map((value) => value.toLowerCase()))];
  return unique.length === 1
    ? candidates.find((value) => value.toLowerCase() === unique[0]) ?? null
    : null;
}

function uniqueNumber(sources: RawTask[], names: string[]) {
  const candidates = sources.flatMap((source) => {
    const value = recordValue(source, names);
    return Array.isArray(value) ? value : [value];
  }).map(numericValue).filter((value): value is number => value !== null);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function conditionContext(sources: RawTask[]) {
  const values = new Map<string, Set<string>>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (!["string", "number", "boolean"].includes(typeof value)) continue;
      const normalizedKey = key.trim().toLowerCase();
      const bucket = values.get(normalizedKey) ?? new Set<string>();
      bucket.add(String(value).trim());
      values.set(normalizedKey, bucket);
    }
  }
  return Object.fromEntries(
    [...values.entries()]
      .filter(([, entries]) => entries.size === 1)
      .map(([key, entries]) => [key, [...entries][0]]),
  );
}

function bnpRateInput(task: RawTask): BnpTaskRateInput | null {
  const sources = pricingSources(task);
  const customers = customerIds(task);
  const customerCode = customers.length === 1 ? customers[0] : null;
  const billTo = uniqueText(sources, [
    "billTo", "billToCode", "billToID", "billToId", "billtoID", "billingCustomerId",
  ]);
  const serviceCode = uniqueText(sources, [
    "billingCode", "billingItemCode", "serviceCode", "jobCode", "accountItemCode", "chargeCode",
  ]);
  const quantity = uniqueNumber(sources, ["quantity", "qty", "jobQty"]);
  const uom = uniqueText(sources, ["uom", "uomCode", "uomID", "uomId", "jobUom"]);
  const location = uniqueText(sources, [
    "location", "locationCode", "locationID", "locationId", "site", "siteCode", "warehouseID", "warehouseId",
  ]);
  const occurredAt = String(task.createdTime ?? "").trim();
  if (!customerCode || !billTo || !serviceCode || quantity === null || !uom || !location || !Number.isFinite(Date.parse(occurredAt))) {
    return null;
  }
  return {
    customerCode,
    billTo,
    serviceCode,
    quantity,
    uom,
    location,
    occurredAt,
    conditions: conditionContext(sources),
  };
}

function bnpTaskCharge(rate: Awaited<ReturnType<typeof lookupBnpTaskRate>>): TaskCharge {
  if (!rate) return unavailableCharge;
  try {
    const amount = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: rate.currency,
      currencyDisplay: "code",
    }).format(rate.amount);
    return { available: true, display: `${amount} per ${rate.uom}` };
  } catch {
    return unavailableCharge;
  }
}

function taskRateKey(taskType: string, subtype: string) {
  return `${taskType.trim().toUpperCase()}|${(subtype.trim() || "Not set").toUpperCase()}`;
}

function dollarCharge(amount: number): TaskCharge {
  return {
    available: true,
    display: new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount),
  };
}

function gurunandaTaskCharge(taskType: string, subtype: string, customers: string[]) {
  if (!customers.includes(GURUNANDA_CUSTOMER_ID)) return null;
  const rate = GURUNANDA_RATE_BY_TASK.get(taskRateKey(taskType, subtype));
  return rate === undefined ? null : dollarCharge(rate);
}

function generalTaskCharge(detail: GeneralTaskDetail): TaskCharge {
  const total = numericValue(detail.totalBillableAmount);
  const lines = Array.isArray(detail.generalTaskLines) ? detail.generalTaskLines : [];
  if (total === null || lines.length === 0) return unavailableCharge;

  const completeLines = lines.filter((line) =>
    numericValue(line.jobPrice) !== null &&
    numericValue(line.jobQty) !== null &&
    String(line.jobUom ?? "").trim() &&
    String(line.jobCurrency ?? "").trim(),
  );
  if (completeLines.length !== lines.length) return unavailableCharge;

  const currencies = [...new Set(
    completeLines.map((line) => String(line.jobCurrency).trim().toUpperCase()),
  )];
  if (currencies.length !== 1 || !/^[A-Z]{3}$/.test(currencies[0])) return unavailableCharge;

  try {
    return {
      available: true,
      display: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currencies[0],
        currencyDisplay: "code",
      }).format(total),
    };
  } catch {
    return unavailableCharge;
  }
}

async function mapWithConcurrency<T, U>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<U>,
) {
  const output = new Array<U>(values.length);
  let next = 0;

  async function worker() {
    while (next < values.length) {
      const index = next++;
      output[index] = await mapper(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

async function loadCustomerNames(
  ids: string[],
  session: AuthSession,
  facility: Facility,
) {
  const entries = await mapWithConcurrency(ids, 8, async (id) => {
    try {
      const customer = await requestWithSession<{ name?: string; fullName?: string }>(
        `/mdm/customer/orgId/${encodeURIComponent(id)}`,
        {
          session,
          method: "GET",
          facilityId: facility.id,
          timeZone: facility.timeZone,
        },
      );
      return [id, String(customer.fullName || customer.name || "Name unavailable")] as const;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      return [id, "Name unavailable"] as const;
    }
  });
  return new Map(entries);
}

async function loadGeneralTaskCharges(
  rows: Array<{ type: string; task: RawTask }>,
  session: AuthSession,
  facility: Facility,
) {
  const generalTasks = rows.filter(({ type, task }) =>
    type.toUpperCase() === "GENERAL" && task.id,
  );
  const entries = await mapWithConcurrency(generalTasks, 6, async ({ task }) => {
    const taskId = String(task.id);
    try {
      const detail = await requestWithSession<GeneralTaskDetail>(
        `/wms-bam/task/general-task/get/${encodeURIComponent(taskId)}`,
        {
          session,
          method: "GET",
          facilityId: facility.id,
          timeZone: facility.timeZone,
        },
      );
      return [task, generalTaskCharge(detail)] as const;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      return [task, unavailableCharge] as const;
    }
  });
  return new Map(entries);
}

async function loadBnpTaskCharges(
  rows: Array<{ type: string; task: RawTask }>,
  authoritativeCharges: Map<RawTask, TaskCharge>,
) {
  const candidates = rows.flatMap(({ task }) => {
    if (authoritativeCharges.get(task)?.available) return [];
    const input = bnpRateInput(task);
    return input ? [{ task, input }] : [];
  });
  const uniqueInputs = new Map<string, BnpTaskRateInput>();
  for (const { input } of candidates) uniqueInputs.set(JSON.stringify(input), input);
  const rates = await mapWithConcurrency([...uniqueInputs.entries()], 4, async ([key, input]) =>
    [key, bnpTaskCharge(await lookupBnpTaskRate(input))] as const,
  );
  const byInput = new Map(rates);
  return new Map(candidates.map(({ task, input }) => [task, byInput.get(JSON.stringify(input)) ?? unavailableCharge]));
}

export async function loadAssignedTasks(
  session: AuthSession,
  facility: Facility,
  selection: { date?: string; month?: string } = {},
) {
  const period = resolvePeriod(facility, selection);
  const data = await requestWithSession<TaskSearchData>("/wms-bam/tasks/search", {
    session,
    method: "POST",
    facilityId: facility.id,
    timeZone: facility.timeZone,
    body: {
      currentPage: 1,
      pageSize: 500,
      createdTimeFrom: `${period.startDate}T00:00:00`,
      createdTimeTo: `${period.endDate}T23:59:59.999`,
    },
  });

  const rawRows: Array<{ type: string; task: RawTask; customers: string[] }> = [];
  for (const [collection, value] of Object.entries(data)) {
    if (!Array.isArray(value)) continue;
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object") continue;
      const task = candidate as RawTask;
      const createdDate = String(task.createdTime ?? "").slice(0, 10);
      if (task.assigneeUserId === null || task.assigneeUserId === undefined || task.assigneeUserId === "") continue;
      if (createdDate < period.startDate || createdDate > period.endDate) continue;
      rawRows.push({
        type: taskTypeFromCollection(collection),
        task,
        customers: customerIds(task),
      });
    }
  }

  const uniqueCustomerIds = [...new Set(rawRows.flatMap((row) => row.customers))];
  const [names, generalTaskCharges] = await Promise.all([
    loadCustomerNames(uniqueCustomerIds, session, facility),
    loadGeneralTaskCharges(rawRows, session, facility),
  ]);
  const bnpTaskCharges = await loadBnpTaskCharges(rawRows, generalTaskCharges);
  const tasks: TaskRow[] = rawRows.map(({ type, task, customers }) => {
    const authoritativeCharge = generalTaskCharges.get(task);
    const bnpCharge = bnpTaskCharges.get(task);
    const subtype = taskSubtype(task);
    return {
      taskType: type,
      taskSubtype: subtype,
      customer: customers.join("; ") || "Unassigned customer",
      customerName:
        customers.map((id) => names.get(id) || "Name unavailable").join("; ") ||
        "Unassigned customer",
      taskId: String(task.id ?? ""),
      status: String(task.status ?? ""),
      charge: authoritativeCharge?.available
        ? authoritativeCharge
        : bnpCharge?.available
          ? bnpCharge
          : gurunandaTaskCharge(type, subtype, customers) ?? unavailableCharge,
    };
  });

  tasks.sort((left, right) =>
    left.taskType.localeCompare(right.taskType) ||
    left.customer.localeCompare(right.customer) ||
    left.taskId.localeCompare(right.taskId),
  );

  return { tasks, period };
}
