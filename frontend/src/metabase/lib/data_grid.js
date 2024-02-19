import { getIn } from "icepick";
import { t } from "ttag";
import _ from "underscore";

import { formatColumn, formatValue } from "metabase/lib/formatting";
import { makeCellBackgroundGetter } from "metabase/visualizations/lib/table_format";
import { migratePivotColumnSplitSetting } from "metabase-lib/v1/queries/utils/pivot";

export function isPivotGroupColumn(col) {
  return col.name === "pivot-grouping";
}

export const COLUMN_FORMATTING_SETTING = "table.column_formatting";
export const COLLAPSED_ROWS_SETTING = "pivot_table.collapsed_rows";
export const COLUMN_SPLIT_SETTING = "pivot_table.column_split";
export const COLUMN_SHOW_TOTALS = "pivot_table.column_show_totals";
export const COLUMN_SORT_ORDER = "pivot_table.column_sort_order";
export const ROW_SORT_ORDER = "pivot_table.row_sort_order";
export const ROW_TOTALS_ON_TOP = "pivot_table.row_totals_on_top";
export const MEASURES_AS_ROWS_SETTING = "pivot_table.measures_as_rows";
export const COLUMN_SORT_ORDER_ASC = "ascending";
export const COLUMN_SORT_ORDER_DESC = "descending";

export function multiLevelPivot(data, settings) {
  if (!settings[COLUMN_SPLIT_SETTING]) {
    return null;
  }
  const columnSplit = migratePivotColumnSplitSetting(
    settings[COLUMN_SPLIT_SETTING] ?? { rows: [], columns: [], values: [] },
    data.cols,
  );
  const columnsWithoutPivotGroup = data.cols.filter(
    col => !isPivotGroupColumn(col),
  );

  const {
    columns: columnColumnIndexes,
    rows: rowColumnIndexes,
    values: valueColumnIndexes,
  } = _.mapObject(columnSplit, columnNames =>
    columnNames
      .map(columnName =>
        columnsWithoutPivotGroup.findIndex(col => col.name === columnName),
      )
      .filter(index => index !== -1),
  );

  const { pivotData, columns } = splitPivotData(data);
  const columnSettings = columns.map(column => settings.column(column));
  const allCollapsedSubtotals = settings[COLLAPSED_ROWS_SETTING].value;
  const collapsedSubtotals = filterCollapsedSubtotals(
    allCollapsedSubtotals,
    rowColumnIndexes.map(index => columnSettings[index]),
  );

  // we build a tree for each tuple of pivoted column/row values seen in the data
  const columnColumnTree = [];
  const rowColumnTree = [];

  // this stores pivot table values keyed by all pivoted columns
  const valuesByKey = {};

  // loop over the primary rows to build trees of column/row header data
  const primaryRowsKey = JSON.stringify(
    _.range(columnColumnIndexes.length + rowColumnIndexes.length),
  );
  for (const row of pivotData[primaryRowsKey]) {
    // mutate the trees to add the tuple from the current row
    updateValueObject(
      row,
      columnColumnIndexes,
      columnSettings,
      columnColumnTree,
    );
    updateValueObject(
      row,
      rowColumnIndexes,
      columnSettings,
      rowColumnTree,
      collapsedSubtotals,
    );

    // save the value columns keyed by the values in the column/row pivoted columns
    const valueKey = JSON.stringify(
      columnColumnIndexes.concat(rowColumnIndexes).map(index => row[index]),
    );
    const values = valueColumnIndexes.map(index => row[index]);
    const valueColumns = valueColumnIndexes.map(
      index => columnSettings[index]?.column,
    );

    valuesByKey[valueKey] = {
      values,
      valueColumns,
      data: row.map((value, index) => ({ value, col: columns[index] })),
      dimensions: row
        .map((value, index) => ({
          value,
          column: columns[index],
        }))
        .filter(({ column }) => column.source === "breakout"),
    };
  }

  // build objects to look up subtotal values
  const subtotalValues = {};
  for (const [subtotalName, subtotal] of Object.entries(pivotData)) {
    const indexes = JSON.parse(subtotalName);
    subtotalValues[subtotalName] = {};
    for (const row of subtotal) {
      const valueKey = JSON.stringify(indexes.map(index => row[index]));
      subtotalValues[subtotalName][valueKey] = valueColumnIndexes.map(
        index => row[index],
      );
    }
  }

  if (settings[ROW_SORT_ORDER]) {
    const valueGetter = getValueByIndex(
      subtotalValues,
      rowColumnIndexes,
      columnColumnIndexes,
    );

    sortTreeByValues([], rowColumnTree, valueGetter, settings[ROW_SORT_ORDER]);
  }

  // pivot tables have a lot of repeated values, so we use memoized formatters for each column
  const [valueFormatters, topIndexFormatters, leftIndexFormatters] = [
    valueColumnIndexes,
    columnColumnIndexes,
    rowColumnIndexes,
  ].map(indexes =>
    indexes.map(index =>
      _.memoize(
        value => formatValue(value, columnSettings[index]),
        value => [value, index].join(),
      ),
    ),
  );

  const topIndexColumns = columnColumnIndexes.map(index => columns[index]);
  const formattedColumnTreeWithoutValues = formatValuesInTree(
    columnColumnTree,
    topIndexFormatters,
    topIndexColumns,
  );
  if (
    formattedColumnTreeWithoutValues.length > 1 &&
    settings["pivot.show_row_totals"]
  ) {
    // if there are multiple columns, we should add another for row totals
    formattedColumnTreeWithoutValues.push({
      value: t`Row totals`,
      children: [],
      isSubtotal: true,
      isGrandTotal: true,
    });
  }

  const columnIndex = addEmptyIndexItem(
    formattedColumnTreeWithoutValues.flatMap(root => enumeratePaths(root)),
  );

  const leftIndexColumns = rowColumnIndexes.map(index => columns[index]);
  const formattedRowTreeWithoutSubtotals = formatValuesInTree(
    rowColumnTree,
    leftIndexFormatters,
    leftIndexColumns,
    [],
  );
  const showSubtotalsByColumn = rowColumnIndexes.map(
    index => getIn(columnSettings, [index, COLUMN_SHOW_TOTALS]) !== false,
  );

  const formattedRowTreeWithoutValues = settings["pivot.show_column_totals"]
    ? addSubtotals(
        formattedRowTreeWithoutSubtotals,
        showSubtotalsByColumn,
        settings[MEASURES_AS_ROWS_SETTING],
        settings[ROW_TOTALS_ON_TOP],
      )
    : formattedRowTreeWithoutSubtotals;

  if (
    formattedRowTreeWithoutSubtotals.length > 1 &&
    settings["pivot.show_column_totals"]
  ) {
    // if there are multiple columns, we should add another for row totals
    formattedRowTreeWithoutValues.push({
      value: t`Grand totals`,
      isSubtotal: true,
      isGrandTotal: true,
      children: [],
    });
  }

  if (
    settings[MEASURES_AS_ROWS_SETTING] &&
    formattedColumnTreeWithoutValues.length === 0
  ) {
    formattedColumnTreeWithoutValues.push({
      value: t`Values`,
      children: [],
    });
  }

  const rowSortOrder = settings[ROW_SORT_ORDER] ?? {};

  const rowIndex = addEmptyIndexItem(
    formattedRowTreeWithoutValues.flatMap(root => enumeratePaths(root)),
  );

  const valueColumns = valueColumnIndexes.map(index => [
    columns[index],
    columnSettings[index],
  ]);

  const formattedRowTree = !settings[MEASURES_AS_ROWS_SETTING]
    ? formattedRowTreeWithoutValues
    : addValueRowNodes(formattedRowTreeWithoutValues, valueColumns);

  const formattedColumnTree = settings[MEASURES_AS_ROWS_SETTING]
    ? formattedColumnTreeWithoutValues
    : addValueColumnNodes(
        formattedColumnTreeWithoutValues,
        valueColumns,
        rowSortOrder,
      );

  const leftHeaderItems = treeToArray(formattedRowTree.flat());
  const topHeaderItems = treeToArray(formattedColumnTree.flat());

  const colorGetter = makeCellBackgroundGetter(
    pivotData[primaryRowsKey],
    columns,
    settings["table.column_formatting"] ?? [],
    true,
  );

  const getRowSection = createRowSectionGetter({
    valuesByKey,
    subtotalValues,
    valueFormatters,
    columnColumnIndexes,
    rowColumnIndexes,
    columnIndex,
    rowIndex,
    colorGetter,
    valueColumns: valueColumnIndexes.map(
      index => columnSettings[index]?.column,
    ),
    rowSortOrder,
    collapsedSubtotals,
  });

  return {
    leftHeaderItems,
    topHeaderItems,
    rowCount: rowIndex.length,
    columnCount: columnIndex.length,
    rowIndex,
    getRowSection,
    rowIndexes: rowColumnIndexes,
    columnIndexes: columnColumnIndexes,
    valueIndexes: valueColumnIndexes,
    rowMetrics: settings[MEASURES_AS_ROWS_SETTING],
  };
}

// This pulls apart the different aggregations that were packed into one result set.
// There's a column indicating which breakouts were used to compute that row.
// We use that column to split apart the data and convert the field refs to indexes.
function splitPivotData(data) {
  const groupIndex = data.cols.findIndex(isPivotGroupColumn);
  const columns = data.cols.filter(col => !isPivotGroupColumn(col));
  const breakouts = columns.filter(col => col.source === "breakout");

  const pivotData = _.chain(data.rows)
    .groupBy(row => row[groupIndex])
    .pairs()
    .map(([key, rows]) => {
      key = parseInt(key);
      const indexes = _.range(breakouts.length).filter(
        index => !((1 << index) & key),
      );
      const keyAsIndexes = JSON.stringify(indexes);
      const rowsWithoutColumn = rows.map(row =>
        row.slice(0, groupIndex).concat(row.slice(groupIndex + 1)),
      );

      return [keyAsIndexes, rowsWithoutColumn];
    })
    .object()
    .value();
  return { pivotData, columns };
}

function addEmptyIndexItem(index) {
  // we need a single item even if all columns are on the other axis
  return index.length === 0 ? [[]] : index;
}

// A path can't be collapsed if subtotals are turned off for that column.
// TODO: can we move this to the COLLAPSED_ROW_SETTING itself?
function filterCollapsedSubtotals(collapsedSubtotals, columnSettings) {
  const columnIsCollapsible = columnSettings.map(
    settings => settings[COLUMN_SHOW_TOTALS] !== false,
  );
  return collapsedSubtotals.filter(pathOrLengthString => {
    const pathOrLength = JSON.parse(pathOrLengthString);
    const length = Array.isArray(pathOrLength)
      ? pathOrLength.length
      : pathOrLength;
    return columnIsCollapsible[length - 1];
  });
}

// The getter returned from this function returns the value(s) at given (column, row) location
function createRowSectionGetter({
  valuesByKey,
  subtotalValues,
  valueFormatters,
  columnColumnIndexes,
  rowColumnIndexes,
  columnIndex,
  rowIndex,
  colorGetter,
  rowMetrics,
  valueColumns,
  rowSortOrder,
  collapsedSubtotals = [],
}) {
  const formatValues = values =>
    values === undefined
      ? Array(valueFormatters.length).fill({ value: null })
      : values.map((v, i) => ({ value: valueFormatters[i](v) }));
  const getSubtotals = (breakoutIndexes, values, otherAttrs) => {
    const subtotals = getIn(
      subtotalValues,
      [breakoutIndexes, values].map(a =>
        JSON.stringify(_.sortBy(a, (_value, index) => breakoutIndexes[index])),
      ),
    );

    const formattedSubtotals = formatValues(subtotals);
    return formattedSubtotals.map((value, index) => {
      return subtotals === undefined
        ? {
            ...value,
            ...otherAttrs,
          }
        : {
            ...value,
            ...otherAttrs,
            isSubtotal: true,
            backgroundColor: colorGetter(
              subtotals[index],
              value.rowIndex,
              valueColumns[index].name,
            ),
          };
    });
  };

  const getter = (columnIdx, rowIdx) => {
    const columnValues = columnIndex[columnIdx] || [];
    const rowValues = rowIndex[rowIdx] || [];
    const indexValues = columnValues.concat(rowValues);
    if (
      rowValues.length < rowColumnIndexes.length ||
      columnValues.length < columnColumnIndexes.length
    ) {
      // if we don't have a full-length key, we're looking for a subtotal
      const rowIndexes = rowColumnIndexes.slice(0, rowValues.length);
      const columnIndexes = columnColumnIndexes.slice(0, columnValues.length);
      const indexes = columnIndexes.concat(rowIndexes);
      const isCollapsed =
        // the specific path is collapsed
        collapsedSubtotals.includes(JSON.stringify(rowValues)) ||
        // the entire column is collapsed
        collapsedSubtotals.includes(JSON.stringify(rowValues.length));
      const levelSort = {
        current: getLevelSort(rowSortOrder, rowValues, false),
        rowSectionIdx: JSON.stringify(rowValues),
        colIdx: JSON.stringify(columnValues),
      };

      const otherAttrs = {
        isCollapsed,
        isGrandTotal: rowValues.length === 0,
        levelSort:
          levelSort.current?.colIdx === levelSort.colIdx
            ? levelSort.current
            : undefined,
        isSubtotal: true,
        clicked: !isCollapsed
          ? {
              rowSort: {
                rowSectionIdx: JSON.stringify(rowValues),
                colIdx: JSON.stringify(columnValues),
              },
            }
          : undefined,
      };

      return getSubtotals(indexes, indexValues, {
        ...otherAttrs,
      });
    }
    const { values, data, dimensions, valueColumns } =
      valuesByKey[JSON.stringify(indexValues)] || {};
    return formatValues(values).map((o, index) =>
      data === undefined
        ? o
        : {
            ...o,
            clicked: { data, dimensions },
            backgroundColor: colorGetter(
              values[index],
              o.rowIndex,
              valueColumns[index].name,
            ),
          },
    );
  };
  return _.memoize(getter, (i1, i2) => [i1, i2].join());
}

// Given a tree representation of an index, enumeratePaths produces a list of all paths to leaf nodes
function enumeratePaths(
  { rawValue, isGrandTotal, children, isValueColumn, isValueRow },
  path = [],
) {
  if (isGrandTotal) {
    return [[]];
  }
  if (isValueColumn || isValueRow) {
    return [path];
  }
  const pathWithValue = [...path, rawValue];
  return children.length === 0
    ? [pathWithValue]
    : children.flatMap(child => enumeratePaths(child, pathWithValue));
}

function formatValuesInTree(
  rowColumnTree,
  [formatter, ...formatters],
  [column, ...columns],
  rowSectionIdx,
) {
  return rowColumnTree.map(({ value, children, ...rest }) => {
    const clicked = rowSectionIdx
      ? {
          value,
          column,
          rowSort: {
            rowSectionIdx: JSON.stringify(rowSectionIdx),
          },
        }
      : { value, column };
    return {
      ...rest,
      value: formatter(value),
      rawValue: value,
      children: formatValuesInTree(
        children,
        formatters,
        columns,
        rowSectionIdx ? [...rowSectionIdx, value] : undefined,
      ),
      clicked,
    };
  });
}

// This might add value column(s) to the bottom of the top header tree.
// We display the value column names if there are multiple
// or if there are no columns pivoted to the top header.
function addValueColumnNodes(nodes, valueColumns, rowSortOrder) {
  const levelSort = getLevelSort(rowSortOrder, [], false);

  const leafNodes = valueColumns.map(([column, columnSettings], index) => {
    return {
      value: columnSettings.column_title || formatColumn(column),
      children: [],
      isValueColumn: true,
      levelSort:
        (!levelSort?.colIdx || levelSort?.colIdx === "[]") &&
        levelSort?.column === index
          ? levelSort
          : undefined,
      clicked: {
        rowSort: {
          rowSectionIdx: "[]",
          column: index,
        },
      },
    };
  });

  if (nodes.length === 0) {
    return leafNodes;
  }

  function updateNode(colIdx = []) {
    return node => {
      const newColIdx = node.rawValue ? [...colIdx, node.rawValue] : colIdx;

      const childLeafNodes =
        valueColumns.length <= 1
          ? []
          : leafNodes.map((leafNode, index) => {
              const rowSort = {
                ...(leafNode.clicked?.rowSort ?? {}),
                colIdx: JSON.stringify(newColIdx),
              };

              return {
                ...leafNode,
                clicked: {
                  ...leafNode.clicked,
                  rowSort,
                },
                levelSort:
                  levelSort?.colIdx === rowSort.colIdx &&
                  levelSort?.column === rowSort.column
                    ? levelSort
                    : undefined,
              };
            });

      const children =
        node.children.length === 0
          ? childLeafNodes
          : node.children.map(updateNode(newColIdx));
      const clicked =
        valueColumns.length <= 1 && node.children.length === 0
          ? {
              ...node.clicked,
              rowSort: {
                rowSectionIdx: "[]",
                colIdx: JSON.stringify(newColIdx),
                column: 0,
              },
            }
          : node.clicked;
      return {
        ...node,
        children,
        clicked,
        levelSort:
          valueColumns.length <= 1 &&
          node.children.length === 0 &&
          levelSort?.colIdx === JSON.stringify(newColIdx) &&
          levelSort?.column === 0
            ? levelSort
            : undefined,
      };
    };
  }
  return nodes.map(updateNode([]));
}

// This might add value row(s) to the bottom of the left header tree.
// We display the value row names if there are multiple
// or if there are no rows pivoted to the left header.
function addValueRowNodes(nodes, valueRows) {
  const leafNodes = valueRows.map(([column, columnSettings]) => {
    return {
      value: columnSettings.column_title || formatColumn(column),
      children: [],
      isValueRow: true,
    };
  });
  if (nodes.length === 0) {
    return leafNodes;
  }
  if (valueRows.length <= 1) {
    return nodes;
  }
  function updateNode(node) {
    if (node.isSubtotal) {
      leafNodes.map(node => ({
        ...node,
        isSubtotal: true,
      }));
    }
    const children =
      node.children.length === 0
        ? leafNodes.map(leafNode => ({
            ...leafNode,
            isSubtotal: node.isSubtotal,
          }))
        : node.children.map(updateNode);
    return { ...node, children };
  }
  return nodes.map(updateNode);
}

// This inserts nodes into the left header tree for subtotals.
// We also mark nodes with `hasSubtotal` to display collapsing UI
function addSubtotals(
  rowColumnTree,
  showSubtotalsByColumn,
  rowMetrics = false,
  totalsAbove = false,
) {
  // For top-level items we want to show subtotal even if they have only one child
  // Except the case when top-level items have flat structure
  // (meaning all of the items have just one child)
  // If top-level items are flat, subtotals will just repeat their corresponding row
  // https://github.com/metabase/metabase/issues/15211
  // https://github.com/metabase/metabase/pull/16566
  const notFlat = rowColumnTree.some(item => item.children.length > 1);

  return rowColumnTree.flatMap(item =>
    addSubtotal(item, showSubtotalsByColumn, {
      shouldShowSubtotal: notFlat || item.children.length > 1,
      rowMetrics,
      totalsAbove,
    }),
  );
}

function addSubtotal(
  item,
  [isSubtotalEnabled, ...showSubtotalsByColumn],
  { shouldShowSubtotal = false, rowMetrics = false, totalsAbove = false } = {},
) {
  const hasSubtotal = isSubtotalEnabled && shouldShowSubtotal;
  const subtotal = hasSubtotal
    ? [
        {
          value: t`Totals for ${item.value}`,
          rawValue: item.rawValue,
          isCollapsed: item.isCollapsed,
          span: 1,
          isSubtotal: true,
          children: [],
          clicked: item.clicked,
        },
      ]
    : [];

  if (item.isCollapsed) {
    return subtotal;
  }

  if (totalsAbove) {
    const node = {
      ...item,
      hasSubtotal,
      children: item.children.flatMap(child =>
        // add subtotals until the last level
        child.children.length > 0
          ? addSubtotal(child, showSubtotalsByColumn, {
              shouldShowSubtotal:
                child.children.length > 1 || child.isCollapsed,
              rowMetrics,
              totalsAbove,
            })
          : child,
      ),
    };
    return [...subtotal, node];
  }

  const node = {
    ...item,
    hasSubtotal,
    children: item.children.flatMap(child =>
      // add subtotals until the last level
      child.children.length > 0
        ? addSubtotal(child, showSubtotalsByColumn, {
            shouldShowSubtotal: child.children.length > 1 || child.isCollapsed,
            rowMetrics,
            totalsAbove,
          })
        : child,
    ),
  };

  return [node, ...subtotal];
}

// Update the tree with a row of data
function updateValueObject(
  row,
  indexes,
  columnSettings,
  seenValues,
  collapsedSubtotals = [],
) {
  let currentLevelSeenValues = seenValues;
  const prefix = [];
  for (const index of indexes) {
    const value = row[index];
    prefix.push(value);
    let seenValue = currentLevelSeenValues.find(d => d.value === value);
    const isCollapsed =
      // the specific path is collapsed
      collapsedSubtotals.includes(JSON.stringify(prefix)) ||
      // the entire column is collapsed
      collapsedSubtotals.includes(JSON.stringify(prefix.length));
    if (seenValue === undefined) {
      seenValue = { value, children: [], isCollapsed };
      currentLevelSeenValues.push(seenValue);
      sortLevelOfTree(currentLevelSeenValues, columnSettings[index]);
    }
    currentLevelSeenValues = seenValue.children;
  }
}

// Sorts the array of nodes in place if a sort order is set for that column
function sortLevelOfTree(array, { [COLUMN_SORT_ORDER]: sortOrder } = {}) {
  if (sortOrder == null) {
    // don't sort unless there's a column sort order set
    return;
  }
  array.sort((a, b) => {
    if (a.value === b.value) {
      return 0;
    }
    // by default use "<" to compare values
    let result = a.value < b.value ? -1 : 1;
    // strings should use localeCompare to handle accents, etc
    if (typeof a.value === "string") {
      result = a.value.localeCompare(b.value);
    }
    // flip the comparison for descending
    if (sortOrder === COLUMN_SORT_ORDER_DESC) {
      result *= -1;
    }
    return result;
  });
}

function getValueByIndex(
  subtotalValues,
  rowColumnIndexes,
  columnColumnIndexes,
) {
  return (rowIndexValue, columnIndexValue) => {
    const values = [...columnIndexValue, ...rowIndexValue];

    const rowIndexes = rowColumnIndexes.slice(0, rowIndexValue.length);
    const columnIndexes = columnColumnIndexes.slice(0, columnIndexValue.length);
    const indexes = columnIndexes.concat(rowIndexes);
    // const path = [JSON.stringify(indexes), JSON.stringify(values)];
    const path = [indexes, values].map(a =>
      JSON.stringify(_.sortBy(a, (_value, index) => indexes[index])),
    );
    return getIn(subtotalValues, path);
  };
}

function getLevelSort(sortOrder, prefix = [], descend = true) {
  const levelKey = JSON.stringify(prefix);
  const levelSort = sortOrder[levelKey];

  if (levelSort) {
    return levelSort;
  }

  if (prefix.length === 0 || !descend) {
    return;
  }

  return getLevelSort(sortOrder, prefix.slice(0, -1));
}

function sortTreeByValues(prefix, rows, getter, sortOrder) {
  for (const row of rows) {
    if (row.children?.length > 0) {
      sortTreeByValues([...prefix, row.value], row.children, getter, sortOrder);
    }
  }

  const levelSort = getLevelSort(sortOrder, prefix);

  if (!levelSort) {
    return;
  }

  const colIndex = levelSort.colIdx ? JSON.parse(levelSort.colIdx) : [];

  rows.sort((a, b) => {
    const aValues = getter([...prefix, a.value], colIndex);
    const bValues = getter([...prefix, b.value], colIndex);
    const aValue =
      levelSort.column === undefined || aValues === undefined
        ? a.value
        : aValues[levelSort.column];

    const bValue =
      levelSort.column === undefined || bValues === undefined
        ? b.value
        : bValues[levelSort.column];

    if (aValue === bValue) {
      return 0;
    }
    // by default use "<" to compare values
    let result = aValue < bValue ? -1 : 1;
    // strings should use localeCompare to handle accents, etc
    if (typeof aValue === "string") {
      result = aValue.localeCompare(bValue);
    }
    // flip the comparison for descending
    if (levelSort.direction === COLUMN_SORT_ORDER_DESC) {
      result *= -1;
    }
    return result;
  });
}

// Take a tree and produce a flat list used to layout the top/left headers.
// We track the depth, offset, etc to know how to line items up in the headers.
function treeToArray(nodes) {
  const a = [];
  function dfs(nodes, depth, offset, path = []) {
    if (nodes.length === 0) {
      return { span: 1, maxDepth: 0 };
    }
    let totalSpan = 0;
    let maxDepth = 0;
    for (const {
      children,
      rawValue,
      isGrandTotal,
      isSubtotal,
      isValueColumn,
      isValueRow,
      ...rest
    } of nodes) {
      const pathWithValue =
        isValueColumn || isValueRow || isGrandTotal
          ? null
          : [...path, rawValue];
      const item = {
        ...rest,
        rawValue,
        isGrandTotal,
        isSubtotal,
        isValueRow,
        depth,
        offset,
        hasChildren: children.length > 0,
        path: pathWithValue,
      };
      a.push(item);
      const result = dfs(children, depth + 1, offset, pathWithValue);
      item.span = result.span;
      item.maxDepthBelow = result.maxDepth;
      offset += result.span;
      totalSpan += result.span;
      maxDepth = Math.max(maxDepth, result.maxDepth);
    }
    return { span: totalSpan, maxDepth: maxDepth + 1 };
  }

  dfs(nodes, 0, 0);
  return a;
}

// This is the pivot function used in the normal table visualization.
export function pivot(data, normalCol, pivotCol, cellCol) {
  const { pivotValues, normalValues } = distinctValuesSorted(
    data.rows,
    pivotCol,
    normalCol,
  );

  // make sure that the first element in the pivoted column list is null which makes room for the label of the other column
  pivotValues.unshift(data.cols[normalCol].display_name);

  // start with an empty grid that we'll fill with the appropriate values
  const pivotedRows = normalValues.map((normalValues, index) => {
    const row = pivotValues.map(() => null);
    // for onVisualizationClick:
    row._dimension = {
      value: normalValues,
      column: data.cols[normalCol],
    };
    return row;
  });

  // keep a record of which row the data came from for onVisualizationClick
  const sourceRows = normalValues.map(() => pivotValues.map(() => null));

  // fill it up with the data
  for (let j = 0; j < data.rows.length; j++) {
    const normalColIdx = normalValues.lastIndexOf(data.rows[j][normalCol]);
    const pivotColIdx = pivotValues.lastIndexOf(data.rows[j][pivotCol]);

    pivotedRows[normalColIdx][0] = data.rows[j][normalCol];
    pivotedRows[normalColIdx][pivotColIdx] = data.rows[j][cellCol];
    sourceRows[normalColIdx][pivotColIdx] = j;
  }

  // provide some column metadata to maintain consistency
  const cols = pivotValues.map(function (value, idx) {
    if (idx === 0) {
      // first column is always the coldef of the normal column
      return data.cols[normalCol];
    } else {
      return {
        ...data.cols[cellCol],
        // `name` must be the same for conditional formatting, but put the
        // formatted pivotted value in the `display_name`
        display_name: formatValue(value, { column: data.cols[pivotCol] }) || "",
        // for onVisualizationClick:
        _dimension: {
          value: value,
          column: data.cols[pivotCol],
        },
      };
    }
  });

  return {
    cols: cols,
    columns: pivotValues,
    rows: pivotedRows,
    sourceRows,
  };
}

function distinctValuesSorted(rows, pivotColIdx, normalColIdx) {
  const normalSet = new Set();
  const pivotSet = new Set();

  const normalSortState = new SortState();
  const pivotSortState = new SortState();

  for (const row of rows) {
    const pivotValue = row[pivotColIdx];
    const normalValue = row[normalColIdx];

    normalSet.add(normalValue);
    pivotSet.add(pivotValue);

    normalSortState.update(normalValue, pivotValue);
    pivotSortState.update(pivotValue, normalValue);
  }

  const normalValues = Array.from(normalSet);
  const pivotValues = Array.from(pivotSet);

  normalSortState.sort(normalValues);
  pivotSortState.sort(pivotValues);

  return { normalValues, pivotValues };
}

// This should work for both strings and numbers
const DEFAULT_COMPARE = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

class SortState {
  constructor(compare = DEFAULT_COMPARE) {
    this.compare = compare;

    this.asc = true;
    this.desc = true;
    this.lastValue = undefined;

    this.groupAsc = true;
    this.groupDesc = true;
    this.lastGroupKey = undefined;
    this.isGrouped = false;
  }
  update(value, groupKey) {
    // skip the first value since there's nothing to compare it to
    if (this.lastValue !== undefined) {
      // compare the current value with the previous value
      const result = this.compare(value, this.lastValue);
      // update global sort state
      this.asc = this.asc && result >= 0;
      this.desc = this.desc && result <= 0;
      if (
        // if current and last values are different
        result !== 0 &&
        // and current and last group are same
        this.lastGroupKey !== undefined &&
        this.lastGroupKey === groupKey
      ) {
        // update grouped sort state
        this.groupAsc = this.groupAsc && result >= 0;
        this.groupDesc = this.groupDesc && result <= 0;
        this.isGrouped = true;
      }
    }
    // update last value and group key
    this.lastValue = value;
    this.lastGroupKey = groupKey;
  }
  sort(array) {
    if (this.isGrouped) {
      if (this.groupAsc && this.groupDesc) {
        console.warn("This shouldn't happen");
      } else if (this.groupAsc && !this.asc) {
        array.sort(this.compare);
      } else if (this.groupDesc && !this.desc) {
        array.sort((a, b) => this.compare(b, a));
      }
    }
  }
}
