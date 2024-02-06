import type { ClickObject } from "metabase/visualizations/types";
import type {
  FieldReference,
  AggregateFieldReference,
} from "metabase-types/api";

export type PivotSetting = {
  columns: FieldReference[];
  rows: FieldReference[];
  values: AggregateFieldReference[];
};

export type RowSectionSortOrder = {
  rowSectionIdx: string;
  colIdx?: string;
  column?: number;
};

export interface HeaderItem {
  clicked?: ClickObject;

  isCollapsed?: boolean;
  hasChildren: boolean;
  hasSubtotal?: boolean;
  isSubtotal?: boolean;
  isGrandTotal?: boolean;
  isValueRow?: boolean;
  levelSort?: any;
  sortDirection?: "ascending" | "descending";

  depth: number;
  maxDepthBelow: number;
  offset: number;
  span: number; // rows to span

  path: string[];
  rawValue: string;
  value: string;
}

export type BodyItem = HeaderItem & {
  backgroundColor?: string;
};

export type CustomColumnWidth = Record<number, number>;

export type HeaderWidthType = {
  leftHeaderWidths: number[] | null;
  totalLeftHeaderWidths: number | null;
  valueHeaderWidths: CustomColumnWidth;
};

export type RowSortOrder = {
  [rowSectionIdx: string]: {
    colIdx: string;
    column?: number;
    direction: "ascending" | "descending";
  };
};
