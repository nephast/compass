"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  createApi,
  type AgentReply,
  type Api,
  type DocumentSummary,
  type RagAnswer,
} from "../lib/api";
import { isDev, loadConfig, type AppConfig } from "../lib/config";
import {
  beginSignIn,
  completeSignIn,
  emailFromIdToken,
  refresh,
  signOutUrl,
  storedTokens,
  type AuthEndpoints,
  type Tokens,
} from "../lib/pkce";

type Turn =
  | { kind: "rag"; question: string; answer: RagAnswer }
  | { kind: "agent"; question: string; answer: AgentReply }
  | { kind: "error"; question: string; message: string };

const DEV_USER_KEY = "compass.devUser";

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.traceId ? `${error.message} (trace ${error.traceId})` : error.message;
  }
  return (error as Error).message;
}

export default function Home() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [devUser, setDevUser] = useState<string>("");
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig()
      .then(async (loaded) => {
        setConfig(loaded);
        if (isDev(loaded)) {
          setDevUser(sessionStorage.getItem(DEV_USER_KEY) ?? "");
          return;
        }
        const endpoints = endpointsFor(loaded);
        const params = new URLSearchParams(window.location.search);
        if (params.has("code")) {
          const fresh = await completeSignIn(endpoints, params, sessionStorage);
          window.history.replaceState(null, "", "/");
          setTokens(fresh);
        } else {
          setTokens(storedTokens(sessionStorage));
        }
      })
      .catch((error: unknown) => setBootError(describeError(error)));
  }, []);

  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;

  const api = useMemo<Api | null>(() => {
    if (!config) return null;
    return createApi(config.apiUrl, async () => {
      if (isDev(config)) return { "x-dev-user": sessionStorage.getItem(DEV_USER_KEY) ?? "" };
      let current = tokensRef.current;
      // Refresh a minute early, so a request never leaves with a token that
      // expires in flight.
      if (current && current.expiresAt - Date.now() < 60_000) {
        current = await refresh(endpointsFor(config), current, sessionStorage);
        setTokens(current);
      }
      return current ? { authorization: `Bearer ${current.accessToken}` } : {};
    });
  }, [config]);

  if (bootError)
    return (
      <main className="shell center">
        <p className="error">{bootError}</p>
      </main>
    );
  if (!config || !api)
    return (
      <main className="shell center">
        <p className="muted">Loading…</p>
      </main>
    );

  const signedIn = isDev(config) ? devUser !== "" : tokens !== null;

  if (!signedIn) {
    return (
      <main className="shell center">
        <h1>Compass</h1>
        <p className="muted">Ask your documents. Ask your infrastructure.</p>
        {isDev(config) ? (
          <DevSignIn
            onSignIn={(name) => {
              sessionStorage.setItem(DEV_USER_KEY, name);
              setDevUser(name);
            }}
          />
        ) : (
          <button
            onClick={async () => {
              window.location.assign(await beginSignIn(endpointsFor(config), sessionStorage));
            }}
          >
            Sign in
          </button>
        )}
      </main>
    );
  }

  const who = isDev(config)
    ? `${devUser} (local)`
    : (emailFromIdToken(tokens?.idToken ?? "") ?? "signed in");
  const signOut = () => {
    if (isDev(config)) {
      sessionStorage.removeItem(DEV_USER_KEY);
      setDevUser("");
    } else {
      window.location.assign(signOutUrl(endpointsFor(config), sessionStorage));
    }
  };

  return (
    <main className="shell">
      <header className="top">
        <h1>Compass</h1>
        <div className="who">
          <span>{who}</span>
          <button className="ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <div className="grid">
        <Documents api={api} />
        <Chat api={api} />
      </div>
    </main>
  );
}

function endpointsFor(config: AppConfig): AuthEndpoints {
  if (isDev(config)) throw new Error("no auth endpoints in dev mode");
  return {
    authDomain: config.authDomain,
    clientId: config.clientId,
    redirectUri: `${window.location.origin}/`,
  };
}

function DevSignIn({ onSignIn }: { onSignIn: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (/^[A-Za-z0-9-]+$/.test(name)) onSignIn(name);
      }}
      style={{ display: "grid", gap: 8, width: 280 }}
    >
      <input
        type="text"
        placeholder="local user name (letters, digits, -)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit">Continue (local dev auth)</button>
    </form>
  );
}

function Documents({ api }: { api: Api }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setDocuments((await api.listDocuments()).documents);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Poll while anything is still being ingested; stop when everything settles.
  useEffect(() => {
    if (!documents.some((d) => d.status === "pending" || d.status === "chunked")) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [documents, reload]);

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) await api.upload(file);
      // Ingestion is asynchronous (S3 -> EventBridge -> Step Functions); the
      // row appears once the Lambda starts. Poll briefly for it.
      for (let i = 0; i < 10; i += 1) {
        await new Promise((r) => setTimeout(r, 1500));
        const { documents: next } = await api.listDocuments();
        setDocuments(next);
        if (next.length > documents.length) break;
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <section className="panel" aria-label="Documents">
      <h2>Your documents</h2>
      <input
        ref={input}
        type="file"
        accept=".txt,.md,.markdown,text/plain,text/markdown"
        multiple
        onChange={(e) => void onUpload(e.target.files)}
        disabled={busy}
        aria-label="Upload .txt or .md files"
      />
      <p className="muted">.txt and .md, up to 5 MB. Only you can search what you upload.</p>
      {error && <p className="error">{error}</p>}
      <ul className="docs">
        {documents.length === 0 && (
          <li className="muted">Nothing yet — upload a runbook or notes.</li>
        )}
        {documents.map((doc) => (
          <li key={doc.id}>
            <span className="name">{doc.fileName}</span>
            <span className={`status ${doc.status}`}>
              {doc.status === "embedded" && `ready · ${doc.chunks} chunks`}
              {(doc.status === "pending" || doc.status === "chunked") && "processing…"}
              {doc.status === "duplicate" && "duplicate of an earlier upload"}
              {doc.status === "failed" && `failed: ${doc.failureReason ?? "unknown"}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Chat({ api }: { api: Api }) {
  const [mode, setMode] = useState<"rag" | "agent">("rag");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    try {
      const turn: Turn =
        mode === "rag"
          ? { kind: "rag", question: q, answer: await api.query(q) }
          : { kind: "agent", question: q, answer: await api.agent(q) };
      setTurns((t) => [turn, ...t]);
      setQuestion("");
    } catch (e) {
      setTurns((t) => [{ kind: "error", question: q, message: describeError(e) }, ...t]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="Ask">
      <div className="modes" role="group" aria-label="Mode">
        <button aria-pressed={mode === "rag"} onClick={() => setMode("rag")}>
          Ask my documents
        </button>
        <button aria-pressed={mode === "agent"} onClick={() => setMode("agent")}>
          Ask about ops
        </button>
      </div>
      <form onSubmit={(e) => void onSubmit(e)} style={{ display: "grid", gap: 8 }}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={
            mode === "rag"
              ? "How do I roll back a bad deploy?"
              : "How much have I spent on AWS this week?"
          }
          aria-label="Question"
        />
        <div>
          <button type="submit" disabled={busy}>
            {busy ? "Thinking…" : "Ask"}
          </button>
        </div>
      </form>
      <div className="thread">
        {turns.map((turn, index) => (
          <article className="turn" key={turns.length - index}>
            <div className="q">{turn.question}</div>
            {turn.kind === "error" && <p className="error">{turn.message}</p>}
            {turn.kind === "rag" && (
              <>
                <div className="a">{turn.answer.answer}</div>
                {turn.answer.citations.length > 0 && (
                  <div className="cites">
                    {turn.answer.citations.map((c) => (
                      <div className="cite" key={c.n}>
                        <b>[{c.n}]</b> {c.fileName} · chunks {c.ordinals.join(", ")}
                        <div className="muted">
                          {c.excerpt.slice(0, 280)}
                          {c.excerpt.length > 280 ? "…" : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="meta">
                  {turn.answer.grounded
                    ? `answered by ${turn.answer.model}`
                    : "not found in your documents"}
                </div>
              </>
            )}
            {turn.kind === "agent" && (
              <>
                <div className="a">{turn.answer.answer}</div>
                <div className="meta">
                  {turn.answer.toolCalls.length === 0
                    ? "no tools used"
                    : `tools: ${turn.answer.toolCalls.map((t) => `${t.name} (${t.status}, ${t.durationMs} ms)`).join(" · ")}`}
                </div>
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
