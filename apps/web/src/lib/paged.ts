"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, useApi } from "./api";

/** What the paged endpoints answer: one page of rows, how many there are in all and where the next page starts. */
interface Page<T, C> {
  items: T[];
  total: number;
  next: number | null;
  counts: C;
}

/** A value that follows `value` after it has stopped changing for `ms` (search boxes ask the server once, not per key). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * A list read page by page from the API. New `params` (search, filter) start over from the first page while the
 * old rows stay on screen (`stale`); an answer to an older request never replaces a newer one. `loadMore` is
 * undefined at the end of the list and while a page is on its way. `reload` starts over after a change.
 */
export function usePagedList<T, C>(path: string, params: Record<string, string>) {
  const api = useApi();
  const [version, setVersion] = useState(0);
  const query = new URLSearchParams(params).toString();
  const key = `${query}#${version}`;
  const [page, setPage] = useState<(Page<T, C> & { key: string }) | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(key);

  useEffect(() => {
    latest.current = key;
    api<Page<T, C>>(`${path}?${query}`).then(
      (first) => {
        if (latest.current !== key) return;
        setPage({ ...first, key });
        setError(null);
      },
      (err) => latest.current === key && setError(errorMessage(err)),
    );
  }, [api, path, query, key]);

  const next = page?.next ?? null;
  const loadMore =
    page && page.key === key && next !== null && !loadingMore && !error
      ? async () => {
          setLoadingMore(true);
          try {
            const more = await api<Page<T, C>>(`${path}?${query}&offset=${next}`);
            if (latest.current === key) setPage((all) => (all && all.key === key ? { ...more, items: [...all.items, ...more.items], key } : all));
          } catch (err) {
            if (latest.current === key) setError(errorMessage(err));
          } finally {
            setLoadingMore(false);
          }
        }
      : undefined;

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return {
    items: page?.items ?? null,
    total: page?.total ?? 0,
    counts: page?.counts ?? null,
    /** Rows on screen belong to an earlier search or filter while the new answer is on its way. */
    stale: page !== null && page.key !== key,
    loadingMore,
    loadMore,
    error,
    reload,
  };
}
