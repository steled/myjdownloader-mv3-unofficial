'use strict';

angular.module('myjdWebextensionApp')
    .service('PopupIconService', [
        function () {
            this.updateBadge = function (attributes) {
                if (attributes.color !== undefined) {
                    chrome.action.setBadgeBackgroundColor({color: attributes.color});
                }
                if (attributes.text !== undefined) {
                    chrome.action.setBadgeText({text: attributes.text});
                }
            }
        }]);