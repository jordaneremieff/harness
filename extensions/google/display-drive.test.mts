import assert from "node:assert/strict";
import test from "node:test";
import type { Data, ResultContext } from "./display-data.ts";
import { drivePresenters } from "./display-drive.ts";

function result(name: string, args: Data, data: Data, status: ResultContext["status"] = "ok") {
	return drivePresenters[name]?.result({ args, data, status, error: {}, isError: status === "error" });
}

const file = {
	fileId: "file-1",
	mimeType: "text/plain",
	size: "0",
	trashed: false,
	parents: ["folder-1"],
	externalData: { source: "drive", trust: "untrusted", name: "Field notes.txt", description: "Private description" },
};

test("Drive inventory keeps the page scope and the exact next call", () => {
	const args = {
		query: "name = 'Field notes.txt'  ",
		includeTrash: false,
		limit: 20,
		cursor: "prior",
		extra: "ignored",
	};
	const cursor = " next+=/\t ";
	const page = result("drive_files_list", args, { files: [file], nextCursor: cursor });
	assert.match(page?.outcome ?? "", /1 file on this page.*next page is available/);
	assert.deepEqual(page?.body, ["Field notes.txt · file file-1 · text/plain · 0 bytes"]);
	assert.deepEqual(page?.next, { args: { query: args.query, limit: 20, includeTrash: false, cursor } });

	const empty = result("drive_files_list", {}, { files: [] });
	assert.match(empty?.outcome ?? "", /0 files on this page.*no next page/);
	assert.equal(empty?.next, undefined);
	assert.match(result("drive_files_list", {}, {})?.outcome ?? "", /did not include a file list/);
});

test("Permission inventory exposes actionable principals and replaces only the cursor", () => {
	const args = { fileId: "file-1", limit: 6, cursor: "previous" };
	const permissions = [
		{
			permissionId: "p-1",
			type: "group",
			role: "writer",
			deleted: false,
			externalData: { emailAddress: "editors@example.invalid", displayName: "Editors" },
		},
		{
			permissionId: "p-2",
			type: "anyone",
			role: "reader",
			deleted: false,
			externalData: { emailAddress: "unrelated@example.invalid", domain: "unrelated.invalid" },
		},
	];
	const page = result("drive_permissions_list", args, { permissions, nextCursor: " \tnew+/= " });
	assert.match(page?.outcome ?? "", /2 permissions on this page.*next page is available/);
	assert.deepEqual(page?.body, [
		"group · editors@example.invalid · writer · permission p-1",
		"anyone · reader · permission p-2",
	]);
	assert.deepEqual(page?.next, { args: { fileId: "file-1", limit: 6, cursor: " \tnew+/= " } });
	assert.deepEqual(
		result("drive_permissions_list", { fileId: "file-1" }, { permissions: [], nextCursor: "new" })?.next,
		{ args: { fileId: "file-1", cursor: "new" } },
	);
});

test("Move, rename and trash outcomes require matching receipt evidence", () => {
	const rename = drivePresenters.drive_file_rename.call({ fileId: file.fileId, name: "Notes: November" });
	assert.deepEqual(rename.facts, ["rename to Notes: November"]);
	const move = { fileId: file.fileId, addParentIds: ["folder-1"], removeParentIds: ["folder-2"] };
	const applied = result("drive_file_move", move, file);
	assert.match(applied?.outcome ?? "", /confirmed the requested folder changes/);
	assert.ok(applied?.body?.includes("Parent folder folder-1"));
	assert.match(
		result("drive_file_move", move, { ...file, parents: ["folder-1", "folder-2"] })?.outcome ?? "",
		/does not confirm/,
	);
	assert.match(
		result("drive_file_rename", { fileId: file.fileId, name: "Different name" }, file)?.outcome ?? "",
		/does not confirm/,
	);
	assert.match(
		result("drive_file_trash", { fileId: file.fileId }, { ...file, trashed: true })?.outcome ?? "",
		/is in Trash/,
	);
	assert.match(result("drive_file_untrash", { fileId: file.fileId }, file)?.outcome ?? "", /is out of Trash/);
	assert.match(
		result("drive_file_untrash", { fileId: file.fileId }, { trashed: false })?.outcome ?? "",
		/not confirmed/,
	);
	assert.equal(result("drive_file_trash", { fileId: file.fileId }, { ...file, trashed: true }, "error"), undefined);
});

test("Drive transfers report receipts without upload content or descriptions", () => {
	const path = "/fixture/notes.txt";
	const upload = drivePresenters.drive_file_upload?.call({ path, description: "private", content: "file bytes" });
	assert.equal(upload?.subject, path);
	assert.deepEqual(upload?.args, { description: "7 characters" });
	const receipt = result("drive_file_upload", { path }, { ...file, sourceSha256: "source-checksum" });
	assert.match(receipt?.outcome ?? "", /^Uploaded a file/);
	assert.doesNotMatch(JSON.stringify(receipt), /Private description|source-checksum/);
	assert.match(
		result("drive_file_upload", { path }, { sourceSha256: "source-checksum" })?.outcome ?? "",
		/not confirmed/,
	);

	const args = { fileId: file.fileId, path, mimeType: "text/plain" };
	assert.match(
		result("drive_file_download", args, { fileId: file.fileId, path, bytes: 0 })?.outcome ?? "",
		/Downloaded 0 bytes/,
	);
	assert.match(
		result("drive_file_export", args, { fileId: file.fileId, path, bytes: "1", mimeType: args.mimeType })?.outcome ??
			"",
		/Exported 1 byte to/,
	);
	assert.match(result("drive_file_export", args, { fileId: file.fileId, path })?.outcome ?? "", /not confirmed/);
});

test("Sharing shows the permission receipt, not the email message or a claim of email delivery", () => {
	const args = {
		fileId: "file-1",
		type: "user",
		role: "reader",
		emailAddress: "reader@example.invalid",
		sendNotificationEmail: true,
		emailMessage: "Private note",
	};
	const call = drivePresenters.drive_share?.call(args);
	assert.equal(call?.subject, args.emailAddress);
	assert.deepEqual(call?.facts, ["reader", "user", "file file-1", "request email notification"]);
	assert.deepEqual(call?.args, { emailMessage: "12 characters" });
	assert.equal(
		drivePresenters.drive_share.call({ ...args, type: "domain", domain: "team.invalid" }).subject,
		"team.invalid",
	);
	assert.equal(drivePresenters.drive_share.call({ ...args, type: "anyone" }).subject, "Anyone");
	const permission = { fileId: args.fileId, permissionId: "p-1", notificationSent: true };
	assert.deepEqual(drivePresenters.drive_unshare.call(permission), { subject: "p-1", facts: ["file file-1"] });
	const shared = result("drive_share", args, permission);
	assert.match(shared?.outcome ?? "", /^Created a Drive sharing permission/);
	assert.deepEqual(shared?.body, ["Permission p-1"]);
	assert.deepEqual(shared?.details, ["An email notification was requested."]);
	assert.match(result("drive_share", args, { notificationSent: true })?.outcome ?? "", /not confirmed/);
	assert.match(result("drive_unshare", permission, { ...permission, deleted: true })?.outcome ?? "", /^Removed/);
	assert.match(result("drive_unshare", permission, { ...permission, deleted: false })?.outcome ?? "", /not confirmed/);
});
