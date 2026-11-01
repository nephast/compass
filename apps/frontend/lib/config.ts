// Runtime configuration, fetched from /config.json. In AWS the Site stack
// writes it at deploy time (Cognito ids, API URL); locally it is a copy of
// public/config.local.json. One build artefact serves every environment.

export interface CognitoConfig {
  authMode?: "cognito";
  env: string;
  apiUrl: string;
  region: string;
  userPoolId: string;
  clientId: string;
  authDomain: string;
}

export interface DevConfig {
  authMode: "dev";
  env: string;
  apiUrl: string;
}

export type AppConfig = CognitoConfig | DevConfig;

export function isDev(config: AppConfig): config is DevConfig {
  return config.authMode === "dev";
}

export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch("/config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`config.json: HTTP ${response.status}`);
  return (await response.json()) as AppConfig;
}
