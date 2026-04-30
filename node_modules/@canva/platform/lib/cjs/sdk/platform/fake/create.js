"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "createFakePlatformClients", {
    enumerable: true,
    get: function() {
        return createFakePlatformClients;
    }
});
const _fake_app_process_client = require("./fake_app_process_client");
const _fake_feature_support_client = require("./fake_feature_support_client");
const _fake_notification_client = require("./fake_notification_client");
const _fake_platform_client = require("./fake_platform_client");
function createFakePlatformClients() {
    const appProcess = new _fake_app_process_client.FakeAppProcessClient();
    const platform = new _fake_platform_client.FakePlatformClient();
    const features = new _fake_feature_support_client.FakeFeatureSupportClient();
    const notification = new _fake_notification_client.FakeNotificationClient();
    const i18n = undefined;
    return {
        platform: {
            v2: {
                platform,
                appProcess,
                i18n,
                features,
                notification
            }
        }
    };
}
