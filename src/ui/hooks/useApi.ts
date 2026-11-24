import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Run an async API call with loading/error state.
 * `factory` may return null to skip the call (e.g. no selection).
 * `deps` re-runs the call whenever they change; `reload()` forces one.
 */
export function useApi<T>(factory: () => Promise<T> | null, deps: unknown[]): ApiState<T> {
  const factoryRef = useRef(factory);
  factoryRef.current = factory;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const promise = factoryRef.current();
    if (promise === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setError(null);
    promise
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        setLoading(false);
        setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload };
}
