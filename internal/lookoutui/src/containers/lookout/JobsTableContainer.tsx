import { Fragment, RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  Box,
  Button,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
} from "@mui/material"
import {
  ColumnDef,
  ColumnFiltersState,
  ColumnResizeMode,
  ColumnSizingState,
  ExpandedState,
  ExpandedStateList,
  getCoreRowModel,
  getExpandedRowModel,
  getGroupedRowModel,
  getPaginationRowModel,
  PaginationState,
  Row,
  RowSelectionState,
  SortingState,
  Updater,
  useReactTable,
  VisibilityState,
} from "@tanstack/react-table"
import _ from "lodash"
import { ErrorBoundary } from "react-error-boundary"
import { useLocation, useNavigate, useParams } from "react-router-dom"

import styles from "./JobsTableContainer.module.css"
import { AlertErrorFallback } from "../../components/AlertErrorFallback"
import { JobsTableActionBar } from "../../components/lookout/JobsTableActionBar"
import { HeaderCell } from "../../components/lookout/JobsTableCell"
import { JobsTableRow } from "../../components/lookout/JobsTableRow"
import { Sidebar } from "../../components/lookout/sidebar/Sidebar"
import { useFormatNumberWithUserSettings } from "../../hooks/formatNumberWithUserSettings"
import {
  useFormatIsoTimestampWithUserSettings,
  useDisplayedTimeZoneWithUserSettings,
} from "../../hooks/formatTimeWithUserSettings"
import { useCustomSnackbar } from "../../hooks/useCustomSnackbar"
import { columnIsAggregatable, useFetchJobsTableData } from "../../hooks/useJobsTableData"
import { isJobGroupRow, JobRow, JobTableRow } from "../../models/jobsTableModels"
import { Job, JobFiltersWithExcludes, JobId, Match, SortDirection } from "../../models/lookoutModels"
import { CustomViewsService } from "../../services/lookout/CustomViewsService"
import { IGetJobsService } from "../../services/lookout/GetJobsService"
import { IGroupJobsService } from "../../services/lookout/GroupJobsService"
import { JobsTablePreferences, JobsTablePreferencesService } from "../../services/lookout/JobsTablePreferencesService"
import { UpdateJobsService } from "../../services/lookout/UpdateJobsService"
import { getErrorMessage, waitMillis, CommandSpec } from "../../utils"
import {
  COLUMN_PARSE_TYPES,
  ColumnId,
  createAnnotationColumn,
  getAnnotationKeyCols,
  INPUT_PARSERS,
  GET_JOB_COLUMNS,
  JobTableColumn,
  PINNED_COLUMNS,
  StandardColumnId,
  toAnnotationColId,
  toColId,
  JobColumnsOptions,
} from "../../utils/jobsTableColumns"
import {
  diffOfKeys,
  getFiltersForRowsSelection,
  PendingData,
  pendingDataForAllVisibleData,
  updaterToValue,
} from "../../utils/jobsTableUtils"
import { fromRowId, RowId } from "../../utils/reactTableUtils"
import { EmptyInputError, ParseError } from "../../utils/resourceUtils"

const PAGE_SIZE_OPTIONS = [5, 25, 50, 100]

interface JobsTableContainerProps {
  getJobsService: IGetJobsService
  groupJobsService: IGroupJobsService
  updateJobsService: UpdateJobsService
  debug: boolean
  autoRefreshMs: number | undefined
  commandSpecs: CommandSpec[]
}

export type LookoutColumnFilter = {
  id: string
  value: string | number | string[] | number[]
}

export type LookoutColumnOrder = {
  id: string
  direction: SortDirection
}

function toLookoutOrder(sortingState: SortingState): LookoutColumnOrder {
  if (sortingState.length === 0) {
    return {
      id: StandardColumnId.JobID,
      direction: "DESC",
    }
  }
  return {
    id: sortingState[0].id,
    direction: sortingState[0].desc ? "DESC" : "ASC",
  }
}

function fromLookoutOrder(lookoutOrder: LookoutColumnOrder): SortingState {
  return [
    {
      id: lookoutOrder.id,
      desc: lookoutOrder.direction === "DESC",
    },
  ]
}

export const JobsTableContainer = ({
  getJobsService,
  groupJobsService,
  updateJobsService,
  debug,
  autoRefreshMs,
  commandSpecs,
}: JobsTableContainerProps) => {
  const openSnackbar = useCustomSnackbar()

  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const jobsTablePreferencesService = useMemo(() => new JobsTablePreferencesService({ location, navigate, params }), [])
  const customViewsService = useMemo(() => new CustomViewsService(), [])
  const initialPrefs = useMemo(() => jobsTablePreferencesService.getUserPrefs(), [])

  const formatIsoTimestamp = useFormatIsoTimestampWithUserSettings()
  const displayedTimeZoneName = useDisplayedTimeZoneWithUserSettings()
  const formatNumber = useFormatNumberWithUserSettings()

  const jobColumnsOptions = useMemo<JobColumnsOptions>(
    () => ({ formatIsoTimestamp, displayedTimeZoneName, formatNumber }),
    [formatIsoTimestamp, displayedTimeZoneName, formatNumber],
  )

  // Columns
  const [allColumns, setAllColumns] = useState<JobTableColumn[]>(
    GET_JOB_COLUMNS(jobColumnsOptions).concat(...initialPrefs.annotationColumnKeys.map(createAnnotationColumn)),
  )
  useEffect(() => {
    setAllColumns(
      GET_JOB_COLUMNS(jobColumnsOptions).concat(...initialPrefs.annotationColumnKeys.map(createAnnotationColumn)),
    )
  }, [jobColumnsOptions])

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialPrefs.visibleColumns)
  const visibleColumnIds = useMemo(
    () =>
      Object.keys(columnVisibility)
        .map(toColId)
        .filter((colId) => columnVisibility[colId]),
    [columnVisibility],
  )
  const columnResizeMode = useMemo(() => "onChange" as ColumnResizeMode, [])
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(initialPrefs.columnSizing ?? {})
  const [columnOrder, setColumnOrder] = useState<ColumnId[]>(initialPrefs.columnOrder)

  // Grouping
  const [grouping, setGrouping] = useState<ColumnId[]>(initialPrefs.groupedColumns)

  // Expanding
  const [expanded, setExpanded] = useState<ExpandedStateList>(initialPrefs.expandedState)

  // Selecting
  const [selectedRows, setSelectedRows] = useState<RowSelectionState>({})
  const [lastSelectedRow, setLastSelectedRow] = useState<Row<JobTableRow> | undefined>(undefined)

  // Sidebar
  const [sidebarJobId, setSidebarJobId] = useState<JobId | undefined>(initialPrefs.sidebarJobId)
  const [sidebarWidth, setSidebarWidth] = useState<number>(initialPrefs.sidebarWidth ?? 600)

  // Pagination
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: initialPrefs.pageIndex,
    pageSize: initialPrefs.pageSize,
  })
  const { pageIndex, pageSize } = useMemo(() => pagination, [pagination])

  const [autoRefresh, setAutoRefresh] = useState<boolean>(
    initialPrefs.autoRefresh === undefined ? true : initialPrefs.autoRefresh,
  )

  const onAutoRefreshChange = (autoRefresh: boolean) => {
    setAutoRefresh(autoRefresh)
  }

  // Filtering
  const [columnFilterState, setColumnFilterState] = useState<ColumnFiltersState>(initialPrefs.filters)
  const [lookoutFilters, setLookoutFilters] = useState<LookoutColumnFilter[]>([]) // Parsed later
  const [columnMatches, setColumnMatches] = useState<Record<string, Match>>(initialPrefs.columnMatches)
  const [parseErrors, setParseErrors] = useState<Record<string, string | undefined>>({})
  const [textFieldRefs, setTextFieldRefs] = useState<Record<string, RefObject<HTMLInputElement | undefined>>>({})
  const [activeJobSets, setActiveJobSets] = useState<boolean>(
    initialPrefs.activeJobSets === undefined ? false : initialPrefs.activeJobSets,
  )

  // Sorting
  const [lookoutOrder, setLookoutOrder] = useState<LookoutColumnOrder>(initialPrefs.order)
  const [sorting, setSorting] = useState<SortingState>(fromLookoutOrder(lookoutOrder))

  // Data
  const { data, jobInfoMap, rowsToFetch, setRowsToFetch } = useFetchJobsTableData({
    groupedColumns: grouping,
    visibleColumns: visibleColumnIds,
    expandedState: expanded,
    paginationState: pagination,
    lookoutOrder: lookoutOrder,
    lookoutFilters: lookoutFilters,
    activeJobSets: activeJobSets,
    columnMatches: columnMatches,
    allColumns,
    selectedRows,
    updateSelectedRows: setSelectedRows,
    getJobsService,
    groupJobsService,
    openSnackbar,
  })

  // Custom views (cache)
  const [customViews, setCustomViews] = useState<string[]>(customViewsService.getAllViews())

  // Check if there are grouped columns in initial configuration, and if so enable count column
  useEffect(() => {
    if (grouping.length > 0) {
      setColumnVisibility({
        ...columnVisibility,
        [StandardColumnId.Count]: true,
      })
    }
  }, [])

  // Retrieve data for any expanded rows from intial query param state
  useEffect(() => {
    const rowsToFetch: PendingData[] = [
      { parentRowId: "ROOT", skip: pagination.pageIndex * pagination.pageSize },
      ...Object.keys(initialPrefs.expandedState).map((rowId) => ({ parentRowId: rowId as RowId, skip: 0 })),
    ]
    setRowsToFetch(rowsToFetch)
  }, [initialPrefs])

  // Find the job details for the selected job
  const sidebarJobDetails = useMemo(
    () => (sidebarJobId !== undefined ? jobInfoMap.get(sidebarJobId) : undefined),
    [sidebarJobId, jobInfoMap],
  )

  const prefsFromState = (): JobsTablePreferences => ({
    groupedColumns: grouping,
    expandedState: expanded,
    columnOrder,
    pageIndex,
    pageSize,
    order: lookoutOrder,
    columnSizing: columnSizing,
    filters: columnFilterState,
    columnMatches: columnMatches,
    annotationColumnKeys: getAnnotationKeyCols(allColumns),
    visibleColumns: columnVisibility,
    sidebarJobId: sidebarJobId,
    sidebarWidth: sidebarWidth,
    activeJobSets: activeJobSets,
    autoRefresh: autoRefresh,
  })

  const setTextFields = (filters: ColumnFiltersState) => {
    const filterMap = Object.fromEntries(filters.map((f) => [f.id, f]))
    for (const [id, ref] of Object.entries(textFieldRefs)) {
      let value = ""
      if (id in filterMap) {
        const filter = filterMap[id]
        value = filter.value as string
      }
      if (ref.current) {
        ref.current.value = value
      }
    }
  }

  const setToFirstPage = () => {
    setPagination({
      pageIndex: 0,
      pageSize: pageSize,
    })
  }

  const loadPrefs = (prefs: JobsTablePreferences) => {
    setGrouping(prefs.groupedColumns)
    setExpanded(prefs.expandedState)
    setPagination({
      pageIndex: 0,
      pageSize: prefs.pageSize,
    })
    setLookoutOrder(prefs.order)
    setSorting(fromLookoutOrder(prefs.order))
    setColumnSizing(prefs.columnSizing ?? {})
    setColumnFilterState(prefs.filters)
    setLookoutFilters(parseLookoutFilters(prefs.filters))
    setColumnMatches(prefs.columnMatches)
    const cols = GET_JOB_COLUMNS(jobColumnsOptions).concat(...prefs.annotationColumnKeys.map(createAnnotationColumn))
    setAllColumns(cols)
    setColumnOrder(prefs.columnOrder)
    setColumnVisibility(prefs.visibleColumns)
    setSidebarJobId(prefs.sidebarJobId)
    setSidebarWidth(prefs.sidebarWidth ?? 600)
    setSelectedRows({})
    if (prefs.activeJobSets !== undefined) {
      setActiveJobSets(prefs.activeJobSets)
    }
    if (prefs.autoRefresh !== undefined) {
      onAutoRefreshChange(prefs.autoRefresh)
    }

    // Have to manually set text fields to the filter values since they are uncontrolled
    setTextFields(prefs.filters)

    // Load data
    setRowsToFetch(pendingDataForAllVisibleData(prefs.expandedState, data, prefs.pageSize))
  }

  // Update query params with table state
  useEffect(() => {
    jobsTablePreferencesService.saveNewPrefs(prefsFromState())
  }, [
    columnOrder,
    grouping,
    expanded,
    pageIndex,
    pageSize,
    sorting,
    columnSizing,
    columnFilterState,
    columnMatches,
    allColumns,
    columnVisibility,
    selectedRows,
    sidebarJobId,
    sidebarWidth,
    activeJobSets,
    autoRefresh,
  ])

  const addCustomView = (name: string) => {
    const prefs = prefsFromState()
    customViewsService.saveView(name, prefs)
    setCustomViews(customViewsService.getAllViews())
  }

  const deleteCustomView = (name: string) => {
    customViewsService.deleteView(name)
    setCustomViews(customViewsService.getAllViews())
  }

  const loadCustomView = (name: string) => {
    try {
      const prefs = customViewsService.getView(name)
      setToFirstPage()
      loadPrefs(prefs)
    } catch (e) {
      console.error(getErrorMessage(e))
      openSnackbar("Failed to load custom view", "error")
    }
  }

  const onRefresh = () => {
    setSelectedRows({})
    setRowsToFetch(pendingDataForAllVisibleData(expanded, data, pageSize, pageIndex * pageSize))
  }

  const savedOnRefreshCallback = useRef<() => void>(undefined)

  const [autoRefreshIntervalTimer, setAutoRefreshIntervalTimer] = useState<NodeJS.Timeout | undefined>(undefined)

  useEffect(() => {
    savedOnRefreshCallback.current = onRefresh
  })

  useEffect(() => {
    function clearTimer() {
      if (autoRefreshIntervalTimer) {
        clearInterval(autoRefreshIntervalTimer)
        setAutoRefreshIntervalTimer(undefined)
      }
    }

    if (autoRefreshMs === undefined || !autoRefresh) {
      clearTimer()
      return () => {
        return
      }
    } else {
      const tmr = setInterval(() => {
        if (savedOnRefreshCallback.current) {
          savedOnRefreshCallback.current()
        }
      }, autoRefreshMs)
      setAutoRefreshIntervalTimer(tmr)
      return clearTimer
    }
  }, [autoRefresh, autoRefreshMs])

  const onColumnVisibilityChange = (colIdToToggle: ColumnId) => {
    // Refresh if we make a new aggregate column visible
    let shouldRefresh = false
    if (columnIsAggregatable(colIdToToggle) && grouping.length > 0 && !visibleColumnIds.includes(colIdToToggle)) {
      shouldRefresh = true
    }
    setColumnVisibility({
      ...columnVisibility,
      [colIdToToggle]: !columnVisibility[colIdToToggle],
    })
    if (shouldRefresh) {
      setRowsToFetch(pendingDataForAllVisibleData(expanded, data, pageSize, pageIndex * pageSize))
    }
  }

  const colIsVisible = (column: ColumnId): boolean => {
    return column in columnVisibility && columnVisibility[column]
  }

  const addAnnotationCol = (annotationKey: string) => {
    for (const col of allColumns) {
      if (col.id === toAnnotationColId(annotationKey)) {
        throw new Error(`annotation column "${annotationKey}" already exists`)
      }
    }

    const annotationCol = createAnnotationColumn(annotationKey)
    const annotationColId = toColId(annotationCol.id)
    const newCols = allColumns.concat([annotationCol])
    setColumnOrder((prev) => [...prev, annotationColId])
    setAllColumns(newCols)
    if (!colIsVisible(annotationColId)) {
      onColumnVisibilityChange(annotationColId)
    }
  }

  const removeAnnotationCol = (colId: ColumnId) => {
    const filtered = allColumns.filter((col) => col.id !== colId)
    if (filtered.length === allColumns.length) {
      throw new Error(`column "${colId}" was not removed`)
    }
    setColumnOrder((prev) => prev.filter((prevId) => prevId !== colId))
    setAllColumns(filtered)
    onFilterChange((columnFilters) => {
      return columnFilters.filter((columnFilter) => columnFilter.id !== colId)
    })
  }

  const editAnnotationCol = (colId: ColumnId, annotationKey: string) => {
    let index = -1
    for (let i = 0; i < allColumns.length; i++) {
      if (allColumns[i].id === colId) {
        index = i
      }
    }
    if (index === -1) {
      throw new Error(`column "${colId}" not found`)
    }

    const oldColId = toColId(allColumns[index].id)

    // Make old column not visible
    if (colIsVisible(oldColId)) {
      onColumnVisibilityChange(oldColId)
    }

    allColumns[index] = createAnnotationColumn(annotationKey)
    const newColId = toColId(allColumns[index].id)

    // Make new column visible
    setAllColumns([...allColumns])
    if (!colIsVisible(toColId(newColId))) {
      onColumnVisibilityChange(toColId(newColId))
    }

    // Change column ID in ordering
    setColumnOrder((prev) => prev.map((prevId) => (prevId === oldColId ? newColId : prevId)))
  }

  const onGroupingChange = useCallback(
    (newGroups: ColumnId[]) => {
      setToFirstPage()
      // Reset currently expanded/selected when grouping changes
      setSelectedRows({})
      setSidebarJobId(undefined)
      setExpanded({})

      const baseColumnVisibility = {
        ...columnVisibility,
        [StandardColumnId.Count]: false,
      }
      if (newGroups.length > 0) {
        baseColumnVisibility[StandardColumnId.Count] = true
      }
      // Check all grouping columns are displayed
      setColumnVisibility(newGroups.reduce((a, s) => ({ ...a, [s]: true }), baseColumnVisibility))

      setGrouping([...newGroups])

      // Refetch the root data
      setRowsToFetch([{ parentRowId: "ROOT", skip: 0 }])
    },
    [allColumns, columnVisibility],
  )

  const onRootPaginationChange = useCallback(
    (updater: Updater<PaginationState>) => {
      const newPagination = updaterToValue(updater, pagination)
      // Reset currently expanded/selected when grouping changes
      // TODO: Consider allowing rows to be selected across pages?
      setSelectedRows({})
      setSidebarJobId(undefined)
      setExpanded({})
      setPagination(newPagination)

      // Refetch the root data
      setRowsToFetch([{ parentRowId: "ROOT", skip: newPagination.pageIndex * pageSize }])
    },
    [pagination, pageSize],
  )

  const onLoadMoreSubRows = useCallback((rowId: RowId, skip: number) => {
    setRowsToFetch([{ parentRowId: rowId, skip, append: true }])
  }, [])

  const onExpandedChange = useCallback(
    (updater: Updater<ExpandedState>) => {
      const newExpandedOrBool = updaterToValue(updater, expanded)
      const newExpandedState =
        typeof newExpandedOrBool === "boolean"
          ? _.fromPairs(table.getRowModel().flatRows.map((r) => [r.id, true]))
          : newExpandedOrBool
      const [newlyExpanded] = diffOfKeys<RowId>(newExpandedState, expanded)
      setExpanded(newExpandedState)

      // Fetch subrows for expanded rows
      setRowsToFetch(newlyExpanded.map((rowId) => ({ parentRowId: rowId, skip: 0 })))
    },
    [expanded],
  )

  const onSelectedRowChange = (updater: Updater<RowSelectionState>) => {
    const newSelectedRows = updaterToValue(updater, selectedRows)
    setSelectedRows(newSelectedRows)
  }

  const setParseError = (colId: string, error: string | undefined) => {
    setParseErrors((old) => {
      const newParseErrors = { ...old }
      newParseErrors[colId] = error
      return newParseErrors
    })
  }

  const parseLookoutFilters = (state: ColumnFiltersState): LookoutColumnFilter[] => {
    const lookoutFilters: LookoutColumnFilter[] = []
    for (const columnFilter of state) {
      if (!(columnFilter.id in COLUMN_PARSE_TYPES)) {
        lookoutFilters.push({
          id: columnFilter.id,
          value: columnFilter.value as string | string[] | number | number[],
        })
        continue
      }
      const parseType = COLUMN_PARSE_TYPES[columnFilter.id]
      const parser = INPUT_PARSERS[parseType]
      const raw = columnFilter.value as string
      try {
        const value = parser(raw.trim())
        setParseError(columnFilter.id, undefined)
        lookoutFilters.push({
          id: columnFilter.id,
          value: value,
        })
      } catch (e) {
        if (e instanceof EmptyInputError) {
          setParseError(columnFilter.id, undefined)
        } else if (e instanceof ParseError) {
          setParseError(columnFilter.id, e.message)
        }
      }
    }
    return lookoutFilters
  }

  useEffect(() => {
    setLookoutFilters(parseLookoutFilters(columnFilterState))
  }, [])

  const setTextFieldRef = (columnId: string, ref: RefObject<HTMLInputElement | undefined>) => {
    setTextFieldRefs((old) => {
      const newState = { ...old }
      newState[columnId] = ref
      return newState
    })
  }

  const onFilterChange = (updater: Updater<ColumnFiltersState>) => {
    const newFilterState = updaterToValue(updater, columnFilterState)

    if (_.isEqual(newFilterState, columnFilterState)) {
      return
    }

    setToFirstPage()
    setLookoutFilters(parseLookoutFilters(newFilterState))
    setColumnFilterState(newFilterState)
    setSelectedRows({})
    setSidebarJobId(undefined)
    setRowsToFetch(pendingDataForAllVisibleData(expanded, data, pageSize))
  }

  const onColumnMatchChange = (columnId: string, newMatch: Match) => {
    const newColumnMatches: Record<string, Match> = {
      ...columnMatches,
      [columnId]: newMatch,
    }
    setColumnMatches(newColumnMatches)
    onFilterChange([...columnFilterState])
    setRowsToFetch(pendingDataForAllVisibleData(expanded, data, pageSize))
  }

  const onSortingChange = (updater: Updater<SortingState>) => {
    setToFirstPage()
    const newSortingState = updaterToValue(updater, sorting)
    setLookoutOrder(toLookoutOrder(newSortingState))
    setSorting(newSortingState)
    // Refetch any expanded subgroups, and root data with updated sorting params
    setRowsToFetch(pendingDataForAllVisibleData(expanded, data, pageSize))
  }

  const onColumnSizingChange = useCallback(
    (updater: Updater<ColumnSizingState>) => {
      const newColumnSizing = updaterToValue(updater, columnSizing)
      setColumnSizing(newColumnSizing)
    },
    [columnSizing],
  )

  const toggleSidebarForJobRow = (jobRow: JobRow) => {
    const clickedJob = jobRow as Job
    const jobId = clickedJob.jobId
    // Deselect if clicking on a job row that's already shown in the sidebar
    setSidebarJobId(jobId === sidebarJobId ? undefined : jobId)
  }
  const sideBarClose = () => setSidebarJobId(undefined)

  const selectedItemsFilters: JobFiltersWithExcludes[] = useMemo(
    () => getFiltersForRowsSelection(data, selectedRows, lookoutFilters, columnMatches),
    [data, selectedRows, columnFilterState, lookoutFilters, allColumns],
  )

  const table = useReactTable({
    data: data ?? [],
    columns: allColumns,
    state: {
      grouping,
      expanded,
      pagination,
      columnFilters: columnFilterState,
      rowSelection: selectedRows,
      columnPinning: {
        left: PINNED_COLUMNS,
      },
      columnVisibility,
      sorting,
      columnOrder,
      columnSizing,
    },
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.rowId,
    getSubRows: (row) => (isJobGroupRow(row) && row.subRows) || undefined,
    columnResizeMode: columnResizeMode,

    // Selection
    enableRowSelection: true,
    enableMultiRowSelection: true,
    enableSubRowSelection: true,
    onRowSelectionChange: onSelectedRowChange,

    // Grouping
    manualGrouping: true,
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    onExpandedChange: onExpandedChange,
    autoResetExpanded: false,
    manualExpanding: false,

    // Pagination
    manualPagination: true,
    paginateExpandedRows: true,
    onPaginationChange: onRootPaginationChange,
    getPaginationRowModel: getPaginationRowModel(),

    // Filtering
    onColumnFiltersChange: onFilterChange,
    manualFiltering: true,

    // Sorting
    onSortingChange: onSortingChange,

    // Column resizing
    onColumnSizingChange: onColumnSizingChange,
  })

  const clearFilters = () => {
    table.resetColumnFilters(true)
    for (const [, ref] of Object.entries(textFieldRefs)) {
      if (ref.current) {
        ref.current.value = ""
      }
    }
    onFilterChange([])
    setParseErrors({})
  }

  const clearGroups = () => {
    // Set grouping to an empty array to clear all groups
    onGroupingChange([])

    // Reset expanded states as no groups will exist
    setExpanded({})

    // Clear any related UI states if necessary
    // For example, resetting selection
    setSelectedRows({})
  }

  const shiftSelectRow = (row: Row<JobTableRow>) => {
    if (lastSelectedRow === undefined || row.depth !== lastSelectedRow.depth) {
      return
    }

    const rowIndex = table.getRowModel().rows.indexOf(row)
    const lastSelectedRowIndex = table.getRowModel().rows.indexOf(lastSelectedRow)

    const selectedValue = lastSelectedRow.getIsSelected()
    const rowSelectionMask: RowSelectionState = table
      .getRowModel()
      .rows.slice(Math.min(rowIndex, lastSelectedRowIndex), Math.max(rowIndex, lastSelectedRowIndex) + 1)
      .reduce<RowSelectionState>((acc, { id, depth }) => {
        if (depth === row.depth) {
          acc[id] = selectedValue
        }
        return acc
      }, {})

    table.setRowSelection((prev) => ({ ...prev, ...rowSelectionMask }))
  }

  const selectRow = async (row: Row<JobTableRow>, singleSelect: boolean) => {
    setLastSelectedRow(row)
    const isSelected = row.getIsSelected()
    if (singleSelect) {
      table.toggleAllRowsSelected(false)
      await waitMillis(1)
    }
    row.toggleSelected(!isSelected)
  }

  const topLevelRows = table.getRowModel().rows.filter((row) => row.depth === 0)
  let columnsForSelect = allColumns
  if (grouping.length === 0) {
    columnsForSelect = columnsForSelect.filter((col) => col.id !== StandardColumnId.Count)
  }
  const columnStyle = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: "100%",
    flex: 1,
  }

  const filterColumns = useMemo(() => columnFilterState.map(({ id }) => toColId(id)), [columnFilterState])
  const sortColumns = useMemo(() => [toColId(lookoutOrder.id)], [lookoutOrder])

  return (
    <Box sx={{ display: "flex", flexDirection: "row", height: "100%", width: "100%" }}>
      <Box sx={{ ...columnStyle, marginX: "0.5em", minWidth: 0 }}>
        <Box sx={{ ...columnStyle, marginY: "0.5em", minHeight: 0 }}>
          <ErrorBoundary FallbackComponent={AlertErrorFallback}>
            <JobsTableActionBar
              isLoading={rowsToFetch.length > 0}
              allColumns={columnsForSelect}
              groupedColumns={grouping}
              filterColumns={filterColumns}
              sortColumns={sortColumns}
              visibleColumns={visibleColumnIds}
              columnOrder={columnOrder}
              setColumnOrder={setColumnOrder}
              selectedItemFilters={selectedItemsFilters}
              customViews={customViews}
              activeJobSets={activeJobSets}
              onActiveJobSetsChanged={(newVal) => {
                setActiveJobSets(newVal)
                setToFirstPage()
                setSelectedRows({})
                setRowsToFetch(pendingDataForAllVisibleData(expanded, data, pageSize))
              }}
              onRefresh={onRefresh}
              autoRefresh={autoRefresh}
              onAutoRefreshChange={autoRefreshMs === undefined ? undefined : onAutoRefreshChange}
              onAddAnnotationColumn={addAnnotationCol}
              onRemoveAnnotationColumn={removeAnnotationCol}
              onEditAnnotationColumn={editAnnotationCol}
              onGroupsChanged={onGroupingChange}
              toggleColumnVisibility={onColumnVisibilityChange}
              getJobsService={getJobsService}
              updateJobsService={updateJobsService}
              onClearFilters={clearFilters}
              onClearGroups={clearGroups}
              onAddCustomView={addCustomView}
              onDeleteCustomView={deleteCustomView}
              onLoadCustomView={loadCustomView}
            />
          </ErrorBoundary>
          <ErrorBoundary FallbackComponent={AlertErrorFallback}>
            <TableContainer component={Paper} style={{ height: "100%" }}>
              <Table
                stickyHeader
                sx={{ tableLayout: "fixed" }}
                aria-label="Jobs table"
                style={{
                  width: table.getCenterTotalSize(),
                  borderLeft: "1px solid #cccccc",
                  maxHeight: "100%",
                }}
              >
                <TableHead>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <HeaderCell
                          header={header}
                          key={header.id}
                          parseError={header.id in parseErrors ? parseErrors[header.id] : undefined}
                          columnResizeMode={columnResizeMode}
                          deltaOffset={table.getState().columnSizingInfo.deltaOffset ?? 0}
                          columnMatches={columnMatches}
                          onColumnMatchChange={onColumnMatchChange}
                          onSetTextFieldRef={(ref) => {
                            setTextFieldRef(header.id, ref)
                          }}
                          groupedColumns={grouping}
                        />
                      ))}
                    </TableRow>
                  ))}
                </TableHead>

                <JobsTableBody
                  dataIsLoading={rowsToFetch.length > 0}
                  columns={table.getVisibleLeafColumns()}
                  topLevelRows={topLevelRows}
                  sidebarJobId={sidebarJobId}
                  onLoadMoreSubRows={onLoadMoreSubRows}
                  onClickRowCheckbox={(row) => selectRow(row, false)}
                  onClickJobRow={toggleSidebarForJobRow}
                  onClickRow={(row) => selectRow(row, true)}
                  onShiftClickRow={shiftSelectRow}
                  onControlClickRow={(row) => selectRow(row, false)}
                  onColumnMatchChange={onColumnMatchChange}
                />
              </Table>
            </TableContainer>
            <TablePagination
              component="div"
              rowsPerPageOptions={PAGE_SIZE_OPTIONS}
              // If the total number rows in the database for the current filter
              // is exactly equal to `pageSize`, then this is going to produce a
              // misleading description (e.g., "1-50 of more than 50", even though
              // there are exactly 50 rows).
              count={data.length < pageSize ? pageIndex * pageSize + data.length : -1}
              rowsPerPage={pageSize}
              page={pageIndex}
              onPageChange={(_, page) => table.setPageIndex(page)}
              onRowsPerPageChange={(e) => table.setPageSize(Number(e.target.value))}
              colSpan={table.getVisibleLeafColumns().length}
              showFirstButton={true}
              showLastButton={true}
            />
            {debug && <pre>{JSON.stringify(table.getState(), null, 2)}</pre>}
          </ErrorBoundary>
        </Box>
      </Box>

      {sidebarJobDetails !== undefined && (
        <ErrorBoundary FallbackComponent={AlertErrorFallback}>
          <Sidebar
            job={sidebarJobDetails}
            sidebarWidth={sidebarWidth}
            onClose={sideBarClose}
            onWidthChange={setSidebarWidth}
            commandSpecs={commandSpecs}
          />
        </ErrorBoundary>
      )}
    </Box>
  )
}

interface JobsTableBodyProps {
  dataIsLoading: boolean
  columns: ColumnDef<JobTableRow>[]
  topLevelRows: Row<JobTableRow>[]
  sidebarJobId: JobId | undefined
  onLoadMoreSubRows: (rowId: RowId, skip: number) => void
  onClickRowCheckbox: (row: Row<JobTableRow>) => void
  // Always called if row is a Job row
  onClickJobRow: (jobRow: JobRow) => void
  // Mutually exclusively called depending on key being pressed
  onClickRow: (row: Row<JobTableRow>) => void
  onControlClickRow: (row: Row<JobTableRow>) => void
  onShiftClickRow: (row: Row<JobTableRow>) => void
  onColumnMatchChange: (columnId: string, newMatch: Match) => void
}

const JobsTableBody = ({
  dataIsLoading,
  columns,
  topLevelRows,
  sidebarJobId,
  onLoadMoreSubRows,
  onClickRowCheckbox,
  onClickJobRow,
  onClickRow,
  onControlClickRow,
  onShiftClickRow,
  onColumnMatchChange,
}: JobsTableBodyProps) => {
  const canDisplay = !dataIsLoading && topLevelRows.length > 0
  return (
    <TableBody style={{ overflow: "auto", height: "100%" }}>
      {!canDisplay && (
        <TableRow>
          {dataIsLoading && topLevelRows.length === 0 && (
            <TableCell colSpan={columns.length}>
              <CircularProgress />
            </TableCell>
          )}
          {!dataIsLoading && topLevelRows.length === 0 && (
            <TableCell colSpan={columns.length}>There is no data to display</TableCell>
          )}
        </TableRow>
      )}
      {topLevelRows.map((row) =>
        recursiveRowRender(
          row,
          sidebarJobId,
          onLoadMoreSubRows,
          onClickRowCheckbox,
          onClickJobRow,
          onClickRow,
          onControlClickRow,
          onShiftClickRow,
          onColumnMatchChange,
          dataIsLoading,
        ),
      )}
    </TableBody>
  )
}

const recursiveRowRender = (
  row: Row<JobTableRow>,
  sidebarJobId: JobId | undefined,
  onLoadMoreSubRows: (rowId: RowId, skip: number) => void,
  onClickRowCheckbox: (row: Row<JobTableRow>) => void,
  onClickJobRow: (jobRow: JobRow) => void,
  onClickRow: (row: Row<JobTableRow>) => void,
  onControlClickRow: (row: Row<JobTableRow>) => void,
  onShiftClickRow: (row: Row<JobTableRow>) => void,
  onColumnMatchChange: (columnId: string, newMatch: Match) => void,
  dataIsLoading: boolean,
) => {
  const original = row.original
  const rowIsGroup = isJobGroupRow(original)

  const depthGaugeLevelThicknessPixels = 6
  const isOpenInSidebar = sidebarJobId !== undefined && original.jobId === sidebarJobId

  return (
    <Fragment key={`${row.id}_d${row.depth}`}>
      {/* Render the current row */}
      <JobsTableRow
        row={row}
        isOpenInSidebar={isOpenInSidebar}
        onClick={(e) => {
          if (!rowIsGroup) {
            onClickJobRow(original)
          }
          if (e.shiftKey) {
            onShiftClickRow(row)
          } else if (e.ctrlKey || e.altKey) {
            onControlClickRow(row)
          } else {
            onClickRow(row)
          }
        }}
        onClickRowCheckbox={onClickRowCheckbox}
        onColumnMatchChange={onColumnMatchChange}
      />

      {/* Render any sub rows if expanded */}
      {rowIsGroup &&
        row.getIsExpanded() &&
        row.subRows.map((row) =>
          recursiveRowRender(
            row,
            sidebarJobId,
            onLoadMoreSubRows,
            onClickRowCheckbox,
            onClickJobRow,
            onClickRow,
            onControlClickRow,
            onShiftClickRow,
            onColumnMatchChange,
            dataIsLoading,
          ),
        )}

      {/* Render pagination tools for this expanded row */}
      {rowIsGroup &&
        row.getIsExpanded() &&
        (original.jobCount ?? 0) > original.subRows.length &&
        original.subRows.length > 0 && (
          <TableRow
            className={[styles.rowDepthIndicator, styles.loadMoreRow].join(" ")}
            sx={{ backgroundSize: (row.depth + 1) * depthGaugeLevelThicknessPixels }}
          >
            <TableCell colSpan={row.getVisibleCells().length} align="center" size="small">
              <Button
                size="small"
                variant="text"
                onClick={() => onLoadMoreSubRows(row.id as RowId, original.subRows.length)}
                disabled={dataIsLoading}
                fullWidth
              >
                Load more for{" "}
                {fromRowId(row.id as RowId)
                  .rowIdPartsPath.map(({ type, value }) => `${type}: ${value}`)
                  .join(" > ")}
              </Button>
            </TableCell>
          </TableRow>
        )}
    </Fragment>
  )
}
