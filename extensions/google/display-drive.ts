import {
	count,
	field,
	object,
	pick,
	type CardCall,
	type CardResult,
	type Data,
	type Presenter,
	type ResultContext,
} from "./display-data.ts";

function drive(call: Presenter["call"], result: (context: ResultContext) => CardResult): Presenter {
	return {
		call,
		result: (context) => (context.isError || context.status === "error" ? undefined : result(context)),
	};
}

function fileCall(args: Data): CardCall {
	return { subject: field(args.fileId) };
}

function pageFacts(args: Data): string[] {
	return [
		typeof args.limit === "number" ? `limit ${args.limit}` : "",
		typeof args.cursor === "string" && args.cursor ? "continued page" : "",
	].filter(Boolean);
}

function pageResult(
	{ args, data, status }: ResultContext,
	key: string,
	unit: string,
	stableKeys: string[],
	row: (item: Data) => string,
): CardResult {
	const cursor = typeof data.nextCursor === "string" && data.nextCursor !== "" ? data.nextCursor : undefined;
	const entries = data[key];
	const hasPage = Array.isArray(entries);
	const body = hasPage ? entries.map((item) => row(object(item))).filter(Boolean) : [];
	const coverage = hasPage
		? `Returned ${count(entries.length, unit)} on this page.`
		: `The result did not include a ${unit} list.`;
	const continuation =
		cursor !== undefined
			? " A next page is available."
			: status === "partial" || !hasPage
				? " The result did not include a next page token."
				: " There is no next page.";
	return {
		outcome: coverage + continuation,
		...(body?.length ? { body } : {}),
		...(cursor !== undefined ? { next: { args: { ...pick(args, ...stableKeys), cursor } } } : {}),
	};
}

function byteCount(value: unknown): string {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return count(value, "byte");
	if (typeof value === "string" && /^\d+$/.test(value)) return `${value} ${value === "1" ? "byte" : "bytes"}`;
	return "";
}

function ids(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

function fileLine(data: Data): string {
	return [
		field(object(data.externalData).name),
		field(data.fileId) && `file ${field(data.fileId)}`,
		field(data.mimeType),
		byteCount(data.size),
		data.trashed === true ? "in Trash" : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function fileReceipt({ args, data, status }: ResultContext): boolean {
	return (
		status === "ok" &&
		typeof data.fileId === "string" &&
		Boolean(field(data.fileId)) &&
		(args.fileId === undefined || args.fileId === data.fileId)
	);
}

function parentDetail(data: Data): string[] {
	const parents = ids(data.parents).map(field).filter(Boolean);
	return parents.length ? [`Current parent folders: ${parents.join(", ")}`] : [];
}

function transfer(exportFile: boolean): Presenter {
	return drive(
		(args) => ({
			subject: field(args.fileId),
			facts: [field(args.path) && `to ${field(args.path)}`, exportFile ? field(args.mimeType) : ""].filter(Boolean),
		}),
		(context) => {
			const { args, data } = context;
			const path = field(data.path);
			const bytes = byteCount(data.bytes);
			const action = exportFile ? "export" : "download";
			if (!fileReceipt(context) || !path || !bytes || (args.path !== undefined && data.path !== args.path)) {
				return { outcome: `The file ${action} is not confirmed.` };
			}
			const sha256 = field(data.sha256);
			return {
				outcome: `${exportFile ? "Exported" : "Downloaded"} ${bytes} to a new local file.`,
				body: [path],
				...(sha256 ? { details: [`SHA-256: ${sha256}`] } : {}),
			};
		},
	);
}

function trash(trashed: boolean): Presenter {
	return drive(fileCall, (context) => {
		if (!fileReceipt(context) || context.data.trashed !== trashed) {
			return { outcome: trashed ? "The move to Trash is not confirmed." : "The restore from Trash is not confirmed." };
		}
		return {
			outcome: trashed ? "Drive confirmed the file is in Trash." : "Drive confirmed the file is out of Trash.",
			body: [fileLine(context.data)],
		};
	});
}

function principal(type: unknown, data: Data): string {
	if (type === "domain") return field(data.domain);
	if (type === "user" || type === "group") return field(data.emailAddress) || field(data.displayName);
	return "";
}

function permissionLine(data: Data): string {
	const permissionId = field(data.permissionId);
	return [
		field(data.type),
		principal(data.type, object(data.externalData)),
		field(data.role),
		permissionId && `permission ${permissionId}`,
		data.deleted === true ? "principal deleted" : "",
	]
		.filter(Boolean)
		.join(" · ");
}

export const drivePresenters: Record<string, Presenter> = {
	drive_files_list: drive(
		(args) => ({
			subject: field(args.query) || "Drive files",
			facts: [...pageFacts(args), args.includeTrash === true ? "includes Trash" : "excludes Trash"],
		}),
		(context) => pageResult(context, "files", "file", ["query", "limit", "includeTrash"], fileLine),
	),
	drive_file_get: drive(fileCall, ({ data }) => {
		const line = fileLine(data);
		return line
			? { outcome: "Returned Drive file metadata.", body: [line], details: parentDetail(data) }
			: { outcome: "No Drive file metadata was returned." };
	}),
	drive_file_download: transfer(false),
	drive_file_export: transfer(true),
	drive_file_upload: drive(
		(args) => {
			const path = field(args.path);
			const name = field(args.name);
			const parents = ids(args.parentIds).map(field).filter(Boolean);
			const description =
				typeof args.description === "string" ? count([...args.description].length, "character") : undefined;
			return {
				subject: path,
				facts: [name && `as ${name}`, field(args.mimeType)].filter(Boolean),
				...(parents.length || description !== undefined
					? {
							args: {
								...(parents.length ? { parentIds: parents } : {}),
								...(description !== undefined ? { description } : {}),
							},
						}
					: {}),
			};
		},
		(context) =>
			fileReceipt(context)
				? { outcome: "Uploaded a file to Drive.", body: [fileLine(context.data)], details: parentDetail(context.data) }
				: { outcome: "The Drive upload is not confirmed." },
	),
	drive_file_rename: drive(
		(args) => ({
			subject: field(args.fileId),
			facts: [field(args.name) && `rename to ${field(args.name)}`].filter(Boolean),
		}),
		(context) => {
			const { args, data } = context;
			if (!fileReceipt(context)) return { outcome: "The Drive rename is not confirmed." };
			return {
				outcome:
					typeof args.name === "string" && object(data.externalData).name === args.name
						? "Renamed the Drive file."
						: "The returned metadata does not confirm the requested name.",
				body: [fileLine(data)],
			};
		},
	),
	drive_file_move: drive(
		(args) => {
			const addParentIds = ids(args.addParentIds).map(field).filter(Boolean);
			const removeParentIds = ids(args.removeParentIds).map(field).filter(Boolean);
			return {
				subject: field(args.fileId),
				facts: [
					addParentIds.length ? `add ${count(addParentIds.length, "parent folder")}` : "",
					removeParentIds.length ? `remove ${count(removeParentIds.length, "parent folder")}` : "",
				].filter(Boolean),
				...(addParentIds.length || removeParentIds.length
					? {
							args: {
								...(addParentIds.length ? { addParentIds } : {}),
								...(removeParentIds.length ? { removeParentIds } : {}),
							},
						}
					: {}),
			};
		},
		(context) => {
			const { args, data } = context;
			if (!fileReceipt(context)) return { outcome: "The folder change is not confirmed." };
			const added = ids(args.addParentIds);
			const removed = ids(args.removeParentIds);
			const parents = ids(data.parents);
			const confirmed =
				Array.isArray(data.parents) &&
				parents.length === data.parents.length &&
				(added.length > 0 || removed.length > 0) &&
				added.every((id) => parents.includes(id)) &&
				removed.every((id) => !parents.includes(id));
			const knownParents = parents.map(field).filter(Boolean);
			return {
				outcome: confirmed
					? "Drive confirmed the requested folder changes."
					: "The returned metadata does not confirm the requested folder changes.",
				body: [fileLine(data), ...knownParents.map((id) => `Parent folder ${id}`)],
			};
		},
	),
	drive_file_trash: trash(true),
	drive_file_untrash: trash(false),
	drive_permissions_list: drive(
		(args) => ({ subject: field(args.fileId), facts: pageFacts(args) }),
		(context) => pageResult(context, "permissions", "permission", ["fileId", "limit"], permissionLine),
	),
	drive_share: drive(
		(args) => {
			const file = field(args.fileId);
			const type = field(args.type);
			return {
				subject: type === "anyone" ? "Anyone" : principal(args.type, args),
				facts: [
					field(args.role),
					type === "anyone" ? "" : type,
					file && `file ${file}`,
					args.sendNotificationEmail === true ? "request email notification" : "no email notification requested",
				].filter(Boolean),
				...(typeof args.emailMessage === "string"
					? { args: { emailMessage: count([...args.emailMessage].length, "character") } }
					: {}),
			};
		},
		(context) => {
			const { data } = context;
			const permissionId = field(data.permissionId);
			if (!fileReceipt(context) || !permissionId) return { outcome: "The sharing permission is not confirmed." };
			return {
				outcome: "Created a Drive sharing permission.",
				body: [`Permission ${permissionId}`],
			};
		},
	),
	drive_unshare: drive(
		(args) => {
			const file = field(args.fileId);
			return { subject: field(args.permissionId), facts: file ? [`file ${file}`] : [] };
		},
		(context) => {
			const { args, data } = context;
			const permissionId = field(data.permissionId);
			return fileReceipt(context) &&
				permissionId &&
				data.deleted === true &&
				(args.permissionId === undefined || data.permissionId === args.permissionId)
				? { outcome: "Removed the Drive sharing permission.", body: [`Permission ${permissionId}`] }
				: { outcome: "Removal of the sharing permission is not confirmed." };
		},
	),
};
