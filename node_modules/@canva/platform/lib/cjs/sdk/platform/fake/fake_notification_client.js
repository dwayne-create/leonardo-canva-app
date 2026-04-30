"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "FakeNotificationClient", {
    enumerable: true,
    get: function() {
        return FakeNotificationClient;
    }
});
class FakeNotificationClient {
    async addToast(options) {
        return {
            status: 'completed'
        };
    }
}
