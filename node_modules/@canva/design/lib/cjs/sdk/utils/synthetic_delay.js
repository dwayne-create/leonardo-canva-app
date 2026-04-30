"use strict"
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "createSyntheticDelay", {
    enumerable: true,
    get: function() {
        return createSyntheticDelay;
    }
});
function createSyntheticDelay(timeout) {
    return ()=>new Promise((res)=>setTimeout(res, timeout));
}
