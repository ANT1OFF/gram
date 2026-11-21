// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataTable, type DataTableColumn } from "./data-table";

afterEach(cleanup);

type Row = { id: string; name: string; spend?: number };
const ROWS: readonly Row[] = [
  { id: "1", name: "Bea", spend: 5 },
  { id: "2", name: "Ada" },
  { id: "3", name: "Cy", spend: 9 },
];
const COLUMNS: readonly DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (row) => row.name, sortValue: (row) => row.name },
  {
    id: "spend",
    header: "Spend",
    cell: (row) => row.spend ?? "",
    sortValue: (row) => row.spend,
    align: "end",
  },
];
const names = () =>
  screen.getAllByTestId("data-table-row").map((row) => row.textContent?.replace(/\d/g, ""));

describe("DataTable", () => {
  it("sorts by a header, flips on a second click, and keeps missing values last", () => {
    render(<DataTable label="People" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Spend" }));
    expect(names()).toEqual(["Bea", "Cy", "Ada"]);
    fireEvent.click(screen.getByRole("button", { name: "Spend" }));
    expect(names()).toEqual(["Cy", "Bea", "Ada"]);
    expect(screen.getByRole("columnheader", { name: "Spend" }).getAttribute("aria-sort")).toBe(
      "descending",
    );
  });

  it("opens a row with a click or Enter", () => {
    const open = vi.fn();
    render(
      <DataTable
        label="People"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        onRowOpen={open}
      />,
    );
    const [first] = screen.getAllByTestId("data-table-row");
    fireEvent.click(first!);
    fireEvent.keyDown(first!, { key: "Enter" });
    expect(open.mock.calls.map(([row]) => row.id)).toEqual(["1", "1"]);
  });
});
