// 网络记录 hook —— 注入到页面的 MAIN world，document_start 执行。
//
// 必须赶在页面自己的 JS 之前跑，否则首屏那批 XHR 全漏掉，
// 而恰恰是首屏那批带着列表数据。
//
// 只往 window.__hcNet 里堆记录，不上报、不外发。读取由扩展按需拉。
(() => {
  if (window.__hcNet) return;
  window.__hcNet = [];

  const MAX_ENTRIES = 300;
  const MAX_BODY = 400000;
  // 沿用正文上限作为字节预算；5秒仅限制诊断日志，不限制网页请求。
  const BODY_LOG_TIMEOUT_MS = 5000;

  const captureBody = async (response, record) => {
    let reader;
    let timer;
    try {
      reader = response.clone().body?.getReader();
      if (!reader) { record.bodyState = 'complete'; return; }
      const decoder = new TextDecoder();
      let bytes = 0;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ expired: true }), BODY_LOG_TIMEOUT_MS);
      });
      while (true) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.expired) { record.bodyState = 'timeout'; break; }
        if (chunk.done) {
          record.body += decoder.decode();
          record.bodyState = 'complete';
          break;
        }
        const take = chunk.value.subarray(0, MAX_BODY - bytes);
        record.body += decoder.decode(take, { stream: true });
        bytes += take.byteLength;
        if (bytes >= MAX_BODY) { record.bodyState = 'truncated'; break; }
      }
    } catch (error) {
      // 页面取消、流读取或克隆失败只影响日志，保留错误类型供排查。
      record.bodyState = 'error';
      record.logError = error?.name || 'Error';
    } finally {
      clearTimeout(timer);
      // tee的取消可能等待网页那一支结束，绝不能等待它再释放日志任务。
      if (reader) void reader.cancel().catch(error => {
        record.cancelError = error?.name || 'Error';
      });
    }
  };

  const push = (r) => {
    window.__hcNet.push(r);
    if (window.__hcNet.length > MAX_ENTRIES) window.__hcNet.shift();
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...a) {
      const res = await origFetch.apply(this, a);
      try {
        const url = typeof a[0] === 'string' ? a[0] : a[0]?.url || String(a[0]);
        const ct = res.headers.get('content-type') || '';
        const record = { t: Date.now(), method: a[1]?.method || a[0]?.method || 'GET', url, status: res.status, ct, body: '' };
        push(record);
        // SSE没有完整响应的完成时刻，只记元信息，不能克隆并等待正文。
        if (ct.split(';')[0].trim().toLowerCase() === 'text/event-stream') {
          record.bodyState = 'stream-skipped';
        } else if (/json|text|javascript/i.test(ct)) {
          record.bodyState = 'pending';
          void captureBody(res, record);
        }
      } catch (error) {
        // 诊断失败不改变业务请求结果；仅报告类型，避免输出响应或凭据。
        console.warn('[huashu-chrome] network log failed:', error?.name || 'Error');
      }
      return res;
    };
  }

  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__hc = { method: m, url: String(u) };
    return oOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        push({
          t: Date.now(),
          ...this.__hc,
          status: this.status,
          ct: this.getResponseHeader('content-type') || '',
          body: String(this.responseText || '').slice(0, MAX_BODY),
        });
      } catch {}
    });
    return oSend.apply(this, a);
  };
})();
