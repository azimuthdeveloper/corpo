import { db } from "@dokploy/server/db";
import type { AuditAction, AuditResourceType } from "@dokploy/server/db/schema";
import { member, organization } from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";

// Corpo ships without Dokploy's DSAL-licensed enterprise code, so every
// feature gated on an enterprise licence stays disabled.
export const hasValidLicense = async (_organizationId: string) => false;

export const resolveOrganizationDefaultRole = async (
	organizationId: string,
): Promise<"admin" | "member"> => {
	const org = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: { defaultRole: true },
	});
	return org?.defaultRole === "admin" ? "admin" : "member";
};

export const getOrganizationOwnerId = async (organizationId: string) => {
	const owner = await db.query.member.findFirst({
		where: and(
			eq(member.organizationId, organizationId),
			eq(member.role, "owner"),
		),
		columns: { userId: true },
	});
	return owner?.userId ?? null;
};

export interface CreateAuditLogInput {
	organizationId: string;
	userId: string;
	userEmail: string;
	userRole: string;
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

export const createAuditLog = async (_input: CreateAuditLogInput) => {};
