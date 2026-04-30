"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "FakeFeatureSupportClient", {
    enumerable: true,
    get: function() {
        return FakeFeatureSupportClient;
    }
});
class FakeFeatureSupportClient {
    isSupported(...features) {
        return true;
    }
    registerOnSupportChange(onSupportChange) {
        onSupportChange();
        return ()=>{};
    }
}
