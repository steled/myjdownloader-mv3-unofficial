// Isolated-world relay: receives CNL intercept messages from the MAIN-world
// script (cnlInterceptorMain.js) and forwards the parsed POST body to the
// background service worker via chrome.runtime.sendMessage.
(function () {
  function parseFormBody(body) {
    var result = {};
    if (!body) return result;
    body.split('&').forEach(function (pair) {
      var idx   = pair.indexOf('=');
      var key   = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
      var value = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
      if (result[key] === undefined) {
        result[key] = value;
      } else if (Array.isArray(result[key])) {
        result[key].push(value);
      } else {
        result[key] = [result[key], value];
      }
    });
    return result;
  }

  console.log('[JD CNL] cnlContentscript.js (relay) ready');

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== '__myjd_cnl__') return;
    console.log('[JD CNL] Relay: received CNL from MAIN world, forwarding to background');

    var url       = event.data.url  || '';
    var body      = event.data.body || '';
    var isCrypted = url.indexOf('/flash/addcrypted2') !== -1;
    var formData  = parseFormBody(body);

    chrome.runtime.sendMessage({
      name:   'myjd-cnl',
      action: 'add-request',
      data:   { formData: formData, isCrypted: isCrypted, url: url }
    }, function () {
      if (chrome.runtime.lastError) { /* SW not ready yet – acceptable */ }
    });
  });
})();
