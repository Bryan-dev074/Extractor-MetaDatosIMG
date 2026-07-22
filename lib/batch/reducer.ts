import type { CleanResult } from "../types";
import type { InputImage } from "./types";

export type BatchItemStatus =
  | "queued"
  | "processing"
  | "completed"
  | "error"
  | "cancelled";

export interface BatchItem extends InputImage {
  status: BatchItemStatus;
  progress: number;
  result?: CleanResult;
  error?: string;
}

export interface BatchState {
  generation: number;
  order: string[];
  itemsById: Record<string, BatchItem>;
}

export interface BatchSummary {
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  originalBytes: number;
  cleanedBytes: number;
  removedBytes: number;
}

export type BatchAction =
  | { type: "batch/started"; generation: number; items: InputImage[] }
  | { type: "batch/added"; generation: number; items: InputImage[] }
  | { type: "batch/cancelled"; generation: number }
  | { type: "batch/reset"; generation: number }
  | { type: "item/started"; generation: number; id: string }
  | { type: "item/progress"; generation: number; id: string; progress: number }
  | { type: "item/completed"; generation: number; id: string; result: CleanResult }
  | { type: "item/failed"; generation: number; id: string; error: string }
  | { type: "item/cancelled"; generation: number; id: string }
  | { type: "item/retried"; generation: number; id: string }
  | { type: "item/removed"; generation: number; id: string };

export const initialBatchState: BatchState = {
  generation: 0,
  order: [],
  itemsById: {},
};

function queuedItem(input: InputImage): BatchItem {
  return { ...input, status: "queued", progress: 0 };
}

function stateFromItems(generation: number, items: InputImage[]): BatchState {
  const order: string[] = [];
  const itemsById: Record<string, BatchItem> = {};
  for (const input of items) {
    if (Object.hasOwn(itemsById, input.id)) continue;
    order.push(input.id);
    itemsById[input.id] = queuedItem(input);
  }
  return { generation, order, itemsById };
}

function replaceItem(
  state: BatchState,
  id: string,
  update: (item: BatchItem) => BatchItem,
): BatchState {
  return {
    ...state,
    itemsById: {
      ...state.itemsById,
      [id]: update(state.itemsById[id]),
    },
  };
}

function isLive(status: BatchItemStatus): boolean {
  return status === "queued" || status === "processing";
}

export function batchReducer(state: BatchState, action: BatchAction): BatchState {
  if (action.type === "batch/started") {
    if (action.generation <= state.generation) return state;
    return stateFromItems(action.generation, action.items);
  }

  if (action.type === "batch/reset") {
    if (action.generation <= state.generation) return state;
    return { generation: action.generation, order: [], itemsById: {} };
  }

  if (action.type === "batch/cancelled") {
    if (action.generation < state.generation) return state;
    let changed = action.generation !== state.generation;
    const itemsById = { ...state.itemsById };
    for (const id of state.order) {
      const item = itemsById[id];
      if (!item || !isLive(item.status)) continue;
      changed = true;
      itemsById[id] = { ...item, status: "cancelled", progress: item.progress };
    }
    return changed ? { ...state, generation: action.generation, itemsById } : state;
  }

  if (action.type === "batch/added") {
    if (action.generation !== state.generation) return state;
    const order = [...state.order];
    const itemsById = { ...state.itemsById };
    let changed = false;
    for (const input of action.items) {
      if (Object.hasOwn(itemsById, input.id)) continue;
      changed = true;
      order.push(input.id);
      itemsById[input.id] = queuedItem(input);
    }
    return changed ? { ...state, order, itemsById } : state;
  }

  if (action.generation !== state.generation) return state;
  const item = state.itemsById[action.id];
  if (!item) return state;

  switch (action.type) {
    case "item/started":
      if (item.status !== "queued") return state;
      return replaceItem(state, action.id, (current) => ({
        ...current,
        status: "processing",
        progress: 0,
      }));

    case "item/progress":
      if (item.status !== "processing") return state;
      return replaceItem(state, action.id, (current) => ({
        ...current,
        progress: Math.min(1, Math.max(0, action.progress)),
      }));

    case "item/completed":
      if (item.status !== "processing") return state;
      return replaceItem(state, action.id, (current) => ({
        ...current,
        status: "completed",
        progress: 1,
        result: action.result,
        error: undefined,
      }));

    case "item/failed":
      if (item.status !== "processing") return state;
      return replaceItem(state, action.id, (current) => ({
        ...current,
        status: "error",
        error: action.error,
      }));

    case "item/cancelled":
      if (!isLive(item.status)) return state;
      return replaceItem(state, action.id, (current) => ({
        ...current,
        status: "cancelled",
      }));

    case "item/retried":
      if (item.status !== "error" && item.status !== "cancelled") return state;
      return replaceItem(state, action.id, (current) => ({
        ...current,
        status: "queued",
        progress: 0,
        result: undefined,
        error: undefined,
      }));

    case "item/removed": {
      const { [action.id]: _removed, ...itemsById } = state.itemsById;
      return {
        ...state,
        order: state.order.filter((id) => id !== action.id),
        itemsById,
      };
    }
  }
}

export function summarizeBatch(state: BatchState): BatchSummary {
  const summary: BatchSummary = {
    total: 0,
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    originalBytes: 0,
    cleanedBytes: 0,
    removedBytes: 0,
  };

  for (const id of state.order) {
    const item = state.itemsById[id];
    if (!item) continue;
    summary.total += 1;
    if (item.status === "queued") summary.queued += 1;
    else if (item.status === "processing") summary.processing += 1;
    else if (item.status === "error") summary.failed += 1;
    else if (item.status === "cancelled") summary.cancelled += 1;
    else {
      summary.completed += 1;
      summary.originalBytes += item.result?.originalSize ?? 0;
      summary.cleanedBytes += item.result?.cleanedSize ?? 0;
      summary.removedBytes += Math.max(
        0,
        (item.result?.originalSize ?? 0) - (item.result?.cleanedSize ?? 0),
      );
    }
  }

  return summary;
}
