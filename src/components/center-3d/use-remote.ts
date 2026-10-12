"use client";

import { useEffect, useEffectEvent, useState } from "react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type Remote<T> = {
  data: T | null;
  /** Lý do máy chủ từ chối hoặc không tải được; null khi đang có dữ liệu. */
  error: string | null;
  /** Đang tải lần đầu cho `key` hiện tại (làm mới ngầm không tính). */
  loading: boolean;
  retry: () => void;
};

const OFFLINE = "Không tải được dữ liệu. Kiểm tra kết nối rồi thử lại.";

/**
 * Tải dữ liệu chi tiết bằng một Server Action đọc khi `key` khác null; tải lại khi `key` hoặc `version` đổi.
 * Làm mới ngầm giữ dữ liệu cũ trên màn hình. Máy chủ từ chối (hết quyền, không còn tồn tại) thì thay bằng lỗi;
 * rớt mạng lúc làm mới ngầm thì giữ dữ liệu đang có.
 */
export function useRemote<T>(key: string | null, load: () => Promise<Result<T>>, version: number | string = 0): Remote<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const run = useEffectEvent(load);
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    run().then(
      (result) => {
        if (alive) setState(result.ok ? { key, data: result.data, error: null } : { key, data: null, error: result.error });
      },
      () => {
        if (alive) setState((previous) => (previous?.key === key && previous.data !== null ? previous : { key, data: null, error: OFFLINE }));
      },
    );
    return () => {
      alive = false;
    };
  }, [key, version, attempt]);
  const current = key !== null && state?.key === key ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: key !== null && current === null,
    retry: () => {
      setState(null);
      setAttempt((value) => value + 1);
    },
  };
}

/** Giá trị chỉ đổi sau khi `value` đứng yên `delay` mili giây (ô tìm kiếm). */
export function useDebounced(value: string, delay: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
