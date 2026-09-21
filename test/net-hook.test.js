import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const code = fs.readFileSync(new URL('../extension/net-hook.js', import.meta.url), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function setup(fetch) {
  class XHR { open() {} send() {} }
  const sandbox = {window: {fetch}, XMLHttpRequest: XHR, Date, TextDecoder,
    setTimeout, clearTimeout, console};
  vm.runInNewContext(code, sandbox);
  return sandbox;
}
async function quickly(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('响应被日志阻塞')), 300);
  })]); } finally { clearTimeout(timer); }
}
async function logged(record) {
  for (let i = 0; i < 200 && record.bodyState === 'pending'; i++) await delay(30);
  assert.notEqual(record.bodyState, 'pending');
}

test('网络日志不阻塞事件流且不影响网页读取正文', async () => {
// 流保持开放：包装fetch必须返回原Response，日志不得克隆或消耗正文。
let sseController;
const sse = new Response(new ReadableStream({start(c) {
  sseController = c;
  c.enqueue(new TextEncoder().encode('event: connected\ndata: {}\n\n'));
}}), {headers: {'content-type': 'Text/Event-Stream; charset=utf-8'}});
sse.clone = () => { throw new Error('SSE不应被克隆'); };
const env = setup(async () => sse);
assert.equal(await quickly(env.window.fetch('/events')), sse);
assert.equal(env.window.__hcNet[0].bodyState, 'stream-skipped');
const reader = sse.body.getReader();
assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
sseController.close();
await reader.cancel();

// 日志与网页分别读取JSON，Request对象的method保留；重复注入不叠加包装。
const jsonResponse = new Response('{"ok":true}', {headers: {'content-type': 'application/json'}});
const jsonEnv = setup(async () => jsonResponse);
const wrapped = jsonEnv.window.fetch;
vm.runInNewContext(code, jsonEnv);
assert.equal(jsonEnv.window.fetch, wrapped);
const actual = await quickly(wrapped(new Request('https://example.invalid/test', {method: 'POST'})));
assert.deepEqual(await actual.json(), {ok: true});
await logged(jsonEnv.window.__hcNet[0]);
assert.equal(jsonEnv.window.__hcNet.length, 1);
assert.equal(jsonEnv.window.__hcNet[0].method, 'POST');
assert.equal(jsonEnv.window.__hcNet[0].body, '{"ok":true}');

// 大正文日志被截断，但网页仍能读取完整正文。
const big = 'x'.repeat(450000);
const bigEnv = setup(async () => new Response(big, {headers: {'content-type': 'text/plain'}}));
assert.equal((await (await quickly(bigEnv.window.fetch('/large'))).text()).length, big.length);
await logged(bigEnv.window.__hcNet[0]);
assert.equal(bigEnv.window.__hcNet[0].body.length, 400000);
assert.equal(bigEnv.window.__hcNet[0].bodyState, 'truncated');

// 没有后续数据的普通文本，日志超时只取消克隆分支，网页分支继续可读。
let textController;
const hanging = new Response(new ReadableStream({start(c) {textController = c;}}), {headers: {'content-type': 'text/plain'}});
const hangingEnv = setup(async () => hanging);
assert.equal(await quickly(hangingEnv.window.fetch('/slow-text')), hanging);
await logged(hangingEnv.window.__hcNet[0]);
assert.equal(hangingEnv.window.__hcNet[0].bodyState, 'timeout');
textController.enqueue(new TextEncoder().encode('still works'));
textController.close();
assert.equal(await hanging.text(), 'still works');

// 日志克隆异常不使成功请求失败；原网络错误保持原对象传播。
const unclonable = new Response('ok', {headers: {'content-type': 'text/plain'}});
unclonable.clone = () => {throw new TypeError('clone failure');};
const failedLog = setup(async () => unclonable);
assert.equal(await quickly(failedLog.window.fetch('/clone-fail')), unclonable);
assert.equal(failedLog.window.__hcNet[0].logError, 'TypeError');
const empty = new Response(null, {status: 204, headers: {'content-type': 'application/json'}});
const emptyEnv = setup(async () => empty);
assert.equal(await emptyEnv.window.fetch('/empty'), empty);
assert.equal(emptyEnv.window.__hcNet[0].bodyState, 'complete');
const networkError = new TypeError('network failure');
await assert.rejects(setup(async () => {throw networkError;}).window.fetch('/fail'), e => e === networkError);
console.log('PASS: SSE即时返回、JSON双读、请求方法、重复注入、正文上限、5秒日志超时不影响网页、克隆失败隔离、网络错误传播；无业务网络请求。');

});
