import type * as React from "react";
import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { findDOMNode } from "react-dom";
import { connect } from "react-redux";
import { usePrevious } from "react-use";
import type { OnScrollParams } from "react-virtualized";
import { Grid, Collection, ScrollSync } from "react-virtualized";
import AutoSizer from "react-virtualized-auto-sizer";
import { t } from "ttag";
import _ from "underscore";

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
import {
  getDefaultSize,
  getMinSize,
} from "metabase/visualizations/shared/utils/sizes";
import type { ClickObject } from "metabase/visualizations/types";
import type { DatasetData, VisualizationSettings } from "metabase-types/api";
import type { State } from "metabase-types/store";

import {
  PivotTableRoot,
  PivotTableTopLeftCellsContainer,
} from "./PivotTable.styled";
import {
  Cell,
  TopHeaderCell,
  LeftHeaderCell,
  BodyCell,
} from "./PivotTableCell";
import { RowToggleIcon } from "./RowToggleIcon";
import {
  DEFAULT_CELL_WIDTH,
  CELL_HEIGHT,
  LEFT_HEADER_LEFT_SPACING,
  MIN_HEADER_CELL_WIDTH,
} from "./constants";
import {
  settings,
  _columnSettings as columnSettings,
  getTitleForColumn,
} from "./settings";
import type { HeaderWidthType, RowSortOrder } from "./types";
import {
  getLeftHeaderWidths,
  isSensible,
  checkRenderable,
  leftHeaderCellSizeAndPositionGetter,
  topHeaderCellSizeAndPositionGetter,
  getCellWidthsForSection,
  isRowSortClickedObject,
  updateSort,
} from "./utils";

const mapStateToProps = (state: State) => ({
  fontFamily: getSetting(state, "application-font"),
});

interface PivotTableProps {
  data: DatasetData;
  settings: VisualizationSettings;
  width: number;
  onUpdateVisualizationSettings: (settings: VisualizationSettings) => void;
  isNightMode: boolean;
  isDashboard: boolean;
  fontFamily?: string;
  onVisualizationClick: (options: any) => void;
}

function PivotTable({
  data,
  settings,
  width,
  onUpdateVisualizationSettings,
  isNightMode,
  isDashboard,
  fontFamily,
  onVisualizationClick,
}: PivotTableProps) {
  const [gridElement, setGridElement] = useState<HTMLElement | null>(null);
  const columnWidthSettings = settings["pivot_table.column_widths"];
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
    function (columnIndex) {
      const column = data.cols.filter(col => !isPivotGroupColumn(col))[
        columnIndex
      ];
      return getTitleForColumn(column, settings);
    },
    [data, settings],
  );

  function isColumnCollapsible(columnIndex: number) {
    const columns = data.cols.filter(col => !isPivotGroupColumn(col));
    const { [COLUMN_SHOW_TOTALS]: showTotals } = settings.column(
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
    (previousRowMetrics && !_.isEqual(pivoted?.rowMetrics, previousRowMetrics));

  const rowsOrColumnsChanged =
    (previousRowIndexes &&
      !_.isEqual(pivoted?.rowIndexes, previousRowIndexes)) ||
    (previousRowMetrics && !_.isEqual(pivoted?.rowMetrics, previousRowMetrics));

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

  useEffect(() => {
    if (rowsOrColumnsChanged) {
      setRowSortOrder(() => {
        return {};
      });

      onUpdateVisualizationSettings({
        [ROW_SORT_ORDER]: {},
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
        fontFamily: fontFamily,
        rowMetrics,
      });

      setHeaderWidths({ ...newLeftHeaderWidths, valueHeaderWidths });

      onUpdateVisualizationSettings({
        "pivot_table.column_widths": {
          ...newLeftHeaderWidths,
          valueHeaderWidths,
        },
      });
    }
  }, [
    onUpdateVisualizationSettings,
    valueHeaderWidths,
    pivoted,
    fontFamily,
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
    } else if (columnType === "value") {
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

  const leftHeaderIndexWidth =
    rowIndexes.length > 0
      ? LEFT_HEADER_LEFT_SPACING + (totalLeftHeaderWidths ?? 0)
      : 0;
  const leftHeaderWidth = rowMetrics
    ? leftHeaderIndexWidth
    : leftHeaderIndexWidth;

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
      isDashboard={isDashboard}
      isNightMode={isNightMode}
      data-testid="pivot-table"
    >
      <ScrollSync>
        {({ onScroll, scrollLeft, scrollTop }) => (
          <div className="full-height flex flex-column">
            <div className="flex" style={{ height: topHeaderHeight }}>
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
                ref={topHeaderRef}
                className="scroll-hide-all"
                isNightMode={isNightMode}
                width={width - leftHeaderWidth - scrollBarOffsetSize("v")}
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
            <div className="flex flex-full">
              {/* left header */}
              <div style={{ width: leftHeaderWidth }}>
                <AutoSizer disableWidth>
                  {({ height }) => (
                    <Collection
                      ref={leftHeaderRef}
                      className="scroll-hide-all"
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
                      height={height - scrollBarOffsetSize("h")}
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
                <AutoSizer disableWidth>
                  {({ height }) => (
                    <Grid
                      width={width - leftHeaderWidth}
                      height={height}
                      className="text-dark"
                      rowCount={rowCount}
                      columnCount={columnCount}
                      rowHeight={
                        rowMetrics
                          ? CELL_HEIGHT * valueIndexes.length
                          : CELL_HEIGHT
                      }
                      columnWidth={({ index }) => {
                        const subColumnWidths = rowMetrics
                          ? [DEFAULT_CELL_WIDTH]
                          : getCellWidthsForSection(
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
