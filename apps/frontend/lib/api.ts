// Typed client for apps/api. One place that attaches credentials, so no
// component can forget to (or attach them to the wrong host).

export interface Citation {
  n: number;
  documentId: string;
  fileName: string;
  ordinals: number[];
  distance: number;
  excerpt: string;
}

export interface RagAnswer {
  answer: string;
  grounded: boolean;
  citations: Citation[];
  model: string | null;
}

export interface AgentReply {
  answer: string;
  toolCalls: { name: string; status: string; durationMs: number }[];
  iterations: number;
  stopReason: string;
}

export interface DocumentSummary {
  id: string;
  fileName: string;
  status: "pending" | "chunked" | "embedded" | "failed" | "duplicate";
  failureReason: string | null;
  chunks: number;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly traceId?: string,
  ) {
    super(message);
  }
}

export type AuthHeaders = () => Promise<Record<string, string>>;

export function createApi(baseUrl: string, authHeaders: AuthHeaders) {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(await authHeaders()),
      },
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string; traceId?: string };
    if (!response.ok) {
      throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`, body.traceId);
    }
    return body as T;
  }

  return {
    listDocuments: () => call<{ documents: DocumentSummary[] }>("/documents"),
    query: (question: string) =>
      call<RagAnswer>("/query", { method: "POST", body: JSON.stringify({ question }) }),
    agent: (message: string) =>
      call<AgentReply>("/agent", { method: "POST", body: JSON.stringify({ message }) }),
    async upload(file: File): Promise<string> {
      const target = await call<{ url: string; key: string; headers: Record<string, string> }>(
        "/documents/upload-url",
        { method: "POST", body: JSON.stringify({ fileName: file.name, size: file.size }) },
      );
      // Straight to S3 with the presigned URL: the bytes never pass through
      // the api pods, and the URL only permits this exact key, size and type.
      const put = await fetch(target.url, { method: "PUT", headers: target.headers, body: file });
      if (!put.ok) throw new ApiError(put.status, `upload to storage failed: HTTP ${put.status}`);
      return target.key;
    },
  };
}

export type Api = ReturnType<typeof createApi>;
