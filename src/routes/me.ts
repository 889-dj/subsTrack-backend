import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { entitlements, users } from '../db/schema.js';
import { sendError } from '../errors.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import {
  ALLOWED_MIME_TYPES,
  AVATAR_MAX_BYTES,
  deleteAvatar,
  isAvatarStorageConfigured,
  uploadAvatar,
} from '../services/avatar.js';
import { isValidExpoPushToken } from '../services/push.js';

const pushTokenInput = z.object({
  token: z.string().trim().min(1),
}).strict();

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/me', { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUser(request);
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

    if (!user || user.deletedAt) {
      return sendError(request, reply, 404, 'NOT_FOUND', 'User not found.');
    }

    const entitlement = await db.query.entitlements.findFirst({
      where: and(
        eq(entitlements.userId, userId),
        eq(entitlements.entitlementId, 'pro'),
      ),
    });
    const entitlementActive = Boolean(
      entitlement?.isActive &&
      (!entitlement.expiresAt || entitlement.expiresAt.getTime() > Date.now()),
    );
    const legacyActive = Boolean(user.proUntil && user.proUntil.getTime() > Date.now());

    return {
      id: user.id,
      email: user.email,
      avatarUrl: user.avatarUrl ?? null,
      pushNotificationsEnabled: Boolean(user.pushToken),
      isPro: entitlementActive || legacyActive,
      proUntil: entitlement?.expiresAt?.toISOString() ?? user.proUntil?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  });

  // Multipart upload, capped a little above AVATAR_MAX_BYTES to leave room
  // for form-data framing overhead — the plugin's own fileSize limit (set at
  // registration in app.ts) is what actually caps the image bytes.
  app.post(
    '/v1/me/avatar',
    { preHandler: requireAuth, bodyLimit: AVATAR_MAX_BYTES + 1024 * 100 },
    async (request, reply) => {
      if (!isAvatarStorageConfigured()) {
        return sendError(
          request,
          reply,
          503,
          'INTERNAL_ERROR',
          'Photo uploads are not configured on this server.',
        );
      }

      const userId = currentUser(request);
      const file = await request.file();
      if (!file) {
        return sendError(request, reply, 400, 'VALIDATION_ERROR', 'Attach an image file.');
      }
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return sendError(
          request,
          reply,
          400,
          'VALIDATION_ERROR',
          'Only JPEG, PNG, or WEBP images are supported.',
        );
      }

      const buffer = await file.toBuffer();
      if (file.file.truncated) {
        return sendError(request, reply, 413, 'VALIDATION_ERROR', 'Image is too large (max 5 MB).');
      }

      const avatarUrl = await uploadAvatar(userId, buffer);
      await db.update(users).set({ avatarUrl, updatedAt: new Date() }).where(eq(users.id, userId));
      return { avatarUrl };
    },
  );

  app.delete('/v1/me/avatar', { preHandler: requireAuth }, async (request) => {
    const userId = currentUser(request);
    await deleteAvatar(userId);
    await db.update(users).set({ avatarUrl: null, updatedAt: new Date() }).where(eq(users.id, userId));
    return { avatarUrl: null };
  });

  app.post('/v1/me/push-token', { preHandler: requireAuth }, async (request, reply) => {
    const { token } = pushTokenInput.parse(request.body);
    if (!isValidExpoPushToken(token)) {
      return sendError(request, reply, 400, 'VALIDATION_ERROR', 'Not a valid Expo push token.');
    }
    const userId = currentUser(request);
    await db.update(users).set({ pushToken: token, updatedAt: new Date() }).where(eq(users.id, userId));
    return { pushNotificationsEnabled: true };
  });

  app.delete('/v1/me/push-token', { preHandler: requireAuth }, async (request) => {
    const userId = currentUser(request);
    await db.update(users).set({ pushToken: null, updatedAt: new Date() }).where(eq(users.id, userId));
    return { pushNotificationsEnabled: false };
  });
}
