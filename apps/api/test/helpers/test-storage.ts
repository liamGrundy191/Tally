// A throwaway file storage bucket for one test file. Needs S3: locally the MinIO of
// docker/compose.dev.yml and the S3_ settings in .env; CI provides one.
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { Storage } from '../../src/storage.ts';
import './test-db.ts'; // loads .env

export const storageConfigured = Boolean(process.env.S3_ENDPOINT);
if (!storageConfigured && process.env.CI) {
  throw new Error('CI must provide S3_ENDPOINT for the file storage tests.');
}

/** A new bucket, or the named one (the browser test's, kept between runs). */
export function testStorage(bucket?: string) {
  const Bucket = bucket ?? `test-${randomBytes(4).toString('hex')}`;
  const storage = Storage.fromEnv({ ...process.env, S3_BUCKET: Bucket });
  const keys = async () =>
    ((await storage.s3.send(new ListObjectsV2Command({ Bucket }))).Contents ?? [])
      .map((o) => o.Key!)
      .sort();
  return {
    storage,
    keys,
    create: () => storage.s3.send(new CreateBucketCommand({ Bucket })),
    drop: async () => {
      const all = await keys();
      if (all.length) {
        await storage.s3.send(
          new DeleteObjectsCommand({ Bucket, Delete: { Objects: all.map((Key) => ({ Key })) } }),
        );
      }
      await storage.s3.send(new DeleteBucketCommand({ Bucket }));
    },
  };
}
