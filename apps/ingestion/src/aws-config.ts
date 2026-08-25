// Shared LocalStack wiring for every AWS SDK client in this app (see
// docker-compose.yml). Only activates when LOCALSTACK_ENDPOINT is set (see
// .env.example) -- otherwise clients resolve the real regional endpoint via
// the default SDK chain, so this file has no effect outside local dev.
const localstackEndpoint = process.env.LOCALSTACK_ENDPOINT;

export const isLocalstack = Boolean(localstackEndpoint);

export const baseClientConfig = {
  region: process.env.AWS_REGION ?? "eu-west-1",
  ...(localstackEndpoint
    ? {
        endpoint: localstackEndpoint,
        // LocalStack doesn't validate credentials, but the SDK still
        // requires something resolvable -- this is LocalStack's own
        // documented dummy keypair, so real profiles/keys stay untouched.
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      }
    : {}),
};
