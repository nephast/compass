import type { Tool } from "./types.js";

// GitHub Actions runs for ONE repository, fixed by configuration. The model
// can choose how many runs and which branch, never which repository -- the
// owner/repo pair is not in the schema at all, so there is nothing to inject.

export interface CiInput {
  limit?: number;
  branch?: string;
}

export interface CiToolOptions {
  repository: string; // "owner/name"
  token?: string | undefined; // optional: public repos need none, it only lifts rate limits
  fetchImpl?: typeof fetch;
}

interface WorkflowRun {
  name?: string;
  display_title?: string;
  head_branch?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  created_at?: string;
  html_url?: string;
}

export function ciTool(options: CiToolOptions): Tool<CiInput> {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(options.repository)) {
    throw new Error(`GITHUB_REPOSITORY "${options.repository}" is not owner/name`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    readOnly: true,
    spec: {
      name: "get_recent_ci_runs",
      description: `Recent GitHub Actions workflow runs for ${options.repository}, newest first. Read-only.`,
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
          branch: { type: "string", pattern: "^[A-Za-z0-9._/-]{1,100}$" },
        },
        additionalProperties: false,
      },
    },
    async execute({ limit = 5, branch }) {
      const url = new URL(`https://api.github.com/repos/${options.repository}/actions/runs`);
      url.searchParams.set("per_page", String(limit));
      if (branch) url.searchParams.set("branch", branch);

      const response = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "compass-agent-tools",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
      const body = (await response.json()) as { workflow_runs?: WorkflowRun[] };

      return {
        repository: options.repository,
        runs: (body.workflow_runs ?? []).map((run) => ({
          workflow: run.name,
          title: run.display_title,
          branch: run.head_branch,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          createdAt: run.created_at,
          url: run.html_url,
        })),
      };
    },
  };
}
