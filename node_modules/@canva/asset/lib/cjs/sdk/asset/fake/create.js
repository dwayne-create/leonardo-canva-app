"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "createFakeAssetClients", {
    enumerable: true,
    get: function() {
        return createFakeAssetClients;
    }
});
const _fake_content_client = require("./fake_content_client");
function createFakeAssetClients() {
    const v2 = {
        content: new _fake_content_client.FakeContentClient()
    };
    return {
        asset: {
            v2
        }
    };
}
