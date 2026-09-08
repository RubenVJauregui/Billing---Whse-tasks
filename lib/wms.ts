import { AuthError, getSession, type AuthSession } from "@/lib/session";

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

const FALLBACK_FACILITY_ID = "LT_F1";
const FALLBACK_TIME_ZONE = "America/Los_Angeles";

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
  const names = await loadCustomerNames(uniqueCustomerIds, session, facility);
  const tasks: TaskRow[] = rawRows.map(({ type, task, customers }) => ({
    taskType: type,
    taskSubtype: taskSubtype(task),
    customer: customers.join("; ") || "Unassigned customer",
    customerName:
      customers.map((id) => names.get(id) || "Name unavailable").join("; ") ||
      "Unassigned customer",
    taskId: String(task.id ?? ""),
    status: String(task.status ?? ""),
  }));

  tasks.sort((left, right) =>
    left.taskType.localeCompare(right.taskType) ||
    left.customer.localeCompare(right.customer) ||
    left.taskId.localeCompare(right.taskId),
  );

  return { tasks, period };
}
