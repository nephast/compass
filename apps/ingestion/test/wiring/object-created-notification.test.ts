// Slow tier: proves the *wiring*, not the logic. Bundles the handler,
// deploys it as a real LocalStack Lambda, PUTs an object, and asserts the
// notification actually invoked it and the row landed in Postgres.
//
// This is the only test that needs the docker.sock mount (Lambda invoke
// spins up runtime containers via the host Docker daemon) and the only one
// that can take minutes on a cold LocalStack. It is not part of the
// save-loop -- run it before opening a PR: npm run test:wiring
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import {
  createBucket,
  deleteBucket,
  deleteFunction,
  deployHandler,
  s3,
  triggerOnObjectCreated,
} from "../helpers/localstack.js";

const bucket = `compass-wiring-test-${randomUUID()}`;
const functionName = `compass-wiring-test-${randomUUID()}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await createBucket(bucket);
  const arn = await deployHandler(functionName);
  await triggerOnObjectCreated(arn, bucket);
}, 180_000);

afterAll(async () => {
  // Best-effort cleanup -- don't let it mask the test's own failure.
  try {
    await deleteFunction(functionName);
    await deleteBucket(bucket);
    await pool.query("DELETE FROM chunks WHERE bucket = $1", [bucket]);
  } catch (err) {
    console.warn("cleanup failed:", err);
  } finally {
    await pool.end();
  }
});

describe("S3 ObjectCreated -> Lambda (LocalStack)", () => {
  it("invokes the deployed lambda, which stores the object as a chunk row", async () => {
    const key = `docs/${randomUUID()}.txt`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "hello" }));

    // The notification is asynchronous: poll for the row rather than
    // sleeping a fixed guess. The DB row is the real assertion -- it can
    // only exist if the Lambda ran and completed.
    for (let attempt = 0; attempt < 60; attempt++) {
      const { rows } = await pool.query(
        "SELECT content FROM chunks WHERE bucket = $1 AND object_key = $2",
        [bucket, key],
      );
      if (rows.length === 1) {
        expect(rows[0].content).toBe("hello");
        return;
      }
      await sleep(1000);
    }
    throw new Error(`lambda never wrote a row for s3://${bucket}/${key}`);
  }, 90_000);
});
