import "server-only";

export type BnpTaskRateInput = {
  customerCode: string;
  billTo: string;
  serviceCode: string;
  quantity: number;
  uom: string;
  location: string;
  occurredAt: string;
  conditions: Record<string, string>;
};

export type BnpTaskRate = {
  amount: number;
  currency: string;
  uom: string;
};

type JsonRecord = Record<string, unknown>;

type BnpSession = {
  token: string;
  userId: string;
  clientId: number;
  expiresAt: number;
};

const LOGIN_PATH = "/PayAndBillAPI/api/v1/oauth/token";
const PRICE_LIST_PATH = "/ApiV2/api/billingpricelist/getListPage";
const PRICE_DETAIL_PATH = "/ApiV2/api/billingpricelist/getPriceDetail";
const BILLING_ITEMS_PATH = "/ApiV2/api/billingpricelist/GetPriceListBillingItemsAsync";
const SESSION_LIFETIME_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

let cachedSession: BnpSession | null = null;
let pendingSession: Promise<BnpSession> | null = null;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function field(source: JsonRecord, names: string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const entry = Object.entries(source).find(([key]) => wanted.has(key.toLowerCase()));
  return entry?.[1];
}

function scalar(source: JsonRecord, names: string[]) {
  const value = field(source, names);
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim() || null;
}

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function findScalar(value: unknown, names: string[], depth = 0): string | null {
  if (depth > 5) return null;
  const current = parsed(value);
  if (Array.isArray(current)) {
    for (const item of current) {
      const match = findScalar(item, names, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const source = record(current);
  if (!source) return null;
  const direct = scalar(source, names);
  if (direct) return direct;
  for (const nested of Object.values(source)) {
    const match = findScalar(nested, names, depth + 1);
    if (match) return match;
  }
  return null;
}

function configuration() {
  const baseUrl = process.env.BNP_BASE_URL?.trim().replace(/\/$/, "");
  const username = process.env.BNP_USERNAME?.trim();
  const password = process.env.BNP_PASSWORD;
  if (!baseUrl || !username || !password) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { baseUrl, username, password };
}

async function jsonResponse(response: Response) {
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error("BNP request failed");
  const source = record(payload);
  const status = source ? field(source, ["status", "success"]) : undefined;
  const code = source ? field(source, ["code"]) : undefined;
  if (status === false || status === "false" || Number(code) >= 400) {
    throw new Error("BNP request was not approved");
  }
  return payload;
}

async function authenticate(force = false): Promise<BnpSession | null> {
  const config = configuration();
  if (!config) return null;
  if (!force && cachedSession && cachedSession.expiresAt > Date.now()) return cachedSession;
  if (pendingSession) return pendingSession;

  pendingSession = (async () => {
    const response = await fetch(`${config.baseUrl}${LOGIN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userName: config.username, password: config.password }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await jsonResponse(response);
    const token = findScalar(payload, ["signToken", "accessToken", "access_token", "token"]);
    const userId = findScalar(payload, ["userID", "userId", "userid"]);
    const clientId = numberValue(findScalar(payload, ["clientID", "clientId", "clientid"]));
    if (!token || !userId || clientId === null) throw new Error("BNP login response is incomplete");

    cachedSession = {
      token,
      userId,
      clientId,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    };
    return cachedSession;
  })();

  try {
    return await pendingSession;
  } finally {
    pendingSession = null;
  }
}

async function authenticatedPost(path: string, body: JsonRecord, retry = true): Promise<unknown> {
  const config = configuration();
  const session = await authenticate();
  if (!config || !session) throw new Error("BNP is not configured");

  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `BasicAuth ${session.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...body,
      clientID: session.clientId,
      userID: session.userId,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 401 && retry) {
    cachedSession = null;
    await authenticate(true);
    return authenticatedPost(path, body, false);
  }
  return jsonResponse(response);
}

function unwrap(value: unknown, depth = 0): unknown {
  if (depth > 5) return parsed(value);
  const current = parsed(value);
  const source = record(current);
  if (!source) return current;
  const nested = field(source, ["data", "result"]);
  return nested === undefined ? current : unwrap(nested, depth + 1);
}

function rows(value: unknown) {
  const current = unwrap(value);
  if (Array.isArray(current)) return current.map(record).filter(Boolean) as JsonRecord[];
  const source = record(current);
  if (!source) return [];
  const values = field(source, ["rows", "items", "list", "priceLists"]);
  return Array.isArray(values) ? values.map(record).filter(Boolean) as JsonRecord[] : [];
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function values(source: JsonRecord, names: string[]) {
  const value = field(source, names);
  const candidates = Array.isArray(value) ? value : [value];
  return candidates
    .flatMap((candidate) => typeof candidate === "string" ? candidate.split(/[;,]/) : [candidate])
    .map(normalized)
    .filter(Boolean);
}

function equalsAny(expected: string, source: JsonRecord, names: string[]) {
  const options = values(source, names);
  return options.length > 0 && options.includes(normalized(expected));
}

function activeVersion(version: JsonRecord) {
  const status = field(version, ["status", "statusID", "statusId"]);
  const active = field(version, ["isActive", "active"]);
  return active === true || normalized(status) === "active" || Number(status) === 1;
}

function dateKey(value: unknown) {
  if (!value) return null;
  const direct = String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (direct) return direct;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

function effectiveVersion(version: JsonRecord, occurredAt: string) {
  const occurred = dateKey(occurredAt);
  const start = dateKey(field(version, ["startDate", "effectiveDate", "effectiveFrom"]));
  const endValue = field(version, ["endDate", "expirationDate", "effectiveTo"]);
  const end = endValue ? dateKey(endValue) : null;
  if (occurred === null || start === null || (endValue && end === null)) return false;
  return start <= occurred && (end === null || occurred <= end);
}

function collectPricingRecords(value: unknown, output: JsonRecord[] = [], depth = 0) {
  if (depth > 6) return output;
  const current = parsed(value);
  if (Array.isArray(current)) {
    current.forEach((item) => collectPricingRecords(item, output, depth + 1));
    return output;
  }
  const source = record(current);
  if (!source) return output;
  const hasRate = field(source, ["rate", "unitPrice", "price", "charge", "amount"]) !== undefined;
  const hasCode = field(source, [
    "accountItemCode", "billingItemCode", "chargeCode", "serviceCode", "jobCode", "customerRefCode",
  ]) !== undefined;
  if (hasRate && hasCode) output.push(source);
  Object.values(source).forEach((item) => collectPricingRecords(item, output, depth + 1));
  return output;
}

function recordId(source: JsonRecord) {
  return scalar(source, ["accountItemID", "billingItemID", "invoiceAccountItemID", "itemID", "id"]);
}

function mergedPricingRecords(detail: unknown, billingItems: unknown) {
  const records = [...collectPricingRecords(detail), ...collectPricingRecords(billingItems)];
  const byId = new Map<string, JsonRecord>();
  const withoutId: JsonRecord[] = [];
  for (const item of records) {
    const id = recordId(item);
    if (!id) withoutId.push(item);
    else byId.set(id, { ...(byId.get(id) || {}), ...item });
  }
  return [...byId.values(), ...withoutId];
}

function enabledItem(item: JsonRecord) {
  const active = field(item, ["isActive", "isValid", "active"]);
  return active === undefined || active === null || active === true || Number(active) === 1;
}

function quantityMatches(item: JsonRecord, quantity: number) {
  const exact = numberValue(field(item, ["quantity", "qty", "defaultQty"]));
  const minimum = numberValue(field(item, ["minimumQuantity", "minQuantity", "minQty", "quantityFrom"]));
  const maximum = numberValue(field(item, ["maximumQuantity", "maxQuantity", "maxQty", "quantityTo"]));
  if (exact !== null && exact !== quantity) return false;
  if (minimum !== null && quantity < minimum) return false;
  if (maximum !== null && quantity > maximum) return false;
  return true;
}

function conditionMatches(condition: unknown, context: Record<string, string>) {
  const source = record(condition);
  if (!source) return false;
  const name = scalar(source, ["variableName", "field", "name", "key", "questionCode"]);
  const expected = scalar(source, ["variableValue", "value", "answer", "expectedValue"]);
  const operator = normalized(field(source, ["operator", "comparison", "joinType"]) ?? "equals");
  if (!name || expected === null || !["=", "==", "eq", "equal", "equals"].includes(operator)) return false;
  return normalized(context[normalized(name)]) === normalized(expected);
}

function conditionsMatch(item: JsonRecord, context: Record<string, string>) {
  const raw = field(item, ["conditions", "pricingConditions", "conditionList", "questions", "questionList", "factors"]);
  if (raw !== undefined && raw !== null && raw !== "") {
    const parsedConditions = parsed(raw);
    if (!Array.isArray(parsedConditions) || !parsedConditions.every((condition) => conditionMatches(condition, context))) {
      return false;
    }
  }

  const opaqueCondition = Object.entries(item).some(([key, value]) =>
    /^extendProperty(?:0\d)?$/i.test(key) && value !== null && value !== undefined && value !== "",
  );
  return !opaqueCondition;
}

function singleRate(item: JsonRecord) {
  const rates = ["rate", "unitPrice", "price", "charge", "amount"]
    .map((name) => numberValue(field(item, [name])))
    .filter((value): value is number => value !== null);
  const unique = [...new Set(rates)];
  return unique.length === 1 ? unique[0] : null;
}

function currency(item: JsonRecord, version: JsonRecord, detail: unknown) {
  const options = [
    scalar(item, ["currency", "currencyCode"]),
    scalar(version, ["currency", "currencyCode"]),
    findScalar(detail, ["currency", "currencyCode"]),
  ].filter((value): value is string => Boolean(value)).map((value) => value.toUpperCase());
  const unique = [...new Set(options)];
  return unique.length === 1 && /^[A-Z]{3}$/.test(unique[0]) ? unique[0] : null;
}

function scopedItemMatches(
  item: JsonRecord,
  versionId: number,
  vendorId: number,
  billToId: number,
) {
  const scopes: Array<[unknown, number]> = [
    [field(item, ["versionID", "versionId", "billingCodeVersionID"]), versionId],
    [field(item, ["vendorID", "vendorId", "customerID", "customerId"]), vendorId],
    [field(item, ["billToID", "billtoID", "billToId"]), billToId],
  ];
  return scopes.every(([value, expected]) => {
    if (value === undefined || value === null || value === "") return true;
    return numberValue(value) === expected;
  });
}

function totalRows(value: unknown) {
  const source = record(unwrap(value));
  return source ? numberValue(field(source, ["total", "totalCount", "rowCount"])) : null;
}

async function loadActivePriceLists(input: BnpTaskRateInput) {
  const session = await authenticate();
  if (!session) return [];
  const pageSize = 100;
  const baseRequest = {
    postParams: true,
    pageSize,
    isAll: false,
    ids: [],
    clientId: session.clientId,
    searchKeyword: input.customerCode,
    customerIds: [],
    billToIds: [],
    sources: [],
    status: 1,
  };
  const firstPayload = await authenticatedPost(PRICE_LIST_PATH, { ...baseRequest, pageIndex: 1 });
  const firstRows = rows(firstPayload);
  const total = totalRows(firstPayload);
  if (total === null) return firstRows.length < pageSize ? firstRows : [];
  if (total > 10_000) return [];

  const pageCount = Math.ceil(total / pageSize);
  const additional: JsonRecord[] = [];
  for (let pageIndex = 2; pageIndex <= pageCount; pageIndex += 4) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(4, pageCount - pageIndex + 1) }, (_, index) =>
        authenticatedPost(PRICE_LIST_PATH, { ...baseRequest, pageIndex: pageIndex + index }),
      ),
    );
    additional.push(...batch.flatMap(rows));
  }
  const allRows = [...firstRows, ...additional];
  return allRows.length >= total ? allRows : [];
}

export async function lookupBnpTaskRate(input: BnpTaskRateInput): Promise<BnpTaskRate | null> {
  if (!configuration()) return null;
  try {
    const versions = (await loadActivePriceLists(input)).filter((version) =>
      equalsAny(input.customerCode, version, ["customerCode", "vendorCode", "accountCode"]) &&
      equalsAny(input.billTo, version, ["billTo", "billToCode", "billToID", "billtoID"]) &&
      activeVersion(version) &&
      effectiveVersion(version, input.occurredAt),
    );
    if (versions.length !== 1) return null;
    const version = versions[0];
    const versionId = numberValue(field(version, ["id", "versionID", "versionId"]));
    if (versionId === null) return null;

    const detail = await authenticatedPost(PRICE_DETAIL_PATH, version);
    const vendorId = numberValue(
      field(version, ["vendorID", "vendorId", "customerID", "customerId"]) ??
      findScalar(detail, ["vendorID", "vendorId", "customerID", "customerId"]),
    );
    const billToId = numberValue(
      field(version, ["billToID", "billtoID", "billToId"]) ??
      findScalar(detail, ["billToID", "billtoID", "billToId"]),
    );
    if (vendorId === null || billToId === null) return null;

    const billingItems = await authenticatedPost(BILLING_ITEMS_PATH, {
      versionID: versionId,
      vendorID: vendorId,
      billtoID: billToId,
    });
    const candidates = mergedPricingRecords(detail, billingItems).filter((item) =>
      enabledItem(item) &&
      scopedItemMatches(item, versionId, vendorId, billToId) &&
      equalsAny(input.serviceCode, item, [
        "accountItemCode", "billingItemCode", "chargeCode", "serviceCode", "jobCode", "customerRefCode",
      ]) &&
      equalsAny(input.uom, item, ["uom", "uomCode", "uomDescription", "jobUom"]) &&
      equalsAny(input.location, item, [
        "location", "locationCode", "locationID", "locationId", "site", "siteCode", "warehouseID", "facilityID",
      ]) &&
      quantityMatches(item, input.quantity) &&
      conditionsMatch(item, input.conditions) &&
      singleRate(item) !== null,
    );
    if (candidates.length !== 1) return null;
    const amount = singleRate(candidates[0]);
    const rateCurrency = currency(candidates[0], version, detail);
    if (amount === null || !rateCurrency) return null;
    return { amount, currency: rateCurrency, uom: input.uom };
  } catch {
    return null;
  }
}
