"use client";

import {
  CircleAlert,
  ClipboardList,
  RefreshCw,
  Search,
  Warehouse,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Facility = {
  id: string;
  name: string;
  code: string;
  timeZone: string;
};

type Task = {
  taskType: string;
  taskSubtype: string;
  customer: string;
  customerName: string;
  taskId: string;
  status: string;
};

type TaskPeriod = {
  mode: "day" | "month";
  startDate: string;
  endDate: string;
  today: string;
};

type TaskSelection = { date?: string; month?: string };

type View =
  | "details"
  | "taskType"
  | "taskSubtype"
  | "customer"
  | "customerName"
  | "taskId"
  | "status";

type ApiError = { message?: string };

const initialFacility: Facility = {
  id: "",
  name: "Valley View",
  code: "",
  timeZone: "",
};

const views: Array<{ key: View; label: string }> = [
  { key: "details", label: "Show All" },
  { key: "taskType", label: "Task Type" },
  { key: "taskSubtype", label: "Task Subtype" },
  { key: "customer", label: "Customer" },
  { key: "customerName", label: "Customer Name" },
  { key: "taskId", label: "Task ID" },
  { key: "status", label: "Status" },
];

const initialPeriod: TaskPeriod = {
  mode: "day",
  startDate: "",
  endDate: "",
  today: "",
};

const columnLabels: Record<Exclude<View, "details">, string> = {
  taskType: "Task Type",
  taskSubtype: "Task Subtype",
  customer: "Customer",
  customerName: "Customer Name",
  taskId: "Task ID",
  status: "Status",
};

function formatValue(value: string) {
  if (!value) return "Not set";
  return value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(date: string) {
  if (!date) return "Today";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function formatShortDate(date: string) {
  if (!date) return "Today";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function formatMonth(date: string) {
  if (!date) return "This month";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function periodLabel(period: TaskPeriod, short = false) {
  if (period.mode === "month") return formatMonth(period.startDate);
  return short ? formatShortDate(period.startDate) : formatDate(period.startDate);
}

function selectionForPeriod(period: TaskPeriod): TaskSelection {
  if (!period.startDate) return {};
  return period.mode === "month"
    ? { month: period.startDate.slice(0, 7) }
    : { date: period.startDate };
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function statusClass(status: string) {
  const normalized = status.toUpperCase();
  if (normalized === "IN_PROGRESS") return "status status-progress";
  if (normalized === "NEW") return "status status-new";
  if (normalized.includes("CLOSED") || normalized === "COMPLETED") return "status status-closed";
  if (normalized.includes("CANCEL") || normalized === "EXCEPTION") return "status status-alert";
  return "status status-neutral";
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & ApiError;
  if (!response.ok) throw new Error(payload.message || "Something went wrong.");
  return payload;
}

function Login({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter both your username and password.");
      return;
    }

    setPending(true);
    setError("");
    try {
      await readJson(
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
        }),
      );
      await onSignedIn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-brand" aria-label="WISE assigned tasks">
        <div className="brand-mark"><Warehouse size={26} strokeWidth={1.8} /></div>
        <div>
          <span className="eyebrow">Warehouse operations</span>
          <h1>WISE Assigned Tasks</h1>
        </div>
      </section>
      <section className="login-panel">
        <div className="login-heading">
          <span className="eyebrow">Secure access</span>
          <h2>Sign in</h2>
          <p>Use your WISE account to open today&apos;s facility workload.</p>
        </div>
        <form onSubmit={submit} noValidate>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={pending}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
          />
          {error && <div className="form-error" role="alert"><CircleAlert size={17} />{error}</div>}
          <button className="primary-button" type="submit" disabled={pending}>
            {pending ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function FacilityPicker({
  facilities,
  selected,
  onSelect,
  onClose,
}: {
  facilities: Facility[];
  selected: Facility;
  onSelect: (facility: Facility) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = facilities.filter((facility) =>
    `${facility.name} ${facility.code}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="facility-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="facility-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Facility scope</span>
            <h2 id="facility-title">Choose a warehouse</h2>
          </div>
          <button className="text-button" onClick={onClose} aria-label="Close warehouse picker">Close</button>
        </header>
        <div className="dialog-search">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search facilities"
            aria-label="Search facilities"
          />
        </div>
        <div className="facility-list" role="listbox" aria-label="WISE facilities">
          {matches.map((facility) => (
            <button
              key={facility.id}
              className="facility-option"
              role="option"
              aria-selected={facility.id === selected.id}
              onClick={() => onSelect(facility)}
            >
              <span className="facility-option-name">{facility.name}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <div className="picker-empty">
              <Search size={22} />
              <strong>No facilities found</strong>
              <span>Try a different name.</span>
            </div>
          )}
        </div>
        <footer className="dialog-footer">{matches.length} of {facilities.length} facilities</footer>
      </section>
    </div>
  );
}

function DatePicker({
  period,
  onSelectDay,
  onSelectMonth,
  onClose,
}: {
  period: TaskPeriod;
  onSelectDay: (date: string) => void;
  onSelectMonth: (month: string) => void;
  onClose: () => void;
}) {
  const initialMonth = (period.startDate || period.today).slice(0, 7);
  const [visibleMonth, setVisibleMonth] = useState(initialMonth);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [year, monthNumber] = visibleMonth.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const currentMonth = period.today.slice(0, 7);
  const canMoveNext = visibleMonth < currentMonth;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="date-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="date-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Task period</span>
            <h2 id="date-title">Choose a date</h2>
          </div>
          <button ref={closeRef} className="text-button" onClick={onClose}>Close</button>
        </header>
        <div className="calendar-navigation">
          <button onClick={() => setVisibleMonth(shiftMonth(visibleMonth, -1))}>Previous</button>
          <strong>{formatMonth(`${visibleMonth}-01`)}</strong>
          <button
            onClick={() => setVisibleMonth(shiftMonth(visibleMonth, 1))}
            disabled={!canMoveNext}
          >
            Next
          </button>
        </div>
        <div className="calendar-grid" aria-label={formatMonth(`${visibleMonth}-01`)}>
          {weekdays.map((weekday) => <span className="calendar-weekday" key={weekday}>{weekday}</span>)}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span className="calendar-blank" key={`blank-${index}`} />
          ))}
          {Array.from({ length: dayCount }, (_, index) => {
            const day = index + 1;
            const date = `${visibleMonth}-${String(day).padStart(2, "0")}`;
            return (
              <button
                key={date}
                className={period.mode === "day" && date === period.startDate ? "selected" : ""}
                onClick={() => onSelectDay(date)}
                disabled={date > period.today}
                aria-label={formatDate(date)}
                aria-pressed={period.mode === "day" && date === period.startDate}
              >
                {day}
              </button>
            );
          })}
        </div>
        <footer className="calendar-footer">
          <button
            className="month-button"
            onClick={() => onSelectMonth(visibleMonth)}
            aria-pressed={period.mode === "month" && period.startDate.startsWith(visibleMonth)}
          >
            Show entire month
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function Dashboard() {
  const [auth, setAuth] = useState<"checking" | "signedOut" | "signedIn">("checking");
  const [userName, setUserName] = useState("WISE user");
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [facility, setFacility] = useState<Facility>(initialFacility);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [period, setPeriod] = useState<TaskPeriod>(initialPeriod);
  const [loadingFacilities, setLoadingFacilities] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("details");
  const taskRequest = useRef<AbortController | null>(null);

  const loadTasks = useCallback(async (nextFacility: Facility, selection: TaskSelection = {}) => {
    taskRequest.current?.abort();
    const controller = new AbortController();
    taskRequest.current = controller;
    setLoadingTasks(true);
    setError("");
    setTasks([]);
    try {
      const params = new URLSearchParams({ facilityId: nextFacility.id });
      if (selection.date) params.set("date", selection.date);
      if (selection.month) params.set("month", selection.month);
      const payload = await readJson<{
        tasks: Task[];
        period: TaskPeriod;
        facility: Facility;
      }>(
        await fetch(`/api/tasks?${params.toString()}`, {
          signal: controller.signal,
        }),
      );
      setFacility(payload.facility);
      setTasks(payload.tasks);
      setPeriod(payload.period);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      const message = caught instanceof Error ? caught.message : "Assigned tasks could not be loaded.";
      if (message.toLowerCase().includes("sign in") || message.toLowerCase().includes("session")) {
        setAuth("signedOut");
      } else {
        setError(message);
      }
    } finally {
      if (taskRequest.current === controller) setLoadingTasks(false);
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    setAuth("signedIn");
    setLoadingFacilities(true);
    setLoadingTasks(true);
    setError("");
    try {
      const payload = await readJson<{ facilities: Facility[]; initialFacilityId: string | null }>(
        await fetch("/api/facilities"),
      );
      setFacilities(payload.facilities);
      const selected =
        payload.facilities.find((candidate) => candidate.id === payload.initialFacilityId) ??
        payload.facilities[0];
      if (!selected) {
        setError("No warehouses are available to your account.");
        setTasks([]);
        setLoadingTasks(false);
        return;
      }
      setFacility(selected);
      await loadTasks(selected);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Warehouses could not be loaded.";
      if (message.toLowerCase().includes("sign in") || message.toLowerCase().includes("session")) {
        setAuth("signedOut");
      } else {
        setError(message);
      }
      setLoadingTasks(false);
    } finally {
      setLoadingFacilities(false);
    }
  }, [loadTasks]);

  useEffect(() => {
    let active = true;
    async function checkSession() {
      try {
        const response = await fetch("/api/auth/session");
        const payload = await readJson<{
          authenticated: boolean;
          user?: { name: string };
        }>(response);
        if (!active) return;
        if (!payload.authenticated || !payload.user) {
          setAuth("signedOut");
          return;
        }
        setUserName(payload.user.name);
        await loadWorkspace();
      } catch {
        if (active) setAuth("signedOut");
      }
    }
    checkSession();
    return () => {
      active = false;
      taskRequest.current?.abort();
    };
  }, [loadWorkspace]);

  const counts = useMemo(() => ({
    customers: new Set(tasks.map((task) => task.customer)).size,
    types: new Set(tasks.map((task) => task.taskType)).size,
  }), [tasks]);

  const filteredTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return tasks;
    return tasks.filter((task) => Object.values(task).some((value) => value.toLowerCase().includes(normalized)));
  }, [query, tasks]);

  const groupedRows = useMemo(() => {
    if (view === "details" || view === "status") return [];
    const values = new Map<string, number>();
    for (const task of filteredTasks) {
      const value = task[view] || "Not set";
      values.set(value, (values.get(value) || 0) + 1);
    }
    return [...values.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  }, [filteredTasks, view]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    taskRequest.current?.abort();
    setTasks([]);
    setFacilities([]);
    setAuth("signedOut");
  }

  function selectFacility(nextFacility: Facility) {
    setPickerOpen(false);
    setQuery("");
    setView("details");
    setFacility(nextFacility);
    void loadTasks(nextFacility);
  }

  function selectDate(date: string) {
    setDatePickerOpen(false);
    setQuery("");
    setView("details");
    void loadTasks(facility, { date });
  }

  function selectMonth(month: string) {
    setDatePickerOpen(false);
    setQuery("");
    setView("details");
    void loadTasks(facility, { month });
  }

  function selectView(nextView: View) {
    if (nextView === "details") setQuery("");
    setView(nextView);
  }

  if (auth === "checking") {
    return <main className="app-loading"><div className="brand-mark"><Warehouse size={26} /></div><RefreshCw className="spin" size={22} /><span>Opening WISE...</span></main>;
  }

  if (auth === "signedOut") {
    return <Login onSignedIn={loadWorkspace} />;
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark small"><Warehouse size={21} strokeWidth={1.8} /></div>
          <div><strong>WISE</strong><span>Assigned tasks</span></div>
        </div>
        <div className="user-actions">
          <span className="user-name">{userName}</span>
          <button className="text-button" onClick={logout}>Sign out</button>
        </div>
      </header>

      <div className="dashboard-content">
        <section className="page-heading">
          <div>
            <span className="eyebrow">Daily operations</span>
            <h1>Assigned Tasks</h1>
            <p>{periodLabel(period)} · {facility.name} local time</p>
          </div>
          <button
            className="refresh-button"
            onClick={() => loadTasks(facility, selectionForPeriod(period))}
            disabled={loadingTasks || loadingFacilities}
          >
            <span>{loadingTasks ? "Refreshing" : "Refresh"}</span>
          </button>
        </section>

        <section className="summary-grid" aria-label="Task summary">
          <button
            className="summary-card facility-card"
            onClick={() => setPickerOpen(true)}
            disabled={loadingFacilities || facilities.length === 0}
            aria-haspopup="dialog"
          >
            <div className="summary-body"><span>Facility</span><strong>{facility.name}</strong></div>
          </button>
          <article className="summary-card">
            <div className="summary-body"><span>Assigned tasks</span><strong>{loadingTasks || loadingFacilities ? "—" : tasks.length.toLocaleString()}</strong></div>
          </article>
          <article className="summary-card">
            <div className="summary-body"><span>Customers</span><strong>{loadingTasks || loadingFacilities ? "—" : counts.customers.toLocaleString()}</strong></div>
          </article>
          <article className="summary-card">
            <div className="summary-body"><span>Task types</span><strong>{loadingTasks || loadingFacilities ? "—" : counts.types.toLocaleString()}</strong></div>
          </article>
          <button
            className="summary-card date-card"
            onClick={() => setDatePickerOpen(true)}
            disabled={loadingFacilities || !facility.id || !period.today}
            aria-haspopup="dialog"
          >
            <div className="summary-body"><span>Date</span><strong>{periodLabel(period, true)}</strong></div>
          </button>
        </section>

        <section className="task-section">
          <header className="task-toolbar">
            <div>
              <h2>Task workload</h2>
              <p>{loadingTasks ? "Loading assigned tasks..." : `${tasks.length.toLocaleString()} assigned tasks for ${period.mode === "month" ? "this month" : "this local date"}`}</p>
            </div>
            <div className="table-search">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tasks"
                aria-label="Search tasks"
                disabled={loadingTasks}
              />
              {query && <button onClick={() => setQuery("")} aria-label="Clear search">Clear</button>}
            </div>
          </header>

          <nav className="view-tabs" aria-label="Task views">
            {views.map((item) => (
              <button key={item.key} className={view === item.key ? "active" : ""} onClick={() => selectView(item.key)}>
                {item.label}
              </button>
            ))}
          </nav>

          {error ? (
            <div className="state-panel error-state" role="alert">
              <CircleAlert size={26} />
              <div><strong>Assigned tasks are unavailable</strong><span>{error}</span></div>
              <button onClick={() => loadTasks(facility, selectionForPeriod(period))}>Try again</button>
            </div>
          ) : loadingTasks ? (
            <div className="loading-table" aria-label="Loading assigned tasks">
              <div className="skeleton-row header" />
              {Array.from({ length: 8 }).map((_, index) => <div className="skeleton-row" key={index} />)}
            </div>
          ) : tasks.length === 0 ? (
            <div className="state-panel">
              <ClipboardList size={27} />
              <div><strong>No assigned tasks</strong><span>{facility.name} has no assigned tasks for {period.mode === "month" ? "this month" : "this local date"}.</span></div>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="state-panel">
              <Search size={27} />
              <div><strong>No matching tasks</strong><span>Clear the search or try a different term.</span></div>
              <button onClick={() => setQuery("")}>Clear search</button>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                {view === "details" && (
                  <>
                    <thead><tr><th>Task Type</th><th>Task Subtype</th><th>Customer</th><th>Customer Name</th><th>Task ID</th><th>Status</th></tr></thead>
                    <tbody>{filteredTasks.map((task, index) => (
                      <tr key={`${task.taskId}-${index}`}>
                        <td className="strong-cell">{formatValue(task.taskType)}</td>
                        <td>{formatValue(task.taskSubtype)}</td>
                        <td className="mono-cell">{task.customer}</td>
                        <td>{task.customerName}</td>
                        <td className="mono-cell">{task.taskId}</td>
                        <td><span className={statusClass(task.status)}>{formatValue(task.status)}</span></td>
                      </tr>
                    ))}</tbody>
                  </>
                )}
                {view === "status" && (
                  <>
                    <thead><tr><th>Task ID</th><th>Status</th></tr></thead>
                    <tbody>{filteredTasks.map((task, index) => (
                      <tr key={`${task.taskId}-${index}`}><td className="mono-cell strong-cell">{task.taskId}</td><td><span className={statusClass(task.status)}>{formatValue(task.status)}</span></td></tr>
                    ))}</tbody>
                  </>
                )}
                {view !== "details" && view !== "status" && (
                  <>
                    <thead><tr><th>{columnLabels[view]}</th><th className="count-column">Task Count</th></tr></thead>
                    <tbody>{groupedRows.map(([value, count]) => (
                      <tr key={value}><td className="strong-cell">{view === "taskType" || view === "taskSubtype" ? formatValue(value) : value}</td><td className="count-column">{count.toLocaleString()}</td></tr>
                    ))}</tbody>
                  </>
                )}
              </table>
            </div>
          )}

          {!loadingTasks && !error && filteredTasks.length > 0 && (
            <footer className="table-footer">Showing {filteredTasks.length.toLocaleString()} of {tasks.length.toLocaleString()} tasks</footer>
          )}
        </section>
      </div>

      {pickerOpen && (
        <FacilityPicker facilities={facilities} selected={facility} onSelect={selectFacility} onClose={() => setPickerOpen(false)} />
      )}
      {datePickerOpen && (
        <DatePicker period={period} onSelectDay={selectDate} onSelectMonth={selectMonth} onClose={() => setDatePickerOpen(false)} />
      )}
    </main>
  );
}
