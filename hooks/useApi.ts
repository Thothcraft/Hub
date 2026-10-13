import { useAuth } from '@/contexts/AuthContext';
import { useCallback, useRef } from 'react';

export type ApiError = Error & { status?: number };

function tokenIsExpired(token: string | null): boolean {
  if (!token) return true;
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return false;
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const expires = Number(JSON.parse(atob(normalized))?.exp);
    return Number.isFinite(expires) && expires * 1000 <= Date.now();
  } catch {
    return false;
  }
}

function storedToken(): string | null {
  if (typeof window === 'undefined') return null;
  // Session-only logins ("remember this device" off) keep the token in
  // sessionStorage; remembered logins use localStorage.
  return localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

export const useApi = () => {
  const { user } = useAuth();
  const apiBaseUrl = '/api/proxy';
  
  // Use ref to always have access to latest token without causing re-renders
  const tokenRef = useRef(user?.token);
  tokenRef.current = user?.token;

  const getAuthHeaders = useCallback((): Record<string, string> => {
    const token = tokenRef.current || storedToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    
    if (!token) {
      console.warn('[useApi] No authentication token available, request may fail');
      return headers;
    }

    headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }, []);

  const handleResponse = useCallback(async (response: Response) => {
    if (!response.ok) {
      if (response.status === 401) {
        // Polling endpoints can transiently return 401 while the backend is
        // restarting. Only end the browser session when the JWT itself expired.
        const token = storedToken();
        if (tokenIsExpired(token)) {
          localStorage.removeItem('auth_token');
          localStorage.removeItem('user');
          sessionStorage.removeItem('auth_token');
          sessionStorage.removeItem('user');
          window.location.href = '/auth';
        }
        const unauthorized = new Error('Request was unauthorized; your session was retained.') as ApiError;
        unauthorized.status = 401;
        throw unauthorized;
      }

      const errorData = await response.json().catch(() => ({}));
      const requestError = new Error(
        errorData.detail || errorData.error || `HTTP error! Status: ${response.status}`
      ) as ApiError;
      requestError.status = response.status;
      throw requestError;
    }

    return response.json();
  }, []);

  const get = useCallback(async (url: string) => {
    const hasQuery = url.includes('?');
    const cacheBustedUrl = `${url}${hasQuery ? '&' : '?'}_ts=${Date.now()}`;
    const response = await fetchWithTimeout(`${apiBaseUrl}${cacheBustedUrl}`, {
      method: 'GET',
      headers: getAuthHeaders(),
      cache: 'no-store',
    });

    return handleResponse(response);
  }, [apiBaseUrl, getAuthHeaders, handleResponse]);

  const post = useCallback(async (url: string, data: any) => {
    const response = await fetchWithTimeout(`${apiBaseUrl}${url}`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });

    return handleResponse(response);
  }, [apiBaseUrl, getAuthHeaders, handleResponse]);

  const put = useCallback(async (url: string, data: any) => {
    const response = await fetchWithTimeout(`${apiBaseUrl}${url}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });

    return handleResponse(response);
  }, [apiBaseUrl, getAuthHeaders, handleResponse]);

  const del = useCallback(async (url: string) => {
    const response = await fetchWithTimeout(`${apiBaseUrl}${url}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    return handleResponse(response);
  }, [apiBaseUrl, getAuthHeaders, handleResponse]);

  return { get, post, put, delete: del };
};
