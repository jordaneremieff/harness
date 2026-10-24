import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileHistory } from './history.mts';
import { IMAGE_BYTES, IMAGE_EDGE, IMAGE_PIXELS, imagePart, readImage, validateImageBytes } from './images.mts';
import { imageRequest } from './image-request.mts';
import { projectFrame, projectSavedEntry } from './projection.mts';
import {ApiError} from './errors.mts';

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const raw = {type: 'image', mimeType: 'image/png', data};
const jpegData = '/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9/KKKKAP/2Q==';
const source = {entryId: 'entry', message: 0, part: 0};
const entry = {id: 'entry', type: 'message', message: {role: 'user', content: [raw]}};
test('raster projection has bounded metadata, and exact reads return only matching bytes', () => {
  const image = imagePart(raw); assert.equal(image.type, 'image'); if (image.type !== 'image') return;
  assert.deepEqual([image.width, image.height], [1, 1]); assert.equal(image.bytes, Buffer.from(data, 'base64').length);
  assert.ok(!JSON.stringify(image).includes(data));
  assert.deepEqual(imagePart({...image, source, injected: data}), {...image, source});
  const bytes = readImage(entry, source, image.digest); assert.equal(Buffer.from(bytes.data).toString('base64'), data);
  assert.throws(() => readImage(entry, source, '0'.repeat(64)), {code: 'stale_revision'});
  assert.throws(() => readImage(entry, {...source, entryId: 'other'}, image.digest), {code: 'stale_revision'});
  assert.throws(() => readImage(entry, {...source, part: 100}, image.digest), {code: 'invalid_request'});
  assert.throws(() => readImage({...entry, message: {...entry.message, role: 'custom', display: false}}, source, image.digest));
});
test('a baseline JPEG projects dimensions and returns the original exact image bytes', () => {
  const jpeg = {type: 'image', mimeType: 'image/jpeg', data: jpegData};
  const image = imagePart(jpeg); assert.ok(image.type === 'image');
  assert.deepEqual([image.mimeType, image.width, image.height, image.bytes], ['image/jpeg', 1, 1, 619]);
  assert.ok(!JSON.stringify(image).includes(jpegData));
  const result = readImage({...entry, message: {role: 'user', content: [jpeg]}}, source, image.digest);
  assert.equal(result.mimeType, 'image/jpeg'); assert.equal(Buffer.from(result.data).toString('base64'), jpegData);
});
test('JPEG metadata before its frame header stays inside the uploaded byte bound', () => {
  const original = Buffer.from(jpegData, 'base64'), app = Buffer.alloc(40_004);
  app[0] = 0xff; app[1] = 0xef; app.writeUInt16BE(app.length - 2, 2);
  const jpeg = Buffer.concat([original.subarray(0, 2), app, app, original.subarray(2)]);
  const metadata = validateImageBytes(jpeg, 'image/jpeg');
  assert.deepEqual([metadata.width, metadata.height, metadata.bytes], [1, 1, jpeg.length]);
  const part = {type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64')}, projected = imagePart(part); assert.ok(projected.type === 'image');
  assert.deepEqual(Buffer.from(readImage({...entry, message: {role: 'user', content: [part]}}, source, projected.digest).data), jpeg);
  assert.throws(() => readImage({...entry, message: {role: 'user', content: [part]}}, source, '0'.repeat(64)), {code: 'stale_revision'});
  const malformed = Buffer.from(jpeg); malformed.writeUInt16BE(1, 4);
  assert.throws(() => validateImageBytes(malformed, 'image/jpeg'), {code: 'invalid_request'});
  assert.throws(() => validateImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0xef, 0xff, 0xff, 0xff, 0xd9]), 'image/jpeg'), /malformed or unsupported/);
  const pixels = Buffer.from(jpeg); pixels.writeUInt16BE(5000, app.length * 2 + 7); pixels.writeUInt16BE(5000, app.length * 2 + 9);
  assert.throws(() => validateImageBytes(pixels, 'image/jpeg'), /dimensions exceed/);
  assert.throws(() => validateImageBytes(Buffer.alloc(IMAGE_BYTES + 1), 'image/jpeg'), /allowed bounds/);
});
test('PNG and JPEG reject a pixel product overflow even when both edges fit', () => {
  const edge = 5000; assert.ok(edge < IMAGE_EDGE && edge * edge > IMAGE_PIXELS);
  const png = Buffer.from(data, 'base64'); png.writeUInt32BE(edge, 16); png.writeUInt32BE(edge, 20);
  const jpeg = Buffer.from(jpegData, 'base64'); jpeg.writeUInt16BE(edge, 7); jpeg.writeUInt16BE(edge, 9);
  for (const part of [{...raw, data: png.toString('base64')}, {type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64')}]) {
    assert.deepEqual(imagePart(part), {type: 'omitted', label: 'Image dimensions exceed the display limit.'});
  }
});
test('visible custom-message images retain original source indices and hidden messages deny exact reads', () => {
  const visible = {type: 'custom_message', id: 'custom-image', parentId: null, customType: 'image', display: true, content: [{type: 'text', text: 'Caption'}, raw]};
  const projected = projectSavedEntry(visible), image = projected.messages?.[0]?.parts[1]; assert.ok(image?.type === 'image');
  const exactSource = {entryId: visible.id, message: 0, part: 1}; assert.deepEqual(image.source, exactSource);
  assert.equal(projected.messages?.[0]?.role, 'custom'); assert.equal(projected.head, 'image');
  assert.equal(Buffer.from(readImage(visible, exactSource, image.digest).data).toString('base64'), data);
  assert.throws(() => readImage(visible, exactSource, '0'.repeat(64)), {code: 'stale_revision'});
  assert.throws(() => readImage(visible, {...exactSource, message: 1}, image.digest), {code: 'invalid_request'});
  const hidden = {...visible, display: false}; assert.throws(() => readImage(hidden, exactSource, image.digest), {code: 'stale_revision'});
  assert.deepEqual(projectSavedEntry(hidden).messages?.[0]?.parts, []);
  for (const value of [projected, projectSavedEntry(hidden)]) assert.ok(!JSON.stringify(value).includes(data));
});
test('saved custom images cross the worker boundary only on demand and stay bound to the active branch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ui-custom-image-')), path = join(dir, 'session.jsonl');
  const history = new FileHistory(); t.after(async () => { await history.close(); await rm(dir, {recursive: true, force: true}); });
  const visible = {type: 'custom_message', id: 'visible', parentId: null, customType: 'image', display: true, content: [{type: 'text', text: 'Caption'}, raw]};
  const hidden = {...visible, id: 'hidden', parentId: visible.id, display: false};
  const other = {...visible, id: 'other'};
  const header = {type: 'session', version: 3, id: 'fixture', timestamp: new Date(0).toISOString(), cwd: dir};
  await writeFile(path, [header, visible, hidden, other].map(row => `${JSON.stringify(row)}\n`).join(''));
  const page = await history.page(path, hidden.id), image = page.entries[0]?.messages?.[0]?.parts[1]; assert.ok(image?.type === 'image' && image.source);
  assert.equal(image.source.part, 1); assert.deepEqual(page.entries[1]?.messages?.[0]?.parts, []); assert.ok(!JSON.stringify(page).includes(data));
  const result = await history.image(path, hidden.id, image.source, image.digest);
  assert.equal(result.mimeType, 'image/png'); assert.equal(Buffer.from(result.data).toString('base64'), data);
  await assert.rejects(history.image(path, hidden.id, {...image.source, entryId: hidden.id}, image.digest), {code: 'stale_revision'});
  await assert.rejects(history.image(path, other.id, image.source, image.digest), {code: 'invalid_request'});
  await assert.rejects(history.image(path, hidden.id, image.source, '0'.repeat(64)), {code: 'stale_revision'});
  await assert.rejects(history.image(path, hidden.id, {...image.source, part: 0}, image.digest), {code: 'invalid_request'});
});
test('unsupported, malformed, animated, oversized, and excessive-pixel images remain explicit omissions', () => {
  const huge = Buffer.from(data, 'base64'); huge.writeUInt32BE(8193, 16);
  const animation = Buffer.from(data, 'base64'); animation.write('acTL', 37, 'ascii');
  for (const part of [{...raw, mimeType: 'image/svg+xml'}, {...raw, mimeType: 'image/gif'}, {...raw, data: '<svg/>'}, {...raw, data: 'AAAA'}, {...raw, data: `${data}\n`}, {...raw, data: 'A'.repeat(4 * Math.ceil(IMAGE_BYTES / 3) + 4)}, {...raw, data: huge.toString('base64')}, {...raw, data: animation.toString('base64')}]) assert.equal(imagePart(part).type, 'omitted');
  assert.equal(imagePart({type: 'image', mimeType: 'image/png', digest: '0'.repeat(64), width: -1, height: 1, bytes: 10}).type, 'omitted');
});
test('image queries reject unknown, duplicated, invalid source and identity fields', () => {
  const image = imagePart(raw); assert.ok(image.type === 'image');
  const query = `entry=entry&message=0&part=0&digest=${image.digest}&epoch=1`;
  assert.deepEqual(imageRequest(new URL(`http://localhost/?${query}`), true), {source, digest: image.digest, epoch: 1});
  for (const bad of [`${query}&path=/secret`, `${query}&part=1`, query.replace('part=0', 'part=-1'), query.replace('message=0', 'message=8'), query.replace(image.digest, 'invalid'), query.replace('epoch=1', 'epoch=-1')]) assert.throws(() => imageRequest(new URL(`http://localhost/?${bad}`), true));
});
test('agent image entry IDs match the retained numeric contract while Primary entries remain strings',()=> {
  const query=new URLSearchParams({entry:'1',message:'0',part:'0',digest:'a'.repeat(64)});
  for(const entry of ['0','abc','01','-1','1.5',String(Number.MAX_SAFE_INTEGER),String(Number.MAX_SAFE_INTEGER+1),'9'.repeat(256)]) {
    query.set('entry',entry);
    assert.throws(()=>imageRequest(new URL(`http://localhost/?${query}`),false),error=>error instanceof ApiError&&error.status===400&&error.code==='invalid_request');
    query.set('epoch','1');assert.equal(imageRequest(new URL(`http://localhost/?${query}`),true).source.entryId,entry);query.delete('epoch');
  }
  for(const entry of ['1',String(Number.MAX_SAFE_INTEGER-1)]) {query.set('entry',entry);assert.equal(imageRequest(new URL(`http://localhost/?${query}`),false).source.entryId,entry);}
});
test('bounded image request fields refuse malformed input with explicit HTTP errors',()=> {
  const base={entry:'1',message:'0',part:'0',digest:'a'.repeat(64)},queries:URLSearchParams[]=[];
  for(const field of Object.keys(base)) {const missing=new URLSearchParams(base);missing.delete(field);queries.push(missing);const duplicate=new URLSearchParams(base);duplicate.append(field,base[field as keyof typeof base]);queries.push(duplicate);}
  for(const [field,values] of Object.entries({entry:['','x'.repeat(257),'\u0000'],message:['-1','1.5','8',String(Number.MAX_SAFE_INTEGER+1)],part:['-1','1.5','100',String(Number.MAX_SAFE_INTEGER+1)],digest:['','A'.repeat(64),'a'.repeat(63)],unknown:['1'],epoch:['1']})) {
    for(const value of values) {const query=new URLSearchParams(base);query.set(field,value);queries.push(query);}
  }
  const repeatedWorkspace=new URLSearchParams(base);repeatedWorkspace.append('workspace','one');repeatedWorkspace.append('workspace','two');queries.push(repeatedWorkspace);
  for(const query of queries)assert.throws(()=>imageRequest(new URL(`http://localhost/?${query}`),false),error=>error instanceof ApiError&&error.status===400&&error.code==='invalid_request');
  const edges=new URLSearchParams({...base,message:'7',part:'99',workspace:'workspace'});assert.deepEqual(imageRequest(new URL(`http://localhost/?${edges}`),false).source,{entryId:'1',message:7,part:99});
});
test('saved and native projections preserve source references without eager frame image bytes', () => {
  const saved = projectSavedEntry(entry);
  const image = saved.messages?.[0]?.parts[0]; assert.ok(image?.type === 'image'); assert.deepEqual(image.source, source);
  const frame = projectFrame({entries: [{id: 1, kind: 'message', model: [entry.message]}], live: []});
  const native = frame.entries[0]?.messages?.[0]?.parts[0]; assert.ok(native?.type === 'image');
  assert.deepEqual(native.source, {...source, entryId: '1'});
  for (const value of [saved, frame]) { const json = JSON.stringify(value); assert.ok(!json.includes(data)); assert.ok(json.length < 4096); }
});
