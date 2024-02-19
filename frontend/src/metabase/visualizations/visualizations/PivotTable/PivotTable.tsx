import cx from "classnames";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findDOMNode } from "react-dom";
import { connect } from "react-redux";
import { usePrevious } from "react-use";
import type { OnScrollParams } from "react-virtualized";
import { Collection, Grid, ScrollSync } from "react-virtualized";
import AutoSizer from "react-virtualized-auto-sizer";
import { t } from "ttag";
import _ from "underscore";

import ExplicitSize from "metabase/components/ExplicitSize";
import CS from "metabase/css/core/index.css";
import { sumArray } from "metabase/lib/arrays";
import {
  COLUMN_SHOW_TOTALS,
  MEASURES_AS_ROWS_SETTING,
  ROW_SORT_ORDER,
  isPivotGroupColumn,
  multiLevelPivot,
} from "metabase/lib/data_grid";
import { getScrollBarSize } from "metabase/lib/dom";
import { getSetting } from "metabase/selectors/settings";
import { useMantineTheme } from "metabase/ui";
import {
  getDefaultSize,
  getMinSize,
} from "metabase/visualizations/shared/utils/sizes";
import type { ClickObject, VisualizationProps } from "metabase/visualizations/types";
import type { DatasetData, VisualizationSettings } from "metabase-types/api";
import type { State } from "metabase-types/store";

import {
  PivotTableRoot,
  PivotTableTopLeftCellsContainer,
} from "./PivotTable.styled";
import {
  BodyCell,
  Cell,
  LeftHeaderCell,
  TopHeaderCell,
} from "./PivotTableCell";
import { RowToggleIcon } from "./RowToggleIcon";
import {
  CELL_HEIGHT,
  DEFAULT_CELL_WIDTH,
  LEFT_HEADER_LEFT_SPACING,
  MIN_HEADER_CELL_WIDTH,
  PIVOT_TABLE_BODY_LABEL,
} from "./constants";
import {
  _columnSettings as columnSettings,
  getTitleForColumn,
  settings,
} from "./settings";
import type { HeaderWidthType, RowSortOrder } from "./types";
import {
  checkRenderable,
  exportTable,
  getCellWidthsForSection,
  getLeftHeaderWidths,
  isRowSortClickedObject,
  isSensible,
  leftHeaderCellSizeAndPositionGetter,
  topHeaderCellSizeAndPositionGetter,
  updateSort,
} from "./utils";

const MIN_USABLE_BODY_WIDTH = 240;

const mapStateToProps = (state: State) => ({
  fontFamily: getSetting(state, "application-font"),
});

function _PivotTable({
  data,
  settings,
  width,
  height,
  onUpdateVisualizationSettings,
  isNightMode,
  isDashboard,
  fontFamily,
  isEditing,
  onVisualizationClick,
}: VisualizationProps) {
  const [viewPortWidth, setViewPortWidth] = useState(width);
  const [shouldOverflow, setShouldOverflow] = useState(false);
  const [gridElement, setGridElement] = useState<HTMLElement | null>(null);
  const columnWidthSettings = settings["pivot_table.column_widths"];

  const theme = useMantineTheme();

  const rowMetrics = settings[MEASURES_AS_ROWS_SETTING];
  const rowSortOrderSettings = settings[ROW_SORT_ORDER];

  const [
    { leftHeaderWidths, totalLeftHeaderWidths, valueHeaderWidths },
    setHeaderWidths,
  ] = useState<HeaderWidthType>({
    leftHeaderWidths: null,
    totalLeftHeaderWidths: null,
    valueHeaderWidths: {},
    ...(columnWidthSettings ?? {}),
  });

  const updateHeaderWidths = useCallback(
    (newHeaderWidths: Partial<HeaderWidthType>) => {
      setHeaderWidths(prevHeaderWidths => ({
        ...prevHeaderWidths,
        ...newHeaderWidths,
      }));

      onUpdateVisualizationSettings({
        "pivot_table.column_widths": {
          leftHeaderWidths,
          totalLeftHeaderWidths,
          valueHeaderWidths,
          ...newHeaderWidths,
        },
      });
    },
    [
      onUpdateVisualizationSettings,
      leftHeaderWidths,
      totalLeftHeaderWidths,
      valueHeaderWidths,
    ],
  );

  const [rowSortOrder, setRowSortOrder] = useState<RowSortOrder>({
    ...rowSortOrderSettings,
  });

  const updateRowSortOrder = useCallback(
    (newSortOrder: RowSortOrder) => {
      setRowSortOrder(newSortOrder);
      onUpdateVisualizationSettings({
        [ROW_SORT_ORDER]: newSortOrder,
      });
    },
    [onUpdateVisualizationSettings],
  );

  const bodyRef = useRef<Grid | null>(null);
  const leftHeaderRef = useRef(null);
  const topHeaderRef = useRef(null);

  const getColumnTitle = useCallback(
    function (columnIndex: number) {
      const column = data.cols.filter(col => !isPivotGroupColumn(col))[
        columnIndex
      ];
      return getTitleForColumn(column, settings);
    },
    [data, settings],
  );

  function isColumnCollapsible(columnIndex: number) {
    const columns = data.cols.filter(col => !isPivotGroupColumn(col));
    if (typeof settings.column != "function") {
      throw new Error(
        `Invalid pivot table settings format, missing nested column settings: ${JSON.stringify(
          settings,
        )}`,
      );
    }
    const { [COLUMN_SHOW_TOTALS]: showTotals } = settings.column!(
      columns[columnIndex],
    );
    return showTotals;
  }
  useEffect(() => {
    // This is needed in case the cell counts didn't change, but the data or cell sizes did
    (
      leftHeaderRef.current as Collection | null
    )?.recomputeCellSizesAndPositions?.();
    (
      topHeaderRef.current as Collection | null
    )?.recomputeCellSizesAndPositions?.();
    (bodyRef.current as Grid | null)?.recomputeGridSize?.();
  }, [
    data,
    leftHeaderRef,
    topHeaderRef,
    bodyRef,
    leftHeaderWidths,
    valueHeaderWidths,
    rowSortOrder,
  ]);

  const gridRef = useCallback((grid: Grid | null) => {
    bodyRef.current = grid;
    setGridElement(grid && (findDOMNode(grid) as HTMLElement));
  }, []);

  const pivoted = useMemo(() => {
    if (data == null || !data.cols.some(isPivotGroupColumn)) {
      return null;
    }

    try {
      return multiLevelPivot(data, settings);
    } catch (e) {
      console.warn(e);
    }
    return null;
  }, [data, settings]);

  const previousRowIndexes = usePrevious(pivoted?.rowIndexes);
  const previousRowMetrics = usePrevious(pivoted?.rowMetrics);
  const hasColumnWidths = [
    leftHeaderWidths,
    totalLeftHeaderWidths,
    valueHeaderWidths,
  ].every(Boolean);
  const columnsChanged =
    !hasColumnWidths ||
    (previousRowIndexes &&
      !_.isEqual(pivoted?.rowIndexes, previousRowIndexes)) ||
    leftHeaderWidths?.length !==
      (pivoted?.rowIndexes?.length ?? 0) + (pivoted?.rowMetrics ? 1 : 0) ||
    (previousRowMetrics !== undefined &&
      !_.isEqual(pivoted?.rowMetrics, previousRowMetrics));

  const rowsOrColumnsChanged =
    (previousRowIndexes &&
      !_.isEqual(pivoted?.rowIndexes, previousRowIndexes)) ||
    (previousRowMetrics !== undefined &&
      !_.isEqual(pivoted?.rowMetrics, previousRowMetrics));

  // In cases where there are horizontal scrollbars are visible AND the data grid has to scroll vertically as well,
  // the left sidebar and the main grid can get out of ScrollSync due to slightly differing heights
  function scrollBarOffsetSize(direction: "h" | "v" = "h") {
    if (!gridElement) {
      return 0;
    }

    if (
      (direction === "h" &&
        gridElement.scrollWidth > parseInt(gridElement.style.width)) ||
      (direction === "v" &&
        gridElement.scrollHeight > parseInt(gridElement.style.height))
    ) {
      return getScrollBarSize();
    }

    return 0;
  }

  const { fontSize } = theme.other.pivotTable.cell;

  useEffect(() => {
    if (rowsOrColumnsChanged) {
      setRowSortOrder(() => {
        return {};
      });

      onUpdateVisualizationSettings({
        [ROW_SORT_ORDER]: {},
      });

      setHeaderWidths({
        leftHeaderWidths: null,
        totalLeftHeaderWidths: null,
        valueHeaderWidths: {},
      });
    }

    if (!pivoted?.rowIndexes) {
      setHeaderWidths({
        leftHeaderWidths: null,
        totalLeftHeaderWidths: null,
        valueHeaderWidths,
      });
      return;
    }

    if (columnsChanged) {
      const newLeftHeaderWidths = getLeftHeaderWidths({
        rowIndexes: pivoted?.rowIndexes,
        getColumnTitle: idx => getColumnTitle(idx),
        leftHeaderItems: pivoted?.leftHeaderItems,
        font: { fontFamily, fontSize },
        rowMetrics,
      });

      setHeaderWidths({ ...newLeftHeaderWidths, valueHeaderWidths: {} });

      onUpdateVisualizationSettings({
        "pivot_table.column_widths": {
          ...newLeftHeaderWidths,
          valueHeaderWidths: {},
        },
      });
    }
  }, [
    onUpdateVisualizationSettings,
    valueHeaderWidths,
    pivoted,
    fontFamily,
    fontSize,
    getColumnTitle,
    columnsChanged,
    setHeaderWidths,
    rowMetrics,
    rowsOrColumnsChanged,
  ]);

  const handleColumnResize = (
    columnType: "value" | "leftHeader" | "topHeader",
    columnIndex: number,
    newWidth: number,
  ) => {
    let newColumnWidths: Partial<HeaderWidthType> = {};

    if (columnType === "leftHeader") {
      const newLeftHeaderColumnWidths = [...(leftHeaderWidths as number[])];
      newLeftHeaderColumnWidths[columnIndex] = Math.max(
        newWidth,
        MIN_HEADER_CELL_WIDTH,
      );

      const newTotalWidth = sumArray(newLeftHeaderColumnWidths);

      newColumnWidths = {
        leftHeaderWidths: newLeftHeaderColumnWidths,
        totalLeftHeaderWidths: newTotalWidth,
      };
    } else if (columnType === "value" || columnType === "topHeader") {
      const newValueHeaderWidths = { ...(valueHeaderWidths ?? {}) };
      newValueHeaderWidths[columnIndex] = Math.max(
        newWidth,
        MIN_HEADER_CELL_WIDTH,
      );

      newColumnWidths = {
        valueHeaderWidths: newValueHeaderWidths,
      };
    }

    updateHeaderWidths(newColumnWidths);
  };


  const leftHeaderIndexWidth =
  (pivoted?.rowIndexes?.length ?? 0) > 0
      ? LEFT_HEADER_LEFT_SPACING + (totalLeftHeaderWidths ?? 0)
      : 0;

  const leftHeaderWidth = rowMetrics
    ? leftHeaderIndexWidth
    : leftHeaderIndexWidth;

  useEffect(() => {
    const availableBodyWidth = width - leftHeaderWidth;
    const fullBodyWidth = sumArray(
      getCellWidthsForSection(
        valueHeaderWidths,
        pivoted?.valueIndexes ?? [],
        0,
      ),
    );

    const minUsableBodyWidth = Math.min(MIN_USABLE_BODY_WIDTH, fullBodyWidth);
    const shouldOverflow = availableBodyWidth < minUsableBodyWidth;
    setShouldOverflow(shouldOverflow);
    if (shouldOverflow) {
      setViewPortWidth(leftHeaderWidth + minUsableBodyWidth);
    } else {
      setViewPortWidth(width);
    }
  }, [
    totalLeftHeaderWidths,
    valueHeaderWidths,
    pivoted?.valueIndexes,
    width,
    leftHeaderWidths,
    leftHeaderWidth,
  ]);

  if (pivoted === null || !leftHeaderWidths || columnsChanged) {
    return null;
  }

  const {
    leftHeaderItems,
    topHeaderItems,
    rowCount,
    columnCount,
    rowIndex,
    getRowSection,
    rowIndexes,
    columnIndexes,
    valueIndexes,
  } = pivoted;

  const topHeaderRows = rowMetrics
    ? columnIndexes.length || 1
    : columnIndexes.length + (valueIndexes.length > 1 ? 1 : 0) || 1;

  const topHeaderHeight = topHeaderRows * CELL_HEIGHT;
  const topHeaderWidth = viewPortWidth - leftHeaderWidth;
  const bodyHeight = height - topHeaderHeight - CELL_HEIGHT;

  const bodyWidth = width - leftHeaderWidth;

  function getCellClickHandler(clicked: ClickObject | undefined) {
    if (!clicked) {
      return undefined;
    }

    return (e: React.SyntheticEvent) => {
      if (isRowSortClickedObject(clicked)) {
        e.stopPropagation();
        const { rowSectionIdx, colIdx = "[]", column } = clicked.rowSort ?? {};

        const previousRowSort = rowSortOrder[rowSectionIdx ?? "[]"];

        const sortDirection = previousRowSort?.direction;
        const isAlreadySorted =
          previousRowSort &&
          previousRowSort.colIdx === colIdx &&
          previousRowSort.column === column;

        const newSort =
          updateSort({
            clicked,
            previousRowSortOrder: rowSortOrder,
            sortDirection:
              !isAlreadySorted || sortDirection === "descending"
                ? "ascending"
                : "descending",
          }) ?? {};

        updateRowSortOrder(newSort);

        return;
      }
      return onVisualizationClick({
        ...clicked,
        event: e.nativeEvent,
        settings,
      });
    };
  }

  return (
    <PivotTableRoot
      shouldOverflow={shouldOverflow}
      shouldHideScrollbars={isEditing && isDashboard}
      isDashboard={isDashboard}
      isNightMode={isNightMode}
      data-testid="pivot-table"
    >
      <ScrollSync>
        {({ onScroll, scrollLeft, scrollTop }) => (
          <div className={cx(CS.fullHeight, CS.flex, CS.flexColumn)}>
            <div className={CS.flex} style={{ height: topHeaderHeight }}>
              {/* top left corner - displays left header columns */}
              <PivotTableTopLeftCellsContainer
                isNightMode={isNightMode}
                style={{
                  width: leftHeaderWidth,
                }}
              >
                {rowIndexes.map((rowIndex: number, index: number) => (
                  <Cell
                    key={rowIndex}
                    isEmphasized
                    isBold
                    isBorderedHeader
                    isTransparent
                    hasTopBorder={topHeaderRows > 1}
                    isNightMode={isNightMode}
                    value={getColumnTitle(rowIndex)}
                    onResize={(newWidth: number) =>
                      handleColumnResize("leftHeader", index, newWidth)
                    }
                    style={{
                      flex: "0 0 auto",
                      width:
                        (leftHeaderWidths?.[index] ?? 0) +
                        (index === 0 ? LEFT_HEADER_LEFT_SPACING : 0),
                      ...(index === 0
                        ? { paddingLeft: LEFT_HEADER_LEFT_SPACING }
                        : {}),
                      ...(index === rowIndexes.length - 1
                        ? { borderRight: "none" }
                        : {}),
                    }}
                    icon={
                      // you can only collapse before the last column
                      index < rowIndexes.length - 1 &&
                      isColumnCollapsible(rowIndex) && (
                        <RowToggleIcon
                          value={index + 1}
                          settings={settings}
                          updateSettings={onUpdateVisualizationSettings}
                        />
                      )
                    }
                  />
                ))}
                {rowMetrics && (
                  <Cell
                    key={rowIndexes.length + 1}
                    isEmphasized
                    isBold
                    isBorderedHeader
                    isTransparent
                    hasTopBorder={topHeaderRows > 1}
                    isNightMode={isNightMode}
                    value={" "}
                    onResize={(newWidth: number) =>
                      handleColumnResize(
                        "leftHeader",
                        rowIndexes.length,
                        newWidth,
                      )
                    }
                    style={{
                      flex: "0 0 auto",
                      height: "100%",
                      width: leftHeaderWidths?.[rowIndexes.length] ?? 0,
                    }}
                  />
                )}
              </PivotTableTopLeftCellsContainer>
              {/* top header */}
              <Collection
                style={{ minWidth: `${topHeaderWidth}px` }}
                ref={topHeaderRef}
                className={CS.scrollHideAll}
                isNightMode={isNightMode}
                width={bodyWidth - scrollBarOffsetSize("v")}
                height={topHeaderHeight}
                cellCount={topHeaderItems.length}
                cellRenderer={({ index, style, key }) => (
                  <TopHeaderCell
                    key={key}
                    style={style}
                    item={topHeaderItems[index]}
                    getCellClickHandler={getCellClickHandler}
                    isNightMode={isNightMode}
                    onResize={(newWidth: number) =>
                      handleColumnResize(
                        rowMetrics ? "topHeader" : "value",
                        topHeaderItems[index].offset,
                        newWidth,
                      )
                    }
                  />
                )}
                cellSizeAndPositionGetter={({ index }) =>
                  topHeaderCellSizeAndPositionGetter(
                    topHeaderItems[index],
                    topHeaderRows,
                    valueHeaderWidths,
                  )
                }
                onScroll={({ scrollLeft }) =>
                  onScroll({ scrollLeft } as OnScrollParams)
                }
                scrollLeft={scrollLeft}
              />
            </div>
            <div className={cx(CS.flex, CS.flexFull)}>
              {/* left header */}
              <div style={{ width: leftHeaderWidth }}>
                <AutoSizer disableWidth nonce={window.MetabaseNonce}>
                  {() => (
                    <Collection
                      ref={leftHeaderRef}
                      className={CS.scrollHideAll}
                      cellCount={leftHeaderItems.length}
                      cellRenderer={({ index, style, key }) => (
                        <LeftHeaderCell
                          key={key}
                          style={style}
                          item={leftHeaderItems[index]}
                          rowIndex={rowIndex}
                          onUpdateVisualizationSettings={
                            onUpdateVisualizationSettings
                          }
                          settings={settings}
                          isNightMode={isNightMode}
                          getCellClickHandler={getCellClickHandler}
                        />
                      )}
                      cellSizeAndPositionGetter={({ index }) =>
                        leftHeaderCellSizeAndPositionGetter(
                          leftHeaderItems[index],
                          leftHeaderWidths ?? [0],
                          rowIndexes,
                          rowMetrics,
                        )
                      }
                      width={leftHeaderWidth}
                      height={bodyHeight - scrollBarOffsetSize("h")}
                      scrollTop={scrollTop}
                      onScroll={({ scrollTop }) =>
                        onScroll({ scrollTop } as OnScrollParams)
                      }
                    />
                  )}
                </AutoSizer>
              </div>
              {/* pivot table body */}
              <div>
                <AutoSizer disableWidth nonce={window.MetabaseNonce}>
                  {() => (
                    <Grid
                      aria-label={PIVOT_TABLE_BODY_LABEL}
                      width={bodyWidth}
                      height={bodyHeight}
                      rowCount={rowCount}
                      columnCount={columnCount}
                      rowHeight={
                        rowMetrics
                          ? CELL_HEIGHT * valueIndexes.length
                          : CELL_HEIGHT
                      }
                      columnWidth={({ index }) => {
                        if (rowMetrics) {
                          return valueHeaderWidths[index] || DEFAULT_CELL_WIDTH;
                        }

                        const subColumnWidths = getCellWidthsForSection(
                          valueHeaderWidths,
                          valueIndexes,
                          index,
                        );
                        return sumArray(subColumnWidths);
                      }}
                      estimatedColumnSize={DEFAULT_CELL_WIDTH}
                      cellRenderer={({
                        rowIndex,
                        columnIndex,
                        key,
                        style,
                        isScrolling,
                      }) => (
                        <BodyCell
                          key={key}
                          style={style}
                          showTooltip={!isScrolling}
                          rowSection={getRowSection(columnIndex, rowIndex)}
                          isNightMode={isNightMode}
                          getCellClickHandler={getCellClickHandler}
                          rowMetrics={rowMetrics}
                          cellWidths={getCellWidthsForSection(
                            valueHeaderWidths,
                            valueIndexes,
                            columnIndex,
                          )}
                        />
                      )}
                      onScroll={({ scrollLeft, scrollTop }) =>
                        onScroll({ scrollLeft, scrollTop } as OnScrollParams)
                      }
                      ref={gridRef}
                      scrollTop={scrollTop}
                      scrollLeft={scrollLeft}
                    />
                  )}
                </AutoSizer>
              </div>
            </div>
          </div>
        )}
      </ScrollSync>
    </PivotTableRoot>
  );
}

const PivotTable = ExplicitSize<
  VisualizationProps & {
    className?: string;
  }
>({
  wrapped: false,
  refreshMode: "debounceLeading",
})(_PivotTable);

// eslint-disable-next-line import/no-default-export -- deprecated usage
export default Object.assign(connect(mapStateToProps)(PivotTable), {
  uiName: t`Pivot Table`,
  identifier: "pivot",
  iconName: "pivot_table",
  minSize: getMinSize("pivot"),
  defaultSize: getDefaultSize("pivot"),
  canSavePng: false,
  isSensible,
  checkRenderable,
  settings,
  columnSettings,
  isLiveResizable: () => false,
});

export { PivotTable };
