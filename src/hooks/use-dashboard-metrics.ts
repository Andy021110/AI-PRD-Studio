import { useCallback, useEffect, useState } from "react";

type DashboardMetrics = {
  totalReviews: number;
  totalInsights: number;
  totalPrds: number;
  avgRlhfScore: number;
  rlhfCount: number;
};

const STORAGE_KEY = "dashboard-metrics-v1";

const DEFAULT_METRICS: DashboardMetrics = {
  totalReviews: 500,
  totalInsights: 12,
  totalPrds: 38,
  avgRlhfScore: 4.8,
  rlhfCount: 1,
};

function isValidMetrics(value: unknown): value is DashboardMetrics {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.totalReviews === "number" &&
    typeof candidate.totalInsights === "number" &&
    typeof candidate.totalPrds === "number" &&
    typeof candidate.avgRlhfScore === "number" &&
    typeof candidate.rlhfCount === "number"
  );
}

export function useDashboardMetrics() {
  const [metrics, setMetrics] = useState<DashboardMetrics>(DEFAULT_METRICS);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isValidMetrics(parsed)) {
          setMetrics(parsed);
        }
      }
    } catch {
      // Keep defaults when localStorage is unavailable or malformed.
    } finally {
      setIsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(metrics));
  }, [isHydrated, metrics]);

  const incrementReviews = useCallback((count: number) => {
    if (count <= 0) {
      return;
    }
    setMetrics((prev) => ({
      ...prev,
      totalReviews: prev.totalReviews + count,
    }));
  }, []);

  const incrementInsights = useCallback((count: number) => {
    if (count <= 0) {
      return;
    }
    setMetrics((prev) => ({
      ...prev,
      totalInsights: prev.totalInsights + count,
    }));
  }, []);

  const incrementPrds = useCallback(() => {
    setMetrics((prev) => ({
      ...prev,
      totalPrds: prev.totalPrds + 1,
    }));
  }, []);

  const submitRlhfScore = useCallback((score: number) => {
    if (score < 1 || score > 5) {
      return;
    }

    setMetrics((prev) => {
      const nextCount = prev.rlhfCount + 1;
      const nextAverage =
        (prev.avgRlhfScore * prev.rlhfCount + score) / nextCount;

      return {
        ...prev,
        avgRlhfScore: Number(nextAverage.toFixed(2)),
        rlhfCount: nextCount,
      };
    });
  }, []);

  return {
    ...metrics,
    incrementReviews,
    incrementInsights,
    incrementPrds,
    submitRlhfScore,
  };
}

