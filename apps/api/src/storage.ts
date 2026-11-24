// File storage: S3, or MinIO locally (section 3). Keys hold no user data: `uploads/<random UUID>`
// for a file as uploaded, `pages/<upload id>/<page>.jpg` for its page images (D42).
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Signed links work for 5 minutes, for one key only (section 11). */
export const SIGNED_URL_SECONDS = 300;

export class Storage {
  constructor(
    readonly s3: S3Client,
    readonly bucket: string,
  ) {}

  /** Without S3_ACCESS_KEY_ID, AWS's own credentials are used (a server role in production). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env) {
    const endpoint = env.S3_ENDPOINT || undefined;
    const s3 = new S3Client({
      region: env.S3_REGION || 'us-east-1',
      endpoint,
      forcePathStyle: Boolean(endpoint), // MinIO
      credentials: env.S3_ACCESS_KEY_ID
        ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' }
        : undefined,
      // Otherwise a signed upload link would require a checksum the browser does not send.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    return new Storage(s3, env.S3_BUCKET ?? '');
  }

  /** A link the browser can upload one file to, straight to storage. */
  signPut(key: string) {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: SIGNED_URL_SECONDS,
    });
  }

  /** A link the browser can show one file from, e.g. a ticket's scan on the review screen. */
  signGet(key: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: SIGNED_URL_SECONDS,
    });
  }

  /** The file and its size, or null when there is no such file. */
  async get(key: string): Promise<{ body: Readable; size: number } | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { body: res.Body as Readable, size: res.ContentLength ?? 0 };
    } catch (e) {
      if (e instanceof NoSuchKey) return null;
      throw e;
    }
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async remove(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Deletes files, 1000 to a request. A missing file counts as deleted (a purge run again). */
  async removeMany(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const res = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
      // S3 reports a file it could not delete in the answer, not as an error.
      if (res.Errors?.length) {
        throw new Error(
          `${res.Errors.length} file(s) could not be deleted: ${res.Errors[0]!.Message}`,
        );
      }
    }
  }

  /** Deletes every file whose key starts with `prefix`. */
  async removePrefix(prefix: string) {
    let ContinuationToken: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken }),
      );
      await this.removeMany((res.Contents ?? []).map((o) => o.Key!));
      ContinuationToken = res.NextContinuationToken;
    } while (ContinuationToken);
  }
}

/** Writes a downloaded file to disk and returns its SHA-256, in one pass. */
export async function saveTo(body: Readable, path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    body,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(path),
  );
  return hash.digest('hex');
}
