import type { FastifyReply, FastifyRequest } from 'fastify';

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'ENTITLEMENT_REQUIRED'
  | 'INTERNAL_ERROR';

export interface ApiErrorBody {
  message: string;
  code: ErrorCode;
  requestId: string;
  fields?: Record<string, string>;
}

export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  fields?: Record<string, string>,
) {
  const body: ApiErrorBody = {
    message,
    code,
    requestId: request.id,
    ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
  };
  return reply.code(status).send(body);
}
