"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "FakePlatformClient", {
    enumerable: true,
    get: function() {
        return FakePlatformClient;
    }
});
class FakePlatformClient {
    async requestOpenExternalUrl(options) {
        await Promise.resolve();
        return {
            status: 'completed'
        };
    }
    getPlatformInfo() {
        return {
            canAcceptPayments: true
        };
    }
}
