import cx from "classnames";
import type * as React from "react";
import type { ControlPosition, DraggableBounds } from "react-draggable";
import Draggable from "react-draggable";

import { Ellipsified } from "metabase/core/components/Ellipsified";
import { darken } from "metabase/lib/colors";
import { ROW_TOTALS_ON_TOP } from "metabase/lib/data_grid";
import type { ClickObject } from "metabase/visualizations/types";
import type { VisualizationSettings } from "metabase-types/api";

import { PivotTableCell, ResizeHandle, SortIcon } from "./PivotTable.styled";
import { RowToggleIcon } from "./RowToggleIcon";
import {
  LEFT_HEADER_LEFT_SPACING,
  RESIZE_HANDLE_WIDTH,
  CELL_HEIGHT,
} from "./constants";
import type { HeaderItem, BodyItem, RowSectionSortOrder } from "./types";

interface CellProps {
  value: React.ReactNode;
  style?: React.CSSProperties;
  icon?: React.ReactNode;
  backgroundColor?: string;
  isBody?: boolean;
  isBold?: boolean;
  isEmphasized?: boolean;
  isNightMode?: boolean;
  isBorderedHeader?: boolean;
  isTransparent?: boolean;
  hasTopBorder?: boolean;
  onClick?: ((e: React.SyntheticEvent) => void) | undefined;
  onResize?: (newWidth: number) => void;
}

interface CellProps {
  value: React.ReactNode;
  style?: React.CSSProperties;
  icon?: React.ReactNode;
  backgroundColor?: string;
  isBody?: boolean;
  isBold?: boolean;
  isEmphasized?: boolean;
  isNightMode?: boolean;
  isBorderedHeader?: boolean;
  isTransparent?: boolean;
  hasTopBorder?: boolean;
  onClick?: ((e: React.SyntheticEvent) => void) | undefined;
  onResize?: (newWidth: number) => void;
  showTooltip?: boolean;
  sortIcon?: React.ReactNode;
}

export function Cell({
  value,
  style,
  icon,
  backgroundColor,
  isBody = false,
  isBold,
  isEmphasized,
  isNightMode,
  isBorderedHeader,
  isTransparent,
  hasTopBorder,
  onClick,
  onResize,
  showTooltip = true,
  sortIcon,
}: CellProps) {
  return (
    <PivotTableCell
      data-testid="pivot-table-cell"
      isNightMode={isNightMode}
      isBold={isBold}
      isEmphasized={isEmphasized}
      isBorderedHeader={isBorderedHeader}
      hasTopBorder={hasTopBorder}
      isTransparent={isTransparent}
      style={{
        ...style,
        ...(backgroundColor
          ? {
              backgroundColor: isEmphasized
                ? darken(backgroundColor)
                : backgroundColor,
            }
          : {}),
      }}
    >
      <>
        <div
          className={cx("px1 flex align-center", { "justify-end": isBody })}
          onClick={onClick}
        >
          {sortIcon && <div className={cx("flex align-left")}>{sortIcon}</div>}
          <Ellipsified showTooltip={showTooltip}>{value}</Ellipsified>
          {icon && <div className="pl1">{icon}</div>}
        </div>
        {!!onResize && (
          <Draggable
            axis="x"
            enableUserSelectHack
            bounds={{ left: RESIZE_HANDLE_WIDTH } as DraggableBounds}
            position={
              {
                x: style?.width ?? 0,
                y: 0,
              } as ControlPosition
            }
            onStop={(e, { x }) => {
              onResize(x);
            }}
          >
            <ResizeHandle data-testid="pivot-table-resize-handle" />
          </Draggable>
        )}
      </>
    </PivotTableCell>
  );
}

type CellClickHandler = (
  clicked: ClickObject | undefined,
) => ((e: React.SyntheticEvent) => void) | undefined;

function addRowSectionSort(
  clicked: (ClickObject & { rowSort?: RowSectionSortOrder }) | undefined,
  column?: number,
): (ClickObject & { rowSort?: RowSectionSortOrder }) | undefined {
  if (!clicked) {
    return;
  }

  const rowSort = clicked?.rowSort;

  if (!rowSort) {
    return clicked;
  }

  return {
    ...clicked,
    rowSort: {
      ...rowSort,
      column,
    },
  };
}

interface TopHeaderCellProps {
  item: HeaderItem;
  style: React.CSSProperties;
  isNightMode: boolean;
  getCellClickHandler: CellClickHandler;
  onResize?: (newWidth: number) => void;
}

export const TopHeaderCell = ({
  item,
  style,
  isNightMode,
  getCellClickHandler,
  onResize,
}: TopHeaderCellProps) => {
  const {
    value,
    hasChildren,
    clicked,
    isSubtotal,
    maxDepthBelow,
    span,
    levelSort,
  } = item;

  const isSorted = levelSort !== undefined;
  const iconName =
    levelSort?.direction === "descending" ? "chevrondown" : "chevronup";

  return (
    <Cell
      style={{
        ...style,
      }}
      value={value}
      isNightMode={isNightMode}
      isBorderedHeader={maxDepthBelow === 0}
      isEmphasized={hasChildren}
      isBold={isSubtotal}
      onClick={getCellClickHandler(clicked)}
      onResize={span < 2 ? onResize : undefined}
      sortIcon={isSorted && <SortIcon name={iconName} />}
    />
  );
};

type LeftHeaderCellProps = TopHeaderCellProps & {
  rowIndex: string[];
  settings: VisualizationSettings;
  onUpdateVisualizationSettings: (settings: VisualizationSettings) => void;
};

export const LeftHeaderCell = ({
  item,
  style,
  isNightMode,
  getCellClickHandler,
  rowIndex,
  settings,
  onUpdateVisualizationSettings,
  onResize,
}: LeftHeaderCellProps) => {
  const { value, isSubtotal, hasSubtotal, depth, path, clicked } = item;
  const totalsAbove = settings[ROW_TOTALS_ON_TOP];

  return (
    <Cell
      style={{
        ...style,
        ...(depth === 0 ? { paddingLeft: LEFT_HEADER_LEFT_SPACING } : {}),
      }}
      isNightMode={isNightMode}
      value={value}
      isEmphasized={isSubtotal}
      isBold={isSubtotal}
      onClick={getCellClickHandler(clicked)}
      onResize={onResize}
      icon={
        (isSubtotal || (hasSubtotal && !totalsAbove)) && (
          <RowToggleIcon
            data-testid={`${item.rawValue}-toggle-button`}
            value={path}
            settings={settings}
            updateSettings={onUpdateVisualizationSettings}
            hideUnlessCollapsed={isSubtotal && !totalsAbove}
            rowIndex={rowIndex} // used to get a list of "other" paths when open one item in a collapsed column
          />
        )
      }
    />
  );
};

interface BodyCellProps {
  style: React.CSSProperties;
  rowSection: BodyItem[];
  isNightMode: boolean;
  getCellClickHandler: CellClickHandler;
  cellWidths: number[];
  showTooltip?: boolean;
  rowMetrics?: boolean;
}

export const BodyCell = ({
  style,
  rowSection,
  isNightMode,
  getCellClickHandler,
  cellWidths,
  showTooltip = true,
  rowMetrics = false,
}: BodyCellProps) => {
  const flexDirection = rowMetrics ? "column" : "row";

  return (
    <div
      style={{
        ...style,
        flexDirection,
      }}
      className="flex"
    >
      {rowSection.map(
        (
          {
            value,
            isSubtotal,
            clicked,
            backgroundColor,
            levelSort,
            isGrandTotal,
            isCollapsed,
          },
          index,
        ) => {
          const flexBasis = rowMetrics ? CELL_HEIGHT : cellWidths[index];
          const isSorted =
            levelSort?.column === index && !isGrandTotal && !isCollapsed;
          const iconName =
            levelSort?.direction === "descending" ? "chevrondown" : "chevronup";

          return (
            <Cell
              isNightMode={isNightMode}
              key={index}
              style={{
                flexBasis,
              }}
              value={value}
              isEmphasized={isSubtotal}
              isBold={isSubtotal}
              showTooltip={showTooltip}
              isBody
              onClick={getCellClickHandler(addRowSectionSort(clicked, index))}
              backgroundColor={backgroundColor}
              sortIcon={isSorted && <SortIcon name={iconName} />}
            />
          );
        },
      )}
    </div>
  );
};
