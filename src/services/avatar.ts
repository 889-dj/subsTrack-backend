import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config.js';

// cloudinary's SDK reads process.env.CLOUDINARY_URL itself on import — dotenv
// (loaded by config.ts, imported above) has already populated it by then.

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isAvatarStorageConfigured(): boolean {
  return Boolean(env.CLOUDINARY_URL);
}

function publicIdFor(userId: string): string {
  return `substrack/avatars/${userId}`;
}

/**
 * Streams a validated image buffer to Cloudinary under a deterministic
 * per-user id, so a re-upload overwrites the previous asset instead of
 * accumulating orphans against the free storage quota.
 */
export function uploadAvatar(userId: string, buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicIdFor(userId),
        overwrite: true,
        resource_type: 'image',
        // Reject anything that isn't decodable as an image — belt-and-braces
        // alongside the declared-mimetype check the route does first.
        transformation: [{ width: 512, height: 512, crop: 'fill', gravity: 'face' }],
      },
      (error, result) => {
        if (error || !result) {
          reject(error instanceof Error ? error : new Error('Cloudinary upload failed'));
          return;
        }
        resolve(result.secure_url);
      },
    );
    stream.end(buffer);
  });
}

/** Best-effort: a failed delete leaves an orphaned asset, not a broken account. */
export async function deleteAvatar(userId: string): Promise<void> {
  try {
    await cloudinary.uploader.destroy(publicIdFor(userId));
  } catch {
    // Ignored — see doc comment above.
  }
}
