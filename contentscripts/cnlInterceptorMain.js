// Runs in MAIN world – intercepts XHR/fetch/form POSTs to localhost:9666/flash/*
// and forwards the POST body to the isolated-world relay before cancelling
// the original request (so it never reaches JDownloader's local server
// when the extension handles it instead).
(function () {
  if (window.__myjdCNLInterceptorInstalled) return;
  window.__myjdCNLInterceptorInstalled = true;
  console.log('[JD CNL] cnlInterceptorMain.js injected');

  function isCNLFlashUrl(url) {
    return (
      (url.indexOf('127.0.0.1:9666/flash/') !== -1 ||
       url.indexOf('localhost:9666/flash/')  !== -1) &&
      url.indexOf('?fromExtension') === -1
    );
  }

  function bodyToString(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      var parts = [];
      body.forEach(function (value, key) {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      });
      return parts.join('&');
    }
    return '';
  }

  function extractFormBody(form) {
    var parts = [];
    var elements = form.elements;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el.name && !el.disabled &&
          el.type !== 'submit' && el.type !== 'reset' &&
          el.type !== 'button' && el.type !== 'image') {
        parts.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value));
      }
    }
    return parts.join('&');
  }

  // ---- XMLHttpRequest interception ----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._myjdMethod = method;
    this._myjdUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var url    = this._myjdUrl    || '';
    var method = (this._myjdMethod || 'GET').toUpperCase();

    if (method === 'POST' && isCNLFlashUrl(url)) {
      var bodyText = bodyToString(body);
      console.log('[JD CNL] Intercepted XHR POST to', url, '- body length:', bodyText.length);
      window.postMessage({ type: '__myjd_cnl__', url: url, body: bodyText }, '*');

      // Simulate a 200 OK so the page does not show an error.
      var self = this;
      setTimeout(function () {
        try {
          Object.defineProperty(self, 'readyState',   { configurable: true, get: function () { return 4; } });
          Object.defineProperty(self, 'status',       { configurable: true, get: function () { return 200; } });
          Object.defineProperty(self, 'responseText', { configurable: true, get: function () { return 'success'; } });
          Object.defineProperty(self, 'response',     { configurable: true, get: function () { return 'success'; } });
          if (typeof self.onreadystatechange === 'function') self.onreadystatechange.call(self, new Event('readystatechange'));
          if (typeof self.onload === 'function')            self.onload.call(self, new Event('load'));
          self.dispatchEvent(new Event('readystatechange'));
          self.dispatchEvent(new Event('load'));
        } catch (e) { console.warn('[JD CNL] Error simulating XHR response:', e); }
      }, 50);
      return;
    }

    return origSend.apply(this, arguments);
  };

  // ---- fetch interception ----
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;

    // Returns a fake "success" promise for CNL POSTs, otherwise undefined.
    var cnlFetchHook = function (input, init) {
      var url    = typeof input === 'string' ? input
                 : input instanceof URL      ? input.href
                 : input instanceof Request  ? input.url : '';
      var method = (init && init.method
                 ? init.method
                 : input instanceof Request ? input.method : 'GET'
                 ).toUpperCase();

      if (method === 'POST' && isCNLFlashUrl(url)) {
        var bodyText = init ? bodyToString(init.body) : '';
        console.log('[JD CNL] Intercepted fetch POST to', url, '- body length:', bodyText.length);
        window.postMessage({ type: '__myjd_cnl__', url: url, body: bodyText }, '*');
        return Promise.resolve(new Response('success', { status: 200 }));
      }
    };

    try {
      // Chrome lists a page's own fetch failures (blocked requests, CSP, offline, ...)
      // on the extension's error page when a frame of the extension script is on the
      // stack of the failing call. Building the pass-through wrapper with new Function
      // gives it no extension URL, so those errors stay attributed to the page.
      window.fetch = new Function('orig', 'hook',
        'return function fetch(input, init) {' +
        '  var r = hook(input, init);' +
        '  if (r) return r;' +
        '  return orig.apply(this, arguments);' +
        '};')(origFetch, cnlFetchHook);
    } catch (e) {
      // page CSP forbids eval: fall back to a regular wrapper
      window.fetch = function (input, init) {
        return cnlFetchHook(input, init) || origFetch.apply(this, arguments);
      };
    }
  }

  // ---- form.submit() interception ----
  // filecrypt.cc and similar sites use form.submit() directly (not XHR/fetch),
  // so we must also patch HTMLFormElement.prototype.submit.
  var origFormSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    var action = (this.action || '').toString();
    var method = (this.method || 'GET').toUpperCase();
    if (method === 'POST' && isCNLFlashUrl(action)) {
      var bodyText = extractFormBody(this);
      console.log('[JD CNL] Intercepted FORM.submit() POST to', action, '- body length:', bodyText.length);
      window.postMessage({ type: '__myjd_cnl__', url: action, body: bodyText }, '*');
      return; // suppress the actual network request
    }
    return origFormSubmit.apply(this, arguments);
  };

  // ---- form submit-event interception (requestSubmit() and button clicks) ----
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.tagName !== 'FORM') return;
    var action = (form.action || '').toString();
    var method = (form.method || 'GET').toUpperCase();
    if (method === 'POST' && isCNLFlashUrl(action)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      var bodyText = extractFormBody(form);
      console.log('[JD CNL] Intercepted FORM submit-event POST to', action, '- body length:', bodyText.length);
      window.postMessage({ type: '__myjd_cnl__', url: action, body: bodyText }, '*');
    }
  }, true); // capture phase so we run before the page's own handlers

})();
