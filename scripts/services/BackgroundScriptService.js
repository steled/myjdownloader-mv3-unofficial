"use strict";

// In MV3 there is no persistent background page.  The MyJDownloader connection
// is therefore managed directly by each UI page (popup / toolbar) that has
// access to myjdClientFactory / myjdDeviceClientFactory.
// Queue-management messages (link-info, remove-*, close-*) are still routed
// through the service-worker background.js.

angular.module('myjdWebextensionApp')
    .service('BackgroundScriptService', [
        '$q', 'ExtensionMessagingService', 'myjdClientFactory', 'myjdDeviceClientFactory',
        function ($q, ExtensionMessagingService, myjdClientFactory, myjdDeviceClientFactory) {

            // ----------------------------------------------------------------
            // Helper: wrap jQuery-Deferred in a $q promise
            // ----------------------------------------------------------------
            function wrapDeferred(deferred) {
                return $q(function (resolve, reject) {
                    deferred.done(resolve).fail(reject);
                });
            }

            // ----------------------------------------------------------------
            // Session / authentication
            // ----------------------------------------------------------------
            function getSessionInfo() {
                var client = myjdClientFactory.get();
                var initPromise = client._connectPromise || $q.resolve();
                console.log("[JD Debug] getSessionInfo() called, waiting for _connectPromise");
                chrome.storage.local.get("jdapi/src/core/core.js", function (stored) {
                    console.log("[JD Debug] getSessionInfo - storage at call time:", JSON.stringify(stored));
                });
                return initPromise.then(
                    function () {
                        var token = client.api && client.api.jdAPICore &&
                                    client.api.jdAPICore.options.sessiontoken;
                        var loggedIn = !!(token && token.length > 0);
                        console.log("[JD Debug] getSessionInfo() resolved. isLoggedIn:", loggedIn, "sessiontoken present:", !!(token && token.length > 0));
                        return { data: { isLoggedIn: loggedIn } };
                    },
                    function (err) {
                        console.log("[JD Debug] getSessionInfo() _connectPromise rejected:", err);
                        return { data: { isLoggedIn: false } };
                    }
                );
            }

            function login(credentials) {
                // PopupCtrl wraps as {credentials: {email, password}} — unwrap one level.
                // MyjdService.connect() expects {email, password} directly.
                // MyjdService.apiStateChanceListener sends CONNECTION_STATE_CHANGE automatically.
                var innerCreds = (credentials && credentials.credentials)
                    ? credentials.credentials
                    : credentials;
                return $q(function (resolve, reject) {
                    myjdClientFactory.get().connect(innerCreds).then(function () {
                        resolve({ data: true });
                    }).catch(function (error) {
                        reject(error);
                    });
                });
            }

            function logout() {
                return $q(function (resolve, reject) {
                    myjdClientFactory.get().disconnect().then(function () {
                        resolve({ data: true });
                    }).catch(function (error) {
                        reject(error);
                    });
                });
            }

            function getUsername() {
                return $q(function (resolve, reject) {
                    var api = myjdClientFactory.get() && myjdClientFactory.get().api;
                    if (api && api.jdAPICore && api.jdAPICore.options.email) {
                        resolve({ username: api.jdAPICore.options.email });
                    } else {
                        reject("Not connected");
                    }
                });
            }

            // ----------------------------------------------------------------
            // Device / API
            // ----------------------------------------------------------------
            function getDevices() {
                console.log("[JD Debug] getDevices() called");
                return $q(function (resolve, reject) {
                    myjdClientFactory.get().getDeviceList().then(function (result) {
                        console.log("[JD Debug] getDevices() success:", JSON.stringify(result && result.result));
                        resolve({ data: { devices: result.result } });
                        ExtensionMessagingService.sendMessage("myjd-toolbar", "devices-change", { devices: result.result });
                    }, function (error) {
                        console.log("[JD Debug] getDevices() FAILED:", JSON.stringify(error));
                        reject(error);
                        ExtensionMessagingService.sendMessage("myjd-toolbar", "devices-change", { error: error });
                    });
                });
            }

            function addLink(device, addLinkQuery) {
                return wrapDeferred(
                    myjdDeviceClientFactory.get(device)
                        .sendRequest('/linkgrabberv2/addLinks', JSON.stringify(addLinkQuery))
                );
            }

            function addCnl(device, addCnlQuery) {
                return wrapDeferred(
                    myjdDeviceClientFactory.get(device)
                        .sendRequest('/flash/addcnl', JSON.stringify(addCnlQuery))
                );
            }

            function sendFeedback(message) {
                return wrapDeferred(
                    myjdClientFactory.get().sendFeedback(message)
                );
            }

            function sendApiRequest(device, action, params) {
                return $q(function (resolve, reject) {
                    myjdDeviceClientFactory.get(device).sendRequest(action, params)
                        .done(function (result) { resolve({ data: result }); })
                        .fail(function (error)  { reject(error); });
                });
            }

            function devicePoll(device) {
                return $q(function (resolve) {
                    myjdDeviceClientFactory.get(device).oneTimePoll();
                    resolve();
                });
            }

            function startDevicePoll(device) {
                return devicePoll(device);
            }

            function stopDevicePoll(device) {
                return $q(function (resolve) { resolve(); });
            }

            // ----------------------------------------------------------------
            // Event callbacks (still forwarded through service worker)
            // ----------------------------------------------------------------
            function onConnectionChanged(callback) {
                return ExtensionMessagingService.addListener("myjd-toolbar", "session-change", callback);
            }

            function onApiError(callback) {
                return ExtensionMessagingService.addListener("myjd-toolbar", "api-error", callback);
            }

            function onDeviceListChanged(callback) {
                return ExtensionMessagingService.addListener("myjd-toolbar", "devices-change", callback);
            }

            function onDevicePoll(deviceId, callback) {
                return ExtensionMessagingService.addListener("myjd-toolbar", "device-poll-" + deviceId, callback);
            }

            // ----------------------------------------------------------------
            // Public API
            // ----------------------------------------------------------------
            this.getSessionInfo      = getSessionInfo;
            this.login               = login;
            this.logout              = logout;
            this.getUsername         = getUsername;
            this.getDevices          = getDevices;
            this.addLink             = addLink;
            this.addCnl              = addCnl;
            this.sendFeedback        = sendFeedback;
            this.sendApiRequest      = sendApiRequest;
            this.devicePoll          = devicePoll;
            this.startDevicePoll     = startDevicePoll;
            this.stopDevicePoll      = stopDevicePoll;
            this.onConnectionChanged = onConnectionChanged;
            this.onApiError          = onApiError;
            this.onDeviceListChanged = onDeviceListChanged;
            this.onDevicePoll        = onDevicePoll;
        }
    ]);
