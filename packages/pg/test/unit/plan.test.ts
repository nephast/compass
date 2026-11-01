import { describe, expect, it } from "vitest";
import { planConnection } from "../../src/index.js";

describe("planConnection", () => {
  it("prefers DATABASE_URL when present", () => {
    expect(planConnection({ DATABASE_URL: "postgres://a@b/c", DB_HOST: "ignored" })).toEqual({
      kind: "url",
      connectionString: "postgres://a@b/c",
    });
  });

  it("builds an IAM plan from the DB_* variables", () => {
    expect(
      planConnection({
        DB_HOST: "db.internal",
        DB_USER: "compass_app",
        DB_NAME: "compass",
        AWS_REGION: "eu-west-1",
      }),
    ).toMatchObject({ kind: "iam", host: "db.internal", port: 5432, user: "compass_app" });
  });

  it("names every missing variable instead of failing to connect later", () => {
    expect(() => planConnection({ DB_HOST: "db.internal" })).toThrowError(
      /DB_USER, DB_NAME, AWS_REGION/,
    );
  });

  it("rejects a port that is not a port", () => {
    expect(() =>
      planConnection({ DB_HOST: "h", DB_USER: "u", DB_NAME: "d", AWS_REGION: "r", DB_PORT: "abc" }),
    ).toThrowError(/not a port/);
  });
});
