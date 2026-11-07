import { join } from "node:path";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
	ATTACHMENT_MAX_BYTES,
	ensurePrivateDir,
	publishStagedFile,
	readSnapshot,
	removeQuietly,
	stageBytes,
} from "./files.ts";
import { SCOPES } from "./gws.ts";
import { external, GoogleError, ok, TextBudget } from "./result.ts";
import type { ToolSpec } from "./tools.ts";

const FileId = str({ minLength: 1, maxLength: 512 });
const Path = str({ minLength: 1, maxLength: 4096 });
const Limit = opt(int({ minimum: 1, maximum: 50, default: 20 }));
const read = [SCOPES.driveRead, SCOPES.driveFile, SCOPES.drive];
const metadataRead = [SCOPES.driveMetadataRead, ...read];
const write = [SCOPES.driveFile, SCOPES.drive];
const fileFields = "id,name,mimeType,size,modifiedTime,trashed,parents,description,md5Checksum";

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function fileView(file: Record<string, unknown>, budget: TextBudget): Record<string, unknown> {
	const name = budget.clip(file.name, 2048);
	const description = budget.clip(file.description, 4096);
	return {
		fileId: text(file.id),
		mimeType: text(file.mimeType),
		size: text(file.size) || undefined,
		modifiedTime: text(file.modifiedTime) || undefined,
		trashed: file.trashed === true,
		parents: Array.isArray(file.parents) ? file.parents.filter((item): item is string => typeof item === "string") : [],
		md5Checksum: text(file.md5Checksum) || undefined,
		externalData: external("drive", {
			name: name.text,
			description: description.text,
			truncated: name.truncated || description.truncated,
		}),
	};
}
function requiredName(value: string): void {
	if (!value.trim() || /[\0]/.test(value))
		throw new GoogleError("INVALID_ARGUMENT", "A Drive file name must be nonblank and contain no NUL.");
}

export const driveTools: ToolSpec[] = [
	{
		name: "drive_files_list",
		label: "Drive files",
		description: "List or query Drive files with bounded metadata and native pagination.",
		parameters: obj({
			query: opt(str({ maxLength: 4096 })),
			limit: Limit,
			cursor: opt(str({ minLength: 1, maxLength: 4096 })),
			includeTrash: opt(bool({ default: false })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: metadataRead }, signal, async (operation) => {
				const args = value as { query?: string; limit?: number; cursor?: string; includeTrash?: boolean };
				const q = [args.query, args.includeTrash ? undefined : "trashed = false"].filter(Boolean).join(" and ");
				const response = await operation.call<Record<string, unknown>>("drive", ["files", "list"], {
					params: {
						...(q ? { q: `(${q})` } : {}),
						pageSize: args.limit ?? 20,
						...(args.cursor ? { pageToken: args.cursor } : {}),
						fields: `nextPageToken,files(${fileFields})`,
					},
				});
				const budget = new TextBudget();
				return ok({
					files: (Array.isArray(response.files) ? response.files.filter(object) : []).map((file) =>
						fileView(file, budget),
					),
					nextCursor: text(response.nextPageToken) || undefined,
				});
			}),
	},
	{
		name: "drive_file_get",
		label: "Drive metadata",
		description: "Read bounded metadata for one Drive file.",
		parameters: obj({ fileId: FileId }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: metadataRead }, signal, async (operation) => {
				const args = value as { fileId: string };
				return ok(
					fileView(
						await operation.call<Record<string, unknown>>("drive", ["files", "get"], {
							params: { fileId: args.fileId, fields: fileFields },
						}),
						new TextBudget(),
					),
				);
			}),
	},
	...(
		[
			{
				name: "drive_file_download",
				method: "get",
				description: "Download Drive file bytes to an explicit new absolute file.",
				export: false,
			},
			{
				name: "drive_file_export",
				method: "export",
				description: "Export a Google Workspace file to an explicit new absolute file.",
				export: true,
			},
		] as const
	).map(
		(item): ToolSpec => ({
			name: item.name,
			label: item.export ? "Drive export" : "Drive download",
			description: item.description,
			parameters: obj({
				fileId: FileId,
				path: Path,
				...(item.export ? { mimeType: str({ minLength: 1, maxLength: 200 }) } : {}),
			}),
			replay: "unsafe",
			execute: async (value, runtime, signal) =>
				runtime.run({ scopes: read }, signal, async (operation) => {
					const args = value as { fileId: string; path: string; mimeType?: string };
					await ensurePrivateDir(join(operation.stateDir, "downloads"));
					const staged = join(operation.stateDir, "downloads", `${crypto.randomUUID()}.download`);
					try {
						await operation.call("drive", ["files", item.method], {
							params: { fileId: args.fileId, ...(item.export ? { mimeType: args.mimeType } : { alt: "media" }) },
							output: staged,
							allowEmpty: true,
						});
						return ok({
							...(await publishStagedFile(staged, args.path, ATTACHMENT_MAX_BYTES)),
							fileId: args.fileId,
							...(item.export ? { mimeType: args.mimeType } : {}),
						});
					} finally {
						await removeQuietly(staged);
					}
				}),
		}),
	),
	{
		name: "drive_file_upload",
		label: "Drive upload",
		description: "Upload one snapshotted local file into Drive.",
		parameters: obj({
			path: Path,
			name: opt(str({ minLength: 1, maxLength: 4096 })),
			mimeType: opt(str({ minLength: 1, maxLength: 200 })),
			parentIds: opt(arr(str({ minLength: 1, maxLength: 512 }), { maxItems: 10 })),
			description: opt(str({ maxLength: 16384 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: write }, signal, async (operation) => {
				const args = value as {
					path: string;
					name?: string;
					mimeType?: string;
					parentIds?: string[];
					description?: string;
				};
				const snapshot = await readSnapshot(args.path, ATTACHMENT_MAX_BYTES);
				const name = args.name ?? snapshot.name;
				requiredName(name);
				const staged = await stageBytes(join(operation.stateDir, "uploads"), snapshot.bytes);
				try {
					const response = await operation.call<Record<string, unknown>>("drive", ["files", "create"], {
						params: { fields: fileFields },
						body: {
							name,
							...(args.description !== undefined ? { description: args.description } : {}),
							...(args.parentIds?.length ? { parents: args.parentIds } : {}),
						},
						upload: staged,
						uploadContentType: args.mimeType ?? "application/octet-stream",
					});
					return ok({ ...fileView(response, new TextBudget()), sourceSha256: snapshot.sha256 });
				} finally {
					await removeQuietly(staged);
				}
			}),
	},
	{
		name: "drive_file_rename",
		label: "Drive rename",
		description: "Rename one Drive file without changing its location.",
		parameters: obj({ fileId: FileId, name: str({ minLength: 1, maxLength: 4096 }) }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: write }, signal, async (operation) => {
				const args = value as { fileId: string; name: string };
				requiredName(args.name);
				const response = await operation.call<Record<string, unknown>>("drive", ["files", "update"], {
					params: { fileId: args.fileId, fields: fileFields },
					body: { name: args.name },
				});
				return ok(fileView(response, new TextBudget()));
			}),
	},
	{
		name: "drive_file_move",
		label: "Drive move",
		description: "Add and remove parent folders for one Drive file.",
		parameters: obj({
			fileId: FileId,
			addParentIds: opt(arr(str({ minLength: 1, maxLength: 512 }), { maxItems: 10 })),
			removeParentIds: opt(arr(str({ minLength: 1, maxLength: 512 }), { maxItems: 10 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: write }, signal, async (operation) => {
				const args = value as { fileId: string; addParentIds?: string[]; removeParentIds?: string[] };
				if (!args.addParentIds?.length && !args.removeParentIds?.length)
					throw new GoogleError("INVALID_ARGUMENT", "A move requires an added or removed parent.");
				const response = await operation.call<Record<string, unknown>>("drive", ["files", "update"], {
					params: {
						fileId: args.fileId,
						...(args.addParentIds?.length ? { addParents: args.addParentIds.join(",") } : {}),
						...(args.removeParentIds?.length ? { removeParents: args.removeParentIds.join(",") } : {}),
						fields: fileFields,
					},
					body: {},
				});
				return ok(fileView(response, new TextBudget()));
			}),
	},
	...([true, false] as const).map(
		(trashed): ToolSpec => ({
			name: trashed ? "drive_file_trash" : "drive_file_untrash",
			label: trashed ? "Drive trash" : "Drive untrash",
			description: trashed ? "Move one Drive file to Trash." : "Restore one Drive file from Trash.",
			parameters: obj({ fileId: FileId }),
			replay: "unsafe",
			execute: async (value, runtime, signal) =>
				runtime.run({ scopes: write }, signal, async (operation) => {
					const args = value as { fileId: string };
					const response = await operation.call<Record<string, unknown>>("drive", ["files", "update"], {
						params: { fileId: args.fileId, fields: fileFields },
						body: { trashed },
					});
					return ok(fileView(response, new TextBudget()));
				}),
		}),
	),
	{
		name: "drive_permissions_list",
		label: "Drive permissions",
		description: "List the sharing permissions on one Drive file.",
		parameters: obj({ fileId: FileId, limit: Limit, cursor: opt(str({ minLength: 1, maxLength: 4096 })) }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: metadataRead }, signal, async (operation) => {
				const args = value as { fileId: string; limit?: number; cursor?: string };
				const response = await operation.call<Record<string, unknown>>("drive", ["permissions", "list"], {
					params: {
						fileId: args.fileId,
						pageSize: args.limit ?? 20,
						...(args.cursor ? { pageToken: args.cursor } : {}),
						fields: "nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,deleted)",
					},
				});
				const budget = new TextBudget();
				return ok({
					permissions: (Array.isArray(response.permissions) ? response.permissions.filter(object) : []).map(
						(permission) => ({
							permissionId: text(permission.id),
							type: text(permission.type),
							role: text(permission.role),
							deleted: permission.deleted === true,
							externalData: external("drive", {
								emailAddress: budget.clip(permission.emailAddress, 320).text,
								domain: budget.clip(permission.domain, 320).text,
								displayName: budget.clip(permission.displayName, 1024).text,
							}),
						}),
					),
					nextCursor: text(response.nextPageToken) || undefined,
				});
			}),
	},
	{
		name: "drive_share",
		label: "Drive share",
		description: "Create one Drive sharing permission with explicit notification control.",
		parameters: obj({
			fileId: FileId,
			type: oneOf(["user", "group", "domain", "anyone"]),
			role: oneOf(["reader", "commenter", "writer", "organizer"]),
			emailAddress: opt(str({ minLength: 3, maxLength: 320 })),
			domain: opt(str({ minLength: 1, maxLength: 320 })),
			sendNotificationEmail: opt(bool({ default: false })),
			emailMessage: opt(str({ maxLength: 16384 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: write }, signal, async (operation) => {
				const args = value as {
					fileId: string;
					type: string;
					role: string;
					emailAddress?: string;
					domain?: string;
					sendNotificationEmail?: boolean;
					emailMessage?: string;
				};
				if (["user", "group"].includes(args.type) && !args.emailAddress)
					throw new GoogleError("INVALID_ARGUMENT", "User and group sharing requires emailAddress.");
				if (args.type === "domain" && !args.domain)
					throw new GoogleError("INVALID_ARGUMENT", "Domain sharing requires domain.");
				const response = await operation.call<Record<string, unknown>>("drive", ["permissions", "create"], {
					params: {
						fileId: args.fileId,
						sendNotificationEmail: args.sendNotificationEmail ?? false,
						...(args.emailMessage ? { emailMessage: args.emailMessage } : {}),
						fields: "id,type,role,emailAddress,domain",
					},
					body: {
						type: args.type,
						role: args.role,
						...(args.emailAddress ? { emailAddress: args.emailAddress } : {}),
						...(args.domain ? { domain: args.domain } : {}),
					},
				});
				return ok({
					permissionId: text(response.id),
					fileId: args.fileId,
					notificationSent: args.sendNotificationEmail ?? false,
				});
			}),
	},
	{
		name: "drive_unshare",
		label: "Drive unshare",
		description: "Remove one sharing permission from a Drive file.",
		parameters: obj({ fileId: FileId, permissionId: str({ minLength: 1, maxLength: 512 }) }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: write }, signal, async (operation) => {
				const args = value as { fileId: string; permissionId: string };
				await operation.call("drive", ["permissions", "delete"], {
					params: { fileId: args.fileId, permissionId: args.permissionId },
					allowEmpty: true,
				});
				return ok({ fileId: args.fileId, permissionId: args.permissionId, deleted: true });
			}),
	},
];
