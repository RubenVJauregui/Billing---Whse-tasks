"use client";

import { useId, useState } from "react";
import { downloadExcel, type ExcelCell } from "@/lib/export-excel";

type ExportButtonProps = {
  filename: string;
  sheetName: string;
  columns: string[];
  rows: ExcelCell[][];
  unavailableReason?: string;
  className?: string;
};

export default function ExportButton({
  filename,
  sheetName,
  columns,
  rows,
  unavailableReason,
  className = "",
}: ExportButtonProps) {
  const feedbackId = useId();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  async function exportRows() {
    if (unavailableReason) {
      setFeedback({ tone: "error", message: unavailableReason });
      return;
    }
    if (rows.length === 0) {
      setFeedback({ tone: "error", message: "There is no displayed data to export." });
      return;
    }

    setPending(true);
    setFeedback(null);
    try {
      await downloadExcel({ filename, sheetName, columns, rows });
      setFeedback({ tone: "success", message: "Excel export downloaded." });
    } catch {
      setFeedback({ tone: "error", message: "Excel export could not be created. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={`export-control ${className}`.trim()}>
      <button
        type="button"
        className="export-button"
        onClick={exportRows}
        disabled={pending}
        aria-describedby={feedback ? feedbackId : undefined}
      >
        {pending ? "Creating Excel..." : "Export to Excel"}
      </button>
      {feedback && (
        <span
          id={feedbackId}
          className={`export-feedback ${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </span>
      )}
    </div>
  );
}
