import { z } from 'zod';
import { LOCALES } from './locales';

export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** Roles an invite can grant; `owner` is granted later, by an owner (P4-D8). */
export const INVITE_ROLES = ['admin', 'member'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const EMAIL_TOKEN_PURPOSES = ['verify', 'reset'] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'canceled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

// Fields. An email is trimmed and lowercased before anything stores or looks it up (P4-D12).
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const passwordSchema = z.string().min(10).max(256);
export const personNameSchema = z.string().trim().min(1).max(100);
export const orgNameSchema = z.string().trim().min(1).max(120);
export const localeSchema = z.enum(LOCALES);
const roleSchema = z.enum(ROLES);
const inviteRoleSchema = z.enum(INVITE_ROLES);
const tokenSchema = z.string().min(20).max(100);

// Requests.
export const signupRequest = z.object({
  name: personNameSchema,
  email: emailSchema,
  password: passwordSchema,
  companyName: orgNameSchema,
  locale: localeSchema,
});
export type SignupRequest = z.infer<typeof signupRequest>;

export const emailOnlyRequest = z.object({ email: emailSchema });
export type EmailOnlyRequest = z.infer<typeof emailOnlyRequest>;

export const tokenRequest = z.object({ token: tokenSchema });
export type TokenRequest = z.infer<typeof tokenRequest>;

/** Login accepts any non-empty password: the rules for choosing one apply when it is set, not when it is used. */
export const loginRequest = z.object({ email: emailSchema, password: z.string().min(1).max(256) });
export type LoginRequest = z.infer<typeof loginRequest>;

export const resetPasswordRequest = z.object({ token: tokenSchema, password: passwordSchema });
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequest>;

export const patchMeRequest = z
  .object({ name: personNameSchema.optional(), locale: localeSchema.optional() })
  .refine((body) => body.name !== undefined || body.locale !== undefined, { message: 'Send a name or a locale to change' });
export type PatchMeRequest = z.infer<typeof patchMeRequest>;

export const patchOrgRequest = z.object({ name: orgNameSchema });
export type PatchOrgRequest = z.infer<typeof patchOrgRequest>;

export const patchMemberRequest = z.object({ role: roleSchema });
export type PatchMemberRequest = z.infer<typeof patchMemberRequest>;

export const createInviteRequest = z.object({ email: emailSchema, role: inviteRoleSchema });
export type CreateInviteRequest = z.infer<typeof createInviteRequest>;

export const acceptInviteRequest = z.object({
  token: tokenSchema,
  password: passwordSchema,
  name: personNameSchema.optional(),
  locale: localeSchema.optional(),
});
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequest>;

// Responses.
export const statusResponse = z.object({ status: z.string() });
export type StatusResponse = z.infer<typeof statusResponse>;

export const meResponse = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    locale: localeSchema,
    emailVerified: z.boolean(),
    isPlatformAdmin: z.boolean(),
  }),
  org: z.object({ id: z.string(), name: z.string() }),
  role: roleSchema,
});
export type MeResponse = z.infer<typeof meResponse>;

export const orgResponse = z.object({ id: z.string(), name: z.string(), createdAt: z.string() });
export type OrgResponse = z.infer<typeof orgResponse>;

export const membersResponse = z.object({
  members: z.array(z.object({ userId: z.string(), name: z.string(), email: z.string(), role: roleSchema, joinedAt: z.string() })),
  invites: z.array(
    z.object({ id: z.string(), email: z.string(), role: inviteRoleSchema, expiresAt: z.string(), invitedBy: z.string().nullable() }),
  ),
});
export type MembersResponse = z.infer<typeof membersResponse>;

export const inviteResponse = z.object({ id: z.string(), email: z.string(), role: inviteRoleSchema, expiresAt: z.string() });
export type InviteResponse = z.infer<typeof inviteResponse>;

export const invitePreviewResponse = z.object({
  orgName: z.string(),
  email: z.string(),
  role: inviteRoleSchema,
  existingUser: z.boolean(),
});
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponse>;
